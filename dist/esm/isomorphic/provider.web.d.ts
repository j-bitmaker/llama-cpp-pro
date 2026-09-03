import type { EmbedRequest, EmbedResult, GenerateRequest, GenerateResult, InitializeOptions, LlmProvider, MemorySnapshot, PlatformKind, TokenEvent } from './provider.interface';
import type { DetokenizeResult, TokenizeResult } from '../workers/wasm.engine';
/** Verify that the browser supports everything the web WASM path needs. */
export declare function checkWasmCapabilities(): {
    supported: boolean;
    missing: string[];
};
/** Returns true only when COOP/COEP headers are set for WASM threads. */
export declare function checkCrossOriginIsolation(): boolean;
type WorkerFactory = () => Worker;
export declare class WebProvider implements LlmProvider {
    private workerFactoryOverride?;
    private static globalWorkerFactory?;
    readonly platform: PlatformKind;
    private loadedModelIds;
    private worker;
    private reqCounter;
    private pending;
    private scheduler;
    constructor(workerFactoryOverride?: WorkerFactory | undefined);
    static setWorkerFactory(factory?: WorkerFactory): void;
    private resolveWorkerUrl;
    private defaultWorkerFactory;
    private ensureWorker;
    private sendRequest;
    initialize(opts: InitializeOptions): Promise<void>;
    loadModel(opts: InitializeOptions): Promise<void>;
    private readMeasuredFootprintFromWorker;
    unloadModel(modelId: string): Promise<void>;
    generate(req: GenerateRequest): Promise<GenerateResult>;
    generateStream(req: GenerateRequest, onToken: (event: TokenEvent) => void): Promise<GenerateResult>;
    embed(req: EmbedRequest): Promise<EmbedResult>;
    getMemorySnapshot(): Promise<MemorySnapshot>;
    /** Worker WASM linear memory + loaded-model registry (for scheduling UI). */
    fetchWorkerMemory(): Promise<Record<string, unknown>>;
    getWasmMemoryStatus(): Promise<Record<string, unknown>>;
    tokenize(modelId: string, text: string): Promise<TokenizeResult>;
    detokenize(modelId: string, tokens: number[]): Promise<DetokenizeResult>;
    convertJsonSchemaToGrammar(schemaJson: string): Promise<string>;
    private requireLoaded;
    rerank(modelId: string, query: string, documents: string[]): Promise<Array<{
        index: number;
        score: number;
    }>>;
    bench(modelId: string, pp: number, tg: number, pl: number, nr: number): Promise<string>;
    saveSession(modelId: string, filepath: string, tokenSize: number): Promise<number>;
    loadSession(modelId: string, filepath: string): Promise<{
        tokens_loaded: number;
        prompt: string;
    }>;
    applyLoraAdapters(modelId: string, loraAdapters: Array<{
        path: string;
        scaled?: number;
    }>): Promise<void>;
    removeLoraAdapters(modelId: string): Promise<void>;
    getLoadedLoraAdapters(modelId: string): Promise<Array<{
        path: string;
        scaled?: number;
    }>>;
    initMultimodal(modelId: string, path: string, useGpu?: boolean): Promise<boolean>;
    isMultimodalEnabled(modelId: string): Promise<boolean>;
    getMultimodalSupport(modelId: string): Promise<{
        vision: boolean;
        audio: boolean;
    }>;
    releaseMultimodal(modelId: string): Promise<void>;
    initVocoder(modelId: string, path: string, nBatch?: number): Promise<boolean>;
    isVocoderEnabled(modelId: string): Promise<boolean>;
    releaseVocoder(modelId: string): Promise<void>;
    getFormattedAudioCompletion(modelId: string, speaker: object | null, textToSpeak: string): Promise<{
        prompt: string;
        grammar?: string;
    }>;
    getAudioCompletionGuideTokens(modelId: string, textToSpeak: string): Promise<number[]>;
    decodeAudioTokens(modelId: string, tokens: number[]): Promise<number[]>;
    /**
     * Terminate the worker mid-inference. WASM is single-threaded, so posting
     * an abort message cannot be received while generate() is running. Worker
     * termination is the only reliable interrupt. The model will need to be
     * reloaded on the next generate() call.
     */
    stopGeneration(): void;
    health(): Promise<{
        ok: boolean;
        details?: Record<string, unknown>;
    }>;
}
export {};
