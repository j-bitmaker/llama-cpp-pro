import type { LlamaCppPlugin, NativeLlamaContext, NativeCompletionResult, NativeTokenizeResult } from './definitions';
import { WebProvider } from './isomorphic/provider.web';
export declare class LlamaCppWeb implements LlamaCppPlugin {
    protected provider: WebProvider;
    protected contextToModel: Map<number, string>;
    protected listeners: Map<string, Set<(data: unknown) => void>>;
    protected emitListener(eventName: string, data: unknown): void;
    protected hasListeners(eventName: string): boolean;
    toggleNativeLog(): Promise<void>;
    setContextLimit(_opts?: {
        limit: number;
    }): Promise<void>;
    modelInfo({ path }: {
        path: string;
        skip?: string[];
    }): Promise<Object>;
    initContext({ contextId, params, }: {
        contextId: number;
        params: any;
    }): Promise<NativeLlamaContext>;
    releaseContext({ contextId }: {
        contextId: number;
    }): Promise<void>;
    releaseAllContexts(): Promise<void>;
    getFormattedChat({ contextId, messages, chatTemplate, params, }: {
        contextId: number;
        messages: string;
        chatTemplate?: string;
        params?: any;
    }): Promise<any>;
    completion({ contextId, params, }: {
        contextId: number;
        params: any;
    }): Promise<NativeCompletionResult>;
    chat({ contextId, messages, system, chatTemplate, params }: {
        contextId: number;
        messages: Array<{
            role: string;
            content: string;
        }>;
        system?: string;
        chatTemplate?: string;
        params?: any;
    }): Promise<NativeCompletionResult>;
    chatWithSystem({ contextId, system, message, params }: {
        contextId: number;
        system: string;
        message: string;
        params?: any;
    }): Promise<NativeCompletionResult>;
    generateText({ contextId, prompt, params }: {
        contextId: number;
        prompt: string;
        params?: any;
    }): Promise<NativeCompletionResult>;
    stopCompletion(): Promise<void>;
    loadSession({ contextId, filepath, }: {
        contextId: number;
        filepath: string;
    }): Promise<{
        tokens_loaded: number;
        prompt: string;
    }>;
    saveSession({ contextId, filepath, size, }: {
        contextId: number;
        filepath: string;
        size: number;
    }): Promise<number>;
    tokenize({ contextId, text, }: {
        contextId: number;
        text: string;
        imagePaths?: string[];
    }): Promise<NativeTokenizeResult>;
    detokenize({ contextId, tokens, }: {
        contextId: number;
        tokens: number[];
        [key: string]: unknown;
    }): Promise<string>;
    embedding({ contextId, text }: {
        contextId: number;
        text: string;
        params: any;
    }): Promise<any>;
    rerank({ contextId, query, documents, }: {
        contextId: number;
        query: string;
        documents: string[];
        params?: Record<string, unknown>;
    }): Promise<Array<{
        score: number;
        index: number;
    }>>;
    bench({ contextId, pp, tg, pl, nr, }: {
        contextId: number;
        pp: number;
        tg: number;
        pl: number;
        nr: number;
    }): Promise<string>;
    applyLoraAdapters({ contextId, loraAdapters, }: {
        contextId: number;
        loraAdapters: Array<{
            path: string;
            scaled?: number;
        }>;
    }): Promise<void>;
    removeLoraAdapters({ contextId }: {
        contextId: number;
    }): Promise<void>;
    getLoadedLoraAdapters({ contextId, }: {
        contextId: number;
    }): Promise<Array<{
        path: string;
        scaled?: number;
    }>>;
    initMultimodal({ contextId, params, }: {
        contextId: number;
        params: {
            path: string;
            use_gpu?: boolean;
        };
    }): Promise<boolean>;
    isMultimodalEnabled({ contextId }: {
        contextId: number;
    }): Promise<boolean>;
    getMultimodalSupport({ contextId }: {
        contextId: number;
    }): Promise<{
        vision: boolean;
        audio: boolean;
    }>;
    releaseMultimodal({ contextId }: {
        contextId: number;
    }): Promise<void>;
    initVocoder({ contextId, params, }: {
        contextId: number;
        params: {
            path: string;
            n_batch?: number;
        };
    }): Promise<boolean>;
    isVocoderEnabled({ contextId }: {
        contextId: number;
    }): Promise<boolean>;
    getFormattedAudioCompletion({ contextId, speakerJsonStr, textToSpeak, }: {
        contextId: number;
        speakerJsonStr: string;
        textToSpeak: string;
    }): Promise<{
        prompt: string;
        grammar?: string;
    }>;
    getAudioCompletionGuideTokens({ contextId, textToSpeak, }: {
        contextId: number;
        textToSpeak: string;
    }): Promise<number[]>;
    decodeAudioTokens({ contextId, tokens, }: {
        contextId: number;
        tokens: number[];
    }): Promise<number[]>;
    releaseVocoder({ contextId }: {
        contextId: number;
    }): Promise<void>;
    downloadModel({ url, filename }: {
        url: string;
        filename: string;
    }): Promise<string>;
    getDownloadProgress({ url }: {
        url: string;
    }): Promise<{
        progress: number;
        completed: boolean;
        failed: boolean;
        errorMessage?: string;
        localPath?: string;
        downloadedBytes: number;
        totalBytes: number;
    }>;
    cancelDownload({ url }: {
        url: string;
    }): Promise<boolean>;
    getAvailableModels(): Promise<Array<{
        name: string;
        path: string;
        size: number;
    }>>;
    convertJsonSchemaToGrammar({ schema, }: {
        schema: string;
        [key: string]: unknown;
    }): Promise<string>;
    startNativeLlamaServer(_options?: {
        modelPath: string;
        host?: string;
        port?: number;
        params?: import('./definitions').NativeContextParams;
    }): Promise<{
        running: boolean;
    }>;
    stopNativeLlamaServer(): Promise<void>;
    isNativeLlamaServerRunning(): Promise<{
        running: boolean;
    }>;
    addListener(eventName: string, listenerFunc: (data: unknown) => void): Promise<void>;
    removeAllListeners(): Promise<void>;
}
export * from './definitions';
