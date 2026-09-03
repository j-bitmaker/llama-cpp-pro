import type { EmbedRequest, EmbedResult, GenerateRequest, GenerateResult, InitializeOptions, MemorySnapshot, PlatformKind, TokenEvent } from './provider.interface';
import { WebProvider } from './provider.web';
import type { DetokenizeResult, TokenizeResult } from '../workers/wasm.engine';
/**
 * Desktop LLM provider: native sidecar (HTTP) for GPU/CPU inference;
 * WASM worker for multimodal, LoRA, TTS, bench (inherited via composition).
 * Sidecar path supports up to 5 concurrent models with admission control.
 */
export declare class DesktopProvider extends WebProvider {
    readonly platform: PlatformKind;
    private sidecarPort;
    private sidecarScheduler;
    private sidecarLoadedModels;
    private modelPaths;
    private getPort;
    private sidecarAvailable;
    private getDesktopMemorySnapshot;
    private mapSidecarHttpError;
    private sidecarFetch;
    private ensureSidecarProcess;
    private requireSidecarModel;
    setContextLimit(limit: number): Promise<void>;
    listLoadedModels(): string[];
    private sidecarStreamChat;
    private sidecarStreamCompletion;
    initialize(opts: InitializeOptions): Promise<void>;
    loadModel(opts: InitializeOptions): Promise<void>;
    unloadModel(modelId: string): Promise<void>;
    generate(req: GenerateRequest): Promise<GenerateResult>;
    generateStream(req: GenerateRequest, onToken: (event: TokenEvent) => void): Promise<GenerateResult>;
    embed(req: EmbedRequest): Promise<EmbedResult>;
    tokenize(modelId: string, text: string): Promise<TokenizeResult>;
    detokenize(modelId: string, tokens: number[]): Promise<DetokenizeResult>;
    getMemorySnapshot(): Promise<MemorySnapshot>;
    health(): Promise<{
        ok: boolean;
        details?: Record<string, unknown>;
    }>;
    setSidecarPort(port: number): void;
}
