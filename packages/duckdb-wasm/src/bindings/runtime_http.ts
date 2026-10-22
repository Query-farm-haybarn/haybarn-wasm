import { DuckDBModule } from './duckdb_module';

/**
 * Haybarn: the synchronous HTTP requests of the JS runtime (remote files read without httpfs: open, range reads,
 * globs), abortable on the threads bundle.
 *
 * The runtime serves file system calls on the worker's main thread, and a synchronous XHR there cannot be aborted:
 * an interrupted query waited for its request to finish. Once the fetch helper runs (http_fetch_helper.ts), a request
 * goes through it instead (duckdb_web_http_fetch_runtime), and the engine aborts it when the query the runtime call
 * serves is interrupted. Elsewhere (the base bundle, the blocking bindings, before the helper is ready) it is the
 * synchronous XHR it always was.
 *
 * Only what the runtime uses of XMLHttpRequest is implemented.
 */
export function runtimeHTTPRequest(mod: DuckDBModule): XMLHttpRequest {
    if (!(mod as any).httpFetchHelper) {
        return new XMLHttpRequest();
    }
    return new HelperRequest(mod) as unknown as XMLHttpRequest;
}

/** FetchOutcome in http_fetch.h */
enum FetchOutcome {
    UNAVAILABLE = 0,
    OK = 1,
    FAILED = 2,
    CANCELLED = 3,
    TIMED_OUT = 4,
}

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

class HelperRequest {
    protected method = 'GET';
    protected url = '';
    protected requestHeaders: [string, string][] = [];
    protected mimeType: string | null = null;
    protected responseHeaders = new Map<string, string>();
    protected rawResponseHeaders = '';
    public responseType: XMLHttpRequestResponseType = '';
    public status = 0;
    public statusText = '';
    public response: any = null;

    constructor(protected readonly mod: DuckDBModule) {}

    open(method: string, url: string, _async?: boolean): void {
        this.method = method;
        this.url = url;
    }
    setRequestHeader(name: string, value: string): void {
        this.requestHeaders.push([name, value]);
    }
    overrideMimeType(mime: string): void {
        this.mimeType = mime;
    }
    getResponseHeader(name: string): string | null {
        return this.responseHeaders.get(name.toLowerCase()) ?? null;
    }
    getAllResponseHeaders(): string {
        return this.rawResponseHeaders;
    }
    get responseText(): string {
        const bytes = new Uint8Array(this.response ?? new ArrayBuffer(0));
        let text = '';
        for (let i = 0; i < bytes.length; ++i) text += String.fromCharCode(bytes[i]);
        return text;
    }

    send(body?: Uint8Array | ArrayBuffer | null): void {
        const result = this.fetch(body ?? null);
        if (result === null) {
            this.sendXHR(body ?? null);
            return;
        }
        switch (result.outcome) {
            case FetchOutcome.OK:
                this.parse(result.buffer!);
                return;
            case FetchOutcome.CANCELLED:
                throw new Error(`HTTP ${this.method} request to ${this.url} was interrupted`);
            default:
                // Like the network error of a synchronous XHR
                throw new Error(`NetworkError: HTTP ${this.method} request to ${this.url} failed`);
        }
    }

    /** Perform the request through the fetch helper; null when it is unavailable */
    protected fetch(body: Uint8Array | ArrayBuffer | null): { outcome: number; buffer: Uint8Array | null } | null {
        const mod = this.mod;
        const allocations: number[] = [];
        const alloc = (size: number) => {
            const ptr = mod._malloc(Math.max(size, 1)) >>> 0;
            allocations.push(ptr);
            return ptr;
        };
        const cstring = (text: string) => {
            const bytes = TEXT_ENCODER.encode(text);
            const ptr = alloc(bytes.length + 1);
            mod.HEAPU8.set(bytes, ptr);
            mod.HEAPU8[ptr + bytes.length] = 0;
            return ptr;
        };
        try {
            const url = cstring(this.url);
            const method = cstring(this.method);
            const headers = alloc(this.requestHeaders.length * 8);
            this.requestHeaders.forEach(([name, value], i) => {
                const namePtr = cstring(name);
                const valuePtr = cstring(value);
                mod.HEAP32[(headers >>> 2) + i * 2] = namePtr;
                mod.HEAP32[(headers >>> 2) + i * 2 + 1] = valuePtr;
            });
            let bodyPtr = 0;
            let bodyLen = 0;
            if (body !== null) {
                const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
                bodyLen = bytes.length;
                bodyPtr = alloc(bodyLen);
                mod.HEAPU8.set(bytes, bodyPtr);
            }
            const outcomePtr = alloc(4);
            const buffer =
                mod.ccall(
                    'duckdb_web_http_fetch_runtime',
                    'number',
                    ['number', 'number', 'number', 'number', 'number', 'number', 'number'],
                    [url, method, headers, this.requestHeaders.length, bodyPtr, bodyLen, outcomePtr],
                ) >>> 0;
            const outcome = mod.HEAP32[outcomePtr >>> 2];
            if (outcome === FetchOutcome.UNAVAILABLE) return null;
            if (outcome !== FetchOutcome.OK || buffer === 0) return { outcome, buffer: null };
            allocations.push(buffer);
            // [status:2 LE][headers length:4 LE][headers][body length:4 LE][body]
            const view = new DataView(mod.HEAPU8.buffer, buffer);
            const headersLen = view.getUint32(2, true);
            const bodyLength = view.getUint32(6 + headersLen, true);
            return { outcome, buffer: mod.HEAPU8.slice(buffer, buffer + 10 + headersLen + bodyLength) };
        } finally {
            for (const ptr of allocations) mod._free(ptr);
        }
    }

    /** Take over the response of the fetch helper */
    protected parse(buffer: Uint8Array): void {
        const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        this.status = view.getUint16(0, true);
        const headersLen = view.getUint32(2, true);
        this.rawResponseHeaders = TEXT_DECODER.decode(buffer.subarray(6, 6 + headersLen));
        for (const line of this.rawResponseHeaders.split('\r\n')) {
            const colon = line.indexOf(':');
            if (colon > 0) this.responseHeaders.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
        }
        const bodyLen = view.getUint32(6 + headersLen, true);
        const bodyStart = 10 + headersLen;
        this.response = buffer.slice(bodyStart, bodyStart + bodyLen).buffer;
    }

    /** The synchronous XHR, when the helper is unavailable */
    protected sendXHR(body: Uint8Array | ArrayBuffer | null): void {
        const xhr = new XMLHttpRequest();
        xhr.open(this.method, this.url, false);
        for (const [name, value] of this.requestHeaders) xhr.setRequestHeader(name, value);
        if (this.mimeType !== null) xhr.overrideMimeType(this.mimeType);
        if (this.responseType) xhr.responseType = this.responseType;
        xhr.send(body);
        this.status = xhr.status;
        this.statusText = xhr.statusText;
        this.response = xhr.response;
        this.rawResponseHeaders = xhr.getAllResponseHeaders();
        for (const line of this.rawResponseHeaders.split('\r\n')) {
            const colon = line.indexOf(':');
            if (colon > 0) this.responseHeaders.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
        }
    }
}
