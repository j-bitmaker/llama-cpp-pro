import { WebProvider } from './isomorphic/provider.web';
import { ensureModelInOpfs } from './storage/opfs.store';
import { listManifestEntries } from './storage/manifest';
// ---------------------------------------------------------------------------
// Fix #4: LlamaCppWeb now delegates real inference work to WebProvider so
// that calling the standard Capacitor LlamaCpp API on the web platform routes
// through the WASM engine rather than throwing "not supported" errors.
// ---------------------------------------------------------------------------
const MODEL_DESC_STUB = {
    desc: 'WASM model',
    size: 0,
    nEmbd: 0,
    nParams: 0,
    chatTemplates: {
        llamaChat: true,
        minja: {
            default: true,
            defaultCaps: {
                tools: false, toolCalls: false, toolResponses: false,
                systemRole: true, parallelToolCalls: false, toolCallId: false,
            },
            toolUse: false,
            toolUseCaps: {
                tools: false, toolCalls: false, toolResponses: false,
                systemRole: true, parallelToolCalls: false, toolCallId: false,
            },
        },
    },
    metadata: {},
    isChatTemplateSupported: true,
};
/**
 * Format a message array into a prompt string using the specified template.
 * Supports the four most common open-weight model formats. Defaults to ChatML.
 */
function formatMessagesWithTemplate(messages, template) {
    const tpl = (template !== null && template !== void 0 ? template : 'chatml').toLowerCase();
    if (tpl === 'llama3' || tpl === 'llama-3') {
        const parts = messages.map((m) => `<|start_header_id|>${m.role}<|end_header_id|>\n\n${m.content}<|eot_id|>`);
        return `<|begin_of_text|>${parts.join('')}<|start_header_id|>assistant<|end_header_id|>\n\n`;
    }
    if (tpl === 'mistral') {
        // Mistral: [INST] user [/INST] assistant </s> [INST] ...
        let out = '';
        for (let i = 0; i < messages.length; i++) {
            const m = messages[i];
            if (m.role === 'system') {
                out += `[INST] ${m.content}\n`;
            }
            else if (m.role === 'user') {
                out += `[INST] ${m.content} [/INST]`;
            }
            else if (m.role === 'assistant') {
                out += ` ${m.content}</s>`;
            }
        }
        return out;
    }
    if (tpl === 'gemma' || tpl === 'gemma2') {
        const parts = messages.map((m) => `<start_of_turn>${m.role}\n${m.content}<end_of_turn>`);
        return `${parts.join('\n')}\n<start_of_turn>model\n`;
    }
    // Default: ChatML — widely used by Qwen, Phi, Hermes, OpenChat, etc.
    const parts = messages.map((m) => `<|im_start|>${m.role}\n${m.content}<|im_end|>`);
    return `${parts.join('\n')}\n<|im_start|>assistant\n`;
}
const activeDownloads = new Map();
/** Map a user-facing path to a WASM VFS path (MEMFS /tmp). */
function vfsPathForWeb(filepath) {
    var _a;
    if (filepath.startsWith('/'))
        return filepath;
    const base = (_a = filepath.split(/[/\\]/).pop()) !== null && _a !== void 0 ? _a : 'file.bin';
    return `/tmp/${base}`;
}
export class LlamaCppWeb {
    constructor() {
        this.provider = new WebProvider();
        // contextId → modelId
        this.contextToModel = new Map();
        // eventName → Set of listener callbacks
        this.listeners = new Map();
    }
    emitListener(eventName, data) {
        var _a;
        (_a = this.listeners.get(eventName)) === null || _a === void 0 ? void 0 : _a.forEach((cb) => cb(data));
    }
    hasListeners(eventName) {
        const set = this.listeners.get(eventName);
        return !!set && set.size > 0;
    }
    // -------------------------------------------------------------------------
    // Core initialization
    // -------------------------------------------------------------------------
    async toggleNativeLog() {
        // No-op on web; no native log callback to toggle.
    }
    async setContextLimit(_opts) {
        // No-op on web; WebProvider manages its own slot limit via DefaultModelScheduler.
    }
    async modelInfo({ path }) {
        var _a;
        const entry = await listManifestEntries().then((es) => es.find((e) => e.modelId === path || e.path === path));
        return Object.assign(Object.assign({}, MODEL_DESC_STUB), { path, desc: 'WASM model (web)', size: (_a = entry === null || entry === void 0 ? void 0 : entry.sizeBytes) !== null && _a !== void 0 ? _a : 0 });
    }
    async initContext({ contextId, params, }) {
        var _a;
        // Use the model path/URL as the modelId for the isomorphic layer.
        const modelId = params.model;
        await this.provider.initialize({
            modelId,
            modelPath: params.model,
            // If model is a URL, ensureModelInOpfs will download it; if it's an
            // OPFS-relative path, WebProvider will look it up in the manifest.
            modelUrl: ((_a = params.model) === null || _a === void 0 ? void 0 : _a.startsWith('http')) ? params.model : undefined,
            n_ctx: params.n_ctx,
            n_threads: params.n_threads,
            embedding: params.embedding,
        });
        this.contextToModel.set(contextId, modelId);
        return {
            contextId,
            gpu: false,
            reasonNoGPU: 'WebAssembly does not expose GPU acceleration in browsers',
            model: MODEL_DESC_STUB,
        };
    }
    async releaseContext({ contextId }) {
        const modelId = this.contextToModel.get(contextId);
        if (modelId) {
            await this.provider.unloadModel(modelId);
            this.contextToModel.delete(contextId);
        }
    }
    async releaseAllContexts() {
        for (const [contextId, modelId] of this.contextToModel.entries()) {
            await this.provider.unloadModel(modelId).catch(() => { });
            this.contextToModel.delete(contextId);
        }
    }
    // -------------------------------------------------------------------------
    // Chat and completion
    // -------------------------------------------------------------------------
    async getFormattedChat({ contextId, messages, chatTemplate, params, }) {
        const parsed = JSON.parse(messages);
        // If the provider exposes a native getFormattedChat (desktop sidecar or WASM with Jinja),
        // delegate to it so model-embedded templates are used instead of client-side formatters.
        const modelId = this.contextToModel.get(contextId);
        if (modelId && typeof this.provider.getFormattedChat === 'function') {
            try {
                return await this.provider.getFormattedChat(modelId, messages, chatTemplate, params);
            }
            catch (_a) {
                // Fall through to client-side formatting
            }
        }
        const prompt = formatMessagesWithTemplate(parsed, chatTemplate);
        return { type: 'llama-chat', prompt, has_media: false, media_paths: [] };
    }
    async completion({ contextId, params, }) {
        const modelId = this.contextToModel.get(contextId);
        if (!modelId)
            throw new Error('LlamaCppWeb: context not found');
        const wantStream = this.hasListeners('@LlamaCpp_onToken');
        const generateFn = wantStream
            ? this.provider.generateStream.bind(this.provider, {
                modelId,
                prompt: params.prompt,
                max_tokens: params.n_predict,
                temperature: params.temperature,
                top_p: params.top_p,
                top_k: params.top_k,
                min_p: params.min_p,
                repeat_penalty: params.penalty_repeat,
                seed: params.seed,
                stop: params.stop,
                grammar: params.grammar,
                stream: true,
            }, (evt) => {
                this.emitListener('@LlamaCpp_onToken', {
                    contextId,
                    token: evt.token,
                    index: evt.index,
                });
            })
            : () => this.provider.generate({
                modelId,
                prompt: params.prompt,
                max_tokens: params.n_predict,
                temperature: params.temperature,
                top_p: params.top_p,
                top_k: params.top_k,
                min_p: params.min_p,
                repeat_penalty: params.penalty_repeat,
                seed: params.seed,
                stop: params.stop,
                grammar: params.grammar,
                stream: false,
            });
        const result = await generateFn();
        return {
            text: result.text,
            content: result.text,
            reasoning_content: '',
            tool_calls: [],
            tokens_predicted: result.tokens_predicted,
            tokens_evaluated: result.tokens_evaluated,
            truncated: false,
            stopped_eos: result.finish_reason === 'stop',
            stopped_word: '',
            stopped_limit: result.finish_reason === 'length' ? 1 : 0,
            stopping_word: '',
            context_full: false,
            interrupted: result.finish_reason === 'error',
            tokens_cached: 0,
            chat_format: 0,
            timings: {
                prompt_n: result.tokens_evaluated,
                prompt_ms: 0,
                prompt_per_token_ms: 0,
                prompt_per_second: 0,
                predicted_n: result.tokens_predicted,
                predicted_ms: 0,
                predicted_per_token_ms: 0,
                predicted_per_second: 0,
            },
        };
    }
    // Fix #7: implement chat convenience helpers using proper template formatting
    async chat({ contextId, messages, system, chatTemplate, params }) {
        var _a;
        const allMessages = system
            ? [{ role: 'system', content: system }, ...messages]
            : messages;
        const formatted = await this.getFormattedChat({
            contextId,
            messages: JSON.stringify(allMessages),
            chatTemplate,
            params,
        });
        const prompt = (_a = formatted.prompt) !== null && _a !== void 0 ? _a : JSON.stringify(allMessages);
        return this.completion({ contextId, params: Object.assign(Object.assign({}, params), { prompt }) });
    }
    async chatWithSystem({ contextId, system, message, params }) {
        return this.chat({
            contextId,
            messages: [
                { role: 'system', content: system },
                { role: 'user', content: message },
            ],
            params,
        });
    }
    async generateText({ contextId, prompt, params }) {
        return this.completion({ contextId, params: Object.assign(Object.assign({}, params), { prompt }) });
    }
    async stopCompletion() {
        // Terminates the worker process; the model must be reloaded on the next call.
        this.provider.stopGeneration();
    }
    // -------------------------------------------------------------------------
    // Session management (WASM VFS — persist via /tmp paths in worker)
    // -------------------------------------------------------------------------
    async loadSession({ contextId, filepath, }) {
        const modelId = this.contextToModel.get(contextId);
        if (!modelId)
            throw new Error('LlamaCppWeb: context not found');
        return this.provider.loadSession(modelId, vfsPathForWeb(filepath));
    }
    async saveSession({ contextId, filepath, size, }) {
        const modelId = this.contextToModel.get(contextId);
        if (!modelId)
            throw new Error('LlamaCppWeb: context not found');
        return this.provider.saveSession(modelId, vfsPathForWeb(filepath), size);
    }
    // -------------------------------------------------------------------------
    // Tokenization
    // -------------------------------------------------------------------------
    async tokenize({ contextId, text, }) {
        const modelId = this.contextToModel.get(contextId);
        if (!modelId)
            throw new Error('LlamaCppWeb: context not found');
        const result = await this.provider.tokenize(modelId, text);
        return {
            tokens: result.tokens,
            has_images: false,
            bitmap_hashes: [],
            chunk_pos: [],
            chunk_pos_images: [],
        };
    }
    async detokenize({ contextId, tokens, }) {
        const modelId = this.contextToModel.get(contextId);
        if (!modelId)
            throw new Error('LlamaCppWeb: context not found');
        const result = await this.provider.detokenize(modelId, tokens);
        return result.text;
    }
    // -------------------------------------------------------------------------
    // Embeddings
    // -------------------------------------------------------------------------
    async embedding({ contextId, text }) {
        var _a;
        const modelId = this.contextToModel.get(contextId);
        if (!modelId)
            throw new Error('LlamaCppWeb: context not found');
        const result = await this.provider.embed({ modelId, input: text });
        return { embedding: (_a = result.vectors[0]) !== null && _a !== void 0 ? _a : [] };
    }
    async rerank({ contextId, query, documents, }) {
        const modelId = this.contextToModel.get(contextId);
        if (!modelId)
            throw new Error('LlamaCppWeb: context not found');
        return this.provider.rerank(modelId, query, documents);
    }
    // -------------------------------------------------------------------------
    // Benchmarking
    // -------------------------------------------------------------------------
    async bench({ contextId, pp, tg, pl, nr, }) {
        const modelId = this.contextToModel.get(contextId);
        if (!modelId)
            throw new Error('LlamaCppWeb: context not found');
        return this.provider.bench(modelId, pp, tg, pl, nr);
    }
    // -------------------------------------------------------------------------
    // LoRA adapters
    // -------------------------------------------------------------------------
    async applyLoraAdapters({ contextId, loraAdapters, }) {
        const modelId = this.contextToModel.get(contextId);
        if (!modelId)
            throw new Error('LlamaCppWeb: context not found');
        const mapped = loraAdapters.map((la) => (Object.assign(Object.assign({}, la), { path: vfsPathForWeb(la.path) })));
        await this.provider.applyLoraAdapters(modelId, mapped);
    }
    async removeLoraAdapters({ contextId }) {
        const modelId = this.contextToModel.get(contextId);
        if (!modelId)
            throw new Error('LlamaCppWeb: context not found');
        await this.provider.removeLoraAdapters(modelId);
    }
    async getLoadedLoraAdapters({ contextId, }) {
        const modelId = this.contextToModel.get(contextId);
        if (!modelId)
            throw new Error('LlamaCppWeb: context not found');
        return this.provider.getLoadedLoraAdapters(modelId);
    }
    // -------------------------------------------------------------------------
    // Multimodal
    // -------------------------------------------------------------------------
    async initMultimodal({ contextId, params, }) {
        var _a;
        const modelId = this.contextToModel.get(contextId);
        if (!modelId)
            throw new Error('LlamaCppWeb: context not found');
        return this.provider.initMultimodal(modelId, vfsPathForWeb(params.path), (_a = params.use_gpu) !== null && _a !== void 0 ? _a : false);
    }
    async isMultimodalEnabled({ contextId }) {
        const modelId = this.contextToModel.get(contextId);
        if (!modelId)
            return false;
        return this.provider.isMultimodalEnabled(modelId);
    }
    async getMultimodalSupport({ contextId }) {
        const modelId = this.contextToModel.get(contextId);
        if (!modelId)
            return { vision: false, audio: false };
        return this.provider.getMultimodalSupport(modelId);
    }
    async releaseMultimodal({ contextId }) {
        const modelId = this.contextToModel.get(contextId);
        if (!modelId)
            return;
        await this.provider.releaseMultimodal(modelId);
    }
    // -------------------------------------------------------------------------
    // TTS
    // -------------------------------------------------------------------------
    async initVocoder({ contextId, params, }) {
        var _a;
        const modelId = this.contextToModel.get(contextId);
        if (!modelId)
            throw new Error('LlamaCppWeb: context not found');
        return this.provider.initVocoder(modelId, vfsPathForWeb(params.path), (_a = params.n_batch) !== null && _a !== void 0 ? _a : 512);
    }
    async isVocoderEnabled({ contextId }) {
        const modelId = this.contextToModel.get(contextId);
        if (!modelId)
            return false;
        return this.provider.isVocoderEnabled(modelId);
    }
    async getFormattedAudioCompletion({ contextId, speakerJsonStr, textToSpeak, }) {
        const modelId = this.contextToModel.get(contextId);
        if (!modelId)
            throw new Error('LlamaCppWeb: context not found');
        const speaker = speakerJsonStr ? JSON.parse(speakerJsonStr) : null;
        return this.provider.getFormattedAudioCompletion(modelId, speaker, textToSpeak);
    }
    async getAudioCompletionGuideTokens({ contextId, textToSpeak, }) {
        const modelId = this.contextToModel.get(contextId);
        if (!modelId)
            throw new Error('LlamaCppWeb: context not found');
        return this.provider.getAudioCompletionGuideTokens(modelId, textToSpeak);
    }
    async decodeAudioTokens({ contextId, tokens, }) {
        const modelId = this.contextToModel.get(contextId);
        if (!modelId)
            throw new Error('LlamaCppWeb: context not found');
        return this.provider.decodeAudioTokens(modelId, tokens);
    }
    async releaseVocoder({ contextId }) {
        const modelId = this.contextToModel.get(contextId);
        if (!modelId)
            return;
        await this.provider.releaseVocoder(modelId);
    }
    // -------------------------------------------------------------------------
    // Fix #8: Model download / management — implemented via OPFS (#8)
    // -------------------------------------------------------------------------
    async downloadModel({ url, filename }) {
        const modelId = filename;
        const abortController = new AbortController();
        const entry = {
            abortController,
            promise: Promise.resolve(undefined),
            downloaded: 0,
            total: 0,
            completed: false,
            failed: false,
            errorMessage: undefined,
            localPath: undefined,
        };
        entry.promise = ensureModelInOpfs(modelId, url, (downloaded, total) => {
            entry.downloaded = downloaded;
            entry.total = total;
            this.emitListener('@LlamaCpp_onDownloadProgress', {
                url,
                modelId,
                downloaded,
                total,
                progress: total > 0 ? downloaded / total : 0,
            });
        }, abortController.signal)
            .then((manifest) => {
            entry.completed = true;
            entry.localPath = manifest.path;
            this.emitListener('@LlamaCpp_onDownloadComplete', { url, modelId, localPath: manifest.path });
        })
            .catch((err) => {
            const cancelled = abortController.signal.aborted;
            entry.failed = !cancelled;
            entry.errorMessage = err.message;
            if (!cancelled) {
                this.emitListener('@LlamaCpp_onDownloadError', { url, modelId, error: err.message });
            }
        });
        activeDownloads.set(url, entry);
        return modelId;
    }
    async getDownloadProgress({ url }) {
        const dl = activeDownloads.get(url);
        if (!dl) {
            return { progress: 0, completed: false, failed: false, downloadedBytes: 0, totalBytes: 0 };
        }
        const progress = dl.total > 0 ? dl.downloaded / dl.total : 0;
        return {
            progress,
            completed: dl.completed,
            failed: dl.failed,
            errorMessage: dl.errorMessage,
            localPath: dl.localPath,
            downloadedBytes: dl.downloaded,
            totalBytes: dl.total,
        };
    }
    async cancelDownload({ url }) {
        const entry = activeDownloads.get(url);
        if (!entry)
            return false;
        entry.abortController.abort();
        activeDownloads.delete(url);
        return true;
    }
    async getAvailableModels() {
        const entries = await listManifestEntries();
        return entries.map((e) => ({
            name: e.modelId,
            path: e.path,
            size: e.sizeBytes,
        }));
    }
    // -------------------------------------------------------------------------
    // Grammar utilities
    // -------------------------------------------------------------------------
    async convertJsonSchemaToGrammar({ schema, }) {
        return this.provider.convertJsonSchemaToGrammar(schema);
    }
    // -------------------------------------------------------------------------
    // Native server (not available on web)
    // -------------------------------------------------------------------------
    async startNativeLlamaServer(_options) {
        throw new Error('LlamaCppWeb: native server is only available on iOS/Android/Desktop');
    }
    async stopNativeLlamaServer() { }
    async isNativeLlamaServerRunning() {
        return { running: false };
    }
    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------
    async addListener(eventName, listenerFunc) {
        if (!this.listeners.has(eventName)) {
            this.listeners.set(eventName, new Set());
        }
        this.listeners.get(eventName).add(listenerFunc);
    }
    async removeAllListeners() {
        this.listeners.clear();
    }
}
export * from './definitions';
//# sourceMappingURL=web.js.map