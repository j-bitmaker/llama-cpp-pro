var _a;
import { __rest } from "tslib";
import { registerPlugin } from '@capacitor/core';
// Constants
export const LLAMACPP_MTMD_DEFAULT_MEDIA_MARKER = '<__media__>';
// Event names
const EVENT_ON_INIT_CONTEXT_PROGRESS = '@LlamaCpp_onInitContextProgress';
const EVENT_ON_TOKEN = '@LlamaCpp_onToken';
const EVENT_ON_NATIVE_LOG = '@LlamaCpp_onNativeLog';
// Register the plugin — web uses WASM; Electron desktop uses sidecar (via LlamaCppDesktop).
const LlamaCpp = registerPlugin('LlamaCpp', {
    web: () => import('./isomorphic/desktop.runtime').then(async ({ isDesktopRuntime }) => {
        if (isDesktopRuntime()) {
            const m = await import('./desktop');
            return new m.LlamaCppDesktop();
        }
        const w = await import('./web');
        return new w.LlamaCppWeb();
    }),
});
// Log listeners management
const logListeners = [];
// Best-effort wiring: Capacitor stubs can throw synchronously when a platform
// implementation is not ready yet (Node/CJS load, first paint before web impl).
try {
    const sub = LlamaCpp.addListener(EVENT_ON_NATIVE_LOG, (evt) => {
        logListeners.forEach((listener) => listener(evt.level, evt.text));
    });
    if (sub && typeof sub.catch === 'function') {
        sub.catch(() => { });
    }
}
catch (_b) {
    /* ignore until platform impl is loaded */
}
try {
    const p = (_a = LlamaCpp.toggleNativeLog) === null || _a === void 0 ? void 0 : _a.call(LlamaCpp, { enabled: false });
    if (p && typeof p.catch === 'function') {
        p.catch(() => { });
    }
}
catch (_c) {
    /* ignore unimplemented / sync stub throw */
}
export const RNLLAMA_MTMD_DEFAULT_MEDIA_MARKER = LLAMACPP_MTMD_DEFAULT_MEDIA_MARKER;
const validCacheTypes = [
    'f16',
    'f32',
    'bf16',
    'q8_0',
    'q4_0',
    'q4_1',
    'iq4_nl',
    'q5_0',
    'q5_1',
];
const getJsonSchema = (responseFormat) => {
    var _a;
    if ((responseFormat === null || responseFormat === void 0 ? void 0 : responseFormat.type) === 'json_schema') {
        return (_a = responseFormat.json_schema) === null || _a === void 0 ? void 0 : _a.schema;
    }
    if ((responseFormat === null || responseFormat === void 0 ? void 0 : responseFormat.type) === 'json_object') {
        return responseFormat.schema || {};
    }
    return null;
};
// Utility function to convert JSON schema to GBNF grammar
const jsonSchemaToGrammar = async (schema) => {
    // This will call the native method to convert JSON schema to GBNF
    // For now, we'll return a basic implementation
    try {
        const result = await LlamaCpp.convertJsonSchemaToGrammar({ schema: JSON.stringify(schema) });
        return result;
    }
    catch (error) {
        console.warn('Failed to convert JSON schema to GBNF, using fallback:', error);
        // Fallback for basic object structure
        return `root ::= "{" ws object_content ws "}"
object_content ::= string_field ("," ws string_field)*
string_field ::= "\\"" [a-zA-Z_][a-zA-Z0-9_]* "\\"" ws ":" ws value
value ::= string | number | boolean | "null"
string ::= "\\"" [^"]* "\\""
number ::= "-"? [0-9]+ ("." [0-9]+)?
boolean ::= "true" | "false"
ws ::= [ \\t\\n]*`;
    }
};
export class LlamaContext {
    constructor({ contextId, gpu, reasonNoGPU, model }) {
        this.gpu = false;
        this.reasonNoGPU = '';
        this.id = contextId;
        this.gpu = gpu;
        this.reasonNoGPU = reasonNoGPU;
        this.model = model;
    }
    /**
     * Load cached prompt & completion state from a file.
     */
    async loadSession(filepath) {
        let path = filepath;
        if (path.startsWith('file://'))
            path = path.slice(7);
        return LlamaCpp.loadSession({ contextId: this.id, filepath: path });
    }
    /**
     * Save current cached prompt & completion state to a file.
     */
    async saveSession(filepath, options) {
        return LlamaCpp.saveSession({
            contextId: this.id,
            filepath,
            size: (options === null || options === void 0 ? void 0 : options.tokenSize) || -1
        });
    }
    isLlamaChatSupported() {
        return !!this.model.chatTemplates.llamaChat;
    }
    isJinjaSupported() {
        const { minja } = this.model.chatTemplates;
        return !!(minja === null || minja === void 0 ? void 0 : minja.toolUse) || !!(minja === null || minja === void 0 ? void 0 : minja.default);
    }
    async getFormattedChat(messages, template, params) {
        var _a;
        const mediaPaths = [];
        const chat = messages.map((msg) => {
            if (Array.isArray(msg.content)) {
                const content = msg.content.map((part) => {
                    var _a;
                    // Handle multimodal content
                    if (part.type === 'image_url') {
                        let path = ((_a = part.image_url) === null || _a === void 0 ? void 0 : _a.url) || '';
                        if (path === null || path === void 0 ? void 0 : path.startsWith('file://'))
                            path = path.slice(7);
                        mediaPaths.push(path);
                        return {
                            type: 'text',
                            text: RNLLAMA_MTMD_DEFAULT_MEDIA_MARKER,
                        };
                    }
                    else if (part.type === 'input_audio') {
                        const { input_audio: audio } = part;
                        if (!audio)
                            throw new Error('input_audio is required');
                        const { format } = audio;
                        if (format != 'wav' && format != 'mp3') {
                            throw new Error(`Unsupported audio format: ${format}`);
                        }
                        if (audio.url) {
                            const path = audio.url.replace(/file:\/\//, '');
                            mediaPaths.push(path);
                        }
                        else if (audio.data) {
                            mediaPaths.push(audio.data);
                        }
                        return {
                            type: 'text',
                            text: RNLLAMA_MTMD_DEFAULT_MEDIA_MARKER,
                        };
                    }
                    return part;
                });
                return Object.assign(Object.assign({}, msg), { content });
            }
            return msg;
        });
        const useJinja = this.isJinjaSupported() && (params === null || params === void 0 ? void 0 : params.jinja);
        let tmpl;
        if (template)
            tmpl = template; // Force replace if provided
        const jsonSchema = getJsonSchema(params === null || params === void 0 ? void 0 : params.response_format);
        const result = await LlamaCpp.getFormattedChat({
            contextId: this.id,
            messages: JSON.stringify(chat),
            chatTemplate: tmpl,
            params: {
                jinja: useJinja,
                json_schema: jsonSchema ? JSON.stringify(jsonSchema) : undefined,
                tools: (params === null || params === void 0 ? void 0 : params.tools) ? JSON.stringify(params.tools) : undefined,
                parallel_tool_calls: (params === null || params === void 0 ? void 0 : params.parallel_tool_calls)
                    ? JSON.stringify(params.parallel_tool_calls)
                    : undefined,
                tool_choice: params === null || params === void 0 ? void 0 : params.tool_choice,
                enable_thinking: (_a = params === null || params === void 0 ? void 0 : params.enable_thinking) !== null && _a !== void 0 ? _a : true,
                add_generation_prompt: params === null || params === void 0 ? void 0 : params.add_generation_prompt,
                now: typeof (params === null || params === void 0 ? void 0 : params.now) === 'number' ? params.now.toString() : params === null || params === void 0 ? void 0 : params.now,
                chat_template_kwargs: (params === null || params === void 0 ? void 0 : params.chat_template_kwargs) ? JSON.stringify(Object.entries(params.chat_template_kwargs).reduce((acc, [key, value]) => {
                    acc[key] = JSON.stringify(value); // Each value is a stringified JSON object
                    return acc;
                }, {})) : undefined,
            },
        });
        if (!useJinja) {
            return {
                type: 'llama-chat',
                prompt: result,
                has_media: mediaPaths.length > 0,
                media_paths: mediaPaths,
            };
        }
        const jinjaResult = result;
        jinjaResult.type = 'jinja';
        jinjaResult.has_media = mediaPaths.length > 0;
        jinjaResult.media_paths = mediaPaths;
        return jinjaResult;
    }
    /**
     * Generate a completion based on the provided parameters
     * @param params Completion parameters including prompt or messages
     * @param callback Optional callback for token-by-token streaming
     * @returns Promise resolving to the completion result
     *
     * Note: For multimodal support, you can include an media_paths parameter.
     * This will process the images and add them to the context before generating text.
     * Multimodal support must be enabled via initMultimodal() first.
     */
    async completion(params, callback) {
        const nativeParams = Object.assign(Object.assign({}, params), { prompt: params.prompt || '', emit_partial_completion: !!callback });
        if (params.messages) {
            const formattedResult = await this.getFormattedChat(params.messages, params.chat_template || params.chatTemplate, {
                jinja: params.jinja,
                tools: params.tools,
                parallel_tool_calls: params.parallel_tool_calls,
                tool_choice: params.tool_choice,
                enable_thinking: params.enable_thinking,
                add_generation_prompt: params.add_generation_prompt,
                now: params.now,
                chat_template_kwargs: params.chat_template_kwargs,
            });
            if (formattedResult.type === 'jinja') {
                const jinjaResult = formattedResult;
                nativeParams.prompt = jinjaResult.prompt || '';
                if (typeof jinjaResult.chat_format === 'number')
                    nativeParams.chat_format = jinjaResult.chat_format;
                if (jinjaResult.grammar)
                    nativeParams.grammar = jinjaResult.grammar;
                if (typeof jinjaResult.grammar_lazy === 'boolean')
                    nativeParams.grammar_lazy = jinjaResult.grammar_lazy;
                if (jinjaResult.grammar_triggers)
                    nativeParams.grammar_triggers = jinjaResult.grammar_triggers;
                if (jinjaResult.preserved_tokens)
                    nativeParams.preserved_tokens = jinjaResult.preserved_tokens;
                if (jinjaResult.additional_stops) {
                    if (!nativeParams.stop)
                        nativeParams.stop = [];
                    nativeParams.stop.push(...jinjaResult.additional_stops);
                }
                if (jinjaResult.has_media) {
                    nativeParams.media_paths = jinjaResult.media_paths;
                }
            }
            else if (formattedResult.type === 'llama-chat') {
                const llamaChatResult = formattedResult;
                nativeParams.prompt = llamaChatResult.prompt || '';
                if (llamaChatResult.has_media) {
                    nativeParams.media_paths = llamaChatResult.media_paths;
                }
            }
        }
        else {
            nativeParams.prompt = params.prompt || '';
        }
        // If media_paths were explicitly provided or extracted from messages, use them
        if (!nativeParams.media_paths && params.media_paths) {
            nativeParams.media_paths = params.media_paths;
        }
        // Handle structured output and grammar
        if (params.grammar) {
            // Direct GBNF grammar takes precedence
            nativeParams.grammar = params.grammar;
        }
        else if (nativeParams.response_format && !nativeParams.grammar) {
            const jsonSchema = getJsonSchema(params.response_format);
            if (jsonSchema) {
                // Try to convert JSON schema to GBNF grammar
                try {
                    nativeParams.grammar = await jsonSchemaToGrammar(jsonSchema);
                }
                catch (error) {
                    console.warn('Failed to convert JSON schema to grammar, falling back to json_schema parameter:', error);
                    nativeParams.json_schema = JSON.stringify(jsonSchema);
                }
            }
        }
        let tokenListener = callback &&
            LlamaCpp.addListener(EVENT_ON_TOKEN, (evt) => {
                const { contextId, tokenResult } = evt;
                if (contextId !== this.id)
                    return;
                callback(tokenResult);
            });
        if (!nativeParams.prompt)
            throw new Error('Prompt is required');
        const promise = LlamaCpp.completion({ contextId: this.id, params: nativeParams });
        return promise
            .then((completionResult) => {
            tokenListener === null || tokenListener === void 0 ? void 0 : tokenListener.remove();
            tokenListener = null;
            return completionResult;
        })
            .catch((err) => {
            tokenListener === null || tokenListener === void 0 ? void 0 : tokenListener.remove();
            tokenListener = null;
            throw err;
        });
    }
    stopCompletion() {
        return LlamaCpp.stopCompletion({ contextId: this.id });
    }
    /**
     * Tokenize text or text with images
     * @param text Text to tokenize
     * @param params.media_paths Array of image paths to tokenize (if multimodal is enabled)
     * @returns Promise resolving to the tokenize result
     */
    tokenize(text, { media_paths: mediaPaths, } = {}) {
        return LlamaCpp.tokenize({ contextId: this.id, text, imagePaths: mediaPaths });
    }
    detokenize(tokens) {
        return LlamaCpp.detokenize({ contextId: this.id, tokens });
    }
    embedding(text, params) {
        return LlamaCpp.embedding({ contextId: this.id, text, params: params || {} });
    }
    /**
     * Rerank documents based on relevance to a query
     * @param query The query text to rank documents against
     * @param documents Array of document texts to rank
     * @param params Optional reranking parameters
     * @returns Promise resolving to an array of ranking results with scores and indices
     */
    async rerank(query, documents, params) {
        const results = await LlamaCpp.rerank({
            contextId: this.id,
            query,
            documents,
            params: params || {}
        });
        // Sort by score descending and add document text if requested
        return results
            .map((result) => (Object.assign(Object.assign({}, result), { document: documents[result.index] })))
            .sort((a, b) => b.score - a.score);
    }
    async bench(pp, tg, pl, nr) {
        const result = await LlamaCpp.bench({ contextId: this.id, pp, tg, pl, nr });
        const [modelDesc, modelSize, modelNParams, ppAvg, ppStd, tgAvg, tgStd] = JSON.parse(result);
        return {
            modelDesc,
            modelSize,
            modelNParams,
            ppAvg,
            ppStd,
            tgAvg,
            tgStd,
        };
    }
    async applyLoraAdapters(loraList) {
        let loraAdapters = [];
        if (loraList)
            loraAdapters = loraList.map((l) => ({
                path: l.path.replace(/file:\/\//, ''),
                scaled: l.scaled,
            }));
        return LlamaCpp.applyLoraAdapters({ contextId: this.id, loraAdapters });
    }
    async removeLoraAdapters() {
        return LlamaCpp.removeLoraAdapters({ contextId: this.id });
    }
    async getLoadedLoraAdapters() {
        return LlamaCpp.getLoadedLoraAdapters({ contextId: this.id });
    }
    /**
     * Initialize multimodal support with a mmproj file
     * @param params Parameters for multimodal support
     * @param params.path Path to the multimodal projector file
     * @param params.use_gpu Whether to use GPU
     * @returns Promise resolving to true if initialization was successful
     */
    async initMultimodal({ path, use_gpu: useGpu, }) {
        if (path.startsWith('file://'))
            path = path.slice(7);
        return LlamaCpp.initMultimodal({
            contextId: this.id,
            params: {
                path,
                use_gpu: useGpu !== null && useGpu !== void 0 ? useGpu : true,
            },
        });
    }
    /**
     * Check if multimodal support is enabled
     * @returns Promise resolving to true if multimodal is enabled
     */
    async isMultimodalEnabled() {
        return await LlamaCpp.isMultimodalEnabled({ contextId: this.id });
    }
    /**
     * Check multimodal support
     * @returns Promise resolving to an object with vision and audio support
     */
    async getMultimodalSupport() {
        return await LlamaCpp.getMultimodalSupport({ contextId: this.id });
    }
    /**
     * Release multimodal support
     * @returns Promise resolving to void
     */
    async releaseMultimodal() {
        return await LlamaCpp.releaseMultimodal({ contextId: this.id });
    }
    /**
     * Initialize TTS support with a vocoder model
     * @param params Parameters for TTS support
     * @param params.path Path to the vocoder model
     * @param params.n_batch Batch size for the vocoder model
     * @returns Promise resolving to true if initialization was successful
     */
    async initVocoder({ path, n_batch: nBatch }) {
        if (path.startsWith('file://'))
            path = path.slice(7);
        return await LlamaCpp.initVocoder({
            contextId: this.id,
            params: { path, n_batch: nBatch }
        });
    }
    /**
     * Check if TTS support is enabled
     * @returns Promise resolving to true if TTS is enabled
     */
    async isVocoderEnabled() {
        return await LlamaCpp.isVocoderEnabled({ contextId: this.id });
    }
    /**
     * Get a formatted audio completion prompt
     * @param speakerJsonStr JSON string representing the speaker
     * @param textToSpeak Text to speak
     * @returns Promise resolving to the formatted audio completion result with prompt and grammar
     */
    async getFormattedAudioCompletion(speaker, textToSpeak) {
        return await LlamaCpp.getFormattedAudioCompletion({
            contextId: this.id,
            speakerJsonStr: speaker ? JSON.stringify(speaker) : '',
            textToSpeak,
        });
    }
    /**
     * Get guide tokens for audio completion
     * @param textToSpeak Text to speak
     * @returns Promise resolving to the guide tokens
     */
    async getAudioCompletionGuideTokens(textToSpeak) {
        return await LlamaCpp.getAudioCompletionGuideTokens({ contextId: this.id, textToSpeak });
    }
    /**
     * Decode audio tokens
     * @param tokens Array of audio tokens
     * @returns Promise resolving to the decoded audio tokens
     */
    async decodeAudioTokens(tokens) {
        return await LlamaCpp.decodeAudioTokens({ contextId: this.id, tokens });
    }
    /**
     * Release TTS support
     * @returns Promise resolving to void
     */
    async releaseVocoder() {
        return await LlamaCpp.releaseVocoder({ contextId: this.id });
    }
    async release() {
        return LlamaCpp.releaseContext({ contextId: this.id });
    }
}
export async function toggleNativeLog(enabled) {
    return LlamaCpp.toggleNativeLog({ enabled });
}
export function addNativeLogListener(listener) {
    logListeners.push(listener);
    return {
        remove: () => {
            logListeners.splice(logListeners.indexOf(listener), 1);
        },
    };
}
export async function setContextLimit(limit) {
    return LlamaCpp.setContextLimit({ limit });
}
// Fix #14: pure monotonic counter — adding random() caused ID collisions when
// counter + random happened to produce the same value on successive calls.
let contextIdCounter = 0;
const modelInfoSkip = [
    // Large fields
    'tokenizer.ggml.tokens',
    'tokenizer.ggml.token_type',
    'tokenizer.ggml.merges',
    'tokenizer.ggml.scores',
];
export async function loadLlamaModelInfo(model) {
    let path = model;
    if (path.startsWith('file://'))
        path = path.slice(7);
    return LlamaCpp.modelInfo({ path, skip: modelInfoSkip });
}
const poolTypeMap = {
    // -1 is unspecified as undefined
    none: 0,
    mean: 1,
    cls: 2,
    last: 3,
    rank: 4,
};
export async function initLlama(_a, onProgress) {
    var { model, is_model_asset: isModelAsset, pooling_type: poolingType, lora, lora_list: loraList } = _a, rest = __rest(_a, ["model", "is_model_asset", "pooling_type", "lora", "lora_list"]);
    let path = model;
    if (path.startsWith('file://'))
        path = path.slice(7);
    let loraPath = lora;
    if (loraPath === null || loraPath === void 0 ? void 0 : loraPath.startsWith('file://'))
        loraPath = loraPath.slice(7);
    let loraAdapters = [];
    if (loraList)
        loraAdapters = loraList.map((l) => ({
            path: l.path.replace(/file:\/\//, ''),
            scaled: l.scaled,
        }));
    const contextId = ++contextIdCounter;
    let removeProgressListener = null;
    if (onProgress) {
        removeProgressListener = LlamaCpp.addListener(EVENT_ON_INIT_CONTEXT_PROGRESS, (evt) => {
            if (evt.contextId !== contextId)
                return;
            onProgress(evt.progress);
        });
    }
    const poolType = poolTypeMap[poolingType];
    if (rest.cache_type_k && !validCacheTypes.includes(rest.cache_type_k)) {
        console.warn(`[LlamaCpp] initLlama: Invalid cache K type: ${rest.cache_type_k}, falling back to f16`);
        delete rest.cache_type_k;
    }
    if (rest.cache_type_v && !validCacheTypes.includes(rest.cache_type_v)) {
        console.warn(`[LlamaCpp] initLlama: Invalid cache V type: ${rest.cache_type_v}, falling back to f16`);
        delete rest.cache_type_v;
    }
    // Log speculative decoding configuration if enabled
    if (rest.draft_model) {
        console.log(`🚀 Initializing with speculative decoding:
      - Main model: ${path}
      - Draft model: ${rest.draft_model}
      - Speculative samples: ${rest.speculative_samples || 3}
      - Mobile optimization: ${rest.mobile_speculative !== false ? 'enabled' : 'disabled'}`);
    }
    const { gpu, reasonNoGPU, model: modelDetails, androidLib, } = await LlamaCpp.initContext({
        contextId,
        params: Object.assign({ model: path, is_model_asset: !!isModelAsset, use_progress_callback: !!onProgress, pooling_type: poolType, lora: loraPath, lora_list: loraAdapters }, rest),
    }).catch((err) => {
        removeProgressListener === null || removeProgressListener === void 0 ? void 0 : removeProgressListener.remove();
        throw err;
    });
    removeProgressListener === null || removeProgressListener === void 0 ? void 0 : removeProgressListener.remove();
    return new LlamaContext({
        contextId,
        gpu,
        reasonNoGPU,
        model: modelDetails,
        androidLib,
    });
}
export async function releaseAllLlama() {
    return LlamaCpp.releaseAllContexts();
}
// Model download and management functions
export async function downloadModel(url, filename) {
    return LlamaCpp.downloadModel({ url, filename });
}
export async function getDownloadProgress(url) {
    return LlamaCpp.getDownloadProgress({ url });
}
export async function cancelDownload(url) {
    return LlamaCpp.cancelDownload({ url });
}
export async function getAvailableModels() {
    return LlamaCpp.getAvailableModels();
}
/**
 * Convert a JSON schema to GBNF grammar format
 * @param schema JSON schema object
 * @returns Promise resolving to GBNF grammar string
 */
export async function convertJsonSchemaToGrammar(schema) {
    return jsonSchemaToGrammar(schema);
}
export const BuildInfo = {
    number: '1.0.0',
    commit: 'capacitor-llama-cpp',
};
// Re-export the plugin for direct access
export { LlamaCpp };
// Isomorphic provider exports (Phase 0/1 scaffold)
export * from './isomorphic/provider.interface';
export * from './isomorphic/errors';
export * from './isomorphic/provider.factory';
export * from './isomorphic/provider.native';
export * from './isomorphic/provider.web';
export * from './isomorphic/provider.desktop';
export * from './isomorphic/desktop.runtime';
export { LlamaCppDesktop } from './desktop';
export * from './isomorphic/model.admission';
export * from './isomorphic/model.scheduler';
export * from './isomorphic/wasmMemoryPolicy';
export * from './isomorphic/wasmMemoryCalibration';
export * from './storage/manifest';
export * from './storage/opfs.store';
//# sourceMappingURL=index.js.map