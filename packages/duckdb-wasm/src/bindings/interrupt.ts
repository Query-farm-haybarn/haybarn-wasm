/**
 * A connection's interrupt flag, reachable from any thread.
 *
 * On the threads bundle the worker is inside the call that runs a query (a blocking `runQuery`, or one
 * `pollPendingQuery`, which can process many chunks) until that call returns, so a message asking to cancel the
 * query (`cancelPendingQuery`) is read only afterwards. The wasm memory of that bundle is a SharedArrayBuffer, so
 * the caller can set the engine's own flag (`ClientContext::interrupt_state`) in place. The engine checks it between
 * chunks on every thread and in the HTTP client, and the statement fails with an interrupt error, as with a native
 * `Connection::Interrupt()`.
 *
 * The flag belongs to the connection, not to a query: whatever runs on the connection when it is set is
 * interrupted. A statement in autocommit mode clears it before it starts, so a store made between statements has
 * no effect there.
 */
export interface InterruptHandle {
    /** The engine's wasm memory */
    memory: SharedArrayBuffer;
    /** Byte offset of the connection's one-byte interrupt flag in `memory` */
    offset: number;
}

/** ClientInterruptState::NOT_INTERRUPTED */
const NOT_INTERRUPTED = 0;
/** ClientInterruptState::INTERRUPTED */
const INTERRUPTED = 1;

/**
 * Interrupt whatever runs on the handle's connection. Callable from any thread.
 *
 * Moves the flag from not interrupted to interrupted only, as `ClientContext::Interrupt()` does: a statement that
 * suppressed interrupts (after an irreversible step such as a COMMIT) stays unaffected.
 */
export function interruptConnection(handle: InterruptHandle): void {
    Atomics.compareExchange(new Uint8Array(handle.memory, handle.offset, 1), 0, NOT_INTERRUPTED, INTERRUPTED);
}
