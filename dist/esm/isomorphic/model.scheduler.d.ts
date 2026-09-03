import type { MemorySnapshot } from './provider.interface';
import { type ModelLoadMemoryOpts } from './wasmMemoryPolicy';
export type WasmAdmissionContext = {
    wasmLinearBytes?: number;
    wasmPoolCeilingBytes?: number;
    loadOpts?: ModelLoadMemoryOpts;
    skipWasm?: boolean;
};
export interface Scheduler {
    ensureCapacity(modelId: string, modelBytes: number, memory: MemorySnapshot, reserveBytes?: number, wasm?: WasmAdmissionContext): void;
    markLoaded(modelId: string, modelBytes?: number, loadOpts?: ModelLoadMemoryOpts, measuredFootprintBytes?: number): void;
    markUnloaded(modelId: string): void;
    listLoaded(): string[];
    totalFootprintBytes(): number;
    calibrateFootprint(modelId: string, measuredFootprintBytes: number): void;
    getFootprintBytes(modelId: string): number | undefined;
}
export declare class DefaultModelScheduler implements Scheduler {
    private maxModels;
    private loaded;
    private footprints;
    constructor(maxModels?: number);
    ensureCapacity(modelId: string, modelBytes: number, memory: MemorySnapshot, reserveBytes?: number, wasm?: WasmAdmissionContext): void;
    markLoaded(modelId: string, modelBytes?: number, loadOpts?: ModelLoadMemoryOpts, measuredFootprintBytes?: number): void;
    /** Replace formula footprint with post-load measured WASM bytes. */
    calibrateFootprint(modelId: string, measuredFootprintBytes: number): void;
    getFootprintBytes(modelId: string): number | undefined;
    markUnloaded(modelId: string): void;
    listLoaded(): string[];
    totalFootprintBytes(): number;
}
