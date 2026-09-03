import type { NativeContextParams, NativeLlamaContext, NativeCompletionParams, NativeCompletionTokenProb, NativeCompletionResult, NativeTokenizeResult, NativeEmbeddingResult, NativeSessionLoadResult, NativeEmbeddingParams, NativeRerankParams, NativeRerankResult, NativeCompletionTokenProbItem, NativeCompletionResultTimings, JinjaFormattedChatResult, FormattedChatResult, NativeImageProcessingResult, LlamaCppMessagePart, LlamaCppOAICompatibleMessage, ContextParams, EmbeddingParams, RerankParams, RerankResult, CompletionResponseFormat, CompletionParams, BenchResult, LlamaCppPlugin, ToolCall, TokenData } from './definitions';
export declare const LLAMACPP_MTMD_DEFAULT_MEDIA_MARKER = "<__media__>";
declare const LlamaCpp: LlamaCppPlugin;
export type RNLlamaMessagePart = LlamaCppMessagePart;
export type RNLlamaOAICompatibleMessage = LlamaCppOAICompatibleMessage;
export type { NativeContextParams, NativeLlamaContext, NativeCompletionParams, NativeCompletionTokenProb, NativeCompletionResult, NativeTokenizeResult, NativeEmbeddingResult, NativeSessionLoadResult, NativeEmbeddingParams, NativeRerankParams, NativeRerankResult, NativeCompletionTokenProbItem, NativeCompletionResultTimings, FormattedChatResult, JinjaFormattedChatResult, NativeImageProcessingResult, ContextParams, EmbeddingParams, RerankParams, RerankResult, CompletionResponseFormat, CompletionParams, BenchResult, ToolCall, TokenData, };
export declare const RNLLAMA_MTMD_DEFAULT_MEDIA_MARKER = "<__media__>";
export declare class LlamaContext {
    id: number;
    gpu: boolean;
    reasonNoGPU: string;
    model: NativeLlamaContext['model'];
    constructor({ contextId, gpu, reasonNoGPU, model }: NativeLlamaContext);
    /**
     * Load cached prompt & completion state from a file.
     */
    loadSession(filepath: string): Promise<NativeSessionLoadResult>;
    /**
     * Save current cached prompt & completion state to a file.
     */
    saveSession(filepath: string, options?: {
        tokenSize: number;
    }): Promise<number>;
    isLlamaChatSupported(): boolean;
    isJinjaSupported(): boolean;
    getFormattedChat(messages: RNLlamaOAICompatibleMessage[], template?: string | null, params?: {
        jinja?: boolean;
        response_format?: CompletionResponseFormat;
        tools?: object;
        parallel_tool_calls?: object;
        tool_choice?: string;
        enable_thinking?: boolean;
        add_generation_prompt?: boolean;
        now?: string | number;
        chat_template_kwargs?: Record<string, string>;
    }): Promise<FormattedChatResult | JinjaFormattedChatResult>;
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
    completion(params: CompletionParams, callback?: (data: TokenData) => void): Promise<NativeCompletionResult>;
    stopCompletion(): Promise<void>;
    /**
     * Tokenize text or text with images
     * @param text Text to tokenize
     * @param params.media_paths Array of image paths to tokenize (if multimodal is enabled)
     * @returns Promise resolving to the tokenize result
     */
    tokenize(text: string, { media_paths: mediaPaths, }?: {
        media_paths?: string[];
    }): Promise<NativeTokenizeResult>;
    detokenize(tokens: number[]): Promise<string>;
    embedding(text: string, params?: EmbeddingParams): Promise<NativeEmbeddingResult>;
    /**
     * Rerank documents based on relevance to a query
     * @param query The query text to rank documents against
     * @param documents Array of document texts to rank
     * @param params Optional reranking parameters
     * @returns Promise resolving to an array of ranking results with scores and indices
     */
    rerank(query: string, documents: string[], params?: RerankParams): Promise<RerankResult[]>;
    bench(pp: number, tg: number, pl: number, nr: number): Promise<BenchResult>;
    applyLoraAdapters(loraList: Array<{
        path: string;
        scaled?: number;
    }>): Promise<void>;
    removeLoraAdapters(): Promise<void>;
    getLoadedLoraAdapters(): Promise<Array<{
        path: string;
        scaled?: number;
    }>>;
    /**
     * Initialize multimodal support with a mmproj file
     * @param params Parameters for multimodal support
     * @param params.path Path to the multimodal projector file
     * @param params.use_gpu Whether to use GPU
     * @returns Promise resolving to true if initialization was successful
     */
    initMultimodal({ path, use_gpu: useGpu, }: {
        path: string;
        use_gpu?: boolean;
    }): Promise<boolean>;
    /**
     * Check if multimodal support is enabled
     * @returns Promise resolving to true if multimodal is enabled
     */
    isMultimodalEnabled(): Promise<boolean>;
    /**
     * Check multimodal support
     * @returns Promise resolving to an object with vision and audio support
     */
    getMultimodalSupport(): Promise<{
        vision: boolean;
        audio: boolean;
    }>;
    /**
     * Release multimodal support
     * @returns Promise resolving to void
     */
    releaseMultimodal(): Promise<void>;
    /**
     * Initialize TTS support with a vocoder model
     * @param params Parameters for TTS support
     * @param params.path Path to the vocoder model
     * @param params.n_batch Batch size for the vocoder model
     * @returns Promise resolving to true if initialization was successful
     */
    initVocoder({ path, n_batch: nBatch }: {
        path: string;
        n_batch?: number;
    }): Promise<boolean>;
    /**
     * Check if TTS support is enabled
     * @returns Promise resolving to true if TTS is enabled
     */
    isVocoderEnabled(): Promise<boolean>;
    /**
     * Get a formatted audio completion prompt
     * @param speakerJsonStr JSON string representing the speaker
     * @param textToSpeak Text to speak
     * @returns Promise resolving to the formatted audio completion result with prompt and grammar
     */
    getFormattedAudioCompletion(speaker: object | null, textToSpeak: string): Promise<{
        prompt: string;
        grammar?: string;
    }>;
    /**
     * Get guide tokens for audio completion
     * @param textToSpeak Text to speak
     * @returns Promise resolving to the guide tokens
     */
    getAudioCompletionGuideTokens(textToSpeak: string): Promise<Array<number>>;
    /**
     * Decode audio tokens
     * @param tokens Array of audio tokens
     * @returns Promise resolving to the decoded audio tokens
     */
    decodeAudioTokens(tokens: number[]): Promise<Array<number>>;
    /**
     * Release TTS support
     * @returns Promise resolving to void
     */
    releaseVocoder(): Promise<void>;
    release(): Promise<void>;
}
export declare function toggleNativeLog(enabled: boolean): Promise<void>;
export declare function addNativeLogListener(listener: (level: string, text: string) => void): {
    remove: () => void;
};
export declare function setContextLimit(limit: number): Promise<void>;
export declare function loadLlamaModelInfo(model: string): Promise<Object>;
export declare function initLlama({ model, is_model_asset: isModelAsset, pooling_type: poolingType, lora, lora_list: loraList, ...rest }: ContextParams, onProgress?: (progress: number) => void): Promise<LlamaContext>;
export declare function releaseAllLlama(): Promise<void>;
export declare function downloadModel(url: string, filename: string): Promise<string>;
export declare function getDownloadProgress(url: string): Promise<{
    progress: number;
    completed: boolean;
    failed: boolean;
    errorMessage?: string;
    localPath?: string;
    downloadedBytes: number;
    totalBytes: number;
}>;
export declare function cancelDownload(url: string): Promise<boolean>;
export declare function getAvailableModels(): Promise<Array<{
    name: string;
    path: string;
    size: number;
}>>;
/**
 * Convert a JSON schema to GBNF grammar format
 * @param schema JSON schema object
 * @returns Promise resolving to GBNF grammar string
 */
export declare function convertJsonSchemaToGrammar(schema: object): Promise<string>;
export declare const BuildInfo: {
    number: string;
    commit: string;
};
export { LlamaCpp };
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
