import { DuckDBModule } from './duckdb_module';

/**
 * Start the Worker that performs the engine's HTTP requests with fetch(), so a
 * request in flight can be aborted (lib/include/duckdb/web/http_fetch.h has the
 * mailbox layout and the C++ side).
 *
 * Synchronous XHR, the previous and fallback path, blocks the calling thread
 * until the whole response has arrived, so an interrupted query sat out its
 * HTTP request and the request timeout was never applied. The helper runs on
 * its own thread, where fetch() and AbortController work normally; a calling
 * thread waits on the mailbox in short slices and raises the slot's abort lane
 * when its query is interrupted or its deadline passes.
 *
 * It is started here, during instantiate, because a Worker can't start while
 * the thread that created it is blocked, and engine threads block for every
 * request. Only threads builds can use it (the mailbox has to be shared
 * memory); everywhere else, and until it reports ready, requests use XHR.
 */
export async function startHttpFetchHelper(mod: DuckDBModule, timeoutMs = 10_000): Promise<boolean> {
    const memory = (mod as any).wasmMemory as WebAssembly.Memory | undefined;
    if (
        typeof Worker === 'undefined' ||
        typeof Blob === 'undefined' ||
        typeof URL === 'undefined' ||
        typeof URL.createObjectURL !== 'function' ||
        typeof SharedArrayBuffer === 'undefined' ||
        !memory ||
        !(memory.buffer instanceof SharedArrayBuffer)
    ) {
        return false;
    }
    const mailbox = mod.ccall('duckdb_web_http_fetch_mailbox', 'number', [], []) >>> 0;
    const url = URL.createObjectURL(new Blob([HELPER_SOURCE], { type: 'text/javascript' }));
    let worker: Worker;
    try {
        worker = new Worker(url);
    } catch (e) {
        console.warn('[http] fetch helper unavailable, using synchronous XHR:', e);
        URL.revokeObjectURL(url);
        return false;
    }
    const ready = await new Promise<boolean>(resolve => {
        const timer = setTimeout(() => resolve(false), timeoutMs);
        worker.onmessage = (event: MessageEvent) => {
            if (event.data?.type === 'ready') {
                clearTimeout(timer);
                resolve(true);
            }
        };
        worker.onerror = () => {
            clearTimeout(timer);
            resolve(false);
        };
        // A blob: Worker has no Referer of its own; send the one XHR sent from here.
        worker.postMessage({ type: 'init', memory, mailbox, referrer: self.location.href });
    });
    URL.revokeObjectURL(url);
    if (!ready) {
        console.warn('[http] fetch helper did not start, using synchronous XHR');
        worker.terminate();
        return false;
    }
    // Held by the module so the Worker lives as long as the engine: once running it is
    // only parked in Atomics.waitAsync, and nothing else references it.
    (mod as any).httpFetchHelper = worker;
    mod.ccall('duckdb_web_http_fetch_ready', null, [], []);
    return true;
}

// Plain ES2017 so it runs as a classic Worker from a Blob URL. Lane numbers and
// states match lib/src/http_fetch.cc.
const HELPER_SOURCE = String.raw`
'use strict';
var HEADER_LANES = 16, SLOT_LANES = 16;
var STATE = 0, ABORT = 1, URL_PTR = 2, URL_LEN = 3, METHOD = 4, METHOD_LEN = 5, HEADERS = 6,
    HEADER_COUNT = 7, BODY = 8, BODY_LEN = 9, SIZE = 10, BUFFER = 11, PROGRESS = 12, COPIED = 13,
    ABANDONED = 14;
var FREE = 0, REQUEST = 2, IN_FLIGHT = 3, NEEDS_BUFFER = 4, BUFFER_PROVIDED = 5, DONE = 6, FAILED = 7,
    CANCELLED = 8;
var memory, base, referrer;
var serving = new Set();

// Views are re-created on every use: the memory can grow, which replaces its buffer.
function i32() { return new Int32Array(memory.buffer); }
function u8() { return new Uint8Array(memory.buffer); }
function lane(slot, index) { return base + HEADER_LANES + slot * SLOT_LANES + index; }
function load(slot, index) { return Atomics.load(i32(), lane(slot, index)); }
function publish(slot, state) {
    var view = i32();
    Atomics.store(view, lane(slot, STATE), state);
    Atomics.notify(view, lane(slot, STATE));
}
// A terminal state. If the caller gave up waiting (after an abort), nobody will
// collect it, so free the slot here; the caller frees it if it saw it first.
function finish(slot, state) {
    publish(slot, state);
    if (load(slot, ABANDONED) !== 0) {
        Atomics.compareExchange(i32(), lane(slot, STATE), state, FREE);
    }
}
function progressed(slot) { Atomics.add(i32(), lane(slot, PROGRESS), 1); }
// Resolves when the lane stops holding value, or after ms.
function waitFor(index, value, ms) {
    var view = i32();
    if (typeof Atomics.waitAsync === 'function') {
        var r = Atomics.waitAsync(view, index, value, ms);
        return r.async ? r.value : Promise.resolve(r.value);
    }
    return new Promise(function (resolve) { setTimeout(resolve, Math.min(ms, 10)); });
}
// TextDecoder refuses views of shared memory, so copy first.
function bytes(ptr, len) {
    var out = new Uint8Array(len);
    out.set(u8().subarray(ptr, ptr + len));
    return out;
}
function text(ptr, len) { return new TextDecoder().decode(bytes(ptr, len)); }
function cstring(ptr) {
    var view = u8(), end = ptr;
    while (view[end] !== 0) end++;
    return text(ptr, end - ptr);
}
function encode(status, headers, body) {
    var head = new TextEncoder().encode(headers);
    var out = new Uint8Array(2 + 4 + head.length + 4 + body.length);
    var dv = new DataView(out.buffer);
    dv.setUint16(0, status, true);
    dv.setUint32(2, head.length, true);
    out.set(head, 6);
    dv.setUint32(6 + head.length, body.length, true);
    out.set(body, 10 + head.length);
    return out;
}

async function serve(slot) {
    var view = i32();
    if (Atomics.compareExchange(view, lane(slot, STATE), REQUEST, IN_FLIGHT) !== REQUEST) return;
    var url, method, headers, body;
    try {
        url = text(load(slot, URL_PTR) >>> 0, load(slot, URL_LEN));
        method = text(load(slot, METHOD) >>> 0, load(slot, METHOD_LEN));
        headers = new Headers();
        var array = (load(slot, HEADERS) >>> 0) / 4;
        var count = load(slot, HEADER_COUNT);
        for (var i = 0; i < count * 2; i += 2) {
            var name = cstring(Atomics.load(i32(), array + i) >>> 0);
            if (name === 'User-Agent') continue;
            if (name === 'Host') name = 'X-Host-Override';
            try { headers.append(name, cstring(Atomics.load(i32(), array + i + 1) >>> 0)); }
            catch (e) { console.warn('[http] dropping request header', name, e); }
        }
        var bodyLen = load(slot, BODY_LEN);
        body = bodyLen > 0 ? bytes(load(slot, BODY) >>> 0, bodyLen) : null;
    } catch (e) {
        console.error('[http] fetch helper could not read the request:', e);
        Atomics.store(i32(), lane(slot, COPIED), 1);
        finish(slot, FAILED);
        return;
    }
    // From here on nothing of the caller's is read: it may free the request.
    Atomics.store(i32(), lane(slot, COPIED), 1);
    var controller = new AbortController();
    var settled = false;
    (async function watchAbort() {
        while (!settled) {
            if (load(slot, ABORT) !== 0) { controller.abort(); return; }
            await waitFor(lane(slot, ABORT), 0, 50);
        }
    })();
    var response;
    try {
        var res = await fetch(url, {
            method: method, headers: headers, body: body, signal: controller.signal, referrer: referrer,
        });
        progressed(slot);
        // Read the body in chunks so the caller sees progress: its timeout is one of
        // inactivity, not a limit on the whole transfer.
        var chunks = [], total = 0;
        if (method !== 'HEAD' && res.body) {
            var reader = res.body.getReader();
            for (;;) {
                var part = await reader.read();
                if (part.done) break;
                chunks.push(part.value);
                total += part.value.length;
                progressed(slot);
            }
        }
        var data = new Uint8Array(total), offset = 0;
        for (var c = 0; c < chunks.length; c++) { data.set(chunks[c], offset); offset += chunks[c].length; }
        var lines = [];
        res.headers.forEach(function (value, key) { lines.push(key + ': ' + value); });
        response = encode(res.status, lines.join('\r\n'), data);
    } catch (e) {
        settled = true;
        if (controller.signal.aborted) { finish(slot, CANCELLED); return; }
        console.error('[http] ' + method + ' ' + url + ' failed:', e);
        finish(slot, FAILED);
        return;
    }
    settled = true;
    Atomics.store(i32(), lane(slot, SIZE), response.length);
    publish(slot, NEEDS_BUFFER);
    while (load(slot, STATE) === NEEDS_BUFFER) await waitFor(lane(slot, STATE), NEEDS_BUFFER, 1000);
    var buffer = load(slot, BUFFER) >>> 0;
    if (!buffer) { finish(slot, CANCELLED); return; }
    u8().set(response, buffer);
    finish(slot, DONE);
}

async function run() {
    var count = Atomics.load(i32(), base + 2);
    for (;;) {
        var seen = Atomics.load(i32(), base);
        for (var slot = 0; slot < count; slot++) {
            if (!serving.has(slot) && load(slot, STATE) === REQUEST) {
                serving.add(slot);
                (function (s) { serve(s).finally(function () { serving.delete(s); }); })(slot);
            }
        }
        await waitFor(base, seen, 1000);
    }
}

self.onmessage = function (event) {
    var data = event.data;
    if (!data || data.type !== 'init') return;
    memory = data.memory;
    base = data.mailbox / 4;
    referrer = data.referrer;
    self.postMessage({ type: 'ready' });
    run();
};
`;
