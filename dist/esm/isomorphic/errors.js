export class LlmError extends Error {
    constructor(code, message, meta) {
        super(message);
        this.name = 'LlmError';
        this.code = code;
        this.meta = meta;
    }
}
//# sourceMappingURL=errors.js.map