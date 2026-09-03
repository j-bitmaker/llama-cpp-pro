// src/workers/async-file.ts
var canUseAsyncFileRead = (wasmJspiBuild = false) => wasmJspiBuild;
var asyncReaderFromBytes = (bytes) => ({
  sizeBytes: bytes.byteLength,
  readChunk: (offset, length) => bytes.subarray(offset, Math.min(offset + length, bytes.byteLength))
});

// src/workers/heapfs.ts
var fsNameToFile = {};
var fsIdToFile = {};
var currFileId = 0;
var patched = false;
var getHeapU8 = (mod) => {
  const buf = mod.wasmMemory?.buffer ?? mod.HEAPU8?.buffer;
  if (!buf) throw new Error("HeapFS requires WASM linear memory");
  return new Uint8Array(buf);
};
var patchStream = (mod, stream) => {
  const name = stream.node.name;
  const f = fsNameToFile[name];
  if (!f) return;
  const heap = getHeapU8(mod);
  const ptr = Number(f.ptr);
  stream.node.contents = heap.subarray(ptr, ptr + f.size);
  stream.node.usedBytes = f.size;
};
var patchHeapFS = (mod) => {
  if (patched) return;
  patched = true;
  const ops = mod.MEMFS.stream_ops;
  ops._read = ops._read ?? ops.read;
  ops._write = ops._write ?? ops.write;
  ops._llseek = ops._llseek ?? ops.llseek;
  ops._allocate = ops._allocate ?? ops.allocate;
  ops._mmap = ops._mmap ?? ops.mmap;
  ops._msync = ops._msync ?? ops.msync;
  ops.read = function(stream, ...rest) {
    patchStream(mod, stream);
    return ops._read.call(this, stream, ...rest);
  };
  mod.MEMFS.ops_table.file.stream.read = ops.read;
  ops.llseek = function(stream, ...rest) {
    patchStream(mod, stream);
    return ops._llseek.call(this, stream, ...rest);
  };
  mod.MEMFS.ops_table.file.stream.llseek = ops.llseek;
  ops.mmap = function(stream, length, position, prot, flags) {
    patchStream(mod, stream);
    const name = stream.node.name;
    const f = fsNameToFile[name];
    if (f) {
      return { ptr: Number(f.ptr) + Number(position), allocated: false };
    }
    return ops._mmap.call(this, stream, length, position, prot, flags);
  };
  mod.MEMFS.ops_table.file.stream.mmap = ops.mmap;
  mod.FS.mkdir("/models");
  mod.FS.mount(mod.MEMFS, { root: "." }, "/models");
};
var ensureWasmTmpDir = (mod) => {
  const fs = mod.FS;
  if (fs.analyzePath("/tmp").exists) return;
  try {
    if (typeof fs.createPath === "function") {
      fs.createPath("/", "tmp", true, true);
    } else {
      fs.mkdir("/tmp");
    }
  } catch {
    if (!fs.analyzePath("/tmp").exists) {
      throw new Error("Failed to create MEMFS /tmp for model VFS streaming");
    }
  }
};
var heapfsAlloc = (mod, name, size, allocBuffer = true) => {
  if (size < 1) throw new Error("HeapFS file size must be > 0");
  const ptr = allocBuffer ? Number(mod.mmapAlloc(size)) : 0;
  const file = { ptr, size, id: currFileId++ };
  fsIdToFile[file.id] = file;
  fsNameToFile[name] = file;
  return file.id;
};
var heapfsWrite = (mod, id, buffer, offset) => {
  const f = fsIdToFile[id];
  if (!f) throw new Error(`HeapFS file id ${id} not found`);
  const after = offset + buffer.byteLength;
  if (after > f.size) {
    throw new Error(`HeapFS write out of bounds: ${after} > ${f.size}`);
  }
  getHeapU8(mod).set(buffer, Number(f.ptr) + offset);
  return buffer.byteLength;
};
var heapfsModelPath = (basename) => `/models/${basename}`;
var supportsHeapFS = (mod) => !!mod && typeof mod.mmapAlloc === "function" && typeof mod.MEMFS === "object" && typeof mod.FS === "object";

// src/workers/wasm.engine.ts
var safeJsonParse = (raw, fallback) => {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
};
var LARGE_MODEL_BYTES = 500 * 1024 * 1024;
var wasmLoadOptsJson = (opts, overrides) => JSON.stringify({ use_mmap: false, ...opts ?? {}, ...overrides });
var wasmAsyncLoadOptsJson = (opts, overrides) => JSON.stringify({ use_mmap: false, ...opts ?? {}, ...overrides });
var loadViaAsyncFile = (mod, modelId, sizeBytes, readChunk, opts) => {
  const begin = mod.model_vfs_begin;
  const bind = mod.async_model_bind;
  const finish = mod.load_model_from_vfs;
  const abort = mod.model_vfs_abort;
  if (!begin || !bind || !finish) {
    throw new Error("Wasm module missing JSPI async file exports \u2014 rebuild with: npm run build:wasm:jspi");
  }
  const optsJson = wasmAsyncLoadOptsJson(opts);
  const vfsPath = begin(sizeBytes, optsJson);
  if (!vfsPath) throw new Error("model_vfs_begin returned empty path");
  try {
    bind(vfsPath, sizeBytes, (offset, length) => readChunk(offset, length));
    finish(modelId, vfsPath, optsJson);
  } catch (err) {
    abort?.(vfsPath);
    throw err;
  }
};
var isStackOverflowError = (err) => {
  const msg = err instanceof Error ? err.message : String(err);
  return /maximum call stack size exceeded/i.test(msg);
};
var wasmMemoryDiagnostics = (em) => {
  if (!em) {
    return { wasmMemoryAccessible: false };
  }
  const wasmMem = em.wasmMemory;
  const buffer = wasmMem?.buffer ?? em.HEAPU8?.buffer;
  if (!buffer) {
    return { wasmMemoryAccessible: false };
  }
  return {
    wasmMemoryAccessible: true,
    wasmLinearBytes: buffer.byteLength,
    wasmLinearMb: +(buffer.byteLength / 1024 / 1024).toFixed(1),
    wasmMemoryShared: wasmMem?.buffer instanceof SharedArrayBuffer
  };
};
var resolveModuleCandidates = () => {
  const candidates = [];
  const g = globalThis;
  for (const key of ["__LLAMA_WASM_MODULE_URL__", "__LLAMA_ENGINE_URL__"]) {
    const customUrl = g?.[key];
    if (typeof customUrl === "string" && customUrl.length > 0) {
      candidates.push(customUrl);
    }
  }
  try {
    const base = new URL("../../wasm/llama_engine.js", import.meta.url).href;
    candidates.push(base);
    candidates.push(new URL("../../dist/wasm/llama_engine.js", import.meta.url).href);
  } catch {
  }
  const origin = g?.location?.origin ?? "";
  if (origin) {
    candidates.push(`${origin}/llama-cpp/wasm/llama_engine.js`);
    candidates.push(`${origin}/dist/wasm/llama_engine.js`);
    candidates.push(`${origin}/wasm/llama_engine.js`);
  }
  return [...new Set(candidates)];
};
var loadWasmModule = async () => {
  let lastError;
  for (const url of resolveModuleCandidates()) {
    try {
      const mod = await import(
        /* @vite-ignore */
        url
      );
      if (mod && typeof mod.default === "function") {
        await mod.default();
      }
      if (typeof mod.load_model === "function" && typeof mod.generate === "function" && typeof mod.embed === "function") {
        return mod;
      }
      lastError = new Error(`Module loaded but missing required exports at ${url}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `Unable to load wasm wrapper module (llama_engine.js). Set window.__LLAMA_WASM_MODULE_URL__ to llama_engine.js. Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`
  );
};
var loadLlamaWasmEngine = async () => {
  const mod = await loadWasmModule();
  const emscripten = () => mod.getEmscriptenModule?.() ?? null;
  const ensureHeapFS = () => {
    const em = emscripten();
    if (!em || !supportsHeapFS(em)) {
      throw new Error("Wasm build missing HeapFS runtime (mmapAlloc/MEMFS/FS) \u2014 rebuild with npm run build:wasm");
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
      (mod.init_engine ?? mod.init)?.();
      const em = emscripten();
      if (em && supportsHeapFS(em)) {
        patchHeapFS(em);
        ensureWasmTmpDir(em);
      }
    },
    loadModel: async (modelId, modelBuffer, opts) => {
      const bytes = new Uint8Array(modelBuffer);
      const em = emscripten();
      const asyncReady = typeof mod.can_use_async_file === "function" ? mod.can_use_async_file() : canUseAsyncFileRead(em?.__llamaWasmJspi ?? false);
      if (asyncReady) {
        const reader = asyncReaderFromBytes(bytes);
        loadViaAsyncFile(mod, modelId, reader.sizeBytes, reader.readChunk, opts);
        return;
      }
      const begin = mod.model_vfs_begin;
      const write = mod.model_vfs_write;
      const finish = mod.load_model_from_vfs;
      const abort = mod.model_vfs_abort;
      if (begin && write && finish) {
        ensureVfsReady();
        const optsJson = wasmLoadOptsJson(opts);
        const vfsPath = begin(bytes.length, optsJson);
        if (!vfsPath) throw new Error("model_vfs_begin returned empty path");
        try {
          const CHUNK = 32 * 1024 * 1024;
          for (let offset = 0; offset < bytes.length; offset += CHUNK) {
            write(vfsPath, bytes.subarray(offset, offset + CHUNK));
          }
          finish(modelId, vfsPath, optsJson);
        } catch (err) {
          abort?.(vfsPath);
          throw err;
        }
        return;
      }
      const loadModelFn = mod.load_model;
      if (!loadModelFn) throw new Error("Wasm module missing load_model export");
      loadModelFn(modelId, bytes, JSON.stringify(opts ?? {}));
    },
    loadModelFromOpfsReader: async (modelId, reader, opts) => {
      const loadFromPath = mod.load_model_from_path;
      const begin = mod.model_vfs_begin;
      const write = mod.model_vfs_write;
      const finish = mod.load_model_from_vfs;
      const abort = mod.model_vfs_abort;
      const chunkSize = 4 * 1024 * 1024;
      const em = emscripten();
      const asyncReady = typeof mod.can_use_async_file === "function" ? mod.can_use_async_file() : canUseAsyncFileRead(em?.__llamaWasmJspi ?? false);
      const loadViaAsyncOpfs = () => {
        loadViaAsyncFile(
          mod,
          modelId,
          reader.sizeBytes,
          (offset, length) => reader.readChunk(offset, length),
          opts
        );
      };
      const streamOpfsToVfs = (useMmap) => {
        if (!begin || !write || !finish) {
          throw new Error("Wasm module missing OPFS streaming exports (model_vfs_* / load_model_from_path)");
        }
        ensureVfsReady();
        const vfsPath = begin(reader.sizeBytes, wasmLoadOptsJson(opts, { use_mmap: useMmap }));
        if (!vfsPath) {
          throw new Error("model_vfs_begin returned empty path");
        }
        const optsJson = wasmLoadOptsJson(opts, { use_mmap: useMmap });
        try {
          for (let offset = 0; offset < reader.sizeBytes; ) {
            const chunk = reader.readChunk(offset, chunkSize);
            if (chunk.byteLength === 0) {
              break;
            }
            write(vfsPath, chunk);
            offset += chunk.byteLength;
          }
          finish(modelId, vfsPath, optsJson);
        } catch (error) {
          abort?.(vfsPath);
          throw error;
        }
      };
      const tryHeapFSLoad = () => {
        if (!loadFromPath) {
          throw new Error("Wasm module missing load_model_from_path");
        }
        const emMod = ensureHeapFS();
        const basename = `${modelId.replace(/[^\w.-]/g, "_")}.gguf`;
        const vfsPath = heapfsModelPath(basename);
        emMod.FS.createDataFile("/models", basename, new ArrayBuffer(0), true, true, true);
        const fileId = heapfsAlloc(emMod, basename, reader.sizeBytes, true);
        for (let offset = 0; offset < reader.sizeBytes; ) {
          const chunk = reader.readChunk(offset, chunkSize);
          if (chunk.byteLength === 0) break;
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
        const preferVfs = reader.sizeBytes >= LARGE_MODEL_BYTES || opts?.preferVfsStreaming === true;
        if (preferVfs) {
          streamOpfsToVfs(false);
          return;
        }
        if (loadFromPath) {
          try {
            tryHeapFSLoad();
            return;
          } catch (heapErr) {
            const reason = isStackOverflowError(heapErr) ? "HeapFS/mmap caused stack overflow" : "HeapFS load failed";
            console.warn(`[llama-cpp] ${reason}; falling back to VFS streaming:`, heapErr);
          }
        }
        streamOpfsToVfs(false);
      } finally {
        reader.close();
      }
    },
    unloadModel: async (modelId) => {
      const unloadModel = mod.unload_model;
      if (!unloadModel) throw new Error("Wasm module missing unload_model export");
      unloadModel(modelId);
    },
    generate: async (modelId, req, onToken) => {
      if (onToken && typeof mod.generate_stream === "function") {
        const em = emscripten();
        if (em?.__llamaWasmJspi) {
          em.__llamaStreamOnToken = async (token, index) => {
            onToken(token, index);
          };
          try {
            const raw3 = mod.generate_stream(modelId, JSON.stringify(req ?? {}), () => {
            });
            return safeJsonParse(raw3, {
              text: "",
              tokens_predicted: 0,
              tokens_evaluated: 0,
              finish_reason: "error"
            });
          } finally {
            em.__llamaStreamOnToken = void 0;
          }
        }
        const raw2 = mod.generate_stream(modelId, JSON.stringify(req ?? {}), onToken);
        return safeJsonParse(raw2, {
          text: "",
          tokens_predicted: 0,
          tokens_evaluated: 0,
          finish_reason: "error"
        });
      }
      const generate = mod.generate;
      if (!generate) throw new Error("Wasm module missing generate export");
      const raw = generate(modelId, JSON.stringify(req ?? {}));
      return safeJsonParse(raw, {
        text: "",
        tokens_predicted: 0,
        tokens_evaluated: 0,
        finish_reason: "error"
      });
    },
    embed: async (modelId, input) => {
      const embed = mod.embed;
      if (!embed) throw new Error("Wasm module missing embed export");
      const raw = embed(modelId, JSON.stringify({ input }));
      return safeJsonParse(raw, { vectors: [] });
    },
    tokenize: async (modelId, text) => {
      if (!mod.tokenize) {
        throw new Error("Wasm module missing tokenize export \u2014 rebuild with npm run build:wasm");
      }
      const raw = mod.tokenize(modelId, text);
      const parsed = safeJsonParse(raw, {});
      const tokens = Array.isArray(parsed["tokens"]) ? parsed["tokens"] : [];
      return { tokens, has_media: Boolean(parsed["has_media"]) };
    },
    detokenize: async (modelId, tokens) => {
      if (!mod.detokenize) {
        throw new Error("Wasm module missing detokenize export \u2014 rebuild with npm run build:wasm");
      }
      const raw = mod.detokenize(modelId, JSON.stringify(tokens));
      const parsed = safeJsonParse(raw, {});
      return { text: parsed.text ?? raw };
    },
    convertJsonSchemaToGrammar: async (schemaJson) => {
      if (!mod.convert_json_schema_to_grammar) {
        throw new Error("Wasm module missing convert_json_schema_to_grammar export \u2014 rebuild with npm run build:wasm");
      }
      return mod.convert_json_schema_to_grammar(schemaJson);
    },
    rerank: async (modelId, query, documents) => {
      if (!mod.rerank) {
        throw new Error("Wasm module missing rerank export \u2014 rebuild with npm run build:wasm");
      }
      const raw = mod.rerank(modelId, query, JSON.stringify(documents));
      const parsed = safeJsonParse(raw, []);
      if (!Array.isArray(parsed)) {
        throw new Error(typeof parsed === "object" && parsed && "error" in parsed ? String(parsed.error) : "Invalid rerank response");
      }
      return parsed;
    },
    bench: async (modelId, pp, tg, pl, nr) => {
      if (!mod.bench) {
        throw new Error("Wasm module missing bench export \u2014 rebuild with npm run build:wasm");
      }
      return mod.bench(modelId, pp, tg, pl, nr);
    },
    saveSession: async (modelId, filepath, tokenSize) => {
      if (!mod.save_session) {
        throw new Error("Wasm module missing save_session export \u2014 rebuild with npm run build:wasm");
      }
      const raw = mod.save_session(modelId, filepath, tokenSize);
      const parsed = safeJsonParse(raw, {});
      if (parsed.error) throw new Error(parsed.error);
      return { tokens_saved: parsed.tokens_saved ?? 0 };
    },
    loadSession: async (modelId, filepath) => {
      if (!mod.load_session) {
        throw new Error("Wasm module missing load_session export \u2014 rebuild with npm run build:wasm");
      }
      const raw = mod.load_session(modelId, filepath);
      const parsed = safeJsonParse(raw, {});
      if (parsed.error) throw new Error(parsed.error);
      return {
        tokens_loaded: parsed.tokens_loaded ?? 0,
        prompt: parsed.prompt ?? ""
      };
    },
    applyLoraAdapters: async (modelId, loraAdapters) => {
      if (!mod.apply_lora_adapters) {
        throw new Error("Wasm module missing apply_lora_adapters export \u2014 rebuild with npm run build:wasm");
      }
      mod.apply_lora_adapters(modelId, JSON.stringify(loraAdapters));
    },
    removeLoraAdapters: async (modelId) => {
      if (!mod.remove_lora_adapters) {
        throw new Error("Wasm module missing remove_lora_adapters export \u2014 rebuild with npm run build:wasm");
      }
      mod.remove_lora_adapters(modelId);
    },
    getLoadedLoraAdapters: async (modelId) => {
      if (!mod.get_loaded_lora_adapters) {
        throw new Error("Wasm module missing get_loaded_lora_adapters export \u2014 rebuild with npm run build:wasm");
      }
      const raw = mod.get_loaded_lora_adapters(modelId);
      return safeJsonParse(raw, []);
    },
    initMultimodal: async (modelId, path, useGpu = false) => {
      if (!mod.init_multimodal) {
        throw new Error("Wasm module missing init_multimodal export \u2014 rebuild with npm run build:wasm");
      }
      const raw = mod.init_multimodal(modelId, path, useGpu);
      const parsed = safeJsonParse(raw, {});
      if (parsed.error) throw new Error(parsed.error);
      return !!parsed.ok;
    },
    multimodalStatus: async (modelId) => {
      if (!mod.multimodal_status) {
        throw new Error("Wasm module missing multimodal_status export \u2014 rebuild with npm run build:wasm");
      }
      const raw = mod.multimodal_status(modelId);
      return safeJsonParse(raw, {
        enabled: false,
        vision: false,
        audio: false
      });
    },
    releaseMultimodal: async (modelId) => {
      mod.release_multimodal?.(modelId);
    },
    initVocoder: async (modelId, path, nBatch = 512) => {
      if (!mod.init_vocoder) {
        throw new Error("Wasm module missing init_vocoder export \u2014 rebuild with npm run build:wasm");
      }
      const raw = mod.init_vocoder(modelId, path, nBatch);
      const parsed = safeJsonParse(raw, {});
      if (parsed.error) throw new Error(parsed.error);
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
      mod.release_vocoder?.(modelId);
    },
    formattedAudioCompletion: async (modelId, speakerJson, textToSpeak) => {
      if (!mod.formatted_audio_completion) {
        throw new Error("Wasm module missing formatted_audio_completion export \u2014 rebuild with npm run build:wasm");
      }
      const raw = mod.formatted_audio_completion(modelId, speakerJson, textToSpeak);
      const parsed = safeJsonParse(raw, {});
      if (parsed.error) throw new Error(parsed.error);
      return { prompt: parsed.prompt ?? "", grammar: parsed.grammar };
    },
    audioGuideTokens: async (modelId, textToSpeak) => {
      if (!mod.audio_guide_tokens) {
        throw new Error("Wasm module missing audio_guide_tokens export \u2014 rebuild with npm run build:wasm");
      }
      const raw = mod.audio_guide_tokens(modelId, textToSpeak);
      const parsed = safeJsonParse(raw, []);
      if (!Array.isArray(parsed)) {
        throw new Error(typeof parsed === "object" && parsed && "error" in parsed ? String(parsed.error) : "Invalid audio guide tokens response");
      }
      return parsed;
    },
    decodeAudioTokens: async (modelId, tokens) => {
      if (!mod.decode_audio_tokens) {
        throw new Error("Wasm module missing decode_audio_tokens export \u2014 rebuild with npm run build:wasm");
      }
      const raw = mod.decode_audio_tokens(modelId, JSON.stringify(tokens));
      const parsed = safeJsonParse(raw, []);
      if (!Array.isArray(parsed)) {
        throw new Error(typeof parsed === "object" && parsed && "error" in parsed ? String(parsed.error) : "Invalid decode audio response");
      }
      return parsed;
    },
    health: async () => {
      const base = mod.health ? safeJsonParse(mod.health(), {}) : {};
      const em = emscripten();
      return {
        ...base,
        ...wasmMemoryDiagnostics(em),
        wasmJspi: em?.__llamaWasmJspi ?? false,
        wasmAsyncFile: em?.__llamaWasmAsyncFile ?? mod.can_use_async_file?.() ?? false,
        wasmPthread: em?.__llamaWasmPthread ?? false
      };
    },
    memory: async () => {
      const em = emscripten();
      return { pressure: "unknown", ...wasmMemoryDiagnostics(em) };
    }
  };
};

// src/isomorphic/errors.ts
var LlmError = class extends Error {
  constructor(code, message, meta) {
    super(message);
    this.name = "LlmError";
    this.code = code;
    this.meta = meta;
  }
};

// src/storage/manifest.ts
var MANIFEST_FILE = ".llm-manifest.json";
var getStorageApi = () => {
  const storageApi = globalThis?.navigator?.storage;
  if (!storageApi || typeof storageApi.getDirectory !== "function") {
    throw new LlmError(
      "STORAGE_UNAVAILABLE",
      "OPFS is not available in this runtime. navigator.storage.getDirectory is missing."
    );
  }
  return storageApi;
};
var getRootDirectory = async () => {
  const storageApi = getStorageApi();
  try {
    return await storageApi.getDirectory();
  } catch (error) {
    throw new LlmError("STORAGE_IO_FAILED", "Failed to access OPFS root directory.", {
      cause: String(error)
    });
  }
};
var readTextFile = async (fileHandle) => {
  const file = await fileHandle.getFile();
  return file.text();
};
var writeTextFile = async (fileHandle, content) => {
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(content);
  } finally {
    await writable.close();
  }
};
async function loadManifestInternal() {
  const root = await getRootDirectory();
  try {
    const handle = await root.getFileHandle(MANIFEST_FILE, { create: true });
    const content = await readTextFile(handle);
    if (!content.trim()) {
      return {};
    }
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed;
  } catch (error) {
    throw new LlmError("STORAGE_IO_FAILED", "Failed to read OPFS manifest.", {
      cause: String(error)
    });
  }
}
async function saveManifestInternal(manifest) {
  const root = await getRootDirectory();
  try {
    const handle = await root.getFileHandle(MANIFEST_FILE, { create: true });
    await writeTextFile(handle, JSON.stringify(manifest, null, 2));
  } catch (error) {
    throw new LlmError("STORAGE_IO_FAILED", "Failed to write OPFS manifest.", {
      cause: String(error)
    });
  }
}
async function getManifestEntry(modelId) {
  const manifest = await loadManifestInternal();
  return manifest[modelId];
}
async function upsertManifestEntry(entry) {
  const manifest = await loadManifestInternal();
  manifest[entry.modelId] = entry;
  await saveManifestInternal(manifest);
}

// src/storage/opfs.store.ts
var getStorageApi2 = () => {
  const storageApi = globalThis?.navigator?.storage;
  if (!storageApi || typeof storageApi.getDirectory !== "function") {
    throw new LlmError(
      "STORAGE_UNAVAILABLE",
      "OPFS is not available in this runtime. navigator.storage.getDirectory is missing."
    );
  }
  return storageApi;
};
var getRootDirectory2 = async () => {
  const storageApi = getStorageApi2();
  try {
    return await storageApi.getDirectory();
  } catch (error) {
    throw new LlmError("STORAGE_IO_FAILED", "Failed to access OPFS root directory.", {
      cause: String(error)
    });
  }
};
var ensureParentDirAndFileHandle = async (path, create = true) => {
  const root = await getRootDirectory2();
  const parts = path.split("/").filter(Boolean);
  const fileName = parts.pop();
  if (!fileName) {
    throw new LlmError("STORAGE_IO_FAILED", `Invalid OPFS path '${path}'.`);
  }
  let current = root;
  for (const dir of parts) {
    current = await current.getDirectoryHandle(dir, { create: true });
  }
  return current.getFileHandle(fileName, { create });
};
var OPFS_MODEL_CHUNK_BYTES = 4 * 1024 * 1024;
async function openOpfsModelSyncReader(modelId) {
  const entry = await getManifestEntry(modelId);
  if (!entry) {
    throw new LlmError("MODEL_NOT_LOADED", `Model '${modelId}' is not present in OPFS manifest.`);
  }
  const fileHandle = await ensureParentDirAndFileHandle(entry.path, false);
  if (typeof fileHandle.createSyncAccessHandle !== "function") {
    throw new LlmError(
      "STORAGE_UNAVAILABLE",
      "OPFS sync access handles are not available in this browser/worker context.",
      { modelId }
    );
  }
  let accessHandle;
  try {
    accessHandle = await fileHandle.createSyncAccessHandle();
  } catch (error) {
    throw new LlmError("STORAGE_IO_FAILED", `Failed to open OPFS sync handle for '${modelId}'.`, {
      modelId,
      path: entry.path,
      cause: String(error)
    });
  }
  const sizeBytes = accessHandle.getSize();
  await upsertManifestEntry({ ...entry, lastUsedAt: Date.now() });
  return {
    sizeBytes,
    readChunk(offset, length = OPFS_MODEL_CHUNK_BYTES) {
      const toRead = Math.min(length, sizeBytes - offset);
      if (toRead <= 0) {
        return new Uint8Array(0);
      }
      const buf = new Uint8Array(toRead);
      const bytesRead = accessHandle.read(buf, { at: offset });
      return buf.subarray(0, bytesRead);
    },
    close() {
      accessHandle.close();
    }
  };
}
async function readModelBufferFromOpfs(modelId) {
  const file = await readModelFromOpfs(modelId);
  const buffer = await file.arrayBuffer();
  return { buffer, sizeBytes: file.size };
}
async function readModelFromOpfs(modelId) {
  const entry = await getManifestEntry(modelId);
  if (!entry) {
    throw new LlmError("MODEL_NOT_LOADED", `Model '${modelId}' is not present in OPFS manifest.`);
  }
  try {
    const fileHandle = await ensureParentDirAndFileHandle(entry.path, false);
    const file = await fileHandle.getFile();
    await upsertManifestEntry({ ...entry, lastUsedAt: Date.now() });
    return file;
  } catch (error) {
    throw new LlmError("STORAGE_IO_FAILED", `Failed to read model '${modelId}' from OPFS.`, {
      modelId,
      path: entry.path,
      cause: String(error)
    });
  }
}

// src/isomorphic/wasmMemoryCalibration.ts
var WARM_HEAP_BYTES = 64 * 1024 * 1024;

// src/isomorphic/wasmMemoryPolicy.ts
var WASM_MAX_CONCURRENT_MODELS = 5;
var WASM_POOL_RESERVE_BYTES = 64 * 1024 * 1024;

// src/workers/llm.worker.ts
var state = {
  initialized: false,
  wasmEngineContextInitialized: false,
  loadedModels: /* @__PURE__ */ new Set(),
  modelLoadOutcomes: /* @__PURE__ */ new Map(),
  modelLoadFailureReasons: /* @__PURE__ */ new Map(),
  modelLoadInflight: /* @__PURE__ */ new Map(),
  engine: null
};
var isModelReadyInWorker = (modelId) => state.wasmEngineContextInitialized && state.engine != null && state.loadedModels.has(modelId);
var clearModelLoadMemo = (modelId) => {
  state.loadedModels.delete(modelId);
  state.modelLoadOutcomes.delete(modelId);
  state.modelLoadFailureReasons.delete(modelId);
  state.modelLoadInflight.delete(modelId);
};
var postEvent = (evt) => {
  self.postMessage(evt);
};
var postError = (id, code, message, meta) => {
  postEvent({ id, type: "ERROR", code, message, meta });
};
var ensureEngine = () => {
  if (!state.engine) {
    throw new Error("WASM engine is not initialized. Send INIT first.");
  }
  return state.engine;
};
var tryLoadEngine = async () => {
  const engine = await loadLlamaWasmEngine();
  if (!engine || typeof engine.loadModel !== "function" || typeof engine.generate !== "function" || typeof engine.embed !== "function") {
    throw new Error("Loaded wasm engine does not expose required methods.");
  }
  return engine;
};
var loadModelFromOpfs = async (engine, modelId, opts) => {
  if (typeof engine.loadModelFromOpfsReader !== "function") {
    throw new Error(
      "WASM module is missing OPFS streaming exports (model_vfs_*). Rebuild with: npm run build:wasm"
    );
  }
  try {
    const reader = await openOpfsModelSyncReader(modelId);
    await engine.loadModelFromOpfsReader(modelId, reader, opts);
    return;
  } catch (error) {
    const code = error?.code;
    const message = error instanceof Error ? error.message : String(error);
    const syncUnavailable = code === "STORAGE_UNAVAILABLE" || /sync access handle/i.test(message);
    if (!syncUnavailable) {
      throw error;
    }
  }
  console.warn(
    `[llama-cpp] OPFS sync access handle unavailable for '${modelId}'; falling back to full-buffer load (not suitable for models >2GB).`
  );
  const { buffer, sizeBytes } = await readModelBufferFromOpfs(modelId);
  await engine.loadModel(modelId, buffer, { ...opts ?? {}, modelBytes: sizeBytes });
};
self.onmessage = async (evt) => {
  const req = evt.data;
  try {
    switch (req.type) {
      case "INIT": {
        if (!state.initialized) {
          state.engine = await tryLoadEngine();
          await state.engine.init?.();
          state.initialized = true;
          state.wasmEngineContextInitialized = true;
        }
        postEvent({
          id: req.id,
          type: "RESULT",
          payload: { ok: true, initialized: state.initialized }
        });
        return;
      }
      case "LOAD_MODEL": {
        if (!state.initialized) {
          postError(req.id, "WASM_INIT_FAILED", "Worker is not initialized. Send INIT first.");
          return;
        }
        const requestModelId = req.modelId;
        if (isModelReadyInWorker(requestModelId)) {
          postEvent({
            id: req.id,
            type: "RESULT",
            payload: { ok: true, modelId: requestModelId, alreadyLoaded: true, ready: true }
          });
          return;
        }
        const cachedFailure = state.modelLoadFailureReasons.get(requestModelId);
        if (state.modelLoadOutcomes.get(requestModelId) === "failed" && cachedFailure) {
          postError(req.id, "INSUFFICIENT_MEMORY", cachedFailure, {
            modelId: requestModelId,
            cachedFailure: true
          });
          return;
        }
        let inflight = state.modelLoadInflight.get(requestModelId);
        if (!inflight) {
          const engine = ensureEngine();
          inflight = (async () => {
            try {
              await loadModelFromOpfs(engine, requestModelId, req.opts);
              state.loadedModels.add(requestModelId);
              state.modelLoadOutcomes.set(requestModelId, "loaded");
              state.modelLoadFailureReasons.delete(requestModelId);
            } catch (readErr) {
              const reason = readErr instanceof Error ? readErr.message : String(readErr);
              state.modelLoadOutcomes.set(requestModelId, "failed");
              state.modelLoadFailureReasons.set(requestModelId, reason);
              throw readErr;
            }
          })().finally(() => {
            state.modelLoadInflight.delete(requestModelId);
          });
          state.modelLoadInflight.set(requestModelId, inflight);
        }
        try {
          await inflight;
          let measuredFootprintBytes;
          let wasmLinearBytes;
          try {
            const engine = ensureEngine();
            const mem = engine ? await engine.memory?.() : void 0;
            if (mem && typeof mem.wasmLinearBytes === "number") {
              wasmLinearBytes = mem.wasmLinearBytes;
            }
            if (Array.isArray(mem?.loadedModels)) {
              const row = mem.loadedModels.find(
                (m) => m?.modelId === requestModelId
              );
              if (row && typeof row.measuredFootprintBytes === "number" && row.measuredFootprintBytes > 0) {
                measuredFootprintBytes = row.measuredFootprintBytes;
              }
            }
          } catch {
          }
          postEvent({
            id: req.id,
            type: "RESULT",
            payload: {
              ok: true,
              modelId: requestModelId,
              ready: true,
              wasmLinearBytes,
              measuredFootprintBytes
            }
          });
        } catch (readErr) {
          const reason = state.modelLoadFailureReasons.get(requestModelId) ?? (readErr instanceof Error ? readErr.message : String(readErr));
          postError(
            req.id,
            "STORAGE_IO_FAILED",
            `Failed to read model '${requestModelId}' from OPFS in worker: ${reason}`,
            { modelId: requestModelId, cachedFailure: true }
          );
        }
        return;
      }
      case "UNLOAD_MODEL": {
        if (!state.loadedModels.has(req.modelId)) {
          clearModelLoadMemo(req.modelId);
          postEvent({
            id: req.id,
            type: "RESULT",
            payload: { ok: true, modelId: req.modelId, alreadyUnloaded: true }
          });
          return;
        }
        const engine = ensureEngine();
        await engine.unloadModel(req.modelId);
        clearModelLoadMemo(req.modelId);
        postEvent({
          id: req.id,
          type: "RESULT",
          payload: { ok: true, modelId: req.modelId }
        });
        return;
      }
      case "GENERATE": {
        if (!state.loadedModels.has(req.modelId)) {
          postError(req.id, "MODEL_NOT_LOADED", `Model '${req.modelId}' is not loaded in worker.`);
          return;
        }
        const engine = ensureEngine();
        const onToken = req.req.stream ? (token, index) => {
          postEvent({
            id: req.id,
            type: "TOKEN",
            modelId: req.modelId,
            token,
            index
          });
        } : void 0;
        const result = await engine.generate(req.modelId, req.req, onToken);
        postEvent({
          id: req.id,
          type: "RESULT",
          payload: result
        });
        return;
      }
      case "EMBED": {
        if (!state.loadedModels.has(req.modelId)) {
          postError(req.id, "MODEL_NOT_LOADED", `Model '${req.modelId}' is not loaded in worker.`);
          return;
        }
        const engine = ensureEngine();
        const result = await engine.embed(req.modelId, req.input);
        postEvent({
          id: req.id,
          type: "RESULT",
          payload: result
        });
        return;
      }
      case "TOKENIZE": {
        if (!state.loadedModels.has(req.modelId)) {
          postError(req.id, "MODEL_NOT_LOADED", `Model '${req.modelId}' is not loaded in worker.`);
          return;
        }
        const engine = ensureEngine();
        if (typeof engine.tokenize !== "function") {
          postError(req.id, "INFERENCE_FAILED", "tokenize is not supported by this WASM build \u2014 rebuild with npm run build:wasm");
          return;
        }
        const result = await engine.tokenize(req.modelId, req.text);
        postEvent({ id: req.id, type: "RESULT", payload: result });
        return;
      }
      case "DETOKENIZE": {
        if (!state.loadedModels.has(req.modelId)) {
          postError(req.id, "MODEL_NOT_LOADED", `Model '${req.modelId}' is not loaded in worker.`);
          return;
        }
        const engine = ensureEngine();
        if (typeof engine.detokenize !== "function") {
          postError(req.id, "INFERENCE_FAILED", "detokenize is not supported by this WASM build \u2014 rebuild with npm run build:wasm");
          return;
        }
        const result = await engine.detokenize(req.modelId, req.tokens);
        postEvent({ id: req.id, type: "RESULT", payload: result });
        return;
      }
      case "CONVERT_GRAMMAR": {
        const engine = ensureEngine();
        if (typeof engine.convertJsonSchemaToGrammar !== "function") {
          postError(req.id, "INFERENCE_FAILED", "convertJsonSchemaToGrammar is not supported by this WASM build \u2014 rebuild with npm run build:wasm");
          return;
        }
        const grammar = await engine.convertJsonSchemaToGrammar(req.schemaJson);
        postEvent({ id: req.id, type: "RESULT", payload: { grammar } });
        return;
      }
      case "HEALTH": {
        const details = state.engine ? await state.engine.health?.() : void 0;
        postEvent({
          id: req.id,
          type: "RESULT",
          payload: {
            ok: state.initialized,
            initialized: state.initialized,
            loadedModels: state.loadedModels.size,
            details: details ?? {}
          }
        });
        return;
      }
      case "MEMORY": {
        const details = state.engine ? await state.engine.memory?.() : void 0;
        const loadedModelIds = [...state.loadedModels];
        postEvent({
          id: req.id,
          type: "RESULT",
          payload: {
            pressure: "unknown",
            loadedModelIds,
            loadedModelCount: loadedModelIds.length,
            maxModels: WASM_MAX_CONCURRENT_MODELS,
            ...details ?? {}
          }
        });
        return;
      }
      case "RERANK": {
        if (!state.loadedModels.has(req.modelId)) {
          postError(req.id, "MODEL_NOT_LOADED", `Model '${req.modelId}' is not loaded in worker.`);
          return;
        }
        const engine = ensureEngine();
        if (typeof engine.rerank !== "function") {
          postError(req.id, "INFERENCE_FAILED", "rerank is not supported by this WASM build");
          return;
        }
        const results = await engine.rerank(req.modelId, req.query, req.documents);
        postEvent({ id: req.id, type: "RESULT", payload: { results } });
        return;
      }
      case "BENCH": {
        if (!state.loadedModels.has(req.modelId)) {
          postError(req.id, "MODEL_NOT_LOADED", `Model '${req.modelId}' is not loaded in worker.`);
          return;
        }
        const engine = ensureEngine();
        if (typeof engine.bench !== "function") {
          postError(req.id, "INFERENCE_FAILED", "bench is not supported by this WASM build");
          return;
        }
        const result = await engine.bench(req.modelId, req.pp, req.tg, req.pl, req.nr);
        postEvent({ id: req.id, type: "RESULT", payload: { result } });
        return;
      }
      case "SAVE_SESSION": {
        if (!state.loadedModels.has(req.modelId)) {
          postError(req.id, "MODEL_NOT_LOADED", `Model '${req.modelId}' is not loaded in worker.`);
          return;
        }
        const engine = ensureEngine();
        if (typeof engine.saveSession !== "function") {
          postError(req.id, "INFERENCE_FAILED", "saveSession is not supported by this WASM build");
          return;
        }
        const result = await engine.saveSession(req.modelId, req.filepath, req.tokenSize);
        postEvent({ id: req.id, type: "RESULT", payload: result });
        return;
      }
      case "LOAD_SESSION": {
        if (!state.loadedModels.has(req.modelId)) {
          postError(req.id, "MODEL_NOT_LOADED", `Model '${req.modelId}' is not loaded in worker.`);
          return;
        }
        const engine = ensureEngine();
        if (typeof engine.loadSession !== "function") {
          postError(req.id, "INFERENCE_FAILED", "loadSession is not supported by this WASM build");
          return;
        }
        const result = await engine.loadSession(req.modelId, req.filepath);
        postEvent({ id: req.id, type: "RESULT", payload: result });
        return;
      }
      case "APPLY_LORA": {
        if (!state.loadedModels.has(req.modelId)) {
          postError(req.id, "MODEL_NOT_LOADED", `Model '${req.modelId}' is not loaded in worker.`);
          return;
        }
        const engine = ensureEngine();
        if (typeof engine.applyLoraAdapters !== "function") {
          postError(req.id, "INFERENCE_FAILED", "applyLoraAdapters is not supported by this WASM build");
          return;
        }
        await engine.applyLoraAdapters(req.modelId, req.loraAdapters);
        postEvent({ id: req.id, type: "RESULT", payload: { ok: true } });
        return;
      }
      case "REMOVE_LORA": {
        if (!state.loadedModels.has(req.modelId)) {
          postError(req.id, "MODEL_NOT_LOADED", `Model '${req.modelId}' is not loaded in worker.`);
          return;
        }
        const engine = ensureEngine();
        await engine.removeLoraAdapters?.(req.modelId);
        postEvent({ id: req.id, type: "RESULT", payload: { ok: true } });
        return;
      }
      case "GET_LORA": {
        if (!state.loadedModels.has(req.modelId)) {
          postError(req.id, "MODEL_NOT_LOADED", `Model '${req.modelId}' is not loaded in worker.`);
          return;
        }
        const engine = ensureEngine();
        const adapters = await engine.getLoadedLoraAdapters?.(req.modelId) ?? [];
        postEvent({ id: req.id, type: "RESULT", payload: { adapters } });
        return;
      }
      case "INIT_MULTIMODAL": {
        if (!state.loadedModels.has(req.modelId)) {
          postError(req.id, "MODEL_NOT_LOADED", `Model '${req.modelId}' is not loaded in worker.`);
          return;
        }
        const engine = ensureEngine();
        const ok = await engine.initMultimodal?.(req.modelId, req.path, req.useGpu ?? false);
        postEvent({ id: req.id, type: "RESULT", payload: { ok: !!ok } });
        return;
      }
      case "MULTIMODAL_STATUS": {
        if (!state.loadedModels.has(req.modelId)) {
          postError(req.id, "MODEL_NOT_LOADED", `Model '${req.modelId}' is not loaded in worker.`);
          return;
        }
        const engine = ensureEngine();
        const status = await engine.multimodalStatus?.(req.modelId);
        postEvent({ id: req.id, type: "RESULT", payload: status ?? { enabled: false, vision: false, audio: false } });
        return;
      }
      case "RELEASE_MULTIMODAL": {
        const engine = ensureEngine();
        await engine.releaseMultimodal?.(req.modelId);
        postEvent({ id: req.id, type: "RESULT", payload: { ok: true } });
        return;
      }
      case "INIT_VOCODER": {
        if (!state.loadedModels.has(req.modelId)) {
          postError(req.id, "MODEL_NOT_LOADED", `Model '${req.modelId}' is not loaded in worker.`);
          return;
        }
        const engine = ensureEngine();
        const ok = await engine.initVocoder?.(req.modelId, req.path, req.nBatch ?? 512);
        postEvent({ id: req.id, type: "RESULT", payload: { ok: !!ok } });
        return;
      }
      case "VOCODER_ENABLED": {
        if (!state.loadedModels.has(req.modelId)) {
          postError(req.id, "MODEL_NOT_LOADED", `Model '${req.modelId}' is not loaded in worker.`);
          return;
        }
        const engine = ensureEngine();
        const enabled = await engine.vocoderEnabled?.(req.modelId);
        postEvent({ id: req.id, type: "RESULT", payload: { enabled: !!enabled } });
        return;
      }
      case "RELEASE_VOCODER": {
        const engine = ensureEngine();
        await engine.releaseVocoder?.(req.modelId);
        postEvent({ id: req.id, type: "RESULT", payload: { ok: true } });
        return;
      }
      case "FORMATTED_AUDIO": {
        if (!state.loadedModels.has(req.modelId)) {
          postError(req.id, "MODEL_NOT_LOADED", `Model '${req.modelId}' is not loaded in worker.`);
          return;
        }
        const engine = ensureEngine();
        const result = await engine.formattedAudioCompletion?.(
          req.modelId,
          req.speakerJson,
          req.textToSpeak
        );
        postEvent({ id: req.id, type: "RESULT", payload: result ?? { prompt: "" } });
        return;
      }
      case "AUDIO_GUIDE_TOKENS": {
        if (!state.loadedModels.has(req.modelId)) {
          postError(req.id, "MODEL_NOT_LOADED", `Model '${req.modelId}' is not loaded in worker.`);
          return;
        }
        const engine = ensureEngine();
        const tokens = await engine.audioGuideTokens?.(req.modelId, req.textToSpeak);
        postEvent({ id: req.id, type: "RESULT", payload: { tokens: tokens ?? [] } });
        return;
      }
      case "DECODE_AUDIO_TOKENS": {
        if (!state.loadedModels.has(req.modelId)) {
          postError(req.id, "MODEL_NOT_LOADED", `Model '${req.modelId}' is not loaded in worker.`);
          return;
        }
        const engine = ensureEngine();
        const audio = await engine.decodeAudioTokens?.(req.modelId, req.tokens);
        postEvent({ id: req.id, type: "RESULT", payload: { audio: audio ?? [] } });
        return;
      }
      default: {
        const unknownReq = req;
        postError(
          typeof unknownReq?.id === "string" ? unknownReq.id : "unknown",
          "INVALID_REQUEST",
          `Unknown worker request type '${unknownReq?.type}'.`
        );
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = req.type === "INIT" ? "WASM_INIT_FAILED" : "INFERENCE_FAILED";
    postError(req.id, code, message, { requestType: req.type });
  }
};
//# sourceMappingURL=llm.worker.js.map
