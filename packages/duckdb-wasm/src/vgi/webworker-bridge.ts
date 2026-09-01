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
//
// Multi-target adapters opt into an additive handshake: the first target arrives
// in `vgi-init`; later targets use `vgi-register-target` and must answer with
// `vgi-target-ready`/`vgi-target-error` carrying the requestId. Reclamation sends
// `vgi-unregister-target` first and is allowed only when every slot STATE is free.

export interface VgiAdapterTarget {
    /** Worker script that hosts the transport adapter. */
    adapterUrl: string;
    /** Stable identity used to share one adapter worker across many targets. */
    adapterKey: string;
    /** Stable, canonical target identity understood by the adapter. */
    canonicalTarget: string;
}

export interface VgiWebWorkerBridgeOptions {
    /**
     * Gate + resolve which worker URLs SQL may spawn. Return the resolved Worker
     * URL to allow, or null to reject. Default: allow same-origin URLs only.
     */
    resolveWorkerUrl?: (location: string) => string | null;
    /**
     * Optional multi-target adapter resolver. Unlike `resolveWorkerUrl`, this
     * separates the worker script identity from the canonical transport target,
     * allowing one adapter worker to register several independent ABI-v1 regions.
     */
    resolveAdapterTarget?: (location: string) => VgiAdapterTarget | null;
    /**
     * The application's single Iroh transport-adapter Worker. Every strict
     * `iroh://<EndpointId>` target is registered as a separate SAB region on
     * this Worker, so the adapter keeps one local Iroh endpoint identity.
     * Haybarn never constructs or terminates this application-owned Worker.
     */
    irohAdapterWorker?: Worker;
    /**
     * Optional Iroh target resolver/authorizer. Return a canonical Iroh target
     * to allow (normally the input unchanged), or null to deny it. Both the SQL
     * target and the returned target must use a 64-character lowercase-hex ID.
     */
    resolveIrohTarget?: (canonicalTarget: string) => string | null;
    /** Maximum registered target regions per adapter worker. Default: 32. */
    maxTargetsPerAdapter?: number;
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
export function installVgiWebWorkerBridge(opts: VgiWebWorkerBridgeOptions = {}): (worker: Worker) => void {
    const resolveWorkerUrl = opts.resolveWorkerUrl ?? makeResolveWorkerUrl(opts.allowRemoteOrigins);
    const resolveAdapterTarget = opts.resolveAdapterTarget;
    const irohAdapterWorker = opts.irohAdapterWorker;
    const resolveIrohTarget = opts.resolveIrohTarget;
    const maxTargetsPerAdapter = opts.maxTargetsPerAdapter ?? 32;
    if (!Number.isSafeInteger(maxTargetsPerAdapter) || maxTargetsPerAdapter <= 0) {
        throw new Error('maxTargetsPerAdapter must be a positive integer');
    }
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

    interface TargetRegion {
        target: string;
        offset: number;
        buffer: SharedArrayBuffer;
        lastUsed: number;
    }
    interface AdapterEntry {
        key: string;
        url: string;
        worker: Worker;
        regions: Map<string, TargetRegion>;
        registrationQueue: Promise<void>;
    }
    const adapters = new Map<string, AdapterEntry>();
    const pendingAdapters = new Map<string, Promise<AdapterEntry>>();
    let touch = 0;

    const validName = (value: string): boolean => {
        if (value.length === 0 || value.length > 4096) return false;
        for (let i = 0; i < value.length; i++) {
            const code = value.charCodeAt(i);
            if (code < 0x20 || code === 0x7f) return false;
        }
        return true;
    };
    const canonicalIrohTarget = (value: string): string | null =>
        /^iroh:\/\/[0-9a-f]{64}$/.test(value) ? value : null;

    const regionIsIdle = (region: TargetRegion): boolean => {
        try {
            if (!Number.isSafeInteger(region.offset) || region.offset < 0 || (region.offset & 3) !== 0) return false;
            const i32 = new Int32Array(region.buffer);
            const h = region.offset >> 2;
            const nSlots = Atomics.load(i32, h + 2);
            const stride = Atomics.load(i32, h + 4);
            const slotsOff = Atomics.load(i32, h + 5);
            if (nSlots <= 0 || nSlots > 1024 || stride < 64 || slotsOff < 64) return false;
            for (let slot = 0; slot < nSlots; slot++) {
                const state = (region.offset + slotsOff + slot * stride) >> 2;
                if (state < 0 || state >= i32.length || Atomics.load(i32, state) !== 0) return false;
            }
            return true;
        } catch {
            return false;
        }
    };

    let registrationSequence = 0;
    const registerTarget = (entry: AdapterEntry, region: TargetRegion, baseUrl: string): Promise<void> =>
        new Promise<void>((resolve, reject) => {
            const requestId = `vgi-target-${++registrationSequence}`;
            const timer = setTimeout(() => {
                entry.worker.removeEventListener('message', onMessage);
                reject(new Error(`adapter target registration timed out: ${region.target}`));
            }, 30000);
            const onMessage = (ev: MessageEvent) => {
                const m = ev.data as { type?: string; requestId?: string; error?: string } | undefined;
                if (!m || m.requestId !== requestId) return;
                if (m.type !== 'vgi-target-ready' && m.type !== 'vgi-target-error') return;
                clearTimeout(timer);
                entry.worker.removeEventListener('message', onMessage);
                if (m.type === 'vgi-target-ready') resolve();
                else reject(new Error(m.error ?? `adapter rejected target ${region.target}`));
            };
            entry.worker.addEventListener('message', onMessage);
            entry.worker.postMessage({
                type: 'vgi-register-target',
                requestId,
                target: region.target,
                buffer: region.buffer,
                offset: region.offset,
                baseUrl,
            });
        });

    const ensureAdapterRegion = (
        entry: AdapterEntry,
        target: string,
        offset: number,
        buffer: SharedArrayBuffer,
    ): Promise<void> => {
        const operation = entry.registrationQueue.then(async () => {
            const current = entry.regions.get(target);
            if (current && current.offset === offset && current.buffer === buffer) {
                current.lastUsed = ++touch;
                return;
            }

            const conflicts: TargetRegion[] = [];
            if (current) conflicts.push(current);
            for (const region of entry.regions.values()) {
                if (region !== current && region.offset === offset && region.buffer === buffer) conflicts.push(region);
            }

            let victim: TargetRegion | undefined;
            if (!current && conflicts.length === 0 && entry.regions.size >= maxTargetsPerAdapter) {
                victim = [...entry.regions.values()].filter(regionIsIdle).sort((a, b) => a.lastUsed - b.lastUsed)[0];
                if (!victim) {
                    throw new Error(`adapter ${entry.key} reached ${maxTargetsPerAdapter} active target regions`);
                }
                conflicts.push(victim);
            }
            if (conflicts.some(region => !regionIsIdle(region))) {
                throw new Error(`cannot rebind active SAB target region for ${target}`);
            }

            const next: TargetRegion = { target, offset, buffer, lastUsed: ++touch };
            for (const region of conflicts) {
                entry.regions.delete(region.target);
                entry.worker.postMessage({
                    type: 'vgi-unregister-target',
                    target: region.target,
                    offset: region.offset,
                });
            }
            await registerTarget(entry, next, entry.url);
            entry.regions.set(target, next);
        });
        entry.registrationQueue = operation.catch(() => undefined);
        return operation;
    };

    return (duckdbWorker: Worker): void => {
        if (typeof SharedArrayBuffer === 'undefined') {
            console.warn(
                '[vgi] SharedArrayBuffer unavailable (page not cross-origin isolated) — worker: transport disabled',
            );
            return;
        }
        duckdbWorker.addEventListener('message', (e: MessageEvent) => {
            const d = e.data as
                | {
                      type?: string;
                      location?: string;
                      offset?: number;
                      buffer?: SharedArrayBuffer;
                      readySab?: SharedArrayBuffer;
                  }
                | undefined;
            if (!d || d.type !== 'vgi-ensure-worker' || !d.readySab) return;
            const readyI32 = new Int32Array(d.readySab);
            const signal = (v: 1 | -1) => {
                Atomics.store(readyI32, 0, v);
                Atomics.notify(readyI32, 0);
            };

            const location = String(d.location);
            const isIrohRequest = location.toLowerCase().startsWith('iroh://');
            if (isIrohRequest || resolveAdapterTarget) {
                if (!(d.buffer instanceof SharedArrayBuffer) || !Number.isSafeInteger(d.offset)) {
                    console.error('[vgi] adapter request has an invalid SAB region');
                    signal(-1);
                    return;
                }
                let requested: VgiAdapterTarget | null;
                let applicationWorker: Worker | undefined;
                if (isIrohRequest) {
                    const canonical = canonicalIrohTarget(location);
                    if (!canonical) {
                        console.error('[vgi] malformed iroh:// EndpointId:', d.location);
                        signal(-1);
                        return;
                    }
                    if (!irohAdapterWorker) {
                        console.error('[vgi] iroh:// target requires an application-owned irohAdapterWorker');
                        signal(-1);
                        return;
                    }
                    let resolved: string | null;
                    try {
                        resolved = resolveIrohTarget ? resolveIrohTarget(canonical) : canonical;
                    } catch (error) {
                        console.error('[vgi] Iroh target resolver failed:', error);
                        signal(-1);
                        return;
                    }
                    const resolvedCanonical = resolved === null ? null : canonicalIrohTarget(resolved);
                    if (!resolvedCanonical) {
                        console.error('[vgi] Iroh target rejected by application resolver:', d.location);
                        signal(-1);
                        return;
                    }
                    requested = {
                        adapterUrl: self.location.href,
                        adapterKey: '__vgi_application_iroh_adapter_v1__',
                        canonicalTarget: resolvedCanonical,
                    };
                    applicationWorker = irohAdapterWorker;
                } else {
                    requested = resolveAdapterTarget?.(location) ?? null;
                }
                if (!requested || !validName(requested.adapterKey) || !validName(requested.canonicalTarget)) {
                    console.error('[vgi] adapter target rejected:', d.location);
                    signal(-1);
                    return;
                }
                const adapterTarget = requested;
                const adapterUrl = applicationWorker
                    ? adapterTarget.adapterUrl
                    : resolveWorkerUrl(adapterTarget.adapterUrl);
                if (!adapterUrl) {
                    console.error('[vgi] adapter worker URL rejected:', adapterTarget.adapterUrl);
                    signal(-1);
                    return;
                }

                const finish = (entry: AdapterEntry) => {
                    if (entry.url !== adapterUrl) {
                        throw new Error(`adapter key ${entry.key} resolved to multiple worker URLs`);
                    }
                    return ensureAdapterRegion(
                        entry,
                        adapterTarget.canonicalTarget,
                        d.offset as number,
                        d.buffer as SharedArrayBuffer,
                    );
                };

                const existing = adapters.get(adapterTarget.adapterKey);
                if (existing) {
                    Promise.resolve()
                        .then(() => finish(existing))
                        .then(
                            () => signal(1),
                            err => {
                                console.error('[vgi] adapter target registration failed:', err);
                                signal(-1);
                            },
                        );
                    return;
                }
                const inflightAdapter = pendingAdapters.get(adapterTarget.adapterKey);
                if (inflightAdapter) {
                    inflightAdapter.then(finish).then(
                        () => signal(1),
                        err => {
                            console.error('[vgi] adapter target registration failed:', err);
                            signal(-1);
                        },
                    );
                    return;
                }

                const firstRegion: TargetRegion = {
                    target: adapterTarget.canonicalTarget,
                    offset: d.offset as number,
                    buffer: d.buffer as SharedArrayBuffer,
                    lastUsed: ++touch,
                };
                const boot = (applicationWorker ? Promise.resolve(applicationWorker) : spawnWorker(adapterUrl))
                    .then(
                        w =>
                            new Promise<AdapterEntry>((resolve, reject) => {
                                const onBootMessage = (ev: MessageEvent) => {
                                    const m = ev.data as { type?: string; error?: string } | undefined;
                                    if (!m) return;
                                    if (m.type === 'vgi-ready') {
                                        w.removeEventListener('message', onBootMessage);
                                        const entry: AdapterEntry = {
                                            key: adapterTarget.adapterKey,
                                            url: adapterUrl,
                                            worker: w,
                                            regions: new Map([[adapterTarget.canonicalTarget, firstRegion]]),
                                            registrationQueue: Promise.resolve(),
                                        };
                                        w.addEventListener('message', (other: MessageEvent) => {
                                            const data = other.data as { type?: string } | undefined;
                                            if (data?.type === 'vgi-target-ready' || data?.type === 'vgi-target-error')
                                                return;
                                            onVgiWorkerMessage?.(w, other.data);
                                        });
                                        adapters.set(adapterTarget.adapterKey, entry);
                                        resolve(entry);
                                    } else if (m.type === 'vgi-error') {
                                        w.removeEventListener('message', onBootMessage);
                                        if (!applicationWorker) {
                                            try {
                                                w.terminate();
                                            } catch {
                                                /* ignore */
                                            }
                                        }
                                        reject(new Error(m.error ?? 'vgi-error'));
                                    } else {
                                        onVgiWorkerMessage?.(w, m);
                                    }
                                };
                                w.addEventListener('message', onBootMessage);
                                w.postMessage({
                                    type: 'vgi-init',
                                    adapterKey: adapterTarget.adapterKey,
                                    target: adapterTarget.canonicalTarget,
                                    buffer: firstRegion.buffer,
                                    offset: firstRegion.offset,
                                    baseUrl: adapterUrl,
                                });
                            }),
                    )
                    .finally(() => pendingAdapters.delete(adapterTarget.adapterKey));
                pendingAdapters.set(adapterTarget.adapterKey, boot);
                boot.then(
                    () => signal(1),
                    err => {
                        console.error('[vgi] adapter worker boot failed:', err);
                        signal(-1);
                    },
                );
                return;
            }

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
                    w =>
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
                err => {
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
export function composeWorkerBridges(...handlers: Array<(worker: Worker) => void>): (worker: Worker) => void {
    return (worker: Worker) => {
        for (const h of handlers) h(worker);
    };
}
