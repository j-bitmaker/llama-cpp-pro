/**
 * Detect desktop (Electron / Tauri / Node) runtime vs mobile browser.
 */
export function isElectronRuntime() {
    if (typeof process !== 'undefined' && process.versions && process.versions.electron) {
        return true;
    }
    return false;
}
export function isDesktopRuntime() {
    if (isElectronRuntime())
        return true;
    if (typeof globalThis !== 'undefined' && globalThis.__annadataDesktop) {
        return true;
    }
    return false;
}
/** Sidecar HTTP port injected by Electron preload / main process. */
export function getDesktopSidecarPort() {
    const g = globalThis;
    if (typeof g.__annadataSidecarPort === 'number' && g.__annadataSidecarPort > 0) {
        return g.__annadataSidecarPort;
    }
    if (typeof process !== 'undefined' && process.env.LLAMA_SIDECAR_PORT) {
        const p = parseInt(process.env.LLAMA_SIDECAR_PORT, 10);
        if (!Number.isNaN(p) && p > 0)
            return p;
    }
    return null;
}
export function getDesktopBridge() {
    var _a;
    const g = globalThis;
    return (_a = g.annadataLlama) !== null && _a !== void 0 ? _a : null;
}
//# sourceMappingURL=desktop.runtime.js.map