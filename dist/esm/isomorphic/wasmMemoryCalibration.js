const WARM_HEAP_BYTES = 64 * 1024 * 1024;
/** Bytes used for scheduling — measured when calibrated, else estimate. */
export function resolveFootprintBytes(entry, fallbackEstimate) {
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
export function calibrateFootprintFromLinearDelta(linearBefore, linearAfter, estimatedBytes, options) {
    const delta = Math.max(0, linearAfter - linearBefore);
    if ((options === null || options === void 0 ? void 0 : options.firstModelInHeap) && linearAfter > WARM_HEAP_BYTES) {
        return linearAfter;
    }
    if (delta > 0) {
        return delta;
    }
    return estimatedBytes;
}
export function createFootprintEntry(fileBytes, estimatedBytes) {
    return { fileBytes, estimatedBytes };
}
export function applyCalibration(entry, linearBefore, linearAfter, firstModelInHeap) {
    const measuredBytes = calibrateFootprintFromLinearDelta(linearBefore, linearAfter, entry.estimatedBytes, { firstModelInHeap });
    return Object.assign(Object.assign({}, entry), { measuredBytes,
        linearBefore,
        linearAfter, calibratedAt: Date.now() });
}
export function sumResidentFootprintBytes(footprints, excludeModelId) {
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
export function projectWasmAfterLoad(input) {
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
//# sourceMappingURL=wasmMemoryCalibration.js.map