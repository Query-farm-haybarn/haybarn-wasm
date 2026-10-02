/**
 * A connection's interrupt flag, reachable from any thread.
 *
 * A query runs synchronously inside the worker, so a message asking to cancel it
 * (`cancelPendingQuery`) is handled only between polls, and one poll can process
 * dozens of chunks: a scan of a slow remote source can finish inside a single
 * poll before the cancel is ever read, and a blocking `runQuery` cannot be
 * reached at all. On a threads build the wasm memory is a SharedArrayBuffer, so
 * the caller can set the engine's own flag (`ClientContext::interrupted`) in place.
 * The engine checks it between chunks on every thread, and the statement fails
 * with an interrupt error, as with a native `Connection::Interrupt()`.
 *
 * The flag belongs to the connection, not to a query: whatever runs on the
 * connection when it is set is interrupted. Every statement clears it before it
 * starts, so a store made between statements has no effect.
 */
export interface InterruptHandle {
    /** The engine's wasm memory. */
    memory: SharedArrayBuffer;
    /** Byte offset of the connection's one-byte interrupt flag in `memory`. */
    offset: number;
}

/** Interrupt whatever is running on the handle's connection. Callable from any thread. */
export function interruptConnection(handle: InterruptHandle): void {
    Atomics.store(new Uint8Array(handle.memory, handle.offset, 1), 0, 1);
}
