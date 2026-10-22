// Haybarn: messages the page sends its worker that are not AsyncDuckDB requests. They set globals the engine's
// platform functions read later (lib/js-stubs.js), so every worker entry point consumes them before the dispatcher.

/** Consume a configuration message. Returns true if the dispatcher must not see it. */
export function handlePreInitMessage(data: any): boolean {
    if (!data || typeof data !== 'object') return false;
    switch (data.type) {
        case 'init-oauth-sab': {
            // installVgiOAuthBridge: duckdb_wasm_open_auth_url waits on this buffer for the authorization code. The
            // platform function runs on the worker's main thread, which is where this message arrives.
            (globalThis as any).oauthSAB = data.sab;
            (globalThis as any).oauthInt32 = new Int32Array(data.sab);
            (globalThis as any).oauthBytes = new Uint8Array(data.sab);
            return true;
        }
        default:
            return false;
    }
}
