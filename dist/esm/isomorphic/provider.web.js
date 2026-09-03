import { LlmError } from './errors';
import { DefaultModelScheduler } from './model.scheduler';
import { WASM_MAX_CONCURRENT_MODELS, WASM_POOL_CEILING_BYTES, wasmMemoryPressure, } from './wasmMemoryPolicy';
import { ensureModelInOpfs, getOpfsUsage, } from '../storage/opfs.store';
import { getManifestEntry } from '../storage/manifest';
// ---------------------------------------------------------------------------
// Fix #10: Pre-flight capability checks
// ---------------------------------------------------------------------------
/** Verify that the browser supports everything the web WASM path needs. */
export function checkWasmCapabilities() {
    var _a, _b;
    const missing = [];
    if (typeof WebAssembly !== 'object' || typeof WebAssembly.instantiate !== 'function') {
        missing.push('WebAssembly');
    }
    if (typeof (globalThis === null || globalThis === void 0 ? void 0 : globalThis.Worker) === 'undefined') {
        missing.push('Worker');
    }
    if (typeof ((_b = (_a = globalThis === null || globalThis === void 0 ? void 0 : globalThis.navigator) === null || _a === void 0 ? void 0 : _a.storage) === null || _b === void 0 ? void 0 : _b.getDirectory) !== 'function') {
        missing.push('OPFS (navigator.storage.getDirectory)');
    }
    // WASM threads (needed for multi-threaded inference) require cross-origin
    // isolation. Warn but don't block — single-threaded inference still works.
    const coi = (globalThis === null || globalThis === void 0 ? void 0 : globalThis.crossOriginIsolated) === true;
    const hasShared = typeof SharedArrayBuffer !== 'undefined';
    if (!coi || !hasShared) {
        // Not a hard failure — single-threaded WASM still functions.
        // Callers can check this separately via checkCrossOriginIsolation().
    }
    return { supported: missing.length === 0, missing };
}
/** Returns true only when COOP/COEP headers are set for WASM threads. */
export function checkCrossOriginIsolation() {
    return ((globalThis === null || globalThis === void 0 ? void 0 : globalThis.crossOriginIsolated) === true &&
        typeof SharedArrayBuffer !== 'undefined');
}
const toError = (code, message, meta) => {
    const knownCodes = [
        'MODEL_NOT_LOADED',
        'MODEL_LIMIT_REACHED',
        'INSUFFICIENT_MEMORY',
        'MODEL_DOWNLOAD_FAILED',
        'STORAGE_UNAVAILABLE',
        'STORAGE_IO_FAILED',
        'UNSUPPORTED_PLATFORM',
        'WASM_INIT_FAILED',
        'NATIVE_PLUGIN_UNAVAILABLE',
        'INFERENCE_FAILED',
        'INVALID_REQUEST',
    ];
    const normalizedCode = knownCodes.includes(code) ? code : 'INFERENCE_FAILED';
    const text = message == null || message === ''
        ? 'Unknown inference error'
        : typeof message === 'string'
            ? message
            : String(message);
    return new LlmError(normalizedCode, text, meta);
};
// ---------------------------------------------------------------------------
// Fix #11: Cross-browser memory snapshot using storage.estimate() fallback
// ---------------------------------------------------------------------------
async function getMemorySnapshotCrossBrowser() {
    var _a, _b, _c, _d;
    // performance.memory is Chromium-only and non-standard. Use it when present,
    // otherwise fall back to storage.estimate() which is universally available.
    const perfMem = (_a = globalThis === null || globalThis === void 0 ? void 0 : globalThis.performance) === null || _a === void 0 ? void 0 : _a.memory;
    if (perfMem && typeof perfMem.jsHeapSizeLimit === 'number' && perfMem.jsHeapSizeLimit > 0) {
        const totalBytes = Number(perfMem.jsHeapSizeLimit);
        const usedBytes = Number(perfMem.usedJSHeapSize);
        const freeBytes = totalBytes - usedBytes;
        const usedRatio = usedBytes / totalBytes;
        const pressure = usedRatio >= 0.85 ? 'high' : usedRatio >= 0.7 ? 'medium' : 'low';
        return { totalBytes, usedBytes, freeBytes, pressure };
    }
    // Fallback: use OPFS storage quota as a coarse proxy for available memory.
    // Not perfect but gives the admission controller a real number to work with
    // on Safari/Firefox instead of always returning undefined (which caused the
    // memory guard to be silently bypassed — fix #11).
    try {
        const est = await ((_d = (_c = (_b = globalThis === null || globalThis === void 0 ? void 0 : globalThis.navigator) === null || _b === void 0 ? void 0 : _b.storage) === null || _c === void 0 ? void 0 : _c.estimate) === null || _d === void 0 ? void 0 : _d.call(_c));
        if (est && typeof est.quota === 'number' && typeof est.usage === 'number') {
            const totalBytes = est.quota;
            const usedBytes = est.usage;
            const freeBytes = totalBytes - usedBytes;
            const usedRatio = totalBytes > 0 ? usedBytes / totalBytes : 0;
            const pressure = usedRatio >= 0.85 ? 'high' : usedRatio >= 0.7 ? 'medium' : 'low';
            return { totalBytes, usedBytes, freeBytes, pressure };
        }
    }
    catch (_e) {
        // ignore
    }
    return { pressure: 'unknown' };
}
// ---------------------------------------------------------------------------
// WebProvider
// ---------------------------------------------------------------------------
export class WebProvider {
    constructor(workerFactoryOverride) {
        this.workerFactoryOverride = workerFactoryOverride;
        this.platform = 'web';
        this.loadedModelIds = new Set();
        this.worker = null;
        this.reqCounter = 0;
        this.pending = new Map();
        // Fix #5: wire the scheduler so admission control is enforced on the web path.
        this.scheduler = new DefaultModelScheduler(WASM_MAX_CONCURRENT_MODELS);
    }
    static setWorkerFactory(factory) {
        WebProvider.globalWorkerFactory = factory;
    }
    // Fix #15: resolve compiled worker .js first; fall back to .ts for dev.
    resolveWorkerUrl() {
        const customUrl = globalThis === null || globalThis === void 0 ? void 0 : globalThis.__LLAMA_WORKER_URL__;
        if (typeof customUrl === 'string' && customUrl.length > 0) {
            return customUrl;
        }
        try {
            const metaUrl = new Function('return import.meta.url')();
            return new URL('../../dist/workers/llm.worker.js', metaUrl);
        }
        catch (_a) {
            return '/dist/workers/llm.worker.js';
        }
    }
    defaultWorkerFactory() {
        return new Worker(this.resolveWorkerUrl(), { type: 'module' });
    }
    ensureWorker() {
        var _a, _b;
        if (this.worker)
            return this.worker;
        const factory = (_b = (_a = this.workerFactoryOverride) !== null && _a !== void 0 ? _a : WebProvider.globalWorkerFactory) !== null && _b !== void 0 ? _b : (() => this.defaultWorkerFactory());
        const worker = factory();
        worker.onmessage = (evt) => {
            var _a, _b;
            const message = evt.data;
            const request = this.pending.get(message.id);
            if (!request)
                return;
            if (message.type === 'TOKEN') {
                (_a = request.onToken) === null || _a === void 0 ? void 0 : _a.call(request, {
                    modelId: message.modelId,
                    token: message.token,
                    index: message.index,
                });
                return;
            }
            if (message.type === 'PROGRESS') {
                (_b = request.onProgress) === null || _b === void 0 ? void 0 : _b.call(request, message.downloaded, message.total);
                return;
            }
            if (message.type === 'RESULT') {
                this.pending.delete(message.id);
                request.resolve(message.payload);
                return;
            }
            this.pending.delete(message.id);
            request.reject(toError(message.code, message.message, message.meta));
        };
        worker.onerror = (evt) => {
            const err = toError('INFERENCE_FAILED', `Web worker error: ${evt.message || 'unknown worker error'}`);
            for (const [id, req] of this.pending.entries()) {
                this.pending.delete(id);
                req.reject(err);
            }
        };
        this.worker = worker;
        return worker;
    }
    sendRequest(request, onToken, onProgress) {
        const worker = this.ensureWorker();
        const id = `req_${Date.now()}_${this.reqCounter++}`;
        const message = Object.assign(Object.assign({}, request), { id });
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject, onToken, onProgress });
            try {
                // Fix #9: no Transferable[] needed — the ArrayBuffer lives in the worker
                worker.postMessage(message);
            }
            catch (error) {
                this.pending.delete(id);
                reject(toError('INFERENCE_FAILED', 'Failed to post request to wasm worker.', {
                    cause: String(error),
                    requestType: request.type,
                }));
            }
        });
    }
    async initialize(opts) {
        // Fix #10: gate on capability check before touching the worker.
        // Skip when a custom worker factory is injected (tests / custom hosts).
        const usingCustomWorker = !!this.workerFactoryOverride || !!WebProvider.globalWorkerFactory;
        if (!usingCustomWorker) {
            const caps = checkWasmCapabilities();
            if (!caps.supported) {
                throw new LlmError('UNSUPPORTED_PLATFORM', `Missing browser capabilities for WASM inference: ${caps.missing.join(', ')}`, { missing: caps.missing });
            }
        }
        await this.sendRequest({ type: 'INIT' });
        await this.loadModel(opts);
    }
    async loadModel(opts) {
        var _a, _b, _c;
        if (!opts.modelId) {
            throw new LlmError('INVALID_REQUEST', 'modelId is required');
        }
        if (this.loadedModelIds.has(opts.modelId)) {
            return;
        }
        const existing = await getManifestEntry(opts.modelId);
        if (!existing && !opts.modelUrl) {
            throw new LlmError('INVALID_REQUEST', 'modelUrl is required for first-time web load when model is not cached in OPFS.');
        }
        // Download and persist to OPFS if needed (#6: with progress events).
        if (!existing && opts.modelUrl) {
            await ensureModelInOpfs(opts.modelId, opts.modelUrl, opts.onProgress);
        }
        // Fix #5: enforce admission control (memory guard + slot limit) BEFORE
        // asking the worker to load, using a real memory snapshot (#11).
        const memory = await getMemorySnapshotCrossBrowser();
        const wasmMemory = await this.fetchWorkerMemory().catch(() => ({}));
        const wasmLinearBytes = typeof wasmMemory.wasmLinearBytes === 'number' ? wasmMemory.wasmLinearBytes : undefined;
        const manifestEntry = existing !== null && existing !== void 0 ? existing : (await getManifestEntry(opts.modelId));
        const modelBytes = (_a = manifestEntry === null || manifestEntry === void 0 ? void 0 : manifestEntry.sizeBytes) !== null && _a !== void 0 ? _a : 0;
        this.scheduler.ensureCapacity(opts.modelId, modelBytes, memory, undefined, {
            wasmLinearBytes,
            wasmPoolCeilingBytes: WASM_POOL_CEILING_BYTES,
            loadOpts: {
                n_ctx: opts.n_ctx,
                n_batch: opts.n_batch,
                embedding: opts.embedding,
            },
        });
        // Fix #9: send modelId only — the worker reads from OPFS internally.
        const loadResult = await this.sendRequest({
            type: 'LOAD_MODEL',
            modelId: opts.modelId,
            opts: {
                modelPath: (_c = (_b = opts.modelPath) !== null && _b !== void 0 ? _b : opts.model_path) !== null && _c !== void 0 ? _c : manifestEntry === null || manifestEntry === void 0 ? void 0 : manifestEntry.path,
                modelBytes,
                n_ctx: opts.n_ctx,
                n_batch: opts.n_batch,
                n_gpu_layers: opts.n_gpu_layers,
                n_threads: opts.n_threads,
                embedding: opts.embedding,
                use_mmap: opts.use_mmap,
                preferVfsStreaming: opts.preferVfsStreaming,
            },
        }, undefined, opts.onProgress);
        let measuredFootprint = loadResult.measuredFootprintBytes;
        if (!(typeof measuredFootprint === 'number' && measuredFootprint > 0)) {
            const workerMem = await this.fetchWorkerMemory().catch(() => ({}));
            measuredFootprint = this.readMeasuredFootprintFromWorker(workerMem, opts.modelId);
        }
        this.loadedModelIds.add(opts.modelId);
        this.scheduler.markLoaded(opts.modelId, modelBytes, {
            n_ctx: opts.n_ctx,
            n_batch: opts.n_batch,
            embedding: opts.embedding,
        }, measuredFootprint);
        if (typeof measuredFootprint === 'number' && measuredFootprint > 0) {
            this.scheduler.calibrateFootprint(opts.modelId, measuredFootprint);
        }
    }
    readMeasuredFootprintFromWorker(workerMem, modelId) {
        const models = workerMem.loadedModels;
        if (!Array.isArray(models))
            return undefined;
        for (const row of models) {
            if (!row || typeof row !== 'object')
                continue;
            const entry = row;
            if (entry.modelId !== modelId)
                continue;
            if (typeof entry.measuredFootprintBytes === 'number' && entry.measuredFootprintBytes > 0) {
                return entry.measuredFootprintBytes;
            }
        }
        return undefined;
    }
    async unloadModel(modelId) {
        if (!this.loadedModelIds.has(modelId)) {
            return;
        }
        await this.sendRequest({ type: 'UNLOAD_MODEL', modelId });
        this.loadedModelIds.delete(modelId);
        this.scheduler.markUnloaded(modelId);
    }
    async generate(req) {
        if (!this.loadedModelIds.has(req.modelId)) {
            throw new LlmError('MODEL_NOT_LOADED', `Model '${req.modelId}' is not loaded`);
        }
        return this.sendRequest({
            type: 'GENERATE',
            modelId: req.modelId,
            req: {
                prompt: req.prompt,
                messages: req.messages,
                max_tokens: req.max_tokens,
                temperature: req.temperature,
                stream: false,
            },
        });
    }
    async generateStream(req, onToken) {
        if (!this.loadedModelIds.has(req.modelId)) {
            throw new LlmError('MODEL_NOT_LOADED', `Model '${req.modelId}' is not loaded`);
        }
        return this.sendRequest({
            type: 'GENERATE',
            modelId: req.modelId,
            req: {
                prompt: req.prompt,
                messages: req.messages,
                max_tokens: req.max_tokens,
                temperature: req.temperature,
                stream: true,
            },
        }, onToken);
    }
    async embed(req) {
        if (!this.loadedModelIds.has(req.modelId)) {
            throw new LlmError('MODEL_NOT_LOADED', `Model '${req.modelId}' is not loaded`);
        }
        return this.sendRequest({
            type: 'EMBED',
            modelId: req.modelId,
            input: req.input,
        });
    }
    // Fix #11: use cross-browser memory snapshot instead of performance.memory only.
    async getMemorySnapshot() {
        return getMemorySnapshotCrossBrowser();
    }
    /** Worker WASM linear memory + loaded-model registry (for scheduling UI). */
    async fetchWorkerMemory() {
        return this.sendRequest({ type: 'MEMORY' });
    }
    async getWasmMemoryStatus() {
        const [browser, workerRaw] = await Promise.all([
            getMemorySnapshotCrossBrowser(),
            this.fetchWorkerMemory().catch(() => ({})),
        ]);
        const worker = workerRaw;
        const wasmLinearBytes = typeof worker.wasmLinearBytes === 'number' ? worker.wasmLinearBytes : undefined;
        return {
            browser,
            worker,
            wasmLinearBytes,
            wasmPoolCeilingBytes: WASM_POOL_CEILING_BYTES,
            wasmHeadroomBytes: typeof wasmLinearBytes === 'number'
                ? Math.max(0, WASM_POOL_CEILING_BYTES - wasmLinearBytes)
                : undefined,
            pressure: typeof wasmLinearBytes === 'number'
                ? wasmMemoryPressure(wasmLinearBytes, WASM_POOL_CEILING_BYTES)
                : browser.pressure,
            loadedModels: this.loadedModelIds.size,
            maxModels: WASM_MAX_CONCURRENT_MODELS,
            schedulerFootprintBytes: this.scheduler.totalFootprintBytes(),
        };
    }
    async tokenize(modelId, text) {
        if (!this.loadedModelIds.has(modelId)) {
            throw new LlmError('MODEL_NOT_LOADED', `Model '${modelId}' is not loaded`);
        }
        return this.sendRequest({ type: 'TOKENIZE', modelId, text });
    }
    async detokenize(modelId, tokens) {
        if (!this.loadedModelIds.has(modelId)) {
            throw new LlmError('MODEL_NOT_LOADED', `Model '${modelId}' is not loaded`);
        }
        return this.sendRequest({ type: 'DETOKENIZE', modelId, tokens });
    }
    async convertJsonSchemaToGrammar(schemaJson) {
        // CONVERT_GRAMMAR is context-free — no model needs to be loaded.
        // The worker must be initialised (INIT sent), but that happens on first use.
        const result = await this.sendRequest({
            type: 'CONVERT_GRAMMAR',
            schemaJson,
        });
        return result.grammar;
    }
    requireLoaded(modelId) {
        if (!this.loadedModelIds.has(modelId)) {
            throw new LlmError('MODEL_NOT_LOADED', `Model '${modelId}' is not loaded`);
        }
    }
    async rerank(modelId, query, documents) {
        this.requireLoaded(modelId);
        const result = await this.sendRequest({
            type: 'RERANK',
            modelId,
            query,
            documents,
        });
        return result.results;
    }
    async bench(modelId, pp, tg, pl, nr) {
        this.requireLoaded(modelId);
        const result = await this.sendRequest({
            type: 'BENCH',
            modelId,
            pp,
            tg,
            pl,
            nr,
        });
        return result.result;
    }
    async saveSession(modelId, filepath, tokenSize) {
        this.requireLoaded(modelId);
        const result = await this.sendRequest({
            type: 'SAVE_SESSION',
            modelId,
            filepath,
            tokenSize,
        });
        return result.tokens_saved;
    }
    async loadSession(modelId, filepath) {
        this.requireLoaded(modelId);
        return this.sendRequest({
            type: 'LOAD_SESSION',
            modelId,
            filepath,
        });
    }
    async applyLoraAdapters(modelId, loraAdapters) {
        this.requireLoaded(modelId);
        await this.sendRequest({
            type: 'APPLY_LORA',
            modelId,
            loraAdapters,
        });
    }
    async removeLoraAdapters(modelId) {
        this.requireLoaded(modelId);
        await this.sendRequest({ type: 'REMOVE_LORA', modelId });
    }
    async getLoadedLoraAdapters(modelId) {
        this.requireLoaded(modelId);
        const result = await this.sendRequest({
            type: 'GET_LORA',
            modelId,
        });
        return result.adapters;
    }
    async initMultimodal(modelId, path, useGpu = false) {
        this.requireLoaded(modelId);
        const result = await this.sendRequest({
            type: 'INIT_MULTIMODAL',
            modelId,
            path,
            useGpu,
        });
        return !!result.ok;
    }
    async isMultimodalEnabled(modelId) {
        this.requireLoaded(modelId);
        const result = await this.sendRequest({
            type: 'MULTIMODAL_STATUS',
            modelId,
        });
        return !!result.enabled;
    }
    async getMultimodalSupport(modelId) {
        this.requireLoaded(modelId);
        const result = await this.sendRequest({
            type: 'MULTIMODAL_STATUS',
            modelId,
        });
        return { vision: !!result.vision, audio: !!result.audio };
    }
    async releaseMultimodal(modelId) {
        await this.sendRequest({ type: 'RELEASE_MULTIMODAL', modelId });
    }
    async initVocoder(modelId, path, nBatch = 512) {
        this.requireLoaded(modelId);
        const result = await this.sendRequest({
            type: 'INIT_VOCODER',
            modelId,
            path,
            nBatch,
        });
        return !!result.ok;
    }
    async isVocoderEnabled(modelId) {
        this.requireLoaded(modelId);
        const result = await this.sendRequest({
            type: 'VOCODER_ENABLED',
            modelId,
        });
        return !!result.enabled;
    }
    async releaseVocoder(modelId) {
        await this.sendRequest({ type: 'RELEASE_VOCODER', modelId });
    }
    async getFormattedAudioCompletion(modelId, speaker, textToSpeak) {
        this.requireLoaded(modelId);
        return this.sendRequest({
            type: 'FORMATTED_AUDIO',
            modelId,
            speakerJson: speaker ? JSON.stringify(speaker) : '',
            textToSpeak,
        });
    }
    async getAudioCompletionGuideTokens(modelId, textToSpeak) {
        this.requireLoaded(modelId);
        const result = await this.sendRequest({
            type: 'AUDIO_GUIDE_TOKENS',
            modelId,
            textToSpeak,
        });
        return result.tokens;
    }
    async decodeAudioTokens(modelId, tokens) {
        this.requireLoaded(modelId);
        const result = await this.sendRequest({
            type: 'DECODE_AUDIO_TOKENS',
            modelId,
            tokens,
        });
        return result.audio;
    }
    /**
     * Terminate the worker mid-inference. WASM is single-threaded, so posting
     * an abort message cannot be received while generate() is running. Worker
     * termination is the only reliable interrupt. The model will need to be
     * reloaded on the next generate() call.
     */
    stopGeneration() {
        if (!this.worker)
            return;
        this.worker.terminate();
        this.worker = null;
        const interrupted = toError('INFERENCE_FAILED', 'Generation stopped by caller.');
        for (const [id, req] of this.pending.entries()) {
            this.pending.delete(id);
            req.reject(interrupted);
        }
        // Worker is gone, so all previously tracked model IDs are invalid.
        this.loadedModelIds.clear();
        for (const id of this.scheduler.listLoaded()) {
            this.scheduler.markUnloaded(id);
        }
    }
    async health() {
        const usage = await getOpfsUsage().catch(() => ({
            usedBytes: 0,
            quotaBytes: undefined,
        }));
        const workerHealth = await this.sendRequest({ type: 'HEALTH' }).catch((error) => ({
            ok: false,
            message: error instanceof Error ? error.message : String(error),
        }));
        const workerRecord = workerHealth;
        const workerDetails = workerRecord.details;
        return {
            ok: !!(workerHealth === null || workerHealth === void 0 ? void 0 : workerHealth.ok),
            details: {
                loadedModels: this.loadedModelIds.size,
                opfsUsedBytes: usage.usedBytes,
                opfsQuotaBytes: usage.quotaBytes,
                worker: workerHealth,
                crossOriginIsolated: checkCrossOriginIsolation(),
                wasmJspi: workerDetails === null || workerDetails === void 0 ? void 0 : workerDetails.wasmJspi,
                wasmPthread: workerDetails === null || workerDetails === void 0 ? void 0 : workerDetails.wasmPthread,
            },
        };
    }
}
//# sourceMappingURL=provider.web.js.map