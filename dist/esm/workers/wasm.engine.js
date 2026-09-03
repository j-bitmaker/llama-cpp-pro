import { canUseAsyncFileRead, asyncReaderFromBytes, } from './async-file';
import { ensureWasmTmpDir, heapfsAlloc, heapfsModelPath, heapfsWrite, patchHeapFS, supportsHeapFS, } from './heapfs';
const safeJsonParse = (raw, fallback) => {
    try {
        return JSON.parse(raw);
    }
    catch (_a) {
        return fallback;
    }
};
/** Models above this use VFS streaming first (HeapFS/mmap can overflow JS stack). */
const LARGE_MODEL_BYTES = 500 * 1024 * 1024;
/** Legacy MEMFS streaming — use_mmap=false (full file copied into WASM VFS). */
const wasmLoadOptsJson = (opts, overrides) => JSON.stringify(Object.assign(Object.assign({ use_mmap: false }, (opts !== null && opts !== void 0 ? opts : {})), overrides));
/** JSPI async fread — model stays in JS; C++ reads on demand (use_mmap=false). */
const wasmAsyncLoadOptsJson = (opts, overrides) => JSON.stringify(Object.assign(Object.assign({ use_mmap: false }, (opts !== null && opts !== void 0 ? opts : {})), overrides));
const loadViaAsyncFile = (mod, modelId, sizeBytes, readChunk, opts) => {
    const begin = mod.model_vfs_begin;
    const bind = mod.async_model_bind;
    const finish = mod.load_model_from_vfs;
    const abort = mod.model_vfs_abort;
    if (!begin || !bind || !finish) {
        throw new Error('Wasm module missing JSPI async file exports — rebuild with: npm run build:wasm:jspi');
    }
    const optsJson = wasmAsyncLoadOptsJson(opts);
    const vfsPath = begin(sizeBytes, optsJson);
    if (!vfsPath)
        throw new Error('model_vfs_begin returned empty path');
    try {
        bind(vfsPath, sizeBytes, (offset, length) => readChunk(offset, length));
        finish(modelId, vfsPath, optsJson);
    }
    catch (err) {
        abort === null || abort === void 0 ? void 0 : abort(vfsPath);
        throw err;
    }
};
const isStackOverflowError = (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    return /maximum call stack size exceeded/i.test(msg);
};
const wasmMemoryDiagnostics = (em) => {
    var _a, _b;
    if (!em) {
        return { wasmMemoryAccessible: false };
    }
    const wasmMem = em.wasmMemory;
    const buffer = (_a = wasmMem === null || wasmMem === void 0 ? void 0 : wasmMem.buffer) !== null && _a !== void 0 ? _a : (_b = em.HEAPU8) === null || _b === void 0 ? void 0 : _b.buffer;
    if (!buffer) {
        return { wasmMemoryAccessible: false };
    }
    return {
        wasmMemoryAccessible: true,
        wasmLinearBytes: buffer.byteLength,
        wasmLinearMb: +(buffer.byteLength / 1024 / 1024).toFixed(1),
        wasmMemoryShared: (wasmMem === null || wasmMem === void 0 ? void 0 : wasmMem.buffer) instanceof SharedArrayBuffer,
    };
};
// Resolve llama_engine.js candidates (worker-relative + app overrides).
const resolveModuleCandidates = () => {
    var _a, _b;
    const candidates = [];
    const g = globalThis;
    for (const key of ['__LLAMA_WASM_MODULE_URL__', '__LLAMA_ENGINE_URL__']) {
        const customUrl = g === null || g === void 0 ? void 0 : g[key];
        if (typeof customUrl === 'string' && customUrl.length > 0) {
            candidates.push(customUrl);
        }
    }
    try {
        // Static import.meta.url reference — detected correctly by bundlers.
        const base = new URL('../../wasm/llama_engine.js', import.meta.url).href;
        candidates.push(base);
        candidates.push(new URL('../../dist/wasm/llama_engine.js', import.meta.url).href);
    }
    catch (_c) {
        // import.meta.url unavailable (CommonJS transform or test runner).
    }
    const origin = (_b = (_a = g === null || g === void 0 ? void 0 : g.location) === null || _a === void 0 ? void 0 : _a.origin) !== null && _b !== void 0 ? _b : '';
    if (origin) {
        candidates.push(`${origin}/llama-cpp/wasm/llama_engine.js`);
        candidates.push(`${origin}/dist/wasm/llama_engine.js`);
        candidates.push(`${origin}/wasm/llama_engine.js`);
    }
    return [...new Set(candidates)];
};
const loadWasmModule = async () => {
    let lastError;
    for (const url of resolveModuleCandidates()) {
        try {
            const mod = (await import(/* @vite-ignore */ url));
            if (mod && typeof mod.default === 'function') {
                await mod.default();
            }
            if (typeof mod.load_model === 'function' && typeof mod.generate === 'function' && typeof mod.embed === 'function') {
                return mod;
            }
            lastError = new Error(`Module loaded but missing required exports at ${url}`);
        }
        catch (error) {
            lastError = error;
        }
    }
    throw new Error(`Unable to load wasm wrapper module (llama_engine.js). ` +
        `Set window.__LLAMA_WASM_MODULE_URL__ to llama_engine.js. ` +
        `Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
};
export const loadLlamaWasmEngine = async () => {
    const mod = await loadWasmModule();
    const emscripten = () => { var _a, _b; return (_b = (_a = mod.getEmscriptenModule) === null || _a === void 0 ? void 0 : _a.call(mod)) !== null && _b !== void 0 ? _b : null; };
    const ensureHeapFS = () => {
        const em = emscripten();
        if (!em || !supportsHeapFS(em)) {
            throw new Error('Wasm build missing HeapFS runtime (mmapAlloc/MEMFS/FS) — rebuild with npm run build:wasm');
        }
        patchHeapFS(em);
        return em;
    };
    const ensureVfsReady = () => {
        const em = emscripten();
        if (em && supportsHeapFS(em)) {
            ensureWasmTmpDir(em);
        }
    };
    return {
        init: async () => {
            var _a, _b;
            (_b = ((_a = mod.init_engine) !== null && _a !== void 0 ? _a : mod.init)) === null || _b === void 0 ? void 0 : _b();
            const em = emscripten();
            if (em && supportsHeapFS(em)) {
                patchHeapFS(em);
                ensureWasmTmpDir(em);
            }
        },
        loadModel: async (modelId, modelBuffer, opts) => {
            var _a;
            const bytes = new Uint8Array(modelBuffer);
            const em = emscripten();
            const asyncReady = typeof mod.can_use_async_file === 'function'
                ? mod.can_use_async_file()
                : canUseAsyncFileRead((_a = em === null || em === void 0 ? void 0 : em.__llamaWasmJspi) !== null && _a !== void 0 ? _a : false);
            // JSPI async fread: register JS reader — no full-model copy into WASM linear memory.
            if (asyncReady) {
                const reader = asyncReaderFromBytes(bytes);
                loadViaAsyncFile(mod, modelId, reader.sizeBytes, reader.readChunk, opts);
                return;
            }
            // HeapFS fallback: mmapAlloc places GGUF in WASM heap (wllama fallback when no JSPI).
            const begin = mod.model_vfs_begin;
            const write = mod.model_vfs_write;
            const finish = mod.load_model_from_vfs;
            const abort = mod.model_vfs_abort;
            if (begin && write && finish) {
                ensureVfsReady();
                const optsJson = wasmLoadOptsJson(opts);
                const vfsPath = begin(bytes.length, optsJson);
                if (!vfsPath)
                    throw new Error('model_vfs_begin returned empty path');
                try {
                    const CHUNK = 32 * 1024 * 1024;
                    for (let offset = 0; offset < bytes.length; offset += CHUNK) {
                        write(vfsPath, bytes.subarray(offset, offset + CHUNK));
                    }
                    finish(modelId, vfsPath, optsJson);
                }
                catch (err) {
                    abort === null || abort === void 0 ? void 0 : abort(vfsPath);
                    throw err;
                }
                return;
            }
            const loadModelFn = mod.load_model;
            if (!loadModelFn)
                throw new Error('Wasm module missing load_model export');
            loadModelFn(modelId, bytes, JSON.stringify(opts !== null && opts !== void 0 ? opts : {}));
        },
        loadModelFromOpfsReader: async (modelId, reader, opts) => {
            var _a;
            const loadFromPath = mod.load_model_from_path;
            const begin = mod.model_vfs_begin;
            const write = mod.model_vfs_write;
            const finish = mod.load_model_from_vfs;
            const abort = mod.model_vfs_abort;
            const chunkSize = 4 * 1024 * 1024;
            const em = emscripten();
            const asyncReady = typeof mod.can_use_async_file === 'function'
                ? mod.can_use_async_file()
                : canUseAsyncFileRead((_a = em === null || em === void 0 ? void 0 : em.__llamaWasmJspi) !== null && _a !== void 0 ? _a : false);
            const loadViaAsyncOpfs = () => {
                loadViaAsyncFile(mod, modelId, reader.sizeBytes, (offset, length) => reader.readChunk(offset, length), opts);
            };
            const streamOpfsToVfs = (useMmap) => {
                if (!begin || !write || !finish) {
                    throw new Error('Wasm module missing OPFS streaming exports (model_vfs_* / load_model_from_path)');
                }
                ensureVfsReady();
                const vfsPath = begin(reader.sizeBytes, wasmLoadOptsJson(opts, { use_mmap: useMmap }));
                if (!vfsPath) {
                    throw new Error('model_vfs_begin returned empty path');
                }
                const optsJson = wasmLoadOptsJson(opts, { use_mmap: useMmap });
                try {
                    for (let offset = 0; offset < reader.sizeBytes;) {
                        const chunk = reader.readChunk(offset, chunkSize);
                        if (chunk.byteLength === 0) {
                            break;
                        }
                        write(vfsPath, chunk);
                        offset += chunk.byteLength;
                    }
                    finish(modelId, vfsPath, optsJson);
                }
                catch (error) {
                    abort === null || abort === void 0 ? void 0 : abort(vfsPath);
                    throw error;
                }
            };
            const tryHeapFSLoad = () => {
                if (!loadFromPath) {
                    throw new Error('Wasm module missing load_model_from_path');
                }
                const emMod = ensureHeapFS();
                const basename = `${modelId.replace(/[^\w.-]/g, '_')}.gguf`;
                const vfsPath = heapfsModelPath(basename);
                emMod.FS.createDataFile('/models', basename, new ArrayBuffer(0), true, true, true);
                const fileId = heapfsAlloc(emMod, basename, reader.sizeBytes, true);
                for (let offset = 0; offset < reader.sizeBytes;) {
                    const chunk = reader.readChunk(offset, chunkSize);
                    if (chunk.byteLength === 0)
                        break;
                    heapfsWrite(emMod, fileId, chunk, offset);
                    offset += chunk.byteLength;
                }
                loadFromPath(modelId, vfsPath, wasmLoadOptsJson(opts, { use_mmap: true }));
            };
            try {
                if (asyncReady) {
                    loadViaAsyncOpfs();
                    return;
                }
                const preferVfs = reader.sizeBytes >= LARGE_MODEL_BYTES || (opts === null || opts === void 0 ? void 0 : opts.preferVfsStreaming) === true;
                if (preferVfs) {
                    streamOpfsToVfs(false);
                    return;
                }
                if (loadFromPath) {
                    try {
                        tryHeapFSLoad();
                        return;
                    }
                    catch (heapErr) {
                        const reason = isStackOverflowError(heapErr)
                            ? 'HeapFS/mmap caused stack overflow'
                            : 'HeapFS load failed';
                        console.warn(`[llama-cpp] ${reason}; falling back to VFS streaming:`, heapErr);
                    }
                }
                streamOpfsToVfs(false);
            }
            finally {
                reader.close();
            }
        },
        unloadModel: async (modelId) => {
            const unloadModel = mod.unload_model;
            if (!unloadModel)
                throw new Error('Wasm module missing unload_model export');
            unloadModel(modelId);
        },
        generate: async (modelId, req, onToken) => {
            if (onToken && typeof mod.generate_stream === 'function') {
                const em = emscripten();
                // JSPI build: tokens delivered incrementally via EM_ASYNC_JS in C++.
                if (em === null || em === void 0 ? void 0 : em.__llamaWasmJspi) {
                    em.__llamaStreamOnToken = async (token, index) => {
                        onToken(token, index);
                    };
                    try {
                        const raw = mod.generate_stream(modelId, JSON.stringify(req !== null && req !== void 0 ? req : {}), () => { });
                        return safeJsonParse(raw, {
                            text: '',
                            tokens_predicted: 0,
                            tokens_evaluated: 0,
                            finish_reason: 'error',
                        });
                    }
                    finally {
                        em.__llamaStreamOnToken = undefined;
                    }
                }
                const raw = mod.generate_stream(modelId, JSON.stringify(req !== null && req !== void 0 ? req : {}), onToken);
                return safeJsonParse(raw, {
                    text: '',
                    tokens_predicted: 0,
                    tokens_evaluated: 0,
                    finish_reason: 'error',
                });
            }
            const generate = mod.generate;
            if (!generate)
                throw new Error('Wasm module missing generate export');
            const raw = generate(modelId, JSON.stringify(req !== null && req !== void 0 ? req : {}));
            return safeJsonParse(raw, {
                text: '',
                tokens_predicted: 0,
                tokens_evaluated: 0,
                finish_reason: 'error',
            });
        },
        embed: async (modelId, input) => {
            const embed = mod.embed;
            if (!embed)
                throw new Error('Wasm module missing embed export');
            const raw = embed(modelId, JSON.stringify({ input }));
            return safeJsonParse(raw, { vectors: [] });
        },
        tokenize: async (modelId, text) => {
            if (!mod.tokenize) {
                throw new Error('Wasm module missing tokenize export — rebuild with npm run build:wasm');
            }
            const raw = mod.tokenize(modelId, text);
            const parsed = safeJsonParse(raw, {});
            const tokens = Array.isArray(parsed['tokens'])
                ? parsed['tokens']
                : [];
            return { tokens, has_media: Boolean(parsed['has_media']) };
        },
        detokenize: async (modelId, tokens) => {
            var _a;
            if (!mod.detokenize) {
                throw new Error('Wasm module missing detokenize export — rebuild with npm run build:wasm');
            }
            const raw = mod.detokenize(modelId, JSON.stringify(tokens));
            const parsed = safeJsonParse(raw, {});
            return { text: (_a = parsed.text) !== null && _a !== void 0 ? _a : raw };
        },
        convertJsonSchemaToGrammar: async (schemaJson) => {
            if (!mod.convert_json_schema_to_grammar) {
                throw new Error('Wasm module missing convert_json_schema_to_grammar export — rebuild with npm run build:wasm');
            }
            return mod.convert_json_schema_to_grammar(schemaJson);
        },
        rerank: async (modelId, query, documents) => {
            if (!mod.rerank) {
                throw new Error('Wasm module missing rerank export — rebuild with npm run build:wasm');
            }
            const raw = mod.rerank(modelId, query, JSON.stringify(documents));
            const parsed = safeJsonParse(raw, []);
            if (!Array.isArray(parsed)) {
                throw new Error(typeof parsed === 'object' && parsed && 'error' in parsed
                    ? String(parsed.error)
                    : 'Invalid rerank response');
            }
            return parsed;
        },
        bench: async (modelId, pp, tg, pl, nr) => {
            if (!mod.bench) {
                throw new Error('Wasm module missing bench export — rebuild with npm run build:wasm');
            }
            return mod.bench(modelId, pp, tg, pl, nr);
        },
        saveSession: async (modelId, filepath, tokenSize) => {
            var _a;
            if (!mod.save_session) {
                throw new Error('Wasm module missing save_session export — rebuild with npm run build:wasm');
            }
            const raw = mod.save_session(modelId, filepath, tokenSize);
            const parsed = safeJsonParse(raw, {});
            if (parsed.error)
                throw new Error(parsed.error);
            return { tokens_saved: (_a = parsed.tokens_saved) !== null && _a !== void 0 ? _a : 0 };
        },
        loadSession: async (modelId, filepath) => {
            var _a, _b;
            if (!mod.load_session) {
                throw new Error('Wasm module missing load_session export — rebuild with npm run build:wasm');
            }
            const raw = mod.load_session(modelId, filepath);
            const parsed = safeJsonParse(raw, {});
            if (parsed.error)
                throw new Error(parsed.error);
            return {
                tokens_loaded: (_a = parsed.tokens_loaded) !== null && _a !== void 0 ? _a : 0,
                prompt: (_b = parsed.prompt) !== null && _b !== void 0 ? _b : '',
            };
        },
        applyLoraAdapters: async (modelId, loraAdapters) => {
            if (!mod.apply_lora_adapters) {
                throw new Error('Wasm module missing apply_lora_adapters export — rebuild with npm run build:wasm');
            }
            mod.apply_lora_adapters(modelId, JSON.stringify(loraAdapters));
        },
        removeLoraAdapters: async (modelId) => {
            if (!mod.remove_lora_adapters) {
                throw new Error('Wasm module missing remove_lora_adapters export — rebuild with npm run build:wasm');
            }
            mod.remove_lora_adapters(modelId);
        },
        getLoadedLoraAdapters: async (modelId) => {
            if (!mod.get_loaded_lora_adapters) {
                throw new Error('Wasm module missing get_loaded_lora_adapters export — rebuild with npm run build:wasm');
            }
            const raw = mod.get_loaded_lora_adapters(modelId);
            return safeJsonParse(raw, []);
        },
        initMultimodal: async (modelId, path, useGpu = false) => {
            if (!mod.init_multimodal) {
                throw new Error('Wasm module missing init_multimodal export — rebuild with npm run build:wasm');
            }
            const raw = mod.init_multimodal(modelId, path, useGpu);
            const parsed = safeJsonParse(raw, {});
            if (parsed.error)
                throw new Error(parsed.error);
            return !!parsed.ok;
        },
        multimodalStatus: async (modelId) => {
            if (!mod.multimodal_status) {
                throw new Error('Wasm module missing multimodal_status export — rebuild with npm run build:wasm');
            }
            const raw = mod.multimodal_status(modelId);
            return safeJsonParse(raw, {
                enabled: false,
                vision: false,
                audio: false,
            });
        },
        releaseMultimodal: async (modelId) => {
            var _a;
            (_a = mod.release_multimodal) === null || _a === void 0 ? void 0 : _a.call(mod, modelId);
        },
        initVocoder: async (modelId, path, nBatch = 512) => {
            if (!mod.init_vocoder) {
                throw new Error('Wasm module missing init_vocoder export — rebuild with npm run build:wasm');
            }
            const raw = mod.init_vocoder(modelId, path, nBatch);
            const parsed = safeJsonParse(raw, {});
            if (parsed.error)
                throw new Error(parsed.error);
            return !!parsed.ok;
        },
        vocoderEnabled: async (modelId) => {
            if (!mod.vocoder_enabled) {
                return false;
            }
            const raw = mod.vocoder_enabled(modelId);
            const parsed = safeJsonParse(raw, {});
            return !!parsed.enabled;
        },
        releaseVocoder: async (modelId) => {
            var _a;
            (_a = mod.release_vocoder) === null || _a === void 0 ? void 0 : _a.call(mod, modelId);
        },
        formattedAudioCompletion: async (modelId, speakerJson, textToSpeak) => {
            var _a;
            if (!mod.formatted_audio_completion) {
                throw new Error('Wasm module missing formatted_audio_completion export — rebuild with npm run build:wasm');
            }
            const raw = mod.formatted_audio_completion(modelId, speakerJson, textToSpeak);
            const parsed = safeJsonParse(raw, {});
            if (parsed.error)
                throw new Error(parsed.error);
            return { prompt: (_a = parsed.prompt) !== null && _a !== void 0 ? _a : '', grammar: parsed.grammar };
        },
        audioGuideTokens: async (modelId, textToSpeak) => {
            if (!mod.audio_guide_tokens) {
                throw new Error('Wasm module missing audio_guide_tokens export — rebuild with npm run build:wasm');
            }
            const raw = mod.audio_guide_tokens(modelId, textToSpeak);
            const parsed = safeJsonParse(raw, []);
            if (!Array.isArray(parsed)) {
                throw new Error(typeof parsed === 'object' && parsed && 'error' in parsed
                    ? String(parsed.error)
                    : 'Invalid audio guide tokens response');
            }
            return parsed;
        },
        decodeAudioTokens: async (modelId, tokens) => {
            if (!mod.decode_audio_tokens) {
                throw new Error('Wasm module missing decode_audio_tokens export — rebuild with npm run build:wasm');
            }
            const raw = mod.decode_audio_tokens(modelId, JSON.stringify(tokens));
            const parsed = safeJsonParse(raw, []);
            if (!Array.isArray(parsed)) {
                throw new Error(typeof parsed === 'object' && parsed && 'error' in parsed
                    ? String(parsed.error)
                    : 'Invalid decode audio response');
            }
            return parsed;
        },
        health: async () => {
            var _a, _b, _c, _d, _e;
            const base = mod.health
                ? safeJsonParse(mod.health(), {})
                : {};
            const em = emscripten();
            return Object.assign(Object.assign(Object.assign({}, base), wasmMemoryDiagnostics(em)), { wasmJspi: (_a = em === null || em === void 0 ? void 0 : em.__llamaWasmJspi) !== null && _a !== void 0 ? _a : false, wasmAsyncFile: (_d = (_b = em === null || em === void 0 ? void 0 : em.__llamaWasmAsyncFile) !== null && _b !== void 0 ? _b : (_c = mod.can_use_async_file) === null || _c === void 0 ? void 0 : _c.call(mod)) !== null && _d !== void 0 ? _d : false, wasmPthread: (_e = em === null || em === void 0 ? void 0 : em.__llamaWasmPthread) !== null && _e !== void 0 ? _e : false });
        },
        memory: async () => {
            const em = emscripten();
            return Object.assign({ pressure: 'unknown' }, wasmMemoryDiagnostics(em));
        },
    };
};
//# sourceMappingURL=wasm.engine.js.map