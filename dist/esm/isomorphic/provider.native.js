import { Capacitor, registerPlugin } from '@capacitor/core';
import { LlmError } from './errors';
import { DefaultModelScheduler } from './model.scheduler';
const EVENT_ON_TOKEN = '@LlamaCpp_onToken';
const MAX_MODELS = 5;
/** Prefer the plugin instance registered by src/index.ts. */
const getPlugin = () => {
    var _a, _b, _c, _d;
    const caps = Capacitor;
    return ((_d = (_b = (_a = caps.Plugins) === null || _a === void 0 ? void 0 : _a.LlamaCpp) !== null && _b !== void 0 ? _b : (_c = caps.getPlugin) === null || _c === void 0 ? void 0 : _c.call(caps, 'LlamaCpp')) !== null && _d !== void 0 ? _d : registerPlugin('LlamaCpp'));
};
export class NativeProvider {
    constructor() {
        this.platform = 'native';
        this.contextByModel = new Map();
        this.nextContextId = 1;
        this.scheduler = new DefaultModelScheduler(MAX_MODELS);
    }
    async initialize(opts) {
        await getPlugin().setContextLimit({ limit: MAX_MODELS });
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
        const listener = await getPlugin().addListener(EVENT_ON_TOKEN, (evt) => {
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
                maxModels: MAX_MODELS,
                schedulerLoadedModels: this.scheduler.listLoaded().length,
            },
        };
    }
}
//# sourceMappingURL=provider.native.js.map