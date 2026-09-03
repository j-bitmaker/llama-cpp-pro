import { LlamaCppWeb } from './web';
import { DesktopProvider } from './isomorphic/provider.desktop';
import { getDesktopBridge } from './isomorphic/desktop.runtime';
const MODEL_DESC_DESKTOP = {
    desc: 'Desktop sidecar model',
    size: 0,
    nEmbd: 0,
    nParams: 0,
    chatTemplates: {
        llamaChat: true,
        minja: {
            default: true,
            defaultCaps: {
                tools: false, toolCalls: false, toolResponses: false,
                systemRole: true, parallelToolCalls: false, toolCallId: false,
            },
            toolUse: false,
            toolUseCaps: {
                tools: false, toolCalls: false, toolResponses: false,
                systemRole: true, parallelToolCalls: false, toolCallId: false,
            },
        },
    },
    metadata: {},
    isChatTemplateSupported: true,
};
/** Sidecar DELETE route is `/v1/internal/models/([^/]+)` — never use absolute paths as ids. */
function sidecarModelIdFromPath(modelPath) {
    const base = modelPath.split(/[/\\]/).pop() || modelPath;
    return base.replace(/\.gguf$/i, '') || base;
}
/**
 * Capacitor LlamaCpp implementation for Electron desktop.
 * Core inference (chat, completion, embeddings) uses the native GPU/CPU sidecar.
 * Multimodal, LoRA, TTS, and benchmarking use the WASM worker (same as PWA).
 */
export class LlamaCppDesktop extends LlamaCppWeb {
    constructor() {
        super();
        this.sidecarActive = false;
        this.gpuEnabled = false;
        this.desktopProvider = new DesktopProvider();
        this.provider =
            this.desktopProvider;
    }
    async initContext({ contextId, params, }) {
        var _a;
        const modelPath = params.model;
        const modelId = sidecarModelIdFromPath(modelPath);
        const bridge = getDesktopBridge();
        if (bridge === null || bridge === void 0 ? void 0 : bridge.ensureSidecar) {
            const result = await bridge.ensureSidecar({
                modelPath,
                modelId,
                n_ctx: params.n_ctx,
                n_gpu_layers: params.n_gpu_layers,
                n_threads: params.n_threads,
                embedding: params.embedding,
            });
            if ((result === null || result === void 0 ? void 0 : result.ok) && result.port) {
                this.desktopProvider.setSidecarPort(result.port);
                await this.desktopProvider.loadModel({
                    modelId,
                    modelPath,
                    n_ctx: params.n_ctx,
                    n_gpu_layers: params.n_gpu_layers,
                    n_threads: params.n_threads,
                    embedding: params.embedding,
                });
                this.sidecarActive = true;
                this.gpuEnabled = !!result.gpuEnabled;
                this.contextToModel.set(contextId, modelId);
                return {
                    contextId,
                    gpu: this.gpuEnabled,
                    reasonNoGPU: this.gpuEnabled ? '' : ((_a = result.reasonNoGpu) !== null && _a !== void 0 ? _a : 'CPU-only inference'),
                    model: MODEL_DESC_DESKTOP,
                };
            }
        }
        const fallback = await super.initContext({ contextId, params });
        this.sidecarActive = false;
        return fallback;
    }
    async setContextLimit(opts) {
        await this.desktopProvider.setContextLimit(opts.limit);
    }
    async releaseContext({ contextId }) {
        const modelId = this.contextToModel.get(contextId);
        if (modelId && this.sidecarActive) {
            await this.desktopProvider.unloadModel(modelId);
        }
        await super.releaseContext({ contextId });
    }
    async startNativeLlamaServer(options) {
        var _a, _b, _c, _d;
        const bridge = getDesktopBridge();
        if (!(bridge === null || bridge === void 0 ? void 0 : bridge.ensureSidecar)) {
            throw new Error('LlamaCppDesktop: IPC bridge not available — register ipc-handlers in main process');
        }
        const result = await bridge.ensureSidecar({
            modelPath: options.modelPath,
            modelId: sidecarModelIdFromPath(options.modelPath),
            host: (_a = options.host) !== null && _a !== void 0 ? _a : '127.0.0.1',
            port: options.port,
            n_ctx: (_b = options.params) === null || _b === void 0 ? void 0 : _b.n_ctx,
            n_gpu_layers: (_c = options.params) === null || _c === void 0 ? void 0 : _c.n_gpu_layers,
            n_threads: (_d = options.params) === null || _d === void 0 ? void 0 : _d.n_threads,
        });
        if ((result === null || result === void 0 ? void 0 : result.ok) && result.port) {
            this.desktopProvider.setSidecarPort(result.port);
            this.sidecarActive = true;
            return { running: true };
        }
        return { running: false };
    }
    async isNativeLlamaServerRunning() {
        const bridge = getDesktopBridge();
        if (bridge === null || bridge === void 0 ? void 0 : bridge.getSidecarStatus) {
            const st = await bridge.getSidecarStatus();
            return { running: !!(st === null || st === void 0 ? void 0 : st.running) };
        }
        return { running: this.sidecarActive };
    }
    async stopNativeLlamaServer() {
        const bridge = getDesktopBridge();
        if (bridge === null || bridge === void 0 ? void 0 : bridge.stopSidecar) {
            await bridge.stopSidecar();
        }
        this.sidecarActive = false;
    }
}
//# sourceMappingURL=desktop.js.map