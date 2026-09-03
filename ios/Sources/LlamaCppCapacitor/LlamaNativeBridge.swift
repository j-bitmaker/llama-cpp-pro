import Foundation

enum LlamaNativeBridge {
    enum Failure: LocalizedError {
        case missingSymbol(String)
        case modelNotFound(String)
        case initializationFailed(String)
        case completionFailed(String)
        case embeddingFailed(String)
        case operationFailed(String)

        var errorDescription: String? {
            switch self {
            case .missingSymbol(let symbol):
                return "Native symbol \(symbol) is not linked. Rebuild llama-cpp.framework."
            case .modelNotFound(let path):
                return "Model file not found at \(path)"
            case .initializationFailed(let details):
                return "Failed to initialize llama context: \(details)"
            case .completionFailed(let details):
                return "Failed to run local completion: \(details)"
            case .embeddingFailed(let details):
                return "Failed to run local embedding: \(details)"
            case .operationFailed(let details):
                return "Operation failed: \(details)"
            }
        }
    }

    private typealias InitContextFn     = @convention(c) (UnsafePointer<CChar>, UnsafePointer<CChar>) -> Int64
    private typealias ReleaseContextFn  = @convention(c) (Int64) -> Void
    private typealias RunCompletionFn   = @convention(c) (Int64, UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>?
    private typealias FreeResultFn      = @convention(c) (UnsafeMutablePointer<CChar>) -> Void
    // PATCH (2026-08-20, local-ai per-token-streaming-ios, drafted off-device — see this
    // typealias pair's call site, runCompletionStream(), for the full TODO(mac) list):
    // matches cpp/cap-ios-bridge.cpp's existing `llama_completion_stream`'s C signature —
    // `const char * llama_completion_stream(int64_t context_id, const char * params_json,
    // void (*token_callback)(const char *token_text, void *user_data, int token_index),
    // void *user_data)`. That function already exists upstream (comment there: "Streaming
    // completion with per-token C callback (all native/desktop targets)") — this Swift
    // bridge just never called it before this patch. Parameter order must stay in lockstep
    // with the C declaration; if `cap-ios-bridge.cpp` ever changes it, this silently
    // miscompiles into a crash (dlsym has no type info to catch a mismatch), not a
    // compile error — worth re-diffing against the C header on the next `llama-cpp-pro`
    // version bump.
    private typealias TokenCallback         = @convention(c) (UnsafePointer<CChar>?, UnsafeMutableRawPointer?, Int32) -> Void
    private typealias RunCompletionStreamFn = @convention(c) (Int64, UnsafePointer<CChar>, TokenCallback?, UnsafeMutableRawPointer?) -> UnsafeMutablePointer<CChar>?
    private typealias StopCompletionFn  = @convention(c) (Int64) -> Void
    private typealias RunEmbeddingJsonFn = @convention(c) (Int64, UnsafePointer<CChar>, UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>?
    private typealias JsonOpFn          = @convention(c) (Int64, UnsafePointer<CChar>, UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>?
    private typealias SingleArgJsonFn   = @convention(c) (Int64, UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>?
    private typealias BoolFn            = @convention(c) (Int64) -> Int32
    private typealias BoolBoolFn        = @convention(c) (Int64, Int32) -> Int32
    private typealias SessionSaveFn     = @convention(c) (Int64, UnsafePointer<CChar>, Int32) -> Int32
    private typealias BenchFn           = @convention(c) (Int64, Int32, Int32, Int32, Int32) -> UnsafeMutablePointer<CChar>?
    private typealias LoraApplyFn       = @convention(c) (Int64, UnsafePointer<CChar>) -> Int32
    private typealias VoidFn            = @convention(c) (Int64) -> Void
    private typealias MultimodalInitFn  = @convention(c) (Int64, UnsafePointer<CChar>, Int32) -> Int32
    private typealias VocoderInitFn     = @convention(c) (Int64, UnsafePointer<CChar>, Int32) -> Int32

    private static var library: UnsafeMutableRawPointer? = {
        let fm = FileManager.default
        var candidates: [String] = []
        if let fw = Bundle.main.path(forResource: "llama-cpp", ofType: "framework") {
            candidates.append((fw as NSString).appendingPathComponent("llama-cpp"))
        }
        if let exec = Bundle.main.executablePath {
            candidates.append((exec as NSString).deletingLastPathComponent + "/Frameworks/llama-cpp.framework/llama-cpp")
        }
        for path in candidates where fm.fileExists(atPath: path) {
            if let handle = dlopen(path, RTLD_NOW) {
                return handle
            }
            print("[LlamaNativeBridge] dlopen failed for \(path): \(String(cString: dlerror()))")
        }
        print("[LlamaNativeBridge] llama-cpp framework binary not found; tried: \(candidates)")
        return nil
    }()

    static func sym<T>(_ name: String, _ type: T.Type) throws -> T {
        guard let library else {
            throw Failure.missingSymbol(name)
        }
        guard let pointer = dlsym(library, name) else {
            throw Failure.missingSymbol(name)
        }
        return unsafeBitCast(pointer, to: T.self)
    }

    static func trySymOpt<T>(_ name: String, _ type: T.Type) -> T? {
        guard let library, let pointer = dlsym(library, name) else { return nil }
        return unsafeBitCast(pointer, to: T.self)
    }

    // MARK: - Core

    static func initContext(modelPath: String, paramsJson: String) throws -> Int64 {
        let normalizedPath = normalizeModelPath(modelPath)
        guard FileManager.default.fileExists(atPath: normalizedPath) else {
            throw Failure.modelNotFound(normalizedPath)
        }
        let fn = try sym("llama_init_context", InitContextFn.self)
        let id = normalizedPath.withCString { mp in
            paramsJson.withCString { pj in fn(mp, pj) }
        }
        guard id > 0 else {
            throw Failure.initializationFailed("native loader returned \(id) for \(normalizedPath)")
        }
        return id
    }

    static func releaseContext(_ contextId: Int64) {
        guard let fn = try? sym("llama_release_context", ReleaseContextFn.self) else { return }
        fn(contextId)
    }

    static func runCompletion(contextId: Int64, paramsJson: String) throws -> [String: Any] {
        let fn   = try sym("llama_run_completion", RunCompletionFn.self)
        let free = try sym("llama_free_completion_result", FreeResultFn.self)
        let ptr  = paramsJson.withCString { fn(contextId, $0) }
        guard let ptr else { throw Failure.completionFailed("nil result") }
        defer { free(ptr) }
        return try decodeJsonDictionary(from: ptr, failure: .completionFailed("invalid JSON"))
    }

    // PATCH (2026-08-20, local-ai per-token-streaming-ios): per-token sibling of
    // runCompletion() above, added to close the gap docs/decisions.md's "iOS:
    // notifyListeners unimplemented..." entry logged (2026-08-20) — the JS wrapper
    // (dist/esm/index.js) has always expected native per-token events, iOS just never sent
    // any. Wraps `llama_completion_stream`, NOT a new native code path — see the
    // typealias doc comment above for why no C++ changes were needed for this half of the
    // fix.
    //
    // TODO(mac), in order of what would actually break this:
    // 1. `sym("llama_completion_stream", ...)` may throw `.missingSymbol` if the currently
    //    vendored `ios/Frameworks/llama-cpp.xcframework` predates this function being
    //    compiled in. If so: `bash scripts/ensure-llama-ios-xcframework.sh` won't
    //    necessarily rebuild it on its own — that script short-circuits on a cached
    //    xcframework unless `EXPECTED_BUILD_PROFILE` changed (see the script), so you may
    //    need to `rm -rf ios/Frameworks/llama-cpp.xcframework` first, or bump that
    //    constant, to force a real rebuild against the current cpp/ sources. This patch's
    //    LlamaCpp.swift call site already falls back to the non-streaming runCompletion()
    //    on `.missingSymbol` (fails closed, same shape as Android's "method not found"
    //    fallback), so a stale xcframework degrades to today's behavior rather than
    //    crashing — but per-token streaming silently won't happen until it's rebuilt.
    // 2. The C callback fires from wherever `llama_completion_stream`'s internal generation
    //    loop runs (same background thread `LlamaCpp.completion()` already dispatches
    //    onto, DispatchQueue.global(qos: .userInitiated) — see that file). Confirm
    //    `Plugin.notifyListeners()` (called from `onPartialToken` in
    //    LlamaCppPlugin.swift) is actually safe to call off the main thread — if not,
    //    that closure needs a `DispatchQueue.main.async` hop.
    // 3. `llama_completion_stream`'s result JSON (cap-ios-bridge.cpp, ~line 1067) always
    //    sets `reasoning_content: ""` and doesn't run getPartialOutput()'s chat-format
    //    parsing the way `llama_run_completion` does — the TS-side adapter
    //    (llama-cpp-capacitor.adapter.ts's splitReasoningContent()) already nets raw
    //    `<think>` blocks as a fallback, so this is expected to be harmless, but worth
    //    an eyeball on a real `<think>`-using model.
    // 4. Not verified: whether `llama_completion_stream` honors the same stop-word /
    //    stopping_word bookkeeping `llama_run_completion` does (its result always reports
    //    `stopped_word: ""`, `stopping_word: ""`) — check if any of local-ai's/the
    //    consuming app's prompts actually depend on `stop` params for early termination
    //    before trusting this path for those.
    static func runCompletionStream(
        contextId: Int64,
        paramsJson: String,
        onToken: @escaping (String) -> Void
    ) throws -> [String: Any] {
        let fn   = try sym("llama_completion_stream", RunCompletionStreamFn.self)
        let free = try sym("llama_free_completion_result", FreeResultFn.self)

        // Boxes the Swift closure so it can cross the C ABI as a `void *user_data` —
        // `@convention(c)` function pointers can't capture Swift context directly.
        // `passRetained`/`release()` keep the box alive exactly for this call's duration
        // regardless of which exit path (success/throw) is taken.
        final class TokenBox {
            let onToken: (String) -> Void
            init(_ f: @escaping (String) -> Void) { onToken = f }
        }
        let box = TokenBox(onToken)
        let userData = Unmanaged.passRetained(box).toOpaque()
        defer { Unmanaged<TokenBox>.fromOpaque(userData).release() }

        let trampoline: TokenCallback = { tokenPtr, userData, _ in
            guard let tokenPtr, let userData else { return }
            let token = String(cString: tokenPtr)
            Unmanaged<TokenBox>.fromOpaque(userData).takeUnretainedValue().onToken(token)
        }

        let ptr = paramsJson.withCString { fn(contextId, $0, trampoline, userData) }
        guard let ptr else { throw Failure.completionFailed("nil result") }
        defer { free(ptr) }
        return try decodeJsonDictionary(from: ptr, failure: .completionFailed("invalid JSON"))
    }

    static func runEmbedding(contextId: Int64, text: String, paramsJson: String) throws -> [String: Any] {
        let fn   = try sym("llama_run_embedding_json", RunEmbeddingJsonFn.self)
        let free = try sym("llama_free_completion_result", FreeResultFn.self)
        let ptr  = text.withCString { t in paramsJson.withCString { p in fn(contextId, t, p) } }
        guard let ptr else { throw Failure.embeddingFailed("nil result") }
        defer { free(ptr) }
        return try decodeJsonDictionary(from: ptr, failure: .embeddingFailed("invalid JSON"))
    }

    static func stopCompletion(_ contextId: Int64) {
        guard let fn = try? sym("llama_stop_completion", StopCompletionFn.self) else { return }
        fn(contextId)
    }

    // MARK: - Rerank

    /// Returns JSON: [{"score": float, "index": int}, ...]
    static func runRerank(contextId: Int64, query: String, documentsJson: String) throws -> [[String: Any]] {
        // llama_rerank_json(context_id, query_cstr, docs_json_cstr) -> char*
        guard let fn: JsonOpFn = trySymOpt("llama_rerank_json", JsonOpFn.self),
              let free: FreeResultFn = trySymOpt("llama_free_completion_result", FreeResultFn.self) else {
            throw Failure.missingSymbol("llama_rerank_json")
        }
        let ptr = query.withCString { q in documentsJson.withCString { d in fn(contextId, q, d) } }
        guard let ptr else { throw Failure.operationFailed("rerank returned nil") }
        defer { free(ptr) }
        let json = String(cString: ptr)
        guard let data = json.data(using: .utf8),
              let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
            throw Failure.operationFailed("rerank returned invalid JSON")
        }
        return arr
    }

    // MARK: - Bench

    /// Returns the raw bench result string "[modelDesc, size, nParams, ppAvg, ppStd, tgAvg, tgStd]"
    static func runBench(contextId: Int64, pp: Int, tg: Int, pl: Int, nr: Int) throws -> String {
        guard let fn: BenchFn = trySymOpt("llama_bench", BenchFn.self),
              let free: FreeResultFn = trySymOpt("llama_free_completion_result", FreeResultFn.self) else {
            throw Failure.missingSymbol("llama_bench")
        }
        let ptr = fn(contextId, Int32(pp), Int32(tg), Int32(pl), Int32(nr))
        guard let ptr else { return "[]" }
        defer { free(ptr) }
        return String(cString: ptr)
    }

    // MARK: - Session management

    static func loadSession(contextId: Int64, filepath: String) throws -> [String: Any] {
        guard let fn: SingleArgJsonFn = trySymOpt("llama_cap_load_session_file", SingleArgJsonFn.self),
              let free: FreeResultFn  = trySymOpt("llama_free_completion_result", FreeResultFn.self) else {
            throw Failure.missingSymbol("llama_cap_load_session_file")
        }
        let ptr = filepath.withCString { fn(contextId, $0) }
        guard let ptr else { throw Failure.operationFailed("loadSession returned nil for \(filepath)") }
        defer { free(ptr) }
        return try decodeJsonDictionary(from: ptr, failure: .operationFailed("loadSession invalid JSON"))
    }

    static func saveSession(contextId: Int64, filepath: String, size: Int) throws -> Int {
        guard let fn: SessionSaveFn = trySymOpt("llama_cap_save_session_file", SessionSaveFn.self) else {
            throw Failure.missingSymbol("llama_cap_save_session_file")
        }
        let saved = filepath.withCString { fn(contextId, $0, Int32(size)) }
        return Int(saved)
    }

    // MARK: - LoRA

    /// loraAdaptersJson: JSON array [{path:string, scale:float}, ...]
    static func applyLoraAdapters(contextId: Int64, loraAdaptersJson: String) throws -> Int {
        guard let fn: LoraApplyFn = trySymOpt("llama_apply_lora_adapters", LoraApplyFn.self) else {
            throw Failure.missingSymbol("llama_apply_lora_adapters")
        }
        let result = loraAdaptersJson.withCString { fn(contextId, $0) }
        if result < 0 {
            throw Failure.operationFailed("applyLoraAdapters returned \(result)")
        }
        return Int(result)
    }

    static func removeLoraAdapters(contextId: Int64) throws {
        guard let fn: VoidFn = trySymOpt("llama_remove_lora_adapters", VoidFn.self) else {
            throw Failure.missingSymbol("llama_remove_lora_adapters")
        }
        fn(contextId)
    }

    static func getLoadedLoraAdapters(contextId: Int64) throws -> [[String: Any]] {
        guard let fn: SingleArgJsonFn = trySymOpt("llama_get_loaded_lora_adapters", SingleArgJsonFn.self),
              let free: FreeResultFn  = trySymOpt("llama_free_completion_result", FreeResultFn.self) else {
            throw Failure.missingSymbol("llama_get_loaded_lora_adapters")
        }
        // fn takes (contextId, empty_cstr) — use "" as placeholder
        let ptr = "".withCString { fn(contextId, $0) }
        guard let ptr else { return [] }
        defer { free(ptr) }
        let json = String(cString: ptr)
        guard let data = json.data(using: .utf8),
              let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
            return []
        }
        return arr
    }

    // MARK: - Multimodal

    static func initMultimodal(contextId: Int64, mmProjPath: String, useGpu: Bool) throws -> Bool {
        guard let fn: MultimodalInitFn = trySymOpt("llama_init_multimodal", MultimodalInitFn.self) else {
            throw Failure.missingSymbol("llama_init_multimodal")
        }
        let result = mmProjPath.withCString { fn(contextId, $0, useGpu ? 1 : 0) }
        return result != 0
    }

    static func isMultimodalEnabled(contextId: Int64) -> Bool {
        guard let fn: BoolFn = trySymOpt("llama_is_multimodal_enabled", BoolFn.self) else { return false }
        return fn(contextId) != 0
    }

    static func getMultimodalSupport(contextId: Int64) throws -> [String: Any] {
        guard let fn: SingleArgJsonFn = trySymOpt("llama_get_multimodal_support", SingleArgJsonFn.self),
              let free: FreeResultFn  = trySymOpt("llama_free_completion_result", FreeResultFn.self) else {
            throw Failure.missingSymbol("llama_get_multimodal_support")
        }
        let ptr = "".withCString { fn(contextId, $0) }
        guard let ptr else { return ["vision": false, "audio": false] }
        defer { free(ptr) }
        return (try? decodeJsonDictionary(from: ptr, failure: .operationFailed("bad JSON"))) ?? ["vision": false, "audio": false]
    }

    static func releaseMultimodal(contextId: Int64) {
        guard let fn: VoidFn = trySymOpt("llama_release_multimodal", VoidFn.self) else { return }
        fn(contextId)
    }

    // MARK: - TTS / Vocoder

    static func initVocoder(contextId: Int64, path: String, nBatch: Int) throws -> Bool {
        guard let fn: VocoderInitFn = trySymOpt("llama_init_vocoder", VocoderInitFn.self) else {
            throw Failure.missingSymbol("llama_init_vocoder")
        }
        let result = path.withCString { fn(contextId, $0, Int32(nBatch)) }
        return result != 0
    }

    static func isVocoderEnabled(contextId: Int64) -> Bool {
        guard let fn: BoolFn = trySymOpt("llama_is_vocoder_enabled", BoolFn.self) else { return false }
        return fn(contextId) != 0
    }

    static func getFormattedAudioCompletion(contextId: Int64, speakerJson: String, text: String) throws -> [String: Any] {
        guard let fn: JsonOpFn    = trySymOpt("llama_get_formatted_audio_completion", JsonOpFn.self),
              let free: FreeResultFn = trySymOpt("llama_free_completion_result", FreeResultFn.self) else {
            throw Failure.missingSymbol("llama_get_formatted_audio_completion")
        }
        let ptr = speakerJson.withCString { sp in text.withCString { tx in fn(contextId, sp, tx) } }
        guard let ptr else { throw Failure.operationFailed("getFormattedAudioCompletion returned nil") }
        defer { free(ptr) }
        return try decodeJsonDictionary(from: ptr, failure: .operationFailed("audio completion invalid JSON"))
    }

    static func getAudioCompletionGuideTokens(contextId: Int64, text: String) throws -> [Int] {
        guard let fn: SingleArgJsonFn = trySymOpt("llama_get_audio_completion_guide_tokens", SingleArgJsonFn.self),
              let free: FreeResultFn  = trySymOpt("llama_free_completion_result", FreeResultFn.self) else {
            throw Failure.missingSymbol("llama_get_audio_completion_guide_tokens")
        }
        let ptr = text.withCString { fn(contextId, $0) }
        guard let ptr else { return [] }
        defer { free(ptr) }
        let json = String(cString: ptr)
        guard let data = json.data(using: .utf8),
              let arr  = try? JSONSerialization.jsonObject(with: data) as? [Int] else { return [] }
        return arr
    }

    static func decodeAudioTokens(contextId: Int64, tokensJson: String) throws -> [Float] {
        guard let fn: SingleArgJsonFn = trySymOpt("llama_decode_audio_tokens", SingleArgJsonFn.self),
              let free: FreeResultFn  = trySymOpt("llama_free_completion_result", FreeResultFn.self) else {
            throw Failure.missingSymbol("llama_decode_audio_tokens")
        }
        let ptr = tokensJson.withCString { fn(contextId, $0) }
        guard let ptr else { return [] }
        defer { free(ptr) }
        let json = String(cString: ptr)
        guard let data = json.data(using: .utf8),
              let arr  = try? JSONSerialization.jsonObject(with: data) as? [Double] else { return [] }
        return arr.map { Float($0) }
    }

    static func releaseVocoder(contextId: Int64) {
        guard let fn: VoidFn = trySymOpt("llama_release_vocoder", VoidFn.self) else { return }
        fn(contextId)
    }

    // MARK: - GPU info

    /// Returns {"gpu": bool, "reasonNoGPU": string} from native context model JSON
    static func queryGpuInfo(contextId: Int64) -> (gpu: Bool, reason: String) {
        guard let fn: SingleArgJsonFn = trySymOpt("llama_get_context_gpu_info", SingleArgJsonFn.self),
              let free: FreeResultFn  = trySymOpt("llama_free_completion_result", FreeResultFn.self) else {
            return (false, "llama_get_context_gpu_info not available")
        }
        let ptr = "".withCString { fn(contextId, $0) }
        guard let ptr else { return (false, "no GPU info returned") }
        defer { free(ptr) }
        let json = String(cString: ptr)
        guard let data = json.data(using: .utf8),
              let d = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return (false, "GPU info JSON parse error")
        }
        let gpu = (d["gpu"] as? Bool) ?? false
        let reason = (d["reasonNoGPU"] as? String) ?? (gpu ? "" : "Metal/GPU not available")
        return (gpu, reason)
    }

    // MARK: - Helpers

    static func decodeJsonDictionary(
        from resultPointer: UnsafeMutablePointer<CChar>,
        failure: Failure
    ) throws -> [String: Any] {
        let jsonString = String(cString: resultPointer)
        guard let data = jsonString.data(using: .utf8) else { throw failure }
        let object = try JSONSerialization.jsonObject(with: data, options: [])
        guard let dictionary = object as? [String: Any] else { throw failure }
        return dictionary
    }

    static func normalizeModelPath(_ modelPath: String) -> String {
        if modelPath.hasPrefix("file://") {
            return String(modelPath.dropFirst("file://".count))
        }
        return modelPath
    }
}
