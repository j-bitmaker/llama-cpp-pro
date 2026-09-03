import type { MemorySnapshot } from './provider.interface';
/** Max concurrent GGUF contexts in one WASM worker (matches n_threads slot policy). */
export declare const WASM_MAX_CONCURRENT_MODELS = 5;
/** Emscripten MAXIMUM_MEMORY — absolute hard limit from build (2 GiB). */
export declare const WASM_EMSCRIPTEN_MAX_BYTES = 2147483648;
/** WASM pool planning cap — aligned with Emscripten max (was 1536 MB). */
export declare const WASM_POOL_CEILING_BYTES = 2147483648;
/** Keep this much headroom free inside the WASM pool after a load. */
export declare const WASM_POOL_RESERVE_BYTES: number;
export type ModelLoadMemoryOpts = {
    n_ctx?: number;
    n_batch?: number;
    embedding?: boolean;
};
export type WasmMemoryStatus = MemorySnapshot & {
    wasmLinearBytes?: number;
    wasmPoolCeilingBytes?: number;
    wasmHeadroomBytes?: number;
    loadedModelCount?: number;
    maxModels?: number;
    loadedModels?: Array<{
        modelId: string;
        fileBytes?: number;
        estimatedFootprintBytes?: number;
    }>;
};
export type WasmLoadAdmissionInput = {
    modelId: string;
    fileBytes: number;
    loadOpts?: ModelLoadMemoryOpts;
    currentlyLoaded: number;
    maxModels?: number;
    wasmLinearBytes?: number;
    wasmPoolCeilingBytes?: number;
    loadedFootprintBytes?: number;
    /** Prior measured footprint for this model id (if re-loading after unload). */
    candidateMeasuredBytes?: number;
    reserveBytes?: number;
    browserMemory?: MemorySnapshot;
};
export type WasmLoadAdmissionResult = {
    allow: boolean;
    deniedBy?: 'limit' | 'wasm_pool' | 'browser_memory';
    reason?: string;
    estimatedFootprintBytes: number;
    projectedWasmBytes?: number;
};
/**
 * Estimate WASM linear memory for one model (weights + context/KV headroom).
 * PWA loads via async OPFS — weights are not fully duplicated in heap (not 2× file).
 * Observed: LFM2 ~697 MB GGUF → ~940 MB WASM; BGE ~17 MB → ~150–200 MB.
 */
export declare function estimateModelWasmFootprint(fileBytes: number, opts?: ModelLoadMemoryOpts): number;
export declare function canAdmitWasmModelLoad(input: WasmLoadAdmissionInput): WasmLoadAdmissionResult;
export declare function wasmMemoryPressure(wasmLinearBytes: number, ceilingBytes?: number): MemorySnapshot['pressure'];
