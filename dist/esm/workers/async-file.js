/**
 * External GGUF read — model bytes stay in JS/OPFS; WASM sync-fread pulls on demand.
 * Does not require native WebAssembly JSPI (uses sync EM_JS, not EM_ASYNC_JS).
 */
/** True when this build includes the cap-wasm-fs fread hook. */
export const canUseAsyncFileRead = (wasmJspiBuild = false) => wasmJspiBuild;
/** Zero-copy subarray reader over a Uint8Array (ArrayBuffer load path). */
export const asyncReaderFromBytes = (bytes) => ({
    sizeBytes: bytes.byteLength,
    readChunk: (offset, length) => bytes.subarray(offset, Math.min(offset + length, bytes.byteLength)),
});
//# sourceMappingURL=async-file.js.map