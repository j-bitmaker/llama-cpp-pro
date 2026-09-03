/**
 * Detect desktop (Electron / Tauri / Node) runtime vs mobile browser.
 */
import type { MemorySnapshot } from './provider.interface';
export declare function isElectronRuntime(): boolean;
export declare function isDesktopRuntime(): boolean;
/** Sidecar HTTP port injected by Electron preload / main process. */
export declare function getDesktopSidecarPort(): number | null;
export type DesktopBridge = {
    ensureSidecar: (opts: {
        modelPath?: string;
        modelId?: string;
        host?: string;
        port?: number;
        n_ctx?: number;
        n_gpu_layers?: number;
        n_threads?: number;
        embedding?: boolean;
    }) => Promise<{
        ok: boolean;
        port?: number;
        gpuEnabled?: boolean;
        gpuBackend?: string | null;
        reasonNoGpu?: string;
        reason?: string;
    }>;
    stopSidecar?: () => Promise<void>;
    getSidecarStatus?: () => Promise<{
        running: boolean;
        port?: number | null;
        backend?: string | null;
    }>;
    getBackendStatus?: () => Promise<Record<string, unknown>>;
    setBackendOverride?: (value: string) => Promise<void>;
    getMemorySnapshot?: () => Promise<MemorySnapshot>;
};
export declare function getDesktopBridge(): DesktopBridge | null;
