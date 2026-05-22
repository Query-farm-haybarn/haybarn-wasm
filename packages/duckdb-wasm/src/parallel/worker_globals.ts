// Worker pre-init message handling.
//
// A few messages the main thread sends to its worker are not part of the
// AsyncDuckDB request/response protocol — they configure globals the engine
// glue or dispatcher reads later. Handle them here so every browser worker
// entry point shares one implementation.

/**
 * Inspect an incoming message and consume it if it's a pre-init configuration
 * message. Returns true if the message was consumed (and the dispatcher should
 * not see it), false otherwise.
 */
export function handlePreInitMessage(data: any): boolean {
    if (!data || typeof data !== 'object') return false;
    switch (data.type) {
        case 'init-oauth-sab': {
            // VGI interactive OAuth bridge: the engine glue's
            // _duckdb_wasm_open_auth_url() blocks on Atomics.wait against this
            // SAB. Engine glue reads bare `oauthSAB` / `oauthInt32` /
            // `oauthBytes`, which resolve to globalThis.
            (globalThis as any).oauthSAB = data.sab;
            (globalThis as any).oauthInt32 = new Int32Array(data.sab);
            (globalThis as any).oauthBytes = new Uint8Array(data.sab);
            return true;
        }
        case 'init-cancel-sab': {
            // SAB-based query cancellation. AsyncDuckDBDispatcher reads
            // globalThis.cancelInt32 at watcher-arm time and polls it while a
            // pending query is active; when the flag flips to 1 the watcher
            // calls cancelPendingQuery and writes 0 back. Wire format is a
            // 4-byte SAB viewed as a single Int32: 0 = idle, 1 = cancel
            // requested.
            (globalThis as any).cancelInt32 = new Int32Array(data.sab);
            return true;
        }
        default:
            return false;
    }
}
