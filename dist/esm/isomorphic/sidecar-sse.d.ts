/** OpenAI-style SSE lines emitted by the native desktop sidecar. */
export type SidecarSseKind = 'chat' | 'completion';
/** Extract a token string from one SSE `data:` JSON payload (empty if none). */
export declare function extractSidecarSseToken(payload: string, kind: SidecarSseKind): string;
/** Parse a single SSE line; returns a token when present. */
export declare function parseSidecarSseLine(line: string, kind: SidecarSseKind): string | null;
/** Buffers decoded stream bytes into complete newline-delimited lines. */
export declare class SidecarSseLineParser {
    private buffer;
    feed(chunk: string): string[];
    flush(): string[];
}
/** Read token chunks from a fetch `ReadableStream` body. */
export declare function readSidecarSseTokens(body: ReadableStream<Uint8Array>, kind: SidecarSseKind, onToken: (token: string) => void): Promise<void>;
