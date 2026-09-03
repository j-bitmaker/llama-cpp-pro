import { projectWasmAfterLoad } from './wasmMemoryCalibration';
/** Max concurrent GGUF contexts in one WASM worker (matches n_threads slot policy). */
export const WASM_MAX_CONCURRENT_MODELS = 5;
/** Emscripten MAXIMUM_MEMORY — absolute hard limit from build (2 GiB). */
export const WASM_EMSCRIPTEN_MAX_BYTES = 2147483648;
/** WASM pool planning cap — aligned with Emscripten max (was 1536 MB). */
export const WASM_POOL_CEILING_BYTES = WASM_EMSCRIPTEN_MAX_BYTES;
/** Keep this much headroom free inside the WASM pool after a load. */
export const WASM_POOL_RESERVE_BYTES = 64 * 1024 * 1024;
/**
 * Estimate WASM linear memory for one model (weights + context/KV headroom).
 * PWA loads via async OPFS — weights are not fully duplicated in heap (not 2× file).
 * Observed: LFM2 ~697 MB GGUF → ~940 MB WASM; BGE ~17 MB → ~150–200 MB.
 */
export function estimateModelWasmFootprint(fileBytes, opts = {}) {
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
export function canAdmitWasmModelLoad(input) {
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
export function wasmMemoryPressure(wasmLinearBytes, ceilingBytes = WASM_POOL_CEILING_BYTES) {
    if (!(wasmLinearBytes > 0) || !(ceilingBytes > 0))
        return 'unknown';
    const ratio = wasmLinearBytes / ceilingBytes;
    if (ratio >= 0.85)
        return 'high';
    if (ratio >= 0.7)
        return 'medium';
    return 'low';
}
//# sourceMappingURL=wasmMemoryPolicy.js.map