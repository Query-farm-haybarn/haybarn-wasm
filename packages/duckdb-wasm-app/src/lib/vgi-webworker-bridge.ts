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
     * Optional extension hook: invoked for any message a spawned VGI worker posts
     * that this bridge doesn't itself consume (i.e. anything that isn't the
     * `vgi-ready` / `vgi-error` boot handshake). Lets an app extend the worker↔page
     * protocol with page-only capabilities the worker realm can't reach — e.g. a
     * Window-only Web API — WITHOUT baking app-specific logic into this shared
     * bridge. The handler receives the spawned worker and the raw message data.
     */
    onVgiWorkerMessage?: (worker: Worker, data: unknown) => void;
}

function defaultResolveWorkerUrl(location: string): string | null {
    try {
        const url = new URL(location, self.location.href);
        // Same-origin only. Remote worker scripts would need CORP under COEP and an
        // explicit opt-in; keep the default locked down.
        if (url.origin !== self.location.origin) return null;
        return url.href;
    } catch {
        return null;
    }
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
    const resolveWorkerUrl = opts.resolveWorkerUrl ?? defaultResolveWorkerUrl;
    const onVgiWorkerMessage = opts.onVgiWorkerMessage;
    // location(resolved URL) -> the spawned VGI worker. Shared across every ATTACH
    // that targets the same URL (the engine stub also de-dupes per realm, so this
    // is a secondary guard + serves the cross-realm case where a second pthread
    // re-requests the same worker).
    const workers = new Map<string, Worker>();

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

            let vgiWorker: Worker;
            try {
                vgiWorker = new Worker(url);
            } catch (err) {
                console.error('[vgi] worker: spawn failed:', err);
                signal(-1);
                return;
            }
            const onMsg = (ev: MessageEvent) => {
                const m = ev.data as { type?: string; error?: string } | undefined;
                if (!m) return;
                if (m.type === 'vgi-ready') {
                    workers.set(url, vgiWorker);
                    signal(1);
                } else if (m.type === 'vgi-error') {
                    console.error('[vgi] worker boot error:', m.error);
                    vgiWorker.removeEventListener('message', onMsg);
                    try {
                        vgiWorker.terminate();
                    } catch {
                        /* ignore */
                    }
                    signal(-1);
                } else {
                    // Not part of the boot handshake — hand to the app's optional
                    // extension hook (page-only capabilities live in the app, not here).
                    onVgiWorkerMessage?.(vgiWorker, m);
                }
            };
            vgiWorker.addEventListener('message', onMsg);
            // Hand the worker DuckDB's shared memory + the channel offset. It boots,
            // acks 'vgi-ready', and starts serving the channel's slots.
            vgiWorker.postMessage({ type: 'vgi-init', buffer: d.buffer, offset: d.offset });
            // Diagnostic seam: expose the shared channel to the page so a test harness can
            // read raw slot STATE + ring positions (e.g. repro-threads-deadlock.mjs).
            (globalThis as unknown as { __vgiDiag?: unknown }).__vgiDiag = {
                buffer: d.buffer,
                offset: d.offset,
            };
        });
    };
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
