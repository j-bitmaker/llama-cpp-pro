import { canAdmitModel } from './model.admission';
import { canAdmitWasmModelLoad, estimateModelWasmFootprint, WASM_MAX_CONCURRENT_MODELS, WASM_POOL_CEILING_BYTES, } from './wasmMemoryPolicy';
import { LlmError } from './errors';
export class DefaultModelScheduler {
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
                modelId,
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
            modelId,
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
//# sourceMappingURL=model.scheduler.js.map