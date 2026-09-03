type GenerateRequest = {
    prompt?: string;
    messages?: Array<{
        role: string;
        content: string;
    }>;
    max_tokens?: number;
    temperature?: number;
    stream?: boolean;
};
type GenerateResult = {
    text: string;
    tokens_predicted: number;
    tokens_evaluated: number;
    finish_reason: 'stop' | 'length' | 'error';
};
type EmbedResult = {
    vectors: number[][];
};
export type TokenizeResult = {
    tokens: number[];
    has_media?: boolean;
};
export type DetokenizeResult = {
    text: string;
};
export type WasmEngine = {
    init?: () => Promise<void> | void;
    loadModel: (modelId: string, modelBuffer: ArrayBuffer, opts?: Record<string, unknown>) => Promise<void> | void;
    /** Stream from OPFS sync handle without holding full model in JS heap (#9). */
    loadModelFromOpfsReader?: (modelId: string, reader: {
        sizeBytes: number;
        readChunk: (offset: number, length?: number) => Uint8Array;
        close: () => void;
    }, opts?: Record<string, unknown>) => Promise<void> | void;
    unloadModel: (modelId: string) => Promise<void> | void;
    generate: (modelId: string, req: GenerateRequest, onToken?: (token: string, index: number) => void) => Promise<GenerateResult> | GenerateResult;
    embed: (modelId: string, input: string | string[]) => Promise<EmbedResult> | EmbedResult;
    /** Tokenize text using the loaded model vocabulary. */
    tokenize?: (modelId: string, text: string) => Promise<TokenizeResult> | TokenizeResult;
    /** Detokenize a token ID array back to text. */
    detokenize?: (modelId: string, tokens: number[]) => Promise<DetokenizeResult> | DetokenizeResult;
    /** Convert a JSON Schema to a GBNF grammar string for constrained sampling. */
    convertJsonSchemaToGrammar?: (schemaJson: string) => Promise<string> | string;
    rerank?: (modelId: string, query: string, documents: string[]) => Promise<Array<{
        index: number;
        score: number;
    }>>;
    bench?: (modelId: string, pp: number, tg: number, pl: number, nr: number) => Promise<string>;
    saveSession?: (modelId: string, filepath: string, tokenSize: number) => Promise<{
        tokens_saved: number;
    }>;
    loadSession?: (modelId: string, filepath: string) => Promise<{
        tokens_loaded: number;
        prompt: string;
    }>;
    applyLoraAdapters?: (modelId: string, loraAdapters: Array<{
        path: string;
        scaled?: number;
    }>) => Promise<void>;
    removeLoraAdapters?: (modelId: string) => Promise<void>;
    getLoadedLoraAdapters?: (modelId: string) => Promise<Array<{
        path: string;
        scaled?: number;
    }>>;
    initMultimodal?: (modelId: string, path: string, useGpu?: boolean) => Promise<boolean>;
    multimodalStatus?: (modelId: string) => Promise<{
        enabled: boolean;
        vision: boolean;
        audio: boolean;
    }>;
    releaseMultimodal?: (modelId: string) => Promise<void>;
    initVocoder?: (modelId: string, path: string, nBatch?: number) => Promise<boolean>;
    vocoderEnabled?: (modelId: string) => Promise<boolean>;
    releaseVocoder?: (modelId: string) => Promise<void>;
    formattedAudioCompletion?: (modelId: string, speakerJson: string, textToSpeak: string) => Promise<{
        prompt: string;
        grammar?: string;
    }>;
    audioGuideTokens?: (modelId: string, textToSpeak: string) => Promise<number[]>;
    decodeAudioTokens?: (modelId: string, tokens: number[]) => Promise<number[]>;
    health?: () => Promise<Record<string, unknown>> | Record<string, unknown>;
    memory?: () => Promise<Record<string, unknown>> | Record<string, unknown>;
};
export declare const loadLlamaWasmEngine: () => Promise<WasmEngine>;
export {};
