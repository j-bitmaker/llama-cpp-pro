export type ModelFootprintEntry = {
    fileBytes: number;
    estimatedBytes: number;
    measuredBytes?: number;
    linearBefore?: number;
    linearAfter?: number;
    calibratedAt?: number;
};
export type WasmProjectionInput = {
    wasmLinearBytes: number;
    residentModelCount: number;
    residentFootprintBytes: number;
    candidateEstimateBytes: number;
    candidateMeasuredBytes?: number;
};
/** Bytes used for scheduling — measured when calibrated, else estimate. */
export declare function resolveFootprintBytes(entry: ModelFootprintEntry | number | undefined, fallbackEstimate: number): number;
/** Attribute heap growth to one model load (delta from linear before → after). */
export declare function calibrateFootprintFromLinearDelta(linearBefore: number, linearAfter: number, estimatedBytes: number, options?: {
    firstModelInHeap?: boolean;
}): number;
export declare function createFootprintEntry(fileBytes: number, estimatedBytes: number): ModelFootprintEntry;
export declare function applyCalibration(entry: ModelFootprintEntry, linearBefore: number, linearAfter: number, firstModelInHeap: boolean): ModelFootprintEntry;
export declare function sumResidentFootprintBytes(footprints: Map<string, ModelFootprintEntry | number>, excludeModelId?: string): number;
/** Project WASM pool usage after admitting one more model (footprint-based). */
export declare function projectWasmAfterLoad(input: WasmProjectionInput): number;
