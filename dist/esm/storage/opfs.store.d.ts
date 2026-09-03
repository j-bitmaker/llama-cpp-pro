import { type ModelManifestEntry } from './manifest';
export declare function ensureModelInOpfs(modelId: string, modelUrl: string, onProgress?: (downloaded: number, total: number) => void, signal?: AbortSignal): Promise<ModelManifestEntry>;
/**
 * Choice 3 — primary web model load path.
 * Opens an OPFS FileSystemSyncAccessHandle in the worker and reads the
 * model in fixed-size chunks (default 4MB). Chunks are streamed into WASM
 * MEMFS; the full GGUF is never materialised as a single JS ArrayBuffer.
 *
 * Worker-only: createSyncAccessHandle is not available on the main thread.
 */
export declare const OPFS_MODEL_CHUNK_BYTES: number;
export interface OpfsModelSyncReader {
    readonly sizeBytes: number;
    readChunk(offset: number, length?: number): Uint8Array;
    close(): void;
}
export declare function openOpfsModelSyncReader(modelId: string): Promise<OpfsModelSyncReader>;
/**
 * Read the model from OPFS as an ArrayBuffer (fallback when sync handles
 * are unavailable). Prefer openOpfsModelSyncReader in workers.
 */
export declare function readModelBufferFromOpfs(modelId: string): Promise<{
    buffer: ArrayBuffer;
    sizeBytes: number;
}>;
export declare function readModelFromOpfs(modelId: string): Promise<File>;
export declare function removeModelFromOpfs(modelId: string): Promise<void>;
export declare function getOpfsUsage(): Promise<{
    usedBytes: number;
    quotaBytes?: number;
}>;
