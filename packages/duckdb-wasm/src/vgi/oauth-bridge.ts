// VGI interactive OAuth bridge for the Haybarn shell.
//
// The VGI DuckDB-WASM extension drives its own OAuth flow (OIDC discovery +
// PKCE + token exchange happen in C++). When it needs an authorization code it
// calls the engine-glue stub `_duckdb_wasm_open_auth_url(url)`, which posts
// `{type:"open-auth-url", url}` to the main thread and then blocks on
// `Atomics.wait` over a shared "oauth SAB" until the code (or an error) is
// written back.
//
// This module is the main-thread half of that contract:
//   1. Allocate the shared buffer and hand it to the worker (`init-oauth-sab`),
//      which sets the `oauthSAB`/`oauthInt32`/`oauthBytes` globals the engine
//      glue reads (see duckdb-browser-coi.worker.ts).
//   2. On `open-auth-url`, open the authorize URL in a popup, wait for
//      `/oauth-callback.html` to relay the real code over
//      BroadcastChannel("vgi-oauth"), then write it into the SAB and notify the
//      blocked extension thread.
//
// SAB protocol (matches the engine glue's _duckdb_wasm_open_auth_url):
//   int32[0]               flag: 0 waiting / 1 success / -1 error
//   DataView.getInt32(4)   payload byte length (little-endian)
//   bytes[8 .. 8+len]      UTF-8 authorization code (success) or error message
//
// Ported from vgi-web-frontend (src/lib/duckdb-worker-boot.ts +
// src/components/DuckDBShell.tsx). The shell only needs the reactive popup
// path — not the SPA token-caching / oauth_refresh_token layer.

const SAB_BYTES = 8192;

let oauthSAB: SharedArrayBuffer | null = null;

/** Wire the OAuth bridge onto a freshly created DuckDB worker. Safe no-op when
 *  SharedArrayBuffer is unavailable (page not cross-origin isolated — OAuth
 *  can't work without it anyway). Idempotent per worker. */
export function installVgiOAuthBridge(worker: Worker): void {
    if (typeof SharedArrayBuffer === 'undefined') {
        console.warn('[shell] SharedArrayBuffer unavailable (not cross-origin isolated) — VGI OAuth disabled');
        return;
    }
    oauthSAB = new SharedArrayBuffer(SAB_BYTES);
    worker.postMessage({ type: 'init-oauth-sab', sab: oauthSAB });

    worker.addEventListener('message', (e: MessageEvent) => {
        const d: any = e.data;
        if (!d || d.type !== 'open-auth-url') return;
        handleOpenAuthUrl(String(d.url));
    });
}

function handleOpenAuthUrl(url: string): void {
    const sab = oauthSAB;
    if (!sab) {
        console.error("[shell] No oauth SAB — can't route auth code back to extension");
        return;
    }

    const writeSab = (flag: 1 | -1, payload: string) => {
        const int32 = new Int32Array(sab);
        const bytes = new Uint8Array(sab);
        const encoded = new TextEncoder().encode(payload);
        const maxBytes = sab.byteLength - 8;
        if (encoded.length > maxBytes) {
            // Truncate rather than deadlock. The extension gets a garbled code
            // and fails at token exchange — a visible error beats a hung ATTACH.
            console.error(`[shell] SAB payload too large (${encoded.length} > ${maxBytes}), truncating`);
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
    console.log('[shell] Opened OAuth popup:', url.slice(0, 80));

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
            console.log('[shell] Received auth code from popup, delivering to extension');
            writeSab(1, m.code);
        } else {
            const err = m.errorDescription || m.error || 'Authentication failed';
            console.warn('[shell] OAuth popup reported error:', err);
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
        console.warn('[shell] OAuth popup timed out after 60s');
        writeSab(-1, 'Authentication timed out');
        try {
            popup.close();
        } catch {
            /* already closed */
        }
    }, 60_000);
}
