/** An instantiation progress */
export interface InstantiationProgress {
    startedAt: Date;
    updatedAt: Date;
    bytesTotal: number;
    bytesLoaded: number;
}

/** An instantiation progress handler */
export type InstantiationProgressHandler = (p: InstantiationProgress) => void;

/**
 * A connection's query progress in the engine's wasm memory (`QueryProgressSlot` in webdb.h).
 *
 * The thread that runs a query writes it whenever the engine updates its progress, which it does only with
 * `SET enable_progress_bar = true`. On the threads bundle the memory is a SharedArrayBuffer, so the page reads the
 * progress of a running query with `readQueryProgress` on its own schedule, while the worker is busy inside the call
 * that runs it.
 */
export interface QueryProgressHandle {
    /** The engine's wasm memory */
    memory: SharedArrayBuffer | ArrayBuffer;
    /** Byte offset of the connection's progress slot in `memory` */
    offset: number;
}

/** The progress of a connection's query */
export interface QueryProgress {
    /** Whether a query is reporting progress; false once it finished, or before any did */
    running: boolean;
    /** Percentage done in [0, 100], -1 when the engine cannot estimate it */
    percentage: number;
    /** Rows processed so far */
    rowsProcessed: number;
    /** Rows to process in total */
    totalRows: number;
    /** Increases with every update */
    sequence: number;
}

/** Read the progress in a slot, consistently: `null` when a writer kept changing it */
export function readQueryProgress(handle: QueryProgressHandle): QueryProgress | null {
    // A seqlock: the sequence is odd while a write is under way. The writer is one thread, its writes are short
    const words = new Int32Array(handle.memory, handle.offset, 2);
    const values = new Float64Array(handle.memory, handle.offset + 8, 3);
    const shared = typeof SharedArrayBuffer !== 'undefined' && handle.memory instanceof SharedArrayBuffer;
    const load = (i: number) => (shared ? Atomics.load(words, i) : words[i]);
    for (let attempt = 0; attempt < 1000; ++attempt) {
        const before = load(0);
        if ((before & 1) !== 0) continue;
        const running = words[1] !== 0;
        const percentage = values[0];
        const rowsProcessed = values[1];
        const totalRows = values[2];
        if (load(0) !== before) continue;
        return { running, percentage, rowsProcessed, totalRows, sequence: (before >>> 0) / 2 };
    }
    return null;
}
