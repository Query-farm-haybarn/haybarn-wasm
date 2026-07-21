// Main-thread half of the VGI browser `worker:` SAB transport.
//
// A VGI catalog attached with `LOCATION 'worker:<url>'` runs its worker
// client-side in a Web Worker, exchanging Arrow batches with the extension over a
// SharedArrayBuffer duplex-ring channel that lives in DuckDB's own shared linear
// memory (decision #1). When the extension first needs the worker it calls the
// engine-glue stub `vgi_wasm_ensure_worker`, which posts
// `{type:'vgi-ensure-worker', location, offset, buffer, readySab}` up to this
// bridge and blocks on `readySab` (Atomics.wait) until we report the worker
// booted. `buffer` is DuckDB's `wasmMemory.buffer` — the exact SharedArrayBuffer
// the channel was malloc'd into — so handing it to the VGI worker gives it a view
// over the same memory + `offset`.
//
// This is the exact analog of vgi-oauth-bridge.ts (which proxies
// `duckdb_wasm_open_auth_url`), and is registered the same way:
//   <DuckDBProvider onWorkerCreated={composeWorkerBridges(installVgiOAuthBridge,
//                                                          installVgiWebWorkerBridge())}>
//
// Security: SQL must not be able to spawn arbitrary code. `resolveWorkerUrl`
// gates which worker URLs are allowed (default: same-origin only). A rejected
// location fails the ATTACH with a clear error rather than launching anything.

export interface VgiWebWorkerBridgeOptions {
    /**
     * Gate + resolve which worker URLs SQL may spawn. Return the resolved Worker
     * URL to allow, or null to reject. Default: allow same-origin URLs only.
     */
    resolveWorkerUrl?: (location: string) => string | null;
    /**
     * Origins (beyond this page's own) whose worker scripts may be spawned, or
     * `'*'` for any. A worker script cannot be handed to `new Worker()`
     * cross-origin — the browser refuses — so an allowed remote script is
     * fetched under CORS and spawned from a same-origin `blob:` URL.
     *
     * NOTE what that means: a blob worker runs with THIS PAGE's origin, so a
     * remote script gains the page's privileges (same-origin fetch, storage,
     * cookies). Only list origins you would be willing to run as your own app.
     * Default: none — same-origin scripts only.
     */
    allowRemoteOrigins?: string[] | '*';
    /**
     * Optional extension hook: invoked for any message a spawned VGI worker posts
     * that this bridge doesn't itself consume (i.e. anything that isn't the
     * `vgi-ready` / `vgi-error` boot handshake). Lets an app extend the worker↔page
     * protocol with page-only capabilities the worker realm can't reach — e.g. a
     * Window-only Web API — WITHOUT baking app-specific logic into this shared
     * bridge. The handler receives the spawned worker and the raw message data.
     */
    onVgiWorkerMessage?: (worker: Worker, data: unknown) => void;
}

function makeResolveWorkerUrl(allow: string[] | '*' | undefined) {
    return (location: string): string | null => {
        try {
            const url = new URL(location, self.location.href);
            // Same-origin (this includes `blob:` URLs this page minted, whose
            // origin is the inner origin) is always allowed.
            if (url.origin === self.location.origin) return url.href;
            // Otherwise only origins the APP opted into — never something a SQL
            // string alone can choose.
            if (allow === '*') return url.href;
            if (allow && allow.includes(url.origin)) return url.href;
            return null;
        } catch {
            return null;
        }
    };
}

/**
 * Build the `onWorkerCreated` handler for the VGI `worker:` transport. Call it
 * once (optionally with a custom URL resolver) and pass the result to
 * `<DuckDBProvider onWorkerCreated={...}>`. Safe no-op when SharedArrayBuffer is
 * unavailable (page not cross-origin isolated — the transport can't work anyway).
 */
export function installVgiWebWorkerBridge(
    opts: VgiWebWorkerBridgeOptions = {},
): (worker: Worker) => void {
    const resolveWorkerUrl = opts.resolveWorkerUrl ?? makeResolveWorkerUrl(opts.allowRemoteOrigins);
    const onVgiWorkerMessage = opts.onVgiWorkerMessage;
    // location(resolved URL) -> the spawned VGI worker. Shared across every ATTACH
    // that targets the same URL (the engine stub also de-dupes per realm, so this
    // is a secondary guard + serves the cross-realm case where a second pthread
    // re-requests the same worker).
    const workers = new Map<string, Worker>();
    // Boots in progress, keyed by resolved URL. Spawning is asynchronous now (a
    // remote script must be fetched first), so concurrent requests for the same
    // URL have to join the first boot rather than race a second worker onto the
    // same channel.
    const pending = new Map<string, Promise<Worker>>();

    return (duckdbWorker: Worker): void => {
        if (typeof SharedArrayBuffer === 'undefined') {
            console.warn(
                '[vgi] SharedArrayBuffer unavailable (page not cross-origin isolated) — worker: transport disabled',
            );
            return;
        }
        duckdbWorker.addEventListener('message', (e: MessageEvent) => {
            const d = e.data as
                | { type?: string; location?: string; offset?: number; buffer?: SharedArrayBuffer; readySab?: SharedArrayBuffer }
                | undefined;
            if (!d || d.type !== 'vgi-ensure-worker' || !d.readySab) return;
            const readyI32 = new Int32Array(d.readySab);
            const signal = (v: 1 | -1) => {
                Atomics.store(readyI32, 0, v);
                Atomics.notify(readyI32, 0);
            };

            const url = resolveWorkerUrl(String(d.location));
            if (!url) {
                console.error('[vgi] worker: spawn rejected (not allowed by resolveWorkerUrl):', d.location);
                signal(-1);
                return;
            }

            // Already running for this URL → it's serving the same channel; ack now.
            if (workers.has(url)) {
                signal(1);
                return;
            }
            // A second request for a URL still booting must not spawn a rival
            // worker: wait for the in-flight boot and mirror its outcome.
            const inflight = pending.get(url);
            if (inflight) {
                inflight.then(
                    () => signal(1),
                    () => signal(-1),
                );
                return;
            }

            const boot = spawnWorker(url)
                .then(
                    (w) =>
                        new Promise<Worker>((resolve, reject) => {
                            const onMsg = (ev: MessageEvent) => {
                                const m = ev.data as { type?: string; error?: string } | undefined;
                                if (!m) return;
                                if (m.type === 'vgi-ready') {
                                    workers.set(url, w);
                                    resolve(w);
                                } else if (m.type === 'vgi-error') {
                                    console.error('[vgi] worker boot error:', m.error);
                                    w.removeEventListener('message', onMsg);
                                    try {
                                        w.terminate();
                                    } catch {
                                        /* ignore */
                                    }
                                    reject(new Error(m.error ?? 'vgi-error'));
                                } else {
                                    // Not part of the boot handshake — hand to the app's
                                    // optional extension hook (page-only capabilities live
                                    // in the app, not here).
                                    onVgiWorkerMessage?.(w, m);
                                }
                            };
                            w.addEventListener('message', onMsg);
                            // Hand the worker DuckDB's shared memory + the channel offset,
                            // plus the ORIGINAL location: when the script was spawned from a
                            // blob: URL, relative paths inside it no longer resolve against
                            // the asset host, so the worker needs a base to resolve siblings
                            // (its .wasm, importScripts targets) against.
                            w.postMessage({
                                type: 'vgi-init',
                                buffer: d.buffer,
                                offset: d.offset,
                                baseUrl: url,
                            });
                        }),
                )
                .finally(() => pending.delete(url));

            pending.set(url, boot);
            boot.then(
                () => signal(1),
                (err) => {
                    console.error('[vgi] worker: spawn failed:', err);
                    signal(-1);
                },
            );

            // Diagnostic seam: expose the shared channel to the page so a test harness
            // can read raw slot STATE + ring positions.
            (globalThis as unknown as { __vgiDiag?: unknown }).__vgiDiag = {
                buffer: d.buffer,
                offset: d.offset,
            };
        });
    };
}

/**
 * Construct the Worker for an allowed script URL.
 *
 * `new Worker(url)` is same-origin only — the browser rejects a cross-origin
 * script outright — so a remote script is fetched under CORS and spawned from a
 * `blob:` URL, which is same-origin by construction. This is the same technique
 * duckdb-wasm uses for its own engine worker when served from a CDN.
 *
 * Consequence worth being explicit about: the blob worker runs with THIS page's
 * origin and privileges. `resolveWorkerUrl` / `allowRemoteOrigins` is what
 * decides whether a given origin is trusted that far.
 */
async function spawnWorker(url: string): Promise<Worker> {
    const isSameOrigin = (() => {
        try {
            return new URL(url, self.location.href).origin === self.location.origin;
        } catch {
            return false;
        }
    })();
    if (isSameOrigin) return new Worker(url);

    const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (!res.ok) throw new Error(`fetch ${url} failed: ${res.status} ${res.statusText}`);
    const src = await res.blob();
    const blobUrl = URL.createObjectURL(src);
    try {
        return new Worker(blobUrl);
    } finally {
        // The Worker holds its own reference once constructed; release ours so the
        // blob is not retained for the lifetime of the page.
        URL.revokeObjectURL(blobUrl);
    }
}

/**
 * Compose several `onWorkerCreated` handlers into one (e.g. the OAuth bridge and
 * the worker: bridge), since `<DuckDBProvider>` takes a single callback.
 */
export function composeWorkerBridges(
    ...handlers: Array<(worker: Worker) => void>
): (worker: Worker) => void {
    return (worker: Worker) => {
        for (const h of handlers) h(worker);
    };
}
