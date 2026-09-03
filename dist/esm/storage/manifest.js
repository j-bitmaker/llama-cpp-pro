import { LlmError } from '../isomorphic/errors';
const MANIFEST_FILE = '.llm-manifest.json';
const getStorageApi = () => {
    var _a;
    const storageApi = (_a = globalThis === null || globalThis === void 0 ? void 0 : globalThis.navigator) === null || _a === void 0 ? void 0 : _a.storage;
    if (!storageApi || typeof storageApi.getDirectory !== 'function') {
        throw new LlmError('STORAGE_UNAVAILABLE', 'OPFS is not available in this runtime. navigator.storage.getDirectory is missing.');
    }
    return storageApi;
};
const getRootDirectory = async () => {
    const storageApi = getStorageApi();
    try {
        return await storageApi.getDirectory();
    }
    catch (error) {
        throw new LlmError('STORAGE_IO_FAILED', 'Failed to access OPFS root directory.', {
            cause: String(error),
        });
    }
};
const readTextFile = async (fileHandle) => {
    const file = await fileHandle.getFile();
    return file.text();
};
const writeTextFile = async (fileHandle, content) => {
    const writable = await fileHandle.createWritable();
    try {
        await writable.write(content);
    }
    finally {
        await writable.close();
    }
};
async function loadManifestInternal() {
    const root = await getRootDirectory();
    try {
        const handle = await root.getFileHandle(MANIFEST_FILE, { create: true });
        const content = await readTextFile(handle);
        if (!content.trim()) {
            return {};
        }
        const parsed = JSON.parse(content);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return {};
        }
        return parsed;
    }
    catch (error) {
        throw new LlmError('STORAGE_IO_FAILED', 'Failed to read OPFS manifest.', {
            cause: String(error),
        });
    }
}
async function saveManifestInternal(manifest) {
    const root = await getRootDirectory();
    try {
        const handle = await root.getFileHandle(MANIFEST_FILE, { create: true });
        await writeTextFile(handle, JSON.stringify(manifest, null, 2));
    }
    catch (error) {
        throw new LlmError('STORAGE_IO_FAILED', 'Failed to write OPFS manifest.', {
            cause: String(error),
        });
    }
}
export async function listManifestEntries() {
    const manifest = await loadManifestInternal();
    return Object.values(manifest);
}
export async function getManifestEntry(modelId) {
    const manifest = await loadManifestInternal();
    return manifest[modelId];
}
export async function upsertManifestEntry(entry) {
    const manifest = await loadManifestInternal();
    manifest[entry.modelId] = entry;
    await saveManifestInternal(manifest);
}
export async function removeManifestEntry(modelId) {
    const manifest = await loadManifestInternal();
    if (manifest[modelId]) {
        delete manifest[modelId];
        await saveManifestInternal(manifest);
    }
}
//# sourceMappingURL=manifest.js.map