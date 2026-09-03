/**
 * HeapFS — allocate model bytes directly in WASM linear memory (wllama-style).
 *
 * Standard Emscripten MEMFS stores file contents in the JS heap; reads/mmap
 * copy into WASM. HeapFS patches MEMFS so file contents are a subarray of
 * HEAPU8 at an mmapAlloc'd address, enabling zero-copy mmap for llama.cpp.
 *
 * Ref: ref-code/wllama/src/workers-code/llama-cpp.js
 */
export type EmscriptenModule = {
    MEMFS: {
        stream_ops: Record<string, unknown> & {
            read: (...args: unknown[]) => unknown;
            write: (...args: unknown[]) => unknown;
            llseek: (...args: unknown[]) => unknown;
            allocate: (...args: unknown[]) => unknown;
            mmap: (...args: unknown[]) => unknown;
            msync: (...args: unknown[]) => unknown;
            _read?: (...args: unknown[]) => unknown;
            _write?: (...args: unknown[]) => unknown;
            _llseek?: (...args: unknown[]) => unknown;
            _allocate?: (...args: unknown[]) => unknown;
            _mmap?: (...args: unknown[]) => unknown;
            _msync?: (...args: unknown[]) => unknown;
        };
        ops_table: {
            file: {
                stream: Record<string, unknown>;
            };
        };
    };
    FS: {
        mkdir: (path: string) => void;
        analyzePath: (path: string) => {
            exists: boolean;
        };
        createPath?: (parent: string, path: string, canRead: boolean, canWrite: boolean) => void;
        mount: (type: unknown, opts: unknown, mountpoint: string) => void;
        createDataFile: (parent: string, name: string, data: ArrayBuffer, canRead: boolean, canWrite: boolean, canOwn: boolean) => void;
    };
    mmapAlloc: (size: number) => number;
    HEAPU8: Uint8Array;
};
/** Patch MEMFS stream ops so mmap/read use WASM-heap-backed file storage. */
export declare const patchHeapFS: (mod: EmscriptenModule) => void;
/** Ensure MEMFS /tmp exists for VFS model streaming (fopen fails without it). */
export declare const ensureWasmTmpDir: (mod: EmscriptenModule) => void;
/** Allocate `size` bytes in WASM heap for a model file; returns file id. */
export declare const heapfsAlloc: (mod: EmscriptenModule, name: string, size: number, allocBuffer?: boolean) => number;
/** Write bytes at `offset` into a HeapFS file. Returns bytes written. */
export declare const heapfsWrite: (mod: EmscriptenModule, id: number, buffer: Uint8Array, offset: number) => number;
/** VFS path for a model basename under /models/. */
export declare const heapfsModelPath: (basename: string) => string;
/** Whether HeapFS runtime methods are present on the module. */
export declare const supportsHeapFS: (mod: unknown) => mod is EmscriptenModule;
