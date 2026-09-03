'use strict';

var tslib = require('tslib');
var core = require('@capacitor/core');

class LlmError extends Error {
    constructor(code, message, meta) {
        super(message);
        this.name = 'LlmError';
        this.code = code;
        this.meta = meta;
    }
}

function canAdmitModel(input) {
    var _a, _b;
    const multiplier = (_a = input.estimatedMultiplier) !== null && _a !== void 0 ? _a : 1.5;
    const reserveBytes = (_b = input.reserveBytes) !== null && _b !== void 0 ? _b : 512 * 1024 * 1024; // 512MB default reserve
    const estimatedBytes = Math.ceil(input.modelBytes * multiplier);
    if (input.currentlyLoaded >= input.maxModels) {
        return {
            allow: false,
            deniedBy: 'limit',
            reason: `Model limit reached (${input.maxModels})`,
            estimatedBytes,
        };
    }
    if (typeof input.memory.freeBytes === 'number') {
        const postLoadFree = input.memory.freeBytes - estimatedBytes;
        if (postLoadFree < reserveBytes) {
            return {
                allow: false,
                deniedBy: 'memory',
                reason: 'Insufficient free memory after reserve threshold',
                estimatedBytes,
            };
        }
    }
    return { allow: true, estimatedBytes };
}

const WARM_HEAP_BYTES = 64 * 1024 * 1024;
/** Bytes used for scheduling — measured when calibrated, else estimate. */
function resolveFootprintBytes(entry, fallbackEstimate) {
    if (typeof entry === 'number' && entry > 0)
        return entry;
    if (entry && typeof entry === 'object') {
        if (typeof entry.measuredBytes === 'number' && entry.measuredBytes > 0) {
            return entry.measuredBytes;
        }
        if (entry.estimatedBytes > 0)
            return entry.estimatedBytes;
    }
    return fallbackEstimate;
}
/** Attribute heap growth to one model load (delta from linear before → after). */
function calibrateFootprintFromLinearDelta(linearBefore, linearAfter, estimatedBytes, options) {
    const delta = Math.max(0, linearAfter - linearBefore);
    if ((options === null || options === void 0 ? void 0 : options.firstModelInHeap) && linearAfter > WARM_HEAP_BYTES) {
        return linearAfter;
    }
    if (delta > 0) {
        return delta;
    }
    return estimatedBytes;
}
function createFootprintEntry(fileBytes, estimatedBytes) {
    return { fileBytes, estimatedBytes };
}
function applyCalibration(entry, linearBefore, linearAfter, firstModelInHeap) {
    const measuredBytes = calibrateFootprintFromLinearDelta(linearBefore, linearAfter, entry.estimatedBytes, { firstModelInHeap });
    return Object.assign(Object.assign({}, entry), { measuredBytes,
        linearBefore,
        linearAfter, calibratedAt: Date.now() });
}
function sumResidentFootprintBytes(footprints, excludeModelId) {
    let sum = 0;
    for (const [id, entry] of footprints) {
        if (excludeModelId && id === excludeModelId)
            continue;
        const fallback = typeof entry === 'object' ? entry.estimatedBytes : 0;
        sum += resolveFootprintBytes(entry, fallback);
    }
    return sum;
}
/** Project WASM pool usage after admitting one more model (footprint-based). */
function projectWasmAfterLoad(input) {
    var _a;
    const linear = input.wasmLinearBytes;
    const nextBytes = (_a = input.candidateMeasuredBytes) !== null && _a !== void 0 ? _a : input.candidateEstimateBytes;
    // Prefer calibrated footprints over linear heap size. Linear may include unused
    // pre-grown headroom (or a prior failed grow to MAXIMUM_MEMORY).
    if (input.residentModelCount > 0) {
        return input.residentFootprintBytes + nextBytes;
    }
    if (linear > WARM_HEAP_BYTES) {
        return nextBytes;
    }
    return Math.max(linear, nextBytes);
}

/** Max concurrent GGUF contexts in one WASM worker (matches n_threads slot policy). */
const WASM_MAX_CONCURRENT_MODELS = 5;
/** Emscripten MAXIMUM_MEMORY — absolute hard limit from build (2 GiB). */
const WASM_EMSCRIPTEN_MAX_BYTES = 2147483648;
/** WASM pool planning cap — aligned with Emscripten max (was 1536 MB). */
const WASM_POOL_CEILING_BYTES = WASM_EMSCRIPTEN_MAX_BYTES;
/** Keep this much headroom free inside the WASM pool after a load. */
const WASM_POOL_RESERVE_BYTES = 64 * 1024 * 1024;
/**
 * Estimate WASM linear memory for one model (weights + context/KV headroom).
 * PWA loads via async OPFS — weights are not fully duplicated in heap (not 2× file).
 * Observed: LFM2 ~697 MB GGUF → ~940 MB WASM; BGE ~17 MB → ~150–200 MB.
 */
function estimateModelWasmFootprint(fileBytes, opts = {}) {
    if (!(fileBytes > 0))
        return 20 * 1024 * 1024;
    const embedding = opts.embedding === true;
    const n_ctx = typeof opts.n_ctx === 'number' && opts.n_ctx > 0 ? opts.n_ctx : embedding ? 256 : 512;
    const n_batch = typeof opts.n_batch === 'number' && opts.n_batch > 0 ? opts.n_batch : embedding ? 32 : 16;
    // Async OPFS: ~1.3× file for large chat; embed models are lighter.
    const weightMultiplier = embedding ? 1.25 : fileBytes > 200 * 1024 * 1024 ? 1.32 : 1.2;
    const ctxBytes = n_ctx * n_batch * 4096;
    const proportional = Math.ceil(fileBytes * 0.12);
    const minHeadroom = embedding ? 48 * 1024 * 1024 : 96 * 1024 * 1024;
    const headroom = Math.max(minHeadroom, proportional, ctxBytes);
    return Math.ceil(fileBytes * weightMultiplier + headroom);
}
function canAdmitWasmModelLoad(input) {
    var _a, _b, _c, _d, _e, _f, _g;
    const maxModels = (_a = input.maxModels) !== null && _a !== void 0 ? _a : WASM_MAX_CONCURRENT_MODELS;
    const ceiling = (_b = input.wasmPoolCeilingBytes) !== null && _b !== void 0 ? _b : WASM_POOL_CEILING_BYTES;
    const reserve = (_c = input.reserveBytes) !== null && _c !== void 0 ? _c : WASM_POOL_RESERVE_BYTES;
    const estimated = estimateModelWasmFootprint(input.fileBytes, (_d = input.loadOpts) !== null && _d !== void 0 ? _d : {});
    if (input.currentlyLoaded >= maxModels) {
        return {
            allow: false,
            deniedBy: 'limit',
            reason: `Model slot limit reached (${maxModels} concurrent WASM contexts)`,
            estimatedFootprintBytes: estimated,
        };
    }
    const linear = (_e = input.wasmLinearBytes) !== null && _e !== void 0 ? _e : 0;
    const loadedFootprint = (_f = input.loadedFootprintBytes) !== null && _f !== void 0 ? _f : 0;
    const projectedWasm = projectWasmAfterLoad({
        wasmLinearBytes: linear,
        residentModelCount: input.currentlyLoaded,
        residentFootprintBytes: loadedFootprint,
        candidateEstimateBytes: estimated,
        candidateMeasuredBytes: input.candidateMeasuredBytes,
    });
    const admitLimit = Math.min(ceiling, WASM_EMSCRIPTEN_MAX_BYTES) - reserve;
    if (projectedWasm > admitLimit) {
        return {
            allow: false,
            deniedBy: 'wasm_pool',
            reason: `WASM pool would exceed ${(ceiling / 1024 / 1024).toFixed(0)} MB ` +
                `(projected ${(projectedWasm / 1024 / 1024).toFixed(0)} MB, ` +
                `GGUF ${(input.fileBytes / 1024 / 1024).toFixed(0)} MB → est. WASM ~${(estimated / 1024 / 1024).toFixed(0)} MB)`,
            estimatedFootprintBytes: estimated,
            projectedWasmBytes: projectedWasm,
        };
    }
    if (typeof ((_g = input.browserMemory) === null || _g === void 0 ? void 0 : _g.freeBytes) === 'number') {
        const browserReserve = 256 * 1024 * 1024;
        const postFree = input.browserMemory.freeBytes - estimated;
        if (postFree < browserReserve) {
            return {
                allow: false,
                deniedBy: 'browser_memory',
                reason: 'Insufficient browser JS heap after model load reserve',
                estimatedFootprintBytes: estimated,
                projectedWasmBytes: projectedWasm,
            };
        }
    }
    return {
        allow: true,
        estimatedFootprintBytes: estimated,
        projectedWasmBytes: projectedWasm,
    };
}
function wasmMemoryPressure(wasmLinearBytes, ceilingBytes = WASM_POOL_CEILING_BYTES) {
    if (!(wasmLinearBytes > 0) || !(ceilingBytes > 0))
        return 'unknown';
    const ratio = wasmLinearBytes / ceilingBytes;
    if (ratio >= 0.85)
        return 'high';
    if (ratio >= 0.7)
        return 'medium';
    return 'low';
}

class DefaultModelScheduler {
    constructor(maxModels = WASM_MAX_CONCURRENT_MODELS) {
        this.maxModels = maxModels;
        this.loaded = new Set();
        this.footprints = new Map();
    }
    ensureCapacity(modelId, modelBytes, memory, reserveBytes, wasm) {
        var _a, _b, _c, _d;
        if (this.loaded.has(modelId))
            return;
        const loadOpts = wasm === null || wasm === void 0 ? void 0 : wasm.loadOpts;
        const estimatedFootprint = estimateModelWasmFootprint(modelBytes, loadOpts !== null && loadOpts !== void 0 ? loadOpts : {});
        if (!(wasm === null || wasm === void 0 ? void 0 : wasm.skipWasm)) {
            const wasmAdmission = canAdmitWasmModelLoad({
                fileBytes: modelBytes,
                loadOpts,
                currentlyLoaded: this.loaded.size,
                maxModels: this.maxModels,
                wasmLinearBytes: wasm === null || wasm === void 0 ? void 0 : wasm.wasmLinearBytes,
                wasmPoolCeilingBytes: (_a = wasm === null || wasm === void 0 ? void 0 : wasm.wasmPoolCeilingBytes) !== null && _a !== void 0 ? _a : WASM_POOL_CEILING_BYTES,
                loadedFootprintBytes: this.totalFootprintBytes(),
                reserveBytes,
                browserMemory: memory,
            });
            if (!wasmAdmission.allow) {
                const code = wasmAdmission.deniedBy === 'limit' ? 'MODEL_LIMIT_REACHED' : 'INSUFFICIENT_MEMORY';
                throw new LlmError(code, (_b = wasmAdmission.reason) !== null && _b !== void 0 ? _b : 'WASM model admission rejected', {
                    modelId,
                    estimatedBytes: wasmAdmission.estimatedFootprintBytes,
                    projectedWasmBytes: wasmAdmission.projectedWasmBytes,
                    deniedBy: wasmAdmission.deniedBy,
                });
            }
        }
        const admission = canAdmitModel({
            modelBytes,
            currentlyLoaded: this.loaded.size,
            maxModels: this.maxModels,
            memory,
            reserveBytes,
            estimatedMultiplier: estimatedFootprint / Math.max(modelBytes, 1),
        });
        if (!admission.allow) {
            if (admission.deniedBy === 'memory') {
                throw new LlmError('INSUFFICIENT_MEMORY', (_c = admission.reason) !== null && _c !== void 0 ? _c : 'Model admission rejected by memory guard', {
                    modelId,
                    estimatedBytes: admission.estimatedBytes,
                });
            }
            throw new LlmError('MODEL_LIMIT_REACHED', (_d = admission.reason) !== null && _d !== void 0 ? _d : 'Model admission rejected by limit', {
                modelId,
                estimatedBytes: admission.estimatedBytes,
            });
        }
    }
    markLoaded(modelId, modelBytes, loadOpts, measuredFootprintBytes) {
        this.loaded.add(modelId);
        if (typeof modelBytes === 'number' && modelBytes > 0) {
            const estimate = estimateModelWasmFootprint(modelBytes, loadOpts !== null && loadOpts !== void 0 ? loadOpts : {});
            this.footprints.set(modelId, typeof measuredFootprintBytes === 'number' && measuredFootprintBytes > 0
                ? measuredFootprintBytes
                : estimate);
        }
    }
    /** Replace formula footprint with post-load measured WASM bytes. */
    calibrateFootprint(modelId, measuredFootprintBytes) {
        if (!(measuredFootprintBytes > 0))
            return;
        if (this.loaded.has(modelId)) {
            this.footprints.set(modelId, measuredFootprintBytes);
        }
    }
    getFootprintBytes(modelId) {
        return this.footprints.get(modelId);
    }
    markUnloaded(modelId) {
        this.loaded.delete(modelId);
        this.footprints.delete(modelId);
    }
    listLoaded() {
        return [...this.loaded];
    }
    totalFootprintBytes() {
        let sum = 0;
        for (const bytes of this.footprints.values())
            sum += bytes;
        return sum;
    }
}

const EVENT_ON_TOKEN$1 = '@LlamaCpp_onToken';
const MAX_MODELS$1 = 5;
/** Prefer the plugin instance registered by src/index.ts. */
const getPlugin = () => {
    var _a, _b, _c, _d;
    const caps = core.Capacitor;
    return ((_d = (_b = (_a = caps.Plugins) === null || _a === void 0 ? void 0 : _a.LlamaCpp) !== null && _b !== void 0 ? _b : (_c = caps.getPlugin) === null || _c === void 0 ? void 0 : _c.call(caps, 'LlamaCpp')) !== null && _d !== void 0 ? _d : core.registerPlugin('LlamaCpp'));
};
class NativeProvider {
    constructor() {
        this.platform = 'native';
        this.contextByModel = new Map();
        this.nextContextId = 1;
        this.scheduler = new DefaultModelScheduler(MAX_MODELS$1);
    }
    async initialize(opts) {
        await getPlugin().setContextLimit({ limit: MAX_MODELS$1 });
        await this.loadModel(opts);
    }
    async loadModel(opts) {
        if (!opts.modelId) {
            throw new LlmError('INVALID_REQUEST', 'modelId is required');
        }
        if (!opts.modelPath) {
            throw new LlmError('INVALID_REQUEST', 'modelPath is required on native provider');
        }
        if (this.contextByModel.has(opts.modelId)) {
            return;
        }
        const modelBytes = typeof opts.modelBytes === 'number' ? opts.modelBytes : 0;
        const reserveBytes = typeof opts.reserveBytes === 'number' ? opts.reserveBytes : undefined;
        const memory = await this.getMemorySnapshot();
        if (typeof opts.availableMemoryBytes === 'number') {
            memory.freeBytes = opts.availableMemoryBytes;
        }
        if (typeof opts.totalMemoryBytes === 'number') {
            memory.totalBytes = opts.totalMemoryBytes;
        }
        this.scheduler.ensureCapacity(opts.modelId, modelBytes, memory, reserveBytes);
        const contextId = this.nextContextId++;
        await getPlugin().initContext({
            contextId,
            params: {
                model: opts.modelPath,
                n_ctx: opts.n_ctx,
                n_threads: opts.n_threads,
                embedding: opts.embedding,
            },
        });
        this.contextByModel.set(opts.modelId, contextId);
        this.scheduler.markLoaded(opts.modelId);
    }
    async unloadModel(modelId) {
        const contextId = this.contextByModel.get(modelId);
        if (contextId === undefined) {
            return;
        }
        await getPlugin().releaseContext({ contextId });
        this.contextByModel.delete(modelId);
        this.scheduler.markUnloaded(modelId);
    }
    async generate(req) {
        var _a, _b;
        const contextId = this.contextByModel.get(req.modelId);
        if (contextId === undefined) {
            throw new LlmError('MODEL_NOT_LOADED', `Model '${req.modelId}' is not loaded`);
        }
        const prompt = (_a = req.prompt) !== null && _a !== void 0 ? _a : (_b = req.messages) === null || _b === void 0 ? void 0 : _b.map((m) => `${m.role}: ${m.content}`).join('\n');
        if (!prompt) {
            throw new LlmError('INVALID_REQUEST', 'prompt or messages is required');
        }
        const completion = await getPlugin().completion({
            contextId,
            params: {
                prompt,
                n_predict: req.max_tokens,
                temperature: req.temperature,
                emit_partial_completion: false,
            },
        });
        return {
            text: completion.content || completion.text || '',
            tokens_predicted: completion.tokens_predicted || 0,
            tokens_evaluated: completion.tokens_evaluated || 0,
            finish_reason: completion.stopped_limit ? 'length' : 'stop',
        };
    }
    async generateStream(req, onToken) {
        var _a, _b, _c;
        const contextId = this.contextByModel.get(req.modelId);
        if (contextId === undefined) {
            throw new LlmError('MODEL_NOT_LOADED', `Model '${req.modelId}' is not loaded`);
        }
        const prompt = (_a = req.prompt) !== null && _a !== void 0 ? _a : (_b = req.messages) === null || _b === void 0 ? void 0 : _b.map((m) => `${m.role}: ${m.content}`).join('\n');
        if (!prompt) {
            throw new LlmError('INVALID_REQUEST', 'prompt or messages is required');
        }
        let tokenIndex = 0;
        const listener = await getPlugin().addListener(EVENT_ON_TOKEN$1, (evt) => {
            var _a, _b;
            if (evt.contextId !== contextId)
                return;
            const token = (_b = (_a = evt.tokenResult) === null || _a === void 0 ? void 0 : _a.token) !== null && _b !== void 0 ? _b : '';
            if (!token)
                return;
            onToken({ modelId: req.modelId, token, index: tokenIndex++ });
        });
        try {
            const completion = await getPlugin().completion({
                contextId,
                params: {
                    prompt,
                    n_predict: req.max_tokens,
                    temperature: req.temperature,
                    emit_partial_completion: true,
                },
            });
            return {
                text: completion.content || completion.text || '',
                tokens_predicted: completion.tokens_predicted || 0,
                tokens_evaluated: completion.tokens_evaluated || 0,
                finish_reason: completion.stopped_limit ? 'length' : 'stop',
            };
        }
        finally {
            (_c = listener === null || listener === void 0 ? void 0 : listener.remove) === null || _c === void 0 ? void 0 : _c.call(listener);
        }
    }
    async embed(req) {
        const contextId = this.contextByModel.get(req.modelId);
        if (contextId === undefined) {
            throw new LlmError('MODEL_NOT_LOADED', `Model '${req.modelId}' is not loaded`);
        }
        const inputs = Array.isArray(req.input) ? req.input : [req.input];
        const vectors = [];
        for (const text of inputs) {
            const res = await getPlugin().embedding({
                contextId,
                text,
                params: {},
            });
            vectors.push(res.embedding || []);
        }
        return { vectors };
    }
    async getMemorySnapshot() {
        var _a;
        const memoryFromPerformance = (_a = globalThis === null || globalThis === void 0 ? void 0 : globalThis.performance) === null || _a === void 0 ? void 0 : _a.memory;
        if (memoryFromPerformance) {
            const totalBytes = Number(memoryFromPerformance.jsHeapSizeLimit);
            const usedBytes = Number(memoryFromPerformance.usedJSHeapSize);
            const freeBytes = Number(memoryFromPerformance.jsHeapSizeLimit - memoryFromPerformance.usedJSHeapSize);
            const usedRatio = totalBytes > 0 ? usedBytes / totalBytes : 0;
            const pressure = usedRatio >= 0.85 ? 'high' : usedRatio >= 0.7 ? 'medium' : 'low';
            return { totalBytes, usedBytes, freeBytes, pressure };
        }
        return { pressure: 'unknown' };
    }
    async health() {
        return {
            ok: true,
            details: {
                loadedModels: this.contextByModel.size,
                maxModels: MAX_MODELS$1,
                schedulerLoadedModels: this.scheduler.listLoaded().length,
            },
        };
    }
}

const MANIFEST_FILE = '.llm-manifest.json';
const getStorageApi$1 = () => {
    var _a;
    const storageApi = (_a = globalThis === null || globalThis === void 0 ? void 0 : globalThis.navigator) === null || _a === void 0 ? void 0 : _a.storage;
    if (!storageApi || typeof storageApi.getDirectory !== 'function') {
        throw new LlmError('STORAGE_UNAVAILABLE', 'OPFS is not available in this runtime. navigator.storage.getDirectory is missing.');
    }
    return storageApi;
};
const getRootDirectory$1 = async () => {
    const storageApi = getStorageApi$1();
    try {
        return await storageApi.getDirectory();
    }
    catch (error) {
        throw new LlmError('STORAGE_IO_FAILED', 'Failed to access OPFS root directory.', {
            cause: String(error),
        });
    }
};
const readTextFile = async (fileHandle) => {
    const file = await fileHandle.getFile();
    return file.text();
};
const writeTextFile = async (fileHandle, content) => {
    const writable = await fileHandle.createWritable();
    try {
        await writable.write(content);
    }
    finally {
        await writable.close();
    }
};
async function loadManifestInternal() {
    const root = await getRootDirectory$1();
    try {
        const handle = await root.getFileHandle(MANIFEST_FILE, { create: true });
        const content = await readTextFile(handle);
        if (!content.trim()) {
            return {};
        }
        const parsed = JSON.parse(content);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return {};
        }
        return parsed;
    }
    catch (error) {
        throw new LlmError('STORAGE_IO_FAILED', 'Failed to read OPFS manifest.', {
            cause: String(error),
        });
    }
}
async function saveManifestInternal(manifest) {
    const root = await getRootDirectory$1();
    try {
        const handle = await root.getFileHandle(MANIFEST_FILE, { create: true });
        await writeTextFile(handle, JSON.stringify(manifest, null, 2));
    }
    catch (error) {
        throw new LlmError('STORAGE_IO_FAILED', 'Failed to write OPFS manifest.', {
            cause: String(error),
        });
    }
}
async function listManifestEntries() {
    const manifest = await loadManifestInternal();
    return Object.values(manifest);
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
async function removeManifestEntry(modelId) {
    const manifest = await loadManifestInternal();
    if (manifest[modelId]) {
        delete manifest[modelId];
        await saveManifestInternal(manifest);
    }
}

const MODELS_DIR = 'models';
const getStorageApi = () => {
    var _a;
    const storageApi = (_a = globalThis === null || globalThis === void 0 ? void 0 : globalThis.navigator) === null || _a === void 0 ? void 0 : _a.storage;
    if (!storageApi || typeof storageApi.getDirectory !== 'function') {
        throw new LlmError('STORAGE_UNAVAILABLE', 'OPFS is not available in this runtime. navigator.storage.getDirectory is missing.');
    }
    return storageApi;
};
const getRootDirectory = async () => {
    const storageApi = getStorageApi();
    try {
        return await storageApi.getDirectory();
    }
    catch (error) {
        throw new LlmError('STORAGE_IO_FAILED', 'Failed to access OPFS root directory.', {
            cause: String(error),
        });
    }
};
const sanitizeModelId = (modelId) => modelId.replace(/[^a-zA-Z0-9._-]/g, '_');
const pathForModelId = (modelId) => `${MODELS_DIR}/${sanitizeModelId(modelId)}.gguf`;
const ensureParentDirAndFileHandle = async (path, create = true) => {
    const root = await getRootDirectory();
    const parts = path.split('/').filter(Boolean);
    const fileName = parts.pop();
    if (!fileName) {
        throw new LlmError('STORAGE_IO_FAILED', `Invalid OPFS path '${path}'.`);
    }
    let current = root;
    for (const dir of parts) {
        current = await current.getDirectoryHandle(dir, { create: true });
    }
    return current.getFileHandle(fileName, { create });
};
const writeStreamToFile = async (res, fileHandle, onProgress, signal) => {
    var _a;
    const writable = await fileHandle.createWritable();
    const total = Number((_a = res.headers.get('content-length')) !== null && _a !== void 0 ? _a : 0);
    let written = 0;
    try {
        if (!res.body) {
            const buf = await res.arrayBuffer();
            await writable.write(buf);
            written += buf.byteLength;
            onProgress === null || onProgress === void 0 ? void 0 : onProgress(written, total || written);
            return written;
        }
        const reader = res.body.getReader();
        while (true) {
            if (signal === null || signal === void 0 ? void 0 : signal.aborted) {
                reader.cancel();
                throw new LlmError('MODEL_DOWNLOAD_FAILED', 'Download aborted by caller.');
            }
            const { value, done } = await reader.read();
            if (done)
                break;
            if (value) {
                await writable.write(value);
                written += value.byteLength;
                onProgress === null || onProgress === void 0 ? void 0 : onProgress(written, total || written);
            }
        }
        return written;
    }
    finally {
        await writable.close();
    }
};
async function ensureModelInOpfs(modelId, modelUrl, onProgress, signal) {
    if (!modelId) {
        throw new LlmError('INVALID_REQUEST', 'modelId is required for OPFS storage.');
    }
    if (!modelUrl) {
        throw new LlmError('INVALID_REQUEST', 'modelUrl is required for OPFS storage.');
    }
    const existing = await getManifestEntry(modelId);
    if (existing) {
        await upsertManifestEntry(Object.assign(Object.assign({}, existing), { lastUsedAt: Date.now() }));
        return Object.assign(Object.assign({}, existing), { lastUsedAt: Date.now() });
    }
    let res;
    try {
        res = await fetch(modelUrl, signal ? { signal } : undefined);
    }
    catch (error) {
        const isAbort = error instanceof Error && error.name === 'AbortError';
        throw new LlmError('MODEL_DOWNLOAD_FAILED', isAbort
            ? `Download of model '${modelId}' was cancelled.`
            : `Failed to download model '${modelId}'.`, { modelId, modelUrl, cause: String(error) });
    }
    if (!res.ok) {
        throw new LlmError('MODEL_DOWNLOAD_FAILED', `Failed to download model '${modelId}': HTTP ${res.status}`, {
            modelId,
            modelUrl,
            status: res.status,
        });
    }
    const path = pathForModelId(modelId);
    let sizeBytes = 0;
    try {
        const fileHandle = await ensureParentDirAndFileHandle(path, true);
        sizeBytes = await writeStreamToFile(res, fileHandle, onProgress, signal);
    }
    catch (error) {
        throw new LlmError('STORAGE_IO_FAILED', `Failed to persist model '${modelId}' in OPFS.`, {
            modelId,
            path,
            cause: String(error),
        });
    }
    const now = Date.now();
    const entry = {
        modelId,
        path,
        sizeBytes,
        sourceUrl: modelUrl,
        createdAt: now,
        lastUsedAt: now,
    };
    await upsertManifestEntry(entry);
    return entry;
}
/**
 * Choice 3 — primary web model load path.
 * Opens an OPFS FileSystemSyncAccessHandle in the worker and reads the
 * model in fixed-size chunks (default 4MB). Chunks are streamed into WASM
 * MEMFS; the full GGUF is never materialised as a single JS ArrayBuffer.
 *
 * Worker-only: createSyncAccessHandle is not available on the main thread.
 */
const OPFS_MODEL_CHUNK_BYTES = 4 * 1024 * 1024;
async function openOpfsModelSyncReader(modelId) {
    const entry = await getManifestEntry(modelId);
    if (!entry) {
        throw new LlmError('MODEL_NOT_LOADED', `Model '${modelId}' is not present in OPFS manifest.`);
    }
    const fileHandle = await ensureParentDirAndFileHandle(entry.path, false);
    if (typeof fileHandle.createSyncAccessHandle !== 'function') {
        throw new LlmError('STORAGE_UNAVAILABLE', 'OPFS sync access handles are not available in this browser/worker context.', { modelId });
    }
    let accessHandle;
    try {
        accessHandle = await fileHandle.createSyncAccessHandle();
    }
    catch (error) {
        throw new LlmError('STORAGE_IO_FAILED', `Failed to open OPFS sync handle for '${modelId}'.`, {
            modelId,
            path: entry.path,
            cause: String(error),
        });
    }
    const sizeBytes = accessHandle.getSize();
    await upsertManifestEntry(Object.assign(Object.assign({}, entry), { lastUsedAt: Date.now() }));
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
        },
    };
}
/**
 * Read the model from OPFS as an ArrayBuffer (fallback when sync handles
 * are unavailable). Prefer openOpfsModelSyncReader in workers.
 */
async function readModelBufferFromOpfs(modelId) {
    const file = await readModelFromOpfs(modelId);
    const buffer = await file.arrayBuffer();
    return { buffer, sizeBytes: file.size };
}
async function readModelFromOpfs(modelId) {
    const entry = await getManifestEntry(modelId);
    if (!entry) {
        throw new LlmError('MODEL_NOT_LOADED', `Model '${modelId}' is not present in OPFS manifest.`);
    }
    try {
        const fileHandle = await ensureParentDirAndFileHandle(entry.path, false);
        const file = await fileHandle.getFile();
        await upsertManifestEntry(Object.assign(Object.assign({}, entry), { lastUsedAt: Date.now() }));
        return file;
    }
    catch (error) {
        throw new LlmError('STORAGE_IO_FAILED', `Failed to read model '${modelId}' from OPFS.`, {
            modelId,
            path: entry.path,
            cause: String(error),
        });
    }
}
async function removeModelFromOpfs(modelId) {
    const entry = await getManifestEntry(modelId);
    if (!entry)
        return;
    const root = await getRootDirectory();
    const parts = entry.path.split('/').filter(Boolean);
    const fileName = parts.pop();
    if (!fileName) {
        await removeManifestEntry(modelId);
        return;
    }
    try {
        let current = root;
        for (const dir of parts) {
            current = await current.getDirectoryHandle(dir, { create: false });
        }
        await current.removeEntry(fileName);
    }
    catch (error) {
        // Keep manifest cleanup deterministic even if file was already gone.
        if (!(error instanceof Error) || !/not found/i.test(error.message)) {
            throw new LlmError('STORAGE_IO_FAILED', `Failed to remove model '${modelId}' from OPFS.`, {
                modelId,
                path: entry.path,
                cause: String(error),
            });
        }
    }
    finally {
        await removeManifestEntry(modelId);
    }
}
async function getOpfsUsage() {
    var _a, _b, _c;
    const entries = await listManifestEntries();
    const usedBytes = entries.reduce((sum, e) => sum + (e.sizeBytes || 0), 0);
    const estimate = await ((_c = (_b = (_a = globalThis === null || globalThis === void 0 ? void 0 : globalThis.navigator) === null || _a === void 0 ? void 0 : _a.storage) === null || _b === void 0 ? void 0 : _b.estimate) === null || _c === void 0 ? void 0 : _c.call(_b));
    const quotaBytes = typeof (estimate === null || estimate === void 0 ? void 0 : estimate.quota) === 'number' ? estimate.quota : undefined;
    return { usedBytes, quotaBytes };
}

// ---------------------------------------------------------------------------
// Fix #10: Pre-flight capability checks
// ---------------------------------------------------------------------------
/** Verify that the browser supports everything the web WASM path needs. */
function checkWasmCapabilities() {
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
    return { supported: missing.length === 0, missing };
}
/** Returns true only when COOP/COEP headers are set for WASM threads. */
function checkCrossOriginIsolation() {
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
class WebProvider {
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

/**
 * Detect desktop (Electron / Tauri / Node) runtime vs mobile browser.
 */
function isElectronRuntime() {
    if (typeof process !== 'undefined' && process.versions && process.versions.electron) {
        return true;
    }
    return false;
}
function isDesktopRuntime() {
    if (isElectronRuntime())
        return true;
    if (typeof globalThis !== 'undefined' && globalThis.__annadataDesktop) {
        return true;
    }
    return false;
}
/** Sidecar HTTP port injected by Electron preload / main process. */
function getDesktopSidecarPort() {
    const g = globalThis;
    if (typeof g.__annadataSidecarPort === 'number' && g.__annadataSidecarPort > 0) {
        return g.__annadataSidecarPort;
    }
    if (typeof process !== 'undefined' && process.env.LLAMA_SIDECAR_PORT) {
        const p = parseInt(process.env.LLAMA_SIDECAR_PORT, 10);
        if (!Number.isNaN(p) && p > 0)
            return p;
    }
    return null;
}
function getDesktopBridge() {
    var _a;
    const g = globalThis;
    return (_a = g.annadataLlama) !== null && _a !== void 0 ? _a : null;
}

var desktop_runtime = /*#__PURE__*/Object.freeze({
    __proto__: null,
    getDesktopBridge: getDesktopBridge,
    getDesktopSidecarPort: getDesktopSidecarPort,
    isDesktopRuntime: isDesktopRuntime,
    isElectronRuntime: isElectronRuntime
});

/** Extract a token string from one SSE `data:` JSON payload (empty if none). */
function extractSidecarSseToken(payload, kind) {
    var _a, _b, _c, _d, _e, _f, _g;
    if (payload === '[DONE]') {
        return '';
    }
    try {
        const chunk = JSON.parse(payload);
        if (kind === 'chat') {
            return (_d = (_c = (_b = (_a = chunk.choices) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.delta) === null || _c === void 0 ? void 0 : _c.content) !== null && _d !== void 0 ? _d : '';
        }
        return (_g = (_f = (_e = chunk.choices) === null || _e === void 0 ? void 0 : _e[0]) === null || _f === void 0 ? void 0 : _f.text) !== null && _g !== void 0 ? _g : '';
    }
    catch (_h) {
        return '';
    }
}
/** Parse a single SSE line; returns a token when present. */
function parseSidecarSseLine(line, kind) {
    if (!line.startsWith('data: ')) {
        return null;
    }
    const payload = line.slice(6).trim();
    if (payload === '[DONE]') {
        return null;
    }
    const token = extractSidecarSseToken(payload, kind);
    return token ? token : null;
}
/** Buffers decoded stream bytes into complete newline-delimited lines. */
class SidecarSseLineParser {
    constructor() {
        this.buffer = '';
    }
    feed(chunk) {
        var _a;
        this.buffer += chunk;
        const lines = this.buffer.split('\n');
        this.buffer = (_a = lines.pop()) !== null && _a !== void 0 ? _a : '';
        return lines;
    }
    flush() {
        if (!this.buffer) {
            return [];
        }
        const line = this.buffer;
        this.buffer = '';
        return [line];
    }
}
/** Read token chunks from a fetch `ReadableStream` body. */
async function readSidecarSseTokens(body, kind, onToken) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const parser = new SidecarSseLineParser();
    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        const lines = parser.feed(decoder.decode(value, { stream: true }));
        for (const line of lines) {
            const token = parseSidecarSseLine(line, kind);
            if (token) {
                onToken(token);
            }
        }
    }
    for (const line of parser.flush()) {
        const token = parseSidecarSseLine(line, kind);
        if (token) {
            onToken(token);
        }
    }
}

const MAX_MODELS = WASM_MAX_CONCURRENT_MODELS;
/**
 * Desktop LLM provider: native sidecar (HTTP) for GPU/CPU inference;
 * WASM worker for multimodal, LoRA, TTS, bench (inherited via composition).
 * Sidecar path supports up to 5 concurrent models with admission control.
 */
class DesktopProvider extends WebProvider {
    constructor() {
        super(...arguments);
        this.platform = 'desktop';
        this.sidecarPort = null;
        this.sidecarScheduler = new DefaultModelScheduler(MAX_MODELS);
        this.sidecarLoadedModels = new Set();
        this.modelPaths = new Map();
    }
    getPort() {
        if (this.sidecarPort != null)
            return this.sidecarPort;
        const p = getDesktopSidecarPort();
        if (p == null) {
            throw new LlmError('NATIVE_PLUGIN_UNAVAILABLE', 'Desktop sidecar port not set. Register desktop IPC handlers and preload bridge.');
        }
        this.sidecarPort = p;
        return p;
    }
    sidecarAvailable() {
        try {
            this.getPort();
            return true;
        }
        catch (_a) {
            return false;
        }
    }
    async getDesktopMemorySnapshot() {
        const bridge = getDesktopBridge();
        if (bridge === null || bridge === void 0 ? void 0 : bridge.getMemorySnapshot) {
            return bridge.getMemorySnapshot();
        }
        return super.getMemorySnapshot();
    }
    mapSidecarHttpError(status, text) {
        if (status === 429 || text.includes('model_limit_reached') || text.includes('Model limit')) {
            return new LlmError('MODEL_LIMIT_REACHED', text.slice(0, 200));
        }
        if (text.includes('INSUFFICIENT') || text.includes('memory')) {
            return new LlmError('INSUFFICIENT_MEMORY', text.slice(0, 200));
        }
        if (status === 404 && text.includes('model_not_found')) {
            return new LlmError('MODEL_NOT_LOADED', text.slice(0, 200));
        }
        return new LlmError('INFERENCE_FAILED', `Sidecar HTTP ${status}: ${text.slice(0, 200)}`);
    }
    async sidecarFetch(path, method, body, timeoutMs = 120000) {
        var _a;
        const port = this.getPort();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(`http://127.0.0.1:${port}${path}`, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: body != null ? JSON.stringify(body) : undefined,
                signal: controller.signal,
            });
            if (!res.ok) {
                const text = await res.text();
                throw this.mapSidecarHttpError(res.status, text);
            }
            const ct = (_a = res.headers.get('content-type')) !== null && _a !== void 0 ? _a : '';
            if (ct.includes('application/json')) {
                return (await res.json());
            }
            return {};
        }
        finally {
            clearTimeout(timer);
        }
    }
    async ensureSidecarProcess(opts) {
        var _a;
        if (this.sidecarAvailable()) {
            return;
        }
        const bridge = getDesktopBridge();
        if (!(bridge === null || bridge === void 0 ? void 0 : bridge.ensureSidecar)) {
            throw new LlmError('NATIVE_PLUGIN_UNAVAILABLE', 'Desktop IPC bridge not available — register ipc-handlers in Electron main.');
        }
        const payload = {
            modelId: opts === null || opts === void 0 ? void 0 : opts.modelId,
            n_ctx: opts === null || opts === void 0 ? void 0 : opts.n_ctx,
            n_gpu_layers: opts === null || opts === void 0 ? void 0 : opts.n_gpu_layers,
            n_threads: opts === null || opts === void 0 ? void 0 : opts.n_threads,
            embedding: opts === null || opts === void 0 ? void 0 : opts.embedding,
        };
        if (opts === null || opts === void 0 ? void 0 : opts.modelPath) {
            payload.modelPath = opts.modelPath;
        }
        const result = await bridge.ensureSidecar(payload);
        if (!(result === null || result === void 0 ? void 0 : result.ok) || !result.port) {
            throw new LlmError('NATIVE_PLUGIN_UNAVAILABLE', `Sidecar failed to start: ${(_a = result === null || result === void 0 ? void 0 : result.reason) !== null && _a !== void 0 ? _a : 'unknown'}`);
        }
        this.setSidecarPort(result.port);
    }
    requireSidecarModel(modelId) {
        if (!this.sidecarLoadedModels.has(modelId)) {
            throw new LlmError('MODEL_NOT_LOADED', `Model '${modelId}' is not loaded on desktop sidecar`);
        }
    }
    async setContextLimit(limit) {
        const clamped = Math.min(MAX_MODELS, Math.max(1, Math.floor(limit)));
        this.sidecarScheduler = new DefaultModelScheduler(clamped);
        for (const modelId of this.sidecarLoadedModels) {
            this.sidecarScheduler.markLoaded(modelId);
        }
        if (this.sidecarAvailable()) {
            await this.sidecarFetch('/v1/internal/context-limit', 'POST', { limit: clamped }, 5000);
        }
    }
    listLoadedModels() {
        return this.sidecarScheduler.listLoaded();
    }
    async sidecarStreamChat(req, onToken) {
        var _a, _b;
        const port = this.getPort();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 300000);
        let text = '';
        let index = 0;
        try {
            const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: req.modelId,
                    messages: req.messages,
                    prompt: req.prompt,
                    max_tokens: (_a = req.max_tokens) !== null && _a !== void 0 ? _a : 256,
                    temperature: (_b = req.temperature) !== null && _b !== void 0 ? _b : 0.7,
                    stream: true,
                }),
                signal: controller.signal,
            });
            if (!res.ok || !res.body) {
                throw new LlmError('INFERENCE_FAILED', `Sidecar stream failed: ${res.status}`);
            }
            await readSidecarSseTokens(res.body, 'chat', (token) => {
                text += token;
                onToken({ modelId: req.modelId, token, index: index++ });
            });
        }
        finally {
            clearTimeout(timer);
        }
        return {
            text,
            tokens_predicted: index,
            tokens_evaluated: 0,
            finish_reason: 'stop',
        };
    }
    async sidecarStreamCompletion(req, onToken) {
        var _a, _b, _c;
        const port = this.getPort();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 300000);
        let text = '';
        let index = 0;
        try {
            const res = await fetch(`http://127.0.0.1:${port}/v1/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: req.modelId,
                    prompt: (_a = req.prompt) !== null && _a !== void 0 ? _a : '',
                    max_tokens: (_b = req.max_tokens) !== null && _b !== void 0 ? _b : 256,
                    temperature: (_c = req.temperature) !== null && _c !== void 0 ? _c : 0.7,
                    stream: true,
                }),
                signal: controller.signal,
            });
            if (!res.ok || !res.body) {
                throw new LlmError('INFERENCE_FAILED', `Sidecar stream failed: ${res.status}`);
            }
            await readSidecarSseTokens(res.body, 'completion', (token) => {
                text += token;
                onToken({ modelId: req.modelId, token, index: index++ });
            });
        }
        finally {
            clearTimeout(timer);
        }
        return {
            text,
            tokens_predicted: index,
            tokens_evaluated: 0,
            finish_reason: 'stop',
        };
    }
    async initialize(opts) {
        if (!this.sidecarAvailable()) {
            await this.ensureSidecarProcess(opts);
        }
        if (!this.sidecarAvailable()) {
            await super.initialize(opts);
            return;
        }
        await this.loadModel(opts);
    }
    async loadModel(opts) {
        var _a;
        if (!opts.modelId) {
            throw new LlmError('INVALID_REQUEST', 'modelId is required');
        }
        await this.ensureSidecarProcess(opts);
        if (!this.sidecarAvailable()) {
            await super.loadModel(opts);
            return;
        }
        const modelPath = (_a = opts.modelPath) !== null && _a !== void 0 ? _a : opts.modelId;
        // Never register absolute filesystem paths as sidecar ids (DELETE route is single-segment).
        const modelId = (() => {
            const raw = opts.modelId;
            if (!raw.includes('/') && !raw.includes('\\'))
                return raw;
            const base = raw.split(/[/\\]/).pop() || raw;
            return base.replace(/\.gguf$/i, '') || base;
        })();
        if (this.sidecarLoadedModels.has(modelId)) {
            return;
        }
        const modelBytes = typeof opts.modelBytes === 'number' ? opts.modelBytes : 0;
        // Sidecar (Metal/Accelerate) reclaims macOS inactive pages; keep a modest reserve.
        const reserveBytes = typeof opts.reserveBytes === 'number' ? opts.reserveBytes : 128 * 1024 * 1024;
        const memory = await this.getDesktopMemorySnapshot();
        if (typeof opts.availableMemoryBytes === 'number') {
            memory.freeBytes = opts.availableMemoryBytes;
        }
        if (typeof opts.totalMemoryBytes === 'number') {
            memory.totalBytes = opts.totalMemoryBytes;
        }
        // If host free RAM still looks absurdly low vs total (Node freemem quirk / no IPC),
        // treat a fraction of total as available rather than blocking every load.
        if (typeof memory.totalBytes === 'number' &&
            typeof memory.freeBytes === 'number' &&
            memory.totalBytes > 0 &&
            memory.freeBytes / memory.totalBytes < 0.05) {
            memory.freeBytes = Math.floor(memory.totalBytes * 0.45);
        }
        this.sidecarScheduler.ensureCapacity(modelId, modelBytes, memory, reserveBytes, {
            skipWasm: true,
            loadOpts: { n_ctx: opts.n_ctx, embedding: opts.embedding },
        });
        await this.sidecarFetch('/v1/internal/models/load', 'POST', {
            model_id: modelId,
            path: modelPath,
            n_ctx: opts.n_ctx,
            n_gpu_layers: opts.n_gpu_layers,
            n_threads: opts.n_threads,
            embedding: opts.embedding,
        }, 300000);
        this.sidecarLoadedModels.add(modelId);
        this.modelPaths.set(modelId, modelPath);
        this.sidecarScheduler.markLoaded(modelId, modelBytes, {
            n_ctx: opts.n_ctx,
            embedding: opts.embedding,
        });
    }
    async unloadModel(modelId) {
        if (!this.sidecarAvailable()) {
            await super.unloadModel(modelId);
            return;
        }
        const normalized = (() => {
            if (!modelId.includes('/') && !modelId.includes('\\'))
                return modelId;
            const base = modelId.split(/[/\\]/).pop() || modelId;
            return base.replace(/\.gguf$/i, '') || base;
        })();
        if (!this.sidecarLoadedModels.has(normalized) && !this.sidecarLoadedModels.has(modelId)) {
            return;
        }
        const id = this.sidecarLoadedModels.has(normalized) ? normalized : modelId;
        try {
            await this.sidecarFetch(`/v1/internal/models/${encodeURIComponent(id)}`, 'DELETE', undefined, 60000);
        }
        catch (_a) {
            /* model may already be gone on sidecar */
        }
        this.sidecarLoadedModels.delete(id);
        this.sidecarLoadedModels.delete(modelId);
        this.modelPaths.delete(id);
        this.modelPaths.delete(modelId);
        this.sidecarScheduler.markUnloaded(id);
    }
    async generate(req) {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v;
        if (!this.sidecarAvailable()) {
            return super.generate(req);
        }
        this.requireSidecarModel(req.modelId);
        if (req.messages && req.messages.length > 0) {
            const data = await this.sidecarFetch('/v1/chat/completions', 'POST', {
                model: req.modelId,
                messages: req.messages,
                max_tokens: (_a = req.max_tokens) !== null && _a !== void 0 ? _a : 256,
                temperature: (_b = req.temperature) !== null && _b !== void 0 ? _b : 0.7,
                stream: false,
            });
            const text = (_f = (_e = (_d = (_c = data.choices) === null || _c === void 0 ? void 0 : _c[0]) === null || _d === void 0 ? void 0 : _d.message) === null || _e === void 0 ? void 0 : _e.content) !== null && _f !== void 0 ? _f : '';
            return {
                text,
                tokens_predicted: (_h = (_g = data.usage) === null || _g === void 0 ? void 0 : _g.completion_tokens) !== null && _h !== void 0 ? _h : 0,
                tokens_evaluated: (_k = (_j = data.usage) === null || _j === void 0 ? void 0 : _j.prompt_tokens) !== null && _k !== void 0 ? _k : 0,
                finish_reason: 'stop',
            };
        }
        const data = await this.sidecarFetch('/v1/completions', 'POST', {
            model: req.modelId,
            prompt: (_l = req.prompt) !== null && _l !== void 0 ? _l : '',
            max_tokens: (_m = req.max_tokens) !== null && _m !== void 0 ? _m : 256,
            temperature: (_o = req.temperature) !== null && _o !== void 0 ? _o : 0.7,
            stream: false,
        });
        return {
            text: (_r = (_q = (_p = data.choices) === null || _p === void 0 ? void 0 : _p[0]) === null || _q === void 0 ? void 0 : _q.text) !== null && _r !== void 0 ? _r : '',
            tokens_predicted: (_t = (_s = data.usage) === null || _s === void 0 ? void 0 : _s.completion_tokens) !== null && _t !== void 0 ? _t : 0,
            tokens_evaluated: (_v = (_u = data.usage) === null || _u === void 0 ? void 0 : _u.prompt_tokens) !== null && _v !== void 0 ? _v : 0,
            finish_reason: 'stop',
        };
    }
    async generateStream(req, onToken) {
        if (!this.sidecarAvailable()) {
            return super.generateStream(req, onToken);
        }
        this.requireSidecarModel(req.modelId);
        if (req.messages && req.messages.length > 0) {
            return this.sidecarStreamChat(req, onToken);
        }
        return this.sidecarStreamCompletion(req, onToken);
    }
    async embed(req) {
        var _a;
        if (!this.sidecarAvailable()) {
            return super.embed(req);
        }
        this.requireSidecarModel(req.modelId);
        const input = Array.isArray(req.input) ? req.input : [req.input];
        const data = await this.sidecarFetch('/v1/embeddings', 'POST', { model: req.modelId, input });
        return { vectors: ((_a = data.data) !== null && _a !== void 0 ? _a : []).map((d) => { var _a; return (_a = d.embedding) !== null && _a !== void 0 ? _a : []; }) };
    }
    async tokenize(modelId, text) {
        if (!this.sidecarAvailable()) {
            return super.tokenize(modelId, text);
        }
        return super.tokenize(modelId, text);
    }
    async detokenize(modelId, tokens) {
        if (!this.sidecarAvailable()) {
            return super.detokenize(modelId, tokens);
        }
        return super.detokenize(modelId, tokens);
    }
    async getMemorySnapshot() {
        if (!this.sidecarAvailable()) {
            return super.getMemorySnapshot();
        }
        const memory = await this.getDesktopMemorySnapshot();
        try {
            const reg = await this.sidecarFetch('/v1/internal/memory', 'GET', undefined, 5000);
            return Object.assign(Object.assign({}, memory), { loadedModelCount: reg.loaded_count, maxModels: reg.max_models });
        }
        catch (_a) {
            return memory;
        }
    }
    async health() {
        if (!this.sidecarAvailable()) {
            return super.health();
        }
        try {
            const h = await this.sidecarFetch('/health', 'GET', undefined, 5000);
            return {
                ok: h.status === 'ok',
                details: {
                    backend: 'sidecar',
                    port: this.getPort(),
                    platform: 'desktop',
                    loadedModels: this.listLoadedModels(),
                    registry: h.registry,
                },
            };
        }
        catch (err) {
            return { ok: false, details: { error: String(err) } };
        }
    }
    setSidecarPort(port) {
        this.sidecarPort = port;
        if (typeof globalThis !== 'undefined') {
            globalThis.__annadataSidecarPort = port;
        }
    }
}

function createLlmProvider() {
    if (isDesktopRuntime()) {
        return new DesktopProvider();
    }
    const platform = core.Capacitor.getPlatform();
    if (platform === 'ios' || platform === 'android') {
        return new NativeProvider();
    }
    return new WebProvider();
}

// ---------------------------------------------------------------------------
// Fix #4: LlamaCppWeb now delegates real inference work to WebProvider so
// that calling the standard Capacitor LlamaCpp API on the web platform routes
// through the WASM engine rather than throwing "not supported" errors.
// ---------------------------------------------------------------------------
const MODEL_DESC_STUB = {
    desc: 'WASM model',
    size: 0,
    nEmbd: 0,
    nParams: 0,
    chatTemplates: {
        llamaChat: true,
        minja: {
            default: true,
            defaultCaps: {
                tools: false, toolCalls: false, toolResponses: false,
                systemRole: true, parallelToolCalls: false, toolCallId: false,
            },
            toolUse: false,
            toolUseCaps: {
                tools: false, toolCalls: false, toolResponses: false,
                systemRole: true, parallelToolCalls: false, toolCallId: false,
            },
        },
    },
    metadata: {},
    isChatTemplateSupported: true,
};
/**
 * Format a message array into a prompt string using the specified template.
 * Supports the four most common open-weight model formats. Defaults to ChatML.
 */
function formatMessagesWithTemplate(messages, template) {
    const tpl = (template !== null && template !== void 0 ? template : 'chatml').toLowerCase();
    if (tpl === 'llama3' || tpl === 'llama-3') {
        const parts = messages.map((m) => `<|start_header_id|>${m.role}<|end_header_id|>\n\n${m.content}<|eot_id|>`);
        return `<|begin_of_text|>${parts.join('')}<|start_header_id|>assistant<|end_header_id|>\n\n`;
    }
    if (tpl === 'mistral') {
        // Mistral: [INST] user [/INST] assistant </s> [INST] ...
        let out = '';
        for (let i = 0; i < messages.length; i++) {
            const m = messages[i];
            if (m.role === 'system') {
                out += `[INST] ${m.content}\n`;
            }
            else if (m.role === 'user') {
                out += `[INST] ${m.content} [/INST]`;
            }
            else if (m.role === 'assistant') {
                out += ` ${m.content}</s>`;
            }
        }
        return out;
    }
    if (tpl === 'gemma' || tpl === 'gemma2') {
        const parts = messages.map((m) => `<start_of_turn>${m.role}\n${m.content}<end_of_turn>`);
        return `${parts.join('\n')}\n<start_of_turn>model\n`;
    }
    // Default: ChatML — widely used by Qwen, Phi, Hermes, OpenChat, etc.
    const parts = messages.map((m) => `<|im_start|>${m.role}\n${m.content}<|im_end|>`);
    return `${parts.join('\n')}\n<|im_start|>assistant\n`;
}
const activeDownloads = new Map();
/** Map a user-facing path to a WASM VFS path (MEMFS /tmp). */
function vfsPathForWeb(filepath) {
    var _a;
    if (filepath.startsWith('/'))
        return filepath;
    const base = (_a = filepath.split(/[/\\]/).pop()) !== null && _a !== void 0 ? _a : 'file.bin';
    return `/tmp/${base}`;
}
class LlamaCppWeb {
    constructor() {
        this.provider = new WebProvider();
        // contextId → modelId
        this.contextToModel = new Map();
        // eventName → Set of listener callbacks
        this.listeners = new Map();
    }
    emitListener(eventName, data) {
        var _a;
        (_a = this.listeners.get(eventName)) === null || _a === void 0 ? void 0 : _a.forEach((cb) => cb(data));
    }
    hasListeners(eventName) {
        const set = this.listeners.get(eventName);
        return !!set && set.size > 0;
    }
    // -------------------------------------------------------------------------
    // Core initialization
    // -------------------------------------------------------------------------
    async toggleNativeLog() {
        // No-op on web; no native log callback to toggle.
    }
    async setContextLimit(_opts) {
        // No-op on web; WebProvider manages its own slot limit via DefaultModelScheduler.
    }
    async modelInfo({ path }) {
        var _a;
        const entry = await listManifestEntries().then((es) => es.find((e) => e.modelId === path || e.path === path));
        return Object.assign(Object.assign({}, MODEL_DESC_STUB), { path, desc: 'WASM model (web)', size: (_a = entry === null || entry === void 0 ? void 0 : entry.sizeBytes) !== null && _a !== void 0 ? _a : 0 });
    }
    async initContext({ contextId, params, }) {
        var _a;
        // Use the model path/URL as the modelId for the isomorphic layer.
        const modelId = params.model;
        await this.provider.initialize({
            modelId,
            modelPath: params.model,
            // If model is a URL, ensureModelInOpfs will download it; if it's an
            // OPFS-relative path, WebProvider will look it up in the manifest.
            modelUrl: ((_a = params.model) === null || _a === void 0 ? void 0 : _a.startsWith('http')) ? params.model : undefined,
            n_ctx: params.n_ctx,
            n_threads: params.n_threads,
            embedding: params.embedding,
        });
        this.contextToModel.set(contextId, modelId);
        return {
            contextId,
            gpu: false,
            reasonNoGPU: 'WebAssembly does not expose GPU acceleration in browsers',
            model: MODEL_DESC_STUB,
        };
    }
    async releaseContext({ contextId }) {
        const modelId = this.contextToModel.get(contextId);
        if (modelId) {
            await this.provider.unloadModel(modelId);
            this.contextToModel.delete(contextId);
        }
    }
    async releaseAllContexts() {
        for (const [contextId, modelId] of this.contextToModel.entries()) {
            await this.provider.unloadModel(modelId).catch(() => { });
            this.contextToModel.delete(contextId);
        }
    }
    // -------------------------------------------------------------------------
    // Chat and completion
    // -------------------------------------------------------------------------
    async getFormattedChat({ contextId, messages, chatTemplate, params, }) {
        const parsed = JSON.parse(messages);
        // If the provider exposes a native getFormattedChat (desktop sidecar or WASM with Jinja),
        // delegate to it so model-embedded templates are used instead of client-side formatters.
        const modelId = this.contextToModel.get(contextId);
        if (modelId && typeof this.provider.getFormattedChat === 'function') {
            try {
                return await this.provider.getFormattedChat(modelId, messages, chatTemplate, params);
            }
            catch (_a) {
                // Fall through to client-side formatting
            }
        }
        const prompt = formatMessagesWithTemplate(parsed, chatTemplate);
        return { type: 'llama-chat', prompt, has_media: false, media_paths: [] };
    }
    async completion({ contextId, params, }) {
        const modelId = this.contextToModel.get(contextId);
        if (!modelId)
            throw new Error('LlamaCppWeb: context not found');
        const wantStream = this.hasListeners('@LlamaCpp_onToken');
        const generateFn = wantStream
            ? this.provider.generateStream.bind(this.provider, {
                modelId,
                prompt: params.prompt,
                max_tokens: params.n_predict,
                temperature: params.temperature,
                top_p: params.top_p,
                top_k: params.top_k,
                min_p: params.min_p,
                repeat_penalty: params.penalty_repeat,
                seed: params.seed,
                stop: params.stop,
                grammar: params.grammar,
                stream: true,
            }, (evt) => {
                this.emitListener('@LlamaCpp_onToken', {
                    contextId,
                    token: evt.token,
                    index: evt.index,
                });
            })
            : () => this.provider.generate({
                modelId,
                prompt: params.prompt,
                max_tokens: params.n_predict,
                temperature: params.temperature,
                top_p: params.top_p,
                top_k: params.top_k,
                min_p: params.min_p,
                repeat_penalty: params.penalty_repeat,
                seed: params.seed,
                stop: params.stop,
                grammar: params.grammar,
                stream: false,
            });
        const result = await generateFn();
        return {
            text: result.text,
            content: result.text,
            reasoning_content: '',
            tool_calls: [],
            tokens_predicted: result.tokens_predicted,
            tokens_evaluated: result.tokens_evaluated,
            truncated: false,
            stopped_eos: result.finish_reason === 'stop',
            stopped_word: '',
            stopped_limit: result.finish_reason === 'length' ? 1 : 0,
            stopping_word: '',
            context_full: false,
            interrupted: result.finish_reason === 'error',
            tokens_cached: 0,
            chat_format: 0,
            timings: {
                prompt_n: result.tokens_evaluated,
                prompt_ms: 0,
                prompt_per_token_ms: 0,
                prompt_per_second: 0,
                predicted_n: result.tokens_predicted,
                predicted_ms: 0,
                predicted_per_token_ms: 0,
                predicted_per_second: 0,
            },
        };
    }
    // Fix #7: implement chat convenience helpers using proper template formatting
    async chat({ contextId, messages, system, chatTemplate, params }) {
        var _a;
        const allMessages = system
            ? [{ role: 'system', content: system }, ...messages]
            : messages;
        const formatted = await this.getFormattedChat({
            contextId,
            messages: JSON.stringify(allMessages),
            chatTemplate,
            params,
        });
        const prompt = (_a = formatted.prompt) !== null && _a !== void 0 ? _a : JSON.stringify(allMessages);
        return this.completion({ contextId, params: Object.assign(Object.assign({}, params), { prompt }) });
    }
    async chatWithSystem({ contextId, system, message, params }) {
        return this.chat({
            contextId,
            messages: [
                { role: 'system', content: system },
                { role: 'user', content: message },
            ],
            params,
        });
    }
    async generateText({ contextId, prompt, params }) {
        return this.completion({ contextId, params: Object.assign(Object.assign({}, params), { prompt }) });
    }
    async stopCompletion() {
        // Terminates the worker process; the model must be reloaded on the next call.
        this.provider.stopGeneration();
    }
    // -------------------------------------------------------------------------
    // Session management (WASM VFS — persist via /tmp paths in worker)
    // -------------------------------------------------------------------------
    async loadSession({ contextId, filepath, }) {
        const modelId = this.contextToModel.get(contextId);
        if (!modelId)
            throw new Error('LlamaCppWeb: context not found');
        return this.provider.loadSession(modelId, vfsPathForWeb(filepath));
    }
    async saveSession({ contextId, filepath, size, }) {
        const modelId = this.contextToModel.get(contextId);
        if (!modelId)
            throw new Error('LlamaCppWeb: context not found');
        return this.provider.saveSession(modelId, vfsPathForWeb(filepath), size);
    }
    // -------------------------------------------------------------------------
    // Tokenization
    // -------------------------------------------------------------------------
    async tokenize({ contextId, text, }) {
        const modelId = this.contextToModel.get(contextId);
        if (!modelId)
            throw new Error('LlamaCppWeb: context not found');
        const result = await this.provider.tokenize(modelId, text);
        return {
            tokens: result.tokens,
            has_images: false,
            bitmap_hashes: [],
            chunk_pos: [],
            chunk_pos_images: [],
        };
    }
    async detokenize({ contextId, tokens, }) {
        const modelId = this.contextToModel.get(contextId);
        if (!modelId)
            throw new Error('LlamaCppWeb: context not found');
        const result = await this.provider.detokenize(modelId, tokens);
        return result.text;
    }
    // -------------------------------------------------------------------------
    // Embeddings
    // -------------------------------------------------------------------------
    async embedding({ contextId, text }) {
        var _a;
        const modelId = this.contextToModel.get(contextId);
        if (!modelId)
            throw new Error('LlamaCppWeb: context not found');
        const result = await this.provider.embed({ modelId, input: text });
        return { embedding: (_a = result.vectors[0]) !== null && _a !== void 0 ? _a : [] };
    }
    async rerank({ contextId, query, documents, }) {
        const modelId = this.contextToModel.get(contextId);
        if (!modelId)
            throw new Error('LlamaCppWeb: context not found');
        return this.provider.rerank(modelId, query, documents);
    }
    // -------------------------------------------------------------------------
    // Benchmarking
    // -------------------------------------------------------------------------
    async bench({ contextId, pp, tg, pl, nr, }) {
        const modelId = this.contextToModel.get(contextId);
        if (!modelId)
            throw new Error('LlamaCppWeb: context not found');
        return this.provider.bench(modelId, pp, tg, pl, nr);
    }
    // -------------------------------------------------------------------------
    // LoRA adapters
    // -------------------------------------------------------------------------
    async applyLoraAdapters({ contextId, loraAdapters, }) {
        const modelId = this.contextToModel.get(contextId);
        if (!modelId)
            throw new Error('LlamaCppWeb: context not found');
        const mapped = loraAdapters.map((la) => (Object.assign(Object.assign({}, la), { path: vfsPathForWeb(la.path) })));
        await this.provider.applyLoraAdapters(modelId, mapped);
    }
    async removeLoraAdapters({ contextId }) {
        const modelId = this.contextToModel.get(contextId);
        if (!modelId)
            throw new Error('LlamaCppWeb: context not found');
        await this.provider.removeLoraAdapters(modelId);
    }
    async getLoadedLoraAdapters({ contextId, }) {
        const modelId = this.contextToModel.get(contextId);
        if (!modelId)
            throw new Error('LlamaCppWeb: context not found');
        return this.provider.getLoadedLoraAdapters(modelId);
    }
    // -------------------------------------------------------------------------
    // Multimodal
    // -------------------------------------------------------------------------
    async initMultimodal({ contextId, params, }) {
        var _a;
        const modelId = this.contextToModel.get(contextId);
        if (!modelId)
            throw new Error('LlamaCppWeb: context not found');
        return this.provider.initMultimodal(modelId, vfsPathForWeb(params.path), (_a = params.use_gpu) !== null && _a !== void 0 ? _a : false);
    }
    async isMultimodalEnabled({ contextId }) {
        const modelId = this.contextToModel.get(contextId);
        if (!modelId)
            return false;
        return this.provider.isMultimodalEnabled(modelId);
    }
    async getMultimodalSupport({ contextId }) {
        const modelId = this.contextToModel.get(contextId);
        if (!modelId)
            return { vision: false, audio: false };
        return this.provider.getMultimodalSupport(modelId);
    }
    async releaseMultimodal({ contextId }) {
        const modelId = this.contextToModel.get(contextId);
        if (!modelId)
            return;
        await this.provider.releaseMultimodal(modelId);
    }
    // -------------------------------------------------------------------------
    // TTS
    // -------------------------------------------------------------------------
    async initVocoder({ contextId, params, }) {
        var _a;
        const modelId = this.contextToModel.get(contextId);
        if (!modelId)
            throw new Error('LlamaCppWeb: context not found');
        return this.provider.initVocoder(modelId, vfsPathForWeb(params.path), (_a = params.n_batch) !== null && _a !== void 0 ? _a : 512);
    }
    async isVocoderEnabled({ contextId }) {
        const modelId = this.contextToModel.get(contextId);
        if (!modelId)
            return false;
        return this.provider.isVocoderEnabled(modelId);
    }
    async getFormattedAudioCompletion({ contextId, speakerJsonStr, textToSpeak, }) {
        const modelId = this.contextToModel.get(contextId);
        if (!modelId)
            throw new Error('LlamaCppWeb: context not found');
        const speaker = speakerJsonStr ? JSON.parse(speakerJsonStr) : null;
        return this.provider.getFormattedAudioCompletion(modelId, speaker, textToSpeak);
    }
    async getAudioCompletionGuideTokens({ contextId, textToSpeak, }) {
        const modelId = this.contextToModel.get(contextId);
        if (!modelId)
            throw new Error('LlamaCppWeb: context not found');
        return this.provider.getAudioCompletionGuideTokens(modelId, textToSpeak);
    }
    async decodeAudioTokens({ contextId, tokens, }) {
        const modelId = this.contextToModel.get(contextId);
        if (!modelId)
            throw new Error('LlamaCppWeb: context not found');
        return this.provider.decodeAudioTokens(modelId, tokens);
    }
    async releaseVocoder({ contextId }) {
        const modelId = this.contextToModel.get(contextId);
        if (!modelId)
            return;
        await this.provider.releaseVocoder(modelId);
    }
    // -------------------------------------------------------------------------
    // Fix #8: Model download / management — implemented via OPFS (#8)
    // -------------------------------------------------------------------------
    async downloadModel({ url, filename }) {
        const modelId = filename;
        const abortController = new AbortController();
        const entry = {
            abortController,
            promise: Promise.resolve(undefined),
            downloaded: 0,
            total: 0,
            completed: false,
            failed: false,
            errorMessage: undefined,
            localPath: undefined,
        };
        entry.promise = ensureModelInOpfs(modelId, url, (downloaded, total) => {
            entry.downloaded = downloaded;
            entry.total = total;
            this.emitListener('@LlamaCpp_onDownloadProgress', {
                url,
                modelId,
                downloaded,
                total,
                progress: total > 0 ? downloaded / total : 0,
            });
        }, abortController.signal)
            .then((manifest) => {
            entry.completed = true;
            entry.localPath = manifest.path;
            this.emitListener('@LlamaCpp_onDownloadComplete', { url, modelId, localPath: manifest.path });
        })
            .catch((err) => {
            const cancelled = abortController.signal.aborted;
            entry.failed = !cancelled;
            entry.errorMessage = err.message;
            if (!cancelled) {
                this.emitListener('@LlamaCpp_onDownloadError', { url, modelId, error: err.message });
            }
        });
        activeDownloads.set(url, entry);
        return modelId;
    }
    async getDownloadProgress({ url }) {
        const dl = activeDownloads.get(url);
        if (!dl) {
            return { progress: 0, completed: false, failed: false, downloadedBytes: 0, totalBytes: 0 };
        }
        const progress = dl.total > 0 ? dl.downloaded / dl.total : 0;
        return {
            progress,
            completed: dl.completed,
            failed: dl.failed,
            errorMessage: dl.errorMessage,
            localPath: dl.localPath,
            downloadedBytes: dl.downloaded,
            totalBytes: dl.total,
        };
    }
    async cancelDownload({ url }) {
        const entry = activeDownloads.get(url);
        if (!entry)
            return false;
        entry.abortController.abort();
        activeDownloads.delete(url);
        return true;
    }
    async getAvailableModels() {
        const entries = await listManifestEntries();
        return entries.map((e) => ({
            name: e.modelId,
            path: e.path,
            size: e.sizeBytes,
        }));
    }
    // -------------------------------------------------------------------------
    // Grammar utilities
    // -------------------------------------------------------------------------
    async convertJsonSchemaToGrammar({ schema, }) {
        return this.provider.convertJsonSchemaToGrammar(schema);
    }
    // -------------------------------------------------------------------------
    // Native server (not available on web)
    // -------------------------------------------------------------------------
    async startNativeLlamaServer(_options) {
        throw new Error('LlamaCppWeb: native server is only available on iOS/Android/Desktop');
    }
    async stopNativeLlamaServer() { }
    async isNativeLlamaServerRunning() {
        return { running: false };
    }
    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------
    async addListener(eventName, listenerFunc) {
        if (!this.listeners.has(eventName)) {
            this.listeners.set(eventName, new Set());
        }
        this.listeners.get(eventName).add(listenerFunc);
    }
    async removeAllListeners() {
        this.listeners.clear();
    }
}

var web = /*#__PURE__*/Object.freeze({
    __proto__: null,
    LlamaCppWeb: LlamaCppWeb
});

const MODEL_DESC_DESKTOP = {
    desc: 'Desktop sidecar model',
    size: 0,
    nEmbd: 0,
    nParams: 0,
    chatTemplates: {
        llamaChat: true,
        minja: {
            default: true,
            defaultCaps: {
                tools: false, toolCalls: false, toolResponses: false,
                systemRole: true, parallelToolCalls: false, toolCallId: false,
            },
            toolUse: false,
            toolUseCaps: {
                tools: false, toolCalls: false, toolResponses: false,
                systemRole: true, parallelToolCalls: false, toolCallId: false,
            },
        },
    },
    metadata: {},
    isChatTemplateSupported: true,
};
/** Sidecar DELETE route is `/v1/internal/models/([^/]+)` — never use absolute paths as ids. */
function sidecarModelIdFromPath(modelPath) {
    const base = modelPath.split(/[/\\]/).pop() || modelPath;
    return base.replace(/\.gguf$/i, '') || base;
}
/**
 * Capacitor LlamaCpp implementation for Electron desktop.
 * Core inference (chat, completion, embeddings) uses the native GPU/CPU sidecar.
 * Multimodal, LoRA, TTS, and benchmarking use the WASM worker (same as PWA).
 */
class LlamaCppDesktop extends LlamaCppWeb {
    constructor() {
        super();
        this.sidecarActive = false;
        this.gpuEnabled = false;
        this.desktopProvider = new DesktopProvider();
        this.provider =
            this.desktopProvider;
    }
    async initContext({ contextId, params, }) {
        var _a;
        const modelPath = params.model;
        const modelId = sidecarModelIdFromPath(modelPath);
        const bridge = getDesktopBridge();
        if (bridge === null || bridge === void 0 ? void 0 : bridge.ensureSidecar) {
            const result = await bridge.ensureSidecar({
                modelPath,
                modelId,
                n_ctx: params.n_ctx,
                n_gpu_layers: params.n_gpu_layers,
                n_threads: params.n_threads,
                embedding: params.embedding,
            });
            if ((result === null || result === void 0 ? void 0 : result.ok) && result.port) {
                this.desktopProvider.setSidecarPort(result.port);
                await this.desktopProvider.loadModel({
                    modelId,
                    modelPath,
                    n_ctx: params.n_ctx,
                    n_gpu_layers: params.n_gpu_layers,
                    n_threads: params.n_threads,
                    embedding: params.embedding,
                });
                this.sidecarActive = true;
                this.gpuEnabled = !!result.gpuEnabled;
                this.contextToModel.set(contextId, modelId);
                return {
                    contextId,
                    gpu: this.gpuEnabled,
                    reasonNoGPU: this.gpuEnabled ? '' : ((_a = result.reasonNoGpu) !== null && _a !== void 0 ? _a : 'CPU-only inference'),
                    model: MODEL_DESC_DESKTOP,
                };
            }
        }
        const fallback = await super.initContext({ contextId, params });
        this.sidecarActive = false;
        return fallback;
    }
    async setContextLimit(opts) {
        await this.desktopProvider.setContextLimit(opts.limit);
    }
    async releaseContext({ contextId }) {
        const modelId = this.contextToModel.get(contextId);
        if (modelId && this.sidecarActive) {
            await this.desktopProvider.unloadModel(modelId);
        }
        await super.releaseContext({ contextId });
    }
    async startNativeLlamaServer(options) {
        var _a, _b, _c, _d;
        const bridge = getDesktopBridge();
        if (!(bridge === null || bridge === void 0 ? void 0 : bridge.ensureSidecar)) {
            throw new Error('LlamaCppDesktop: IPC bridge not available — register ipc-handlers in main process');
        }
        const result = await bridge.ensureSidecar({
            modelPath: options.modelPath,
            modelId: sidecarModelIdFromPath(options.modelPath),
            host: (_a = options.host) !== null && _a !== void 0 ? _a : '127.0.0.1',
            port: options.port,
            n_ctx: (_b = options.params) === null || _b === void 0 ? void 0 : _b.n_ctx,
            n_gpu_layers: (_c = options.params) === null || _c === void 0 ? void 0 : _c.n_gpu_layers,
            n_threads: (_d = options.params) === null || _d === void 0 ? void 0 : _d.n_threads,
        });
        if ((result === null || result === void 0 ? void 0 : result.ok) && result.port) {
            this.desktopProvider.setSidecarPort(result.port);
            this.sidecarActive = true;
            return { running: true };
        }
        return { running: false };
    }
    async isNativeLlamaServerRunning() {
        const bridge = getDesktopBridge();
        if (bridge === null || bridge === void 0 ? void 0 : bridge.getSidecarStatus) {
            const st = await bridge.getSidecarStatus();
            return { running: !!(st === null || st === void 0 ? void 0 : st.running) };
        }
        return { running: this.sidecarActive };
    }
    async stopNativeLlamaServer() {
        const bridge = getDesktopBridge();
        if (bridge === null || bridge === void 0 ? void 0 : bridge.stopSidecar) {
            await bridge.stopSidecar();
        }
        this.sidecarActive = false;
    }
}

var desktop = /*#__PURE__*/Object.freeze({
    __proto__: null,
    LlamaCppDesktop: LlamaCppDesktop
});

var _a;
// Constants
const LLAMACPP_MTMD_DEFAULT_MEDIA_MARKER = '<__media__>';
// Event names
const EVENT_ON_INIT_CONTEXT_PROGRESS = '@LlamaCpp_onInitContextProgress';
const EVENT_ON_TOKEN = '@LlamaCpp_onToken';
const EVENT_ON_NATIVE_LOG = '@LlamaCpp_onNativeLog';
// Register the plugin — web uses WASM; Electron desktop uses sidecar (via LlamaCppDesktop).
const LlamaCpp = core.registerPlugin('LlamaCpp', {
    web: () => Promise.resolve().then(function () { return desktop_runtime; }).then(async ({ isDesktopRuntime }) => {
        if (isDesktopRuntime()) {
            const m = await Promise.resolve().then(function () { return desktop; });
            return new m.LlamaCppDesktop();
        }
        const w = await Promise.resolve().then(function () { return web; });
        return new w.LlamaCppWeb();
    }),
});
// Log listeners management
const logListeners = [];
// Best-effort wiring: Capacitor stubs can throw synchronously when a platform
// implementation is not ready yet (Node/CJS load, first paint before web impl).
try {
    const sub = LlamaCpp.addListener(EVENT_ON_NATIVE_LOG, (evt) => {
        logListeners.forEach((listener) => listener(evt.level, evt.text));
    });
    if (sub && typeof sub.catch === 'function') {
        sub.catch(() => { });
    }
}
catch (_b) {
    /* ignore until platform impl is loaded */
}
try {
    const p = (_a = LlamaCpp.toggleNativeLog) === null || _a === void 0 ? void 0 : _a.call(LlamaCpp, { enabled: false });
    if (p && typeof p.catch === 'function') {
        p.catch(() => { });
    }
}
catch (_c) {
    /* ignore unimplemented / sync stub throw */
}
const RNLLAMA_MTMD_DEFAULT_MEDIA_MARKER = LLAMACPP_MTMD_DEFAULT_MEDIA_MARKER;
const validCacheTypes = [
    'f16',
    'f32',
    'bf16',
    'q8_0',
    'q4_0',
    'q4_1',
    'iq4_nl',
    'q5_0',
    'q5_1',
];
const getJsonSchema = (responseFormat) => {
    var _a;
    if ((responseFormat === null || responseFormat === void 0 ? void 0 : responseFormat.type) === 'json_schema') {
        return (_a = responseFormat.json_schema) === null || _a === void 0 ? void 0 : _a.schema;
    }
    if ((responseFormat === null || responseFormat === void 0 ? void 0 : responseFormat.type) === 'json_object') {
        return responseFormat.schema || {};
    }
    return null;
};
// Utility function to convert JSON schema to GBNF grammar
const jsonSchemaToGrammar = async (schema) => {
    // This will call the native method to convert JSON schema to GBNF
    // For now, we'll return a basic implementation
    try {
        const result = await LlamaCpp.convertJsonSchemaToGrammar({ schema: JSON.stringify(schema) });
        return result;
    }
    catch (error) {
        console.warn('Failed to convert JSON schema to GBNF, using fallback:', error);
        // Fallback for basic object structure
        return `root ::= "{" ws object_content ws "}"
object_content ::= string_field ("," ws string_field)*
string_field ::= "\\"" [a-zA-Z_][a-zA-Z0-9_]* "\\"" ws ":" ws value
value ::= string | number | boolean | "null"
string ::= "\\"" [^"]* "\\""
number ::= "-"? [0-9]+ ("." [0-9]+)?
boolean ::= "true" | "false"
ws ::= [ \\t\\n]*`;
    }
};
class LlamaContext {
    constructor({ contextId, gpu, reasonNoGPU, model }) {
        this.gpu = false;
        this.reasonNoGPU = '';
        this.id = contextId;
        this.gpu = gpu;
        this.reasonNoGPU = reasonNoGPU;
        this.model = model;
    }
    /**
     * Load cached prompt & completion state from a file.
     */
    async loadSession(filepath) {
        let path = filepath;
        if (path.startsWith('file://'))
            path = path.slice(7);
        return LlamaCpp.loadSession({ contextId: this.id, filepath: path });
    }
    /**
     * Save current cached prompt & completion state to a file.
     */
    async saveSession(filepath, options) {
        return LlamaCpp.saveSession({
            contextId: this.id,
            filepath,
            size: (options === null || options === void 0 ? void 0 : options.tokenSize) || -1
        });
    }
    isLlamaChatSupported() {
        return !!this.model.chatTemplates.llamaChat;
    }
    isJinjaSupported() {
        const { minja } = this.model.chatTemplates;
        return !!(minja === null || minja === void 0 ? void 0 : minja.toolUse) || !!(minja === null || minja === void 0 ? void 0 : minja.default);
    }
    async getFormattedChat(messages, template, params) {
        var _a;
        const mediaPaths = [];
        const chat = messages.map((msg) => {
            if (Array.isArray(msg.content)) {
                const content = msg.content.map((part) => {
                    var _a;
                    // Handle multimodal content
                    if (part.type === 'image_url') {
                        let path = ((_a = part.image_url) === null || _a === void 0 ? void 0 : _a.url) || '';
                        if (path === null || path === void 0 ? void 0 : path.startsWith('file://'))
                            path = path.slice(7);
                        mediaPaths.push(path);
                        return {
                            type: 'text',
                            text: RNLLAMA_MTMD_DEFAULT_MEDIA_MARKER,
                        };
                    }
                    else if (part.type === 'input_audio') {
                        const { input_audio: audio } = part;
                        if (!audio)
                            throw new Error('input_audio is required');
                        const { format } = audio;
                        if (format != 'wav' && format != 'mp3') {
                            throw new Error(`Unsupported audio format: ${format}`);
                        }
                        if (audio.url) {
                            const path = audio.url.replace(/file:\/\//, '');
                            mediaPaths.push(path);
                        }
                        else if (audio.data) {
                            mediaPaths.push(audio.data);
                        }
                        return {
                            type: 'text',
                            text: RNLLAMA_MTMD_DEFAULT_MEDIA_MARKER,
                        };
                    }
                    return part;
                });
                return Object.assign(Object.assign({}, msg), { content });
            }
            return msg;
        });
        const useJinja = this.isJinjaSupported() && (params === null || params === void 0 ? void 0 : params.jinja);
        let tmpl;
        if (template)
            tmpl = template; // Force replace if provided
        const jsonSchema = getJsonSchema(params === null || params === void 0 ? void 0 : params.response_format);
        const result = await LlamaCpp.getFormattedChat({
            contextId: this.id,
            messages: JSON.stringify(chat),
            chatTemplate: tmpl,
            params: {
                jinja: useJinja,
                json_schema: jsonSchema ? JSON.stringify(jsonSchema) : undefined,
                tools: (params === null || params === void 0 ? void 0 : params.tools) ? JSON.stringify(params.tools) : undefined,
                parallel_tool_calls: (params === null || params === void 0 ? void 0 : params.parallel_tool_calls)
                    ? JSON.stringify(params.parallel_tool_calls)
                    : undefined,
                tool_choice: params === null || params === void 0 ? void 0 : params.tool_choice,
                enable_thinking: (_a = params === null || params === void 0 ? void 0 : params.enable_thinking) !== null && _a !== void 0 ? _a : true,
                add_generation_prompt: params === null || params === void 0 ? void 0 : params.add_generation_prompt,
                now: typeof (params === null || params === void 0 ? void 0 : params.now) === 'number' ? params.now.toString() : params === null || params === void 0 ? void 0 : params.now,
                chat_template_kwargs: (params === null || params === void 0 ? void 0 : params.chat_template_kwargs) ? JSON.stringify(Object.entries(params.chat_template_kwargs).reduce((acc, [key, value]) => {
                    acc[key] = JSON.stringify(value); // Each value is a stringified JSON object
                    return acc;
                }, {})) : undefined,
            },
        });
        if (!useJinja) {
            return {
                type: 'llama-chat',
                prompt: result,
                has_media: mediaPaths.length > 0,
                media_paths: mediaPaths,
            };
        }
        const jinjaResult = result;
        jinjaResult.type = 'jinja';
        jinjaResult.has_media = mediaPaths.length > 0;
        jinjaResult.media_paths = mediaPaths;
        return jinjaResult;
    }
    /**
     * Generate a completion based on the provided parameters
     * @param params Completion parameters including prompt or messages
     * @param callback Optional callback for token-by-token streaming
     * @returns Promise resolving to the completion result
     *
     * Note: For multimodal support, you can include an media_paths parameter.
     * This will process the images and add them to the context before generating text.
     * Multimodal support must be enabled via initMultimodal() first.
     */
    async completion(params, callback) {
        const nativeParams = Object.assign(Object.assign({}, params), { prompt: params.prompt || '', emit_partial_completion: !!callback });
        if (params.messages) {
            const formattedResult = await this.getFormattedChat(params.messages, params.chat_template || params.chatTemplate, {
                jinja: params.jinja,
                tools: params.tools,
                parallel_tool_calls: params.parallel_tool_calls,
                tool_choice: params.tool_choice,
                enable_thinking: params.enable_thinking,
                add_generation_prompt: params.add_generation_prompt,
                now: params.now,
                chat_template_kwargs: params.chat_template_kwargs,
            });
            if (formattedResult.type === 'jinja') {
                const jinjaResult = formattedResult;
                nativeParams.prompt = jinjaResult.prompt || '';
                if (typeof jinjaResult.chat_format === 'number')
                    nativeParams.chat_format = jinjaResult.chat_format;
                if (jinjaResult.grammar)
                    nativeParams.grammar = jinjaResult.grammar;
                if (typeof jinjaResult.grammar_lazy === 'boolean')
                    nativeParams.grammar_lazy = jinjaResult.grammar_lazy;
                if (jinjaResult.grammar_triggers)
                    nativeParams.grammar_triggers = jinjaResult.grammar_triggers;
                if (jinjaResult.preserved_tokens)
                    nativeParams.preserved_tokens = jinjaResult.preserved_tokens;
                if (jinjaResult.additional_stops) {
                    if (!nativeParams.stop)
                        nativeParams.stop = [];
                    nativeParams.stop.push(...jinjaResult.additional_stops);
                }
                if (jinjaResult.has_media) {
                    nativeParams.media_paths = jinjaResult.media_paths;
                }
            }
            else if (formattedResult.type === 'llama-chat') {
                const llamaChatResult = formattedResult;
                nativeParams.prompt = llamaChatResult.prompt || '';
                if (llamaChatResult.has_media) {
                    nativeParams.media_paths = llamaChatResult.media_paths;
                }
            }
        }
        else {
            nativeParams.prompt = params.prompt || '';
        }
        // If media_paths were explicitly provided or extracted from messages, use them
        if (!nativeParams.media_paths && params.media_paths) {
            nativeParams.media_paths = params.media_paths;
        }
        // Handle structured output and grammar
        if (params.grammar) {
            // Direct GBNF grammar takes precedence
            nativeParams.grammar = params.grammar;
        }
        else if (nativeParams.response_format && !nativeParams.grammar) {
            const jsonSchema = getJsonSchema(params.response_format);
            if (jsonSchema) {
                // Try to convert JSON schema to GBNF grammar
                try {
                    nativeParams.grammar = await jsonSchemaToGrammar(jsonSchema);
                }
                catch (error) {
                    console.warn('Failed to convert JSON schema to grammar, falling back to json_schema parameter:', error);
                    nativeParams.json_schema = JSON.stringify(jsonSchema);
                }
            }
        }
        let tokenListener = callback &&
            LlamaCpp.addListener(EVENT_ON_TOKEN, (evt) => {
                const { contextId, tokenResult } = evt;
                if (contextId !== this.id)
                    return;
                callback(tokenResult);
            });
        if (!nativeParams.prompt)
            throw new Error('Prompt is required');
        const promise = LlamaCpp.completion({ contextId: this.id, params: nativeParams });
        return promise
            .then((completionResult) => {
            tokenListener === null || tokenListener === void 0 ? void 0 : tokenListener.remove();
            tokenListener = null;
            return completionResult;
        })
            .catch((err) => {
            tokenListener === null || tokenListener === void 0 ? void 0 : tokenListener.remove();
            tokenListener = null;
            throw err;
        });
    }
    stopCompletion() {
        return LlamaCpp.stopCompletion({ contextId: this.id });
    }
    /**
     * Tokenize text or text with images
     * @param text Text to tokenize
     * @param params.media_paths Array of image paths to tokenize (if multimodal is enabled)
     * @returns Promise resolving to the tokenize result
     */
    tokenize(text, { media_paths: mediaPaths, } = {}) {
        return LlamaCpp.tokenize({ contextId: this.id, text, imagePaths: mediaPaths });
    }
    detokenize(tokens) {
        return LlamaCpp.detokenize({ contextId: this.id, tokens });
    }
    embedding(text, params) {
        return LlamaCpp.embedding({ contextId: this.id, text, params: params || {} });
    }
    /**
     * Rerank documents based on relevance to a query
     * @param query The query text to rank documents against
     * @param documents Array of document texts to rank
     * @param params Optional reranking parameters
     * @returns Promise resolving to an array of ranking results with scores and indices
     */
    async rerank(query, documents, params) {
        const results = await LlamaCpp.rerank({
            contextId: this.id,
            query,
            documents,
            params: params || {}
        });
        // Sort by score descending and add document text if requested
        return results
            .map((result) => (Object.assign(Object.assign({}, result), { document: documents[result.index] })))
            .sort((a, b) => b.score - a.score);
    }
    async bench(pp, tg, pl, nr) {
        const result = await LlamaCpp.bench({ contextId: this.id, pp, tg, pl, nr });
        const [modelDesc, modelSize, modelNParams, ppAvg, ppStd, tgAvg, tgStd] = JSON.parse(result);
        return {
            modelDesc,
            modelSize,
            modelNParams,
            ppAvg,
            ppStd,
            tgAvg,
            tgStd,
        };
    }
    async applyLoraAdapters(loraList) {
        let loraAdapters = [];
        if (loraList)
            loraAdapters = loraList.map((l) => ({
                path: l.path.replace(/file:\/\//, ''),
                scaled: l.scaled,
            }));
        return LlamaCpp.applyLoraAdapters({ contextId: this.id, loraAdapters });
    }
    async removeLoraAdapters() {
        return LlamaCpp.removeLoraAdapters({ contextId: this.id });
    }
    async getLoadedLoraAdapters() {
        return LlamaCpp.getLoadedLoraAdapters({ contextId: this.id });
    }
    /**
     * Initialize multimodal support with a mmproj file
     * @param params Parameters for multimodal support
     * @param params.path Path to the multimodal projector file
     * @param params.use_gpu Whether to use GPU
     * @returns Promise resolving to true if initialization was successful
     */
    async initMultimodal({ path, use_gpu: useGpu, }) {
        if (path.startsWith('file://'))
            path = path.slice(7);
        return LlamaCpp.initMultimodal({
            contextId: this.id,
            params: {
                path,
                use_gpu: useGpu !== null && useGpu !== void 0 ? useGpu : true,
            },
        });
    }
    /**
     * Check if multimodal support is enabled
     * @returns Promise resolving to true if multimodal is enabled
     */
    async isMultimodalEnabled() {
        return await LlamaCpp.isMultimodalEnabled({ contextId: this.id });
    }
    /**
     * Check multimodal support
     * @returns Promise resolving to an object with vision and audio support
     */
    async getMultimodalSupport() {
        return await LlamaCpp.getMultimodalSupport({ contextId: this.id });
    }
    /**
     * Release multimodal support
     * @returns Promise resolving to void
     */
    async releaseMultimodal() {
        return await LlamaCpp.releaseMultimodal({ contextId: this.id });
    }
    /**
     * Initialize TTS support with a vocoder model
     * @param params Parameters for TTS support
     * @param params.path Path to the vocoder model
     * @param params.n_batch Batch size for the vocoder model
     * @returns Promise resolving to true if initialization was successful
     */
    async initVocoder({ path, n_batch: nBatch }) {
        if (path.startsWith('file://'))
            path = path.slice(7);
        return await LlamaCpp.initVocoder({
            contextId: this.id,
            params: { path, n_batch: nBatch }
        });
    }
    /**
     * Check if TTS support is enabled
     * @returns Promise resolving to true if TTS is enabled
     */
    async isVocoderEnabled() {
        return await LlamaCpp.isVocoderEnabled({ contextId: this.id });
    }
    /**
     * Get a formatted audio completion prompt
     * @param speakerJsonStr JSON string representing the speaker
     * @param textToSpeak Text to speak
     * @returns Promise resolving to the formatted audio completion result with prompt and grammar
     */
    async getFormattedAudioCompletion(speaker, textToSpeak) {
        return await LlamaCpp.getFormattedAudioCompletion({
            contextId: this.id,
            speakerJsonStr: speaker ? JSON.stringify(speaker) : '',
            textToSpeak,
        });
    }
    /**
     * Get guide tokens for audio completion
     * @param textToSpeak Text to speak
     * @returns Promise resolving to the guide tokens
     */
    async getAudioCompletionGuideTokens(textToSpeak) {
        return await LlamaCpp.getAudioCompletionGuideTokens({ contextId: this.id, textToSpeak });
    }
    /**
     * Decode audio tokens
     * @param tokens Array of audio tokens
     * @returns Promise resolving to the decoded audio tokens
     */
    async decodeAudioTokens(tokens) {
        return await LlamaCpp.decodeAudioTokens({ contextId: this.id, tokens });
    }
    /**
     * Release TTS support
     * @returns Promise resolving to void
     */
    async releaseVocoder() {
        return await LlamaCpp.releaseVocoder({ contextId: this.id });
    }
    async release() {
        return LlamaCpp.releaseContext({ contextId: this.id });
    }
}
async function toggleNativeLog(enabled) {
    return LlamaCpp.toggleNativeLog({ enabled });
}
function addNativeLogListener(listener) {
    logListeners.push(listener);
    return {
        remove: () => {
            logListeners.splice(logListeners.indexOf(listener), 1);
        },
    };
}
async function setContextLimit(limit) {
    return LlamaCpp.setContextLimit({ limit });
}
// Fix #14: pure monotonic counter — adding random() caused ID collisions when
// counter + random happened to produce the same value on successive calls.
let contextIdCounter = 0;
const modelInfoSkip = [
    // Large fields
    'tokenizer.ggml.tokens',
    'tokenizer.ggml.token_type',
    'tokenizer.ggml.merges',
    'tokenizer.ggml.scores',
];
async function loadLlamaModelInfo(model) {
    let path = model;
    if (path.startsWith('file://'))
        path = path.slice(7);
    return LlamaCpp.modelInfo({ path, skip: modelInfoSkip });
}
const poolTypeMap = {
    // -1 is unspecified as undefined
    none: 0,
    mean: 1,
    cls: 2,
    last: 3,
    rank: 4,
};
async function initLlama(_a, onProgress) {
    var { model, is_model_asset: isModelAsset, pooling_type: poolingType, lora, lora_list: loraList } = _a, rest = tslib.__rest(_a, ["model", "is_model_asset", "pooling_type", "lora", "lora_list"]);
    let path = model;
    if (path.startsWith('file://'))
        path = path.slice(7);
    let loraPath = lora;
    if (loraPath === null || loraPath === void 0 ? void 0 : loraPath.startsWith('file://'))
        loraPath = loraPath.slice(7);
    let loraAdapters = [];
    if (loraList)
        loraAdapters = loraList.map((l) => ({
            path: l.path.replace(/file:\/\//, ''),
            scaled: l.scaled,
        }));
    const contextId = ++contextIdCounter;
    let removeProgressListener = null;
    if (onProgress) {
        removeProgressListener = LlamaCpp.addListener(EVENT_ON_INIT_CONTEXT_PROGRESS, (evt) => {
            if (evt.contextId !== contextId)
                return;
            onProgress(evt.progress);
        });
    }
    const poolType = poolTypeMap[poolingType];
    if (rest.cache_type_k && !validCacheTypes.includes(rest.cache_type_k)) {
        console.warn(`[LlamaCpp] initLlama: Invalid cache K type: ${rest.cache_type_k}, falling back to f16`);
        delete rest.cache_type_k;
    }
    if (rest.cache_type_v && !validCacheTypes.includes(rest.cache_type_v)) {
        console.warn(`[LlamaCpp] initLlama: Invalid cache V type: ${rest.cache_type_v}, falling back to f16`);
        delete rest.cache_type_v;
    }
    // Log speculative decoding configuration if enabled
    if (rest.draft_model) {
        console.log(`🚀 Initializing with speculative decoding:
      - Main model: ${path}
      - Draft model: ${rest.draft_model}
      - Speculative samples: ${rest.speculative_samples || 3}
      - Mobile optimization: ${rest.mobile_speculative !== false ? 'enabled' : 'disabled'}`);
    }
    const { gpu, reasonNoGPU, model: modelDetails, androidLib, } = await LlamaCpp.initContext({
        contextId,
        params: Object.assign({ model: path, is_model_asset: !!isModelAsset, use_progress_callback: !!onProgress, pooling_type: poolType, lora: loraPath, lora_list: loraAdapters }, rest),
    }).catch((err) => {
        removeProgressListener === null || removeProgressListener === void 0 ? void 0 : removeProgressListener.remove();
        throw err;
    });
    removeProgressListener === null || removeProgressListener === void 0 ? void 0 : removeProgressListener.remove();
    return new LlamaContext({
        contextId,
        gpu,
        reasonNoGPU,
        model: modelDetails,
        androidLib,
    });
}
async function releaseAllLlama() {
    return LlamaCpp.releaseAllContexts();
}
// Model download and management functions
async function downloadModel(url, filename) {
    return LlamaCpp.downloadModel({ url, filename });
}
async function getDownloadProgress(url) {
    return LlamaCpp.getDownloadProgress({ url });
}
async function cancelDownload(url) {
    return LlamaCpp.cancelDownload({ url });
}
async function getAvailableModels() {
    return LlamaCpp.getAvailableModels();
}
/**
 * Convert a JSON schema to GBNF grammar format
 * @param schema JSON schema object
 * @returns Promise resolving to GBNF grammar string
 */
async function convertJsonSchemaToGrammar(schema) {
    return jsonSchemaToGrammar(schema);
}
const BuildInfo = {
    number: '1.0.0',
    commit: 'capacitor-llama-cpp',
};

exports.BuildInfo = BuildInfo;
exports.DefaultModelScheduler = DefaultModelScheduler;
exports.DesktopProvider = DesktopProvider;
exports.LLAMACPP_MTMD_DEFAULT_MEDIA_MARKER = LLAMACPP_MTMD_DEFAULT_MEDIA_MARKER;
exports.LlamaContext = LlamaContext;
exports.LlamaCpp = LlamaCpp;
exports.LlamaCppDesktop = LlamaCppDesktop;
exports.LlmError = LlmError;
exports.NativeProvider = NativeProvider;
exports.OPFS_MODEL_CHUNK_BYTES = OPFS_MODEL_CHUNK_BYTES;
exports.RNLLAMA_MTMD_DEFAULT_MEDIA_MARKER = RNLLAMA_MTMD_DEFAULT_MEDIA_MARKER;
exports.WASM_EMSCRIPTEN_MAX_BYTES = WASM_EMSCRIPTEN_MAX_BYTES;
exports.WASM_MAX_CONCURRENT_MODELS = WASM_MAX_CONCURRENT_MODELS;
exports.WASM_POOL_CEILING_BYTES = WASM_POOL_CEILING_BYTES;
exports.WASM_POOL_RESERVE_BYTES = WASM_POOL_RESERVE_BYTES;
exports.WebProvider = WebProvider;
exports.addNativeLogListener = addNativeLogListener;
exports.applyCalibration = applyCalibration;
exports.calibrateFootprintFromLinearDelta = calibrateFootprintFromLinearDelta;
exports.canAdmitModel = canAdmitModel;
exports.canAdmitWasmModelLoad = canAdmitWasmModelLoad;
exports.cancelDownload = cancelDownload;
exports.checkCrossOriginIsolation = checkCrossOriginIsolation;
exports.checkWasmCapabilities = checkWasmCapabilities;
exports.convertJsonSchemaToGrammar = convertJsonSchemaToGrammar;
exports.createFootprintEntry = createFootprintEntry;
exports.createLlmProvider = createLlmProvider;
exports.downloadModel = downloadModel;
exports.ensureModelInOpfs = ensureModelInOpfs;
exports.estimateModelWasmFootprint = estimateModelWasmFootprint;
exports.getAvailableModels = getAvailableModels;
exports.getDesktopBridge = getDesktopBridge;
exports.getDesktopSidecarPort = getDesktopSidecarPort;
exports.getDownloadProgress = getDownloadProgress;
exports.getManifestEntry = getManifestEntry;
exports.getOpfsUsage = getOpfsUsage;
exports.initLlama = initLlama;
exports.isDesktopRuntime = isDesktopRuntime;
exports.isElectronRuntime = isElectronRuntime;
exports.listManifestEntries = listManifestEntries;
exports.loadLlamaModelInfo = loadLlamaModelInfo;
exports.openOpfsModelSyncReader = openOpfsModelSyncReader;
exports.projectWasmAfterLoad = projectWasmAfterLoad;
exports.readModelBufferFromOpfs = readModelBufferFromOpfs;
exports.readModelFromOpfs = readModelFromOpfs;
exports.releaseAllLlama = releaseAllLlama;
exports.removeManifestEntry = removeManifestEntry;
exports.removeModelFromOpfs = removeModelFromOpfs;
exports.resolveFootprintBytes = resolveFootprintBytes;
exports.setContextLimit = setContextLimit;
exports.sumResidentFootprintBytes = sumResidentFootprintBytes;
exports.toggleNativeLog = toggleNativeLog;
exports.upsertManifestEntry = upsertManifestEntry;
exports.wasmMemoryPressure = wasmMemoryPressure;
//# sourceMappingURL=plugin.cjs.map
