/**
 * HeapFS — allocate model bytes directly in WASM linear memory (wllama-style).
 *
 * Standard Emscripten MEMFS stores file contents in the JS heap; reads/mmap
 * copy into WASM. HeapFS patches MEMFS so file contents are a subarray of
 * HEAPU8 at an mmapAlloc'd address, enabling zero-copy mmap for llama.cpp.
 *
 * Ref: ref-code/wllama/src/workers-code/llama-cpp.js
 */
const fsNameToFile = {};
const fsIdToFile = {};
let currFileId = 0;
let patched = false;
const getHeapU8 = (mod) => {
    var _a, _b, _c;
    const buf = (_b = (_a = mod.wasmMemory) === null || _a === void 0 ? void 0 : _a.buffer) !== null && _b !== void 0 ? _b : (_c = mod.HEAPU8) === null || _c === void 0 ? void 0 : _c.buffer;
    if (!buf)
        throw new Error('HeapFS requires WASM linear memory');
    return new Uint8Array(buf);
};
const patchStream = (mod, stream) => {
    const name = stream.node.name;
    const f = fsNameToFile[name];
    if (!f)
        return;
    const heap = getHeapU8(mod);
    const ptr = Number(f.ptr);
    stream.node.contents = heap.subarray(ptr, ptr + f.size);
    stream.node.usedBytes = f.size;
};
/** Patch MEMFS stream ops so mmap/read use WASM-heap-backed file storage. */
export const patchHeapFS = (mod) => {
    var _a, _b, _c, _d, _e, _f;
    if (patched)
        return;
    patched = true;
    const ops = mod.MEMFS.stream_ops;
    ops._read = (_a = ops._read) !== null && _a !== void 0 ? _a : ops.read;
    ops._write = (_b = ops._write) !== null && _b !== void 0 ? _b : ops.write;
    ops._llseek = (_c = ops._llseek) !== null && _c !== void 0 ? _c : ops.llseek;
    ops._allocate = (_d = ops._allocate) !== null && _d !== void 0 ? _d : ops.allocate;
    ops._mmap = (_e = ops._mmap) !== null && _e !== void 0 ? _e : ops.mmap;
    ops._msync = (_f = ops._msync) !== null && _f !== void 0 ? _f : ops.msync;
    ops.read = function (stream, ...rest) {
        patchStream(mod, stream);
        return ops._read.call(this, stream, ...rest);
    };
    mod.MEMFS.ops_table.file.stream.read = ops.read;
    ops.llseek = function (stream, ...rest) {
        patchStream(mod, stream);
        return ops._llseek.call(this, stream, ...rest);
    };
    mod.MEMFS.ops_table.file.stream.llseek = ops.llseek;
    ops.mmap = function (stream, length, position, prot, flags) {
        patchStream(mod, stream);
        const name = stream.node.name;
        const f = fsNameToFile[name];
        if (f) {
            return { ptr: Number(f.ptr) + Number(position), allocated: false };
        }
        return ops._mmap.call(this, stream, length, position, prot, flags);
    };
    mod.MEMFS.ops_table.file.stream.mmap = ops.mmap;
    mod.FS.mkdir('/models');
    mod.FS.mount(mod.MEMFS, { root: '.' }, '/models');
};
/** Ensure MEMFS /tmp exists for VFS model streaming (fopen fails without it). */
export const ensureWasmTmpDir = (mod) => {
    const fs = mod.FS;
    if (fs.analyzePath('/tmp').exists)
        return;
    try {
        if (typeof fs.createPath === 'function') {
            fs.createPath('/', 'tmp', true, true);
        }
        else {
            fs.mkdir('/tmp');
        }
    }
    catch (_a) {
        if (!fs.analyzePath('/tmp').exists) {
            throw new Error('Failed to create MEMFS /tmp for model VFS streaming');
        }
    }
};
/** Allocate `size` bytes in WASM heap for a model file; returns file id. */
export const heapfsAlloc = (mod, name, size, allocBuffer = true) => {
    if (size < 1)
        throw new Error('HeapFS file size must be > 0');
    const ptr = allocBuffer ? Number(mod.mmapAlloc(size)) : 0;
    const file = { ptr, size, id: currFileId++ };
    fsIdToFile[file.id] = file;
    fsNameToFile[name] = file;
    return file.id;
};
/** Write bytes at `offset` into a HeapFS file. Returns bytes written. */
export const heapfsWrite = (mod, id, buffer, offset) => {
    const f = fsIdToFile[id];
    if (!f)
        throw new Error(`HeapFS file id ${id} not found`);
    const after = offset + buffer.byteLength;
    if (after > f.size) {
        throw new Error(`HeapFS write out of bounds: ${after} > ${f.size}`);
    }
    getHeapU8(mod).set(buffer, Number(f.ptr) + offset);
    return buffer.byteLength;
};
/** VFS path for a model basename under /models/. */
export const heapfsModelPath = (basename) => `/models/${basename}`;
/** Whether HeapFS runtime methods are present on the module. */
export const supportsHeapFS = (mod) => !!mod &&
    typeof mod.mmapAlloc === 'function' &&
    typeof mod.MEMFS === 'object' &&
    typeof mod.FS === 'object';
//# sourceMappingURL=heapfs.js.map