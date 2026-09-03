import type { NativeContextParams, NativeLlamaContext } from './definitions';
import { LlamaCppWeb } from './web';
/**
 * Capacitor LlamaCpp implementation for Electron desktop.
 * Core inference (chat, completion, embeddings) uses the native GPU/CPU sidecar.
 * Multimodal, LoRA, TTS, and benchmarking use the WASM worker (same as PWA).
 */
export declare class LlamaCppDesktop extends LlamaCppWeb {
    private desktopProvider;
    private sidecarActive;
    private gpuEnabled;
    constructor();
    initContext({ contextId, params, }: {
        contextId: number;
        params: NativeContextParams & {
            embedding?: boolean;
        };
    }): Promise<NativeLlamaContext>;
    setContextLimit(opts: {
        limit: number;
    }): Promise<void>;
    releaseContext({ contextId }: {
        contextId: number;
    }): Promise<void>;
    startNativeLlamaServer(options: {
        modelPath: string;
        host?: string;
        port?: number;
        params?: NativeContextParams;
    }): Promise<{
        running: boolean;
    }>;
    isNativeLlamaServerRunning(): Promise<{
        running: boolean;
    }>;
    stopNativeLlamaServer(): Promise<void>;
}
