export function canAdmitModel(input) {
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
//# sourceMappingURL=model.admission.js.map