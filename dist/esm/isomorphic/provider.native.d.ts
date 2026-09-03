import type { EmbedRequest, EmbedResult, GenerateRequest, GenerateResult, InitializeOptions, LlmProvider, MemorySnapshot, TokenEvent } from './provider.interface';
export declare class NativeProvider implements LlmProvider {
    readonly platform: "native";
    private contextByModel;
    private nextContextId;
    private scheduler;
    initialize(opts: InitializeOptions): Promise<void>;
    loadModel(opts: InitializeOptions): Promise<void>;
    unloadModel(modelId: string): Promise<void>;
    generate(req: GenerateRequest): Promise<GenerateResult>;
    generateStream(req: GenerateRequest, onToken: (event: TokenEvent) => void): Promise<GenerateResult>;
    embed(req: EmbedRequest): Promise<EmbedResult>;
    getMemorySnapshot(): Promise<MemorySnapshot>;
    health(): Promise<{
        ok: boolean;
        details?: Record<string, unknown>;
    }>;
}
