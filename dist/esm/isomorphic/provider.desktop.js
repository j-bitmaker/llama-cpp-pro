import { getDesktopBridge, getDesktopSidecarPort } from './desktop.runtime';
import { readSidecarSseTokens } from './sidecar-sse';
import { WebProvider } from './provider.web';
import { LlmError } from './errors';
import { DefaultModelScheduler } from './model.scheduler';
import { WASM_MAX_CONCURRENT_MODELS } from './wasmMemoryPolicy';
const MAX_MODELS = WASM_MAX_CONCURRENT_MODELS;
/**
 * Desktop LLM provider: native sidecar (HTTP) for GPU/CPU inference;
 * WASM worker for multimodal, LoRA, TTS, bench (inherited via composition).
 * Sidecar path supports up to 5 concurrent models with admission control.
 */
export class DesktopProvider extends WebProvider {
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
//# sourceMappingURL=provider.desktop.js.map