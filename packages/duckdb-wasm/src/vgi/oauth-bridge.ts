// VGI interactive OAuth bridge, the page half of duckdb_wasm_open_auth_url.
//
// The vgi extension runs OIDC discovery, PKCE and the token exchange in C++. When it needs an authorization code it
// calls the engine's duckdb_wasm_open_auth_url(url), which posts {type: 'open-auth-url', url} to the page and waits
// (Atomics.wait) on a shared "OAuth buffer" until the code or an error is written back. On the threads bundle the
// engine runs that wait on the worker's main thread, wherever the extension called it from.
//
// This bridge:
//   1. allocates the buffer and hands it to the worker (`init-oauth-sab`, consumed by the worker's entry point
//      before AsyncDuckDB sees it), so install it before instantiate;
//   2. on `open-auth-url`, opens the URL in a popup, waits for /oauth-callback.html (served by the app, same origin)
//      to relay the code over BroadcastChannel('vgi-oauth'), writes it into the buffer and wakes the engine.
//
// Buffer layout (matches lib/js-stubs.js):
//   int32[0]               flag: 0 waiting / 1 success / -1 error
//   DataView.getInt32(4)   payload byte length (little-endian)
//   bytes[8 .. 8+len]      UTF-8 authorization code (success) or error message
//
// While the login is open the worker's main thread waits for it and serves no other runtime call, so other queries
// of the same database that read files wait too.

const SAB_BYTES = 8192;

/** Wire the OAuth bridge onto a freshly created DuckDB worker. Safe no-op when
 *  SharedArrayBuffer is unavailable (page not cross-origin isolated — OAuth
 *  can't work without it anyway). Install it once per worker, before instantiate. */
export function installVgiOAuthBridge(worker: Worker): void {
    if (typeof SharedArrayBuffer === 'undefined') {
        console.warn('[vgi] SharedArrayBuffer unavailable (not cross-origin isolated) — VGI OAuth disabled');
        return;
    }
    // One buffer per engine Worker, so two engines on a page don't answer each other's logins
    const sab = new SharedArrayBuffer(SAB_BYTES);
    worker.postMessage({ type: 'init-oauth-sab', sab });

    worker.addEventListener('message', (e: MessageEvent) => {
        const d: any = e.data;
        if (!d || d.type !== 'open-auth-url') return;
        handleOpenAuthUrl(sab, String(d.url));
    });
}

function handleOpenAuthUrl(sab: SharedArrayBuffer, url: string): void {
    const writeSab = (flag: 1 | -1, payload: string) => {
        const int32 = new Int32Array(sab);
        const bytes = new Uint8Array(sab);
        const encoded = new TextEncoder().encode(payload);
        const maxBytes = sab.byteLength - 8;
        if (encoded.length > maxBytes) {
            // Truncate rather than deadlock. The extension gets a garbled code
            // and fails at token exchange — a visible error beats a hung ATTACH.
            console.error(`[vgi] SAB payload too large (${encoded.length} > ${maxBytes}), truncating`);
            encoded.subarray(0, maxBytes).forEach((b, i) => {
                bytes[8 + i] = b;
            });
            new DataView(sab).setInt32(4, maxBytes, true);
        } else {
            new DataView(sab).setInt32(4, encoded.length, true);
            bytes.set(encoded, 8);
        }
        Atomics.store(int32, 0, flag);
        Atomics.notify(int32, 0);
    };

    const popup = window.open(url, '_blank', 'popup,width=500,height=700');
    if (!popup) {
        writeSab(-1, 'Popup blocked by browser');
        return;
    }
    console.log('[vgi] Opened OAuth popup:', url.slice(0, 80));

    const bc = new BroadcastChannel('vgi-oauth');
    let settled = false;

    const cleanup = () => {
        settled = true;
        try {
            bc.close();
        } catch {
            /* already closed */
        }
        clearTimeout(timeoutTimer);
    };

    bc.onmessage = (ev: MessageEvent) => {
        if (settled) return;
        const m: any = ev.data;
        if (!m || m.type !== 'oauth-callback') return;
        cleanup();
        if (m.code) {
            console.log('[vgi] Received auth code from popup, delivering to extension');
            writeSab(1, m.code);
        } else {
            const err = m.errorDescription || m.error || 'Authentication failed';
            console.warn('[vgi] OAuth popup reported error:', err);
            writeSab(-1, err);
        }
        try {
            popup.close();
        } catch {
            /* already closed */
        }
    };

    // We intentionally do NOT poll `popup.closed`. With COOP: same-origin
    // (required for SharedArrayBuffer / DuckDB-WASM threads), navigating the
    // popup cross-origin to the IdP severs the browsing context group and the
    // disconnected WindowProxy reports `closed === true` immediately — even
    // mid-login. The same-origin BroadcastChannel message from
    // /oauth-callback.html is the only reliable signal; the timeout bounds the
    // worker's Atomics.wait if no callback arrives.
    const timeoutTimer = setTimeout(() => {
        if (settled) return;
        cleanup();
        console.warn('[vgi] OAuth popup timed out after 60s');
        writeSab(-1, 'Authentication timed out');
        try {
            popup.close();
        } catch {
            /* already closed */
        }
    }, 60_000);
}
