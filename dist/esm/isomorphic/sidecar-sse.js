/** Extract a token string from one SSE `data:` JSON payload (empty if none). */
export function extractSidecarSseToken(payload, kind) {
    var _a, _b, _c, _d, _e, _f, _g;
    if (payload === '[DONE]') {
        return '';
    }
    try {
        const chunk = JSON.parse(payload);
        if (kind === 'chat') {
            return (_d = (_c = (_b = (_a = chunk.choices) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.delta) === null || _c === void 0 ? void 0 : _c.content) !== null && _d !== void 0 ? _d : '';
        }
        return (_g = (_f = (_e = chunk.choices) === null || _e === void 0 ? void 0 : _e[0]) === null || _f === void 0 ? void 0 : _f.text) !== null && _g !== void 0 ? _g : '';
    }
    catch (_h) {
        return '';
    }
}
/** Parse a single SSE line; returns a token when present. */
export function parseSidecarSseLine(line, kind) {
    if (!line.startsWith('data: ')) {
        return null;
    }
    const payload = line.slice(6).trim();
    if (payload === '[DONE]') {
        return null;
    }
    const token = extractSidecarSseToken(payload, kind);
    return token ? token : null;
}
/** Buffers decoded stream bytes into complete newline-delimited lines. */
export class SidecarSseLineParser {
    constructor() {
        this.buffer = '';
    }
    feed(chunk) {
        var _a;
        this.buffer += chunk;
        const lines = this.buffer.split('\n');
        this.buffer = (_a = lines.pop()) !== null && _a !== void 0 ? _a : '';
        return lines;
    }
    flush() {
        if (!this.buffer) {
            return [];
        }
        const line = this.buffer;
        this.buffer = '';
        return [line];
    }
}
/** Read token chunks from a fetch `ReadableStream` body. */
export async function readSidecarSseTokens(body, kind, onToken) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const parser = new SidecarSseLineParser();
    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        const lines = parser.feed(decoder.decode(value, { stream: true }));
        for (const line of lines) {
            const token = parseSidecarSseLine(line, kind);
            if (token) {
                onToken(token);
            }
        }
    }
    for (const line of parser.flush()) {
        const token = parseSidecarSseLine(line, kind);
        if (token) {
            onToken(token);
        }
    }
}
//# sourceMappingURL=sidecar-sse.js.map