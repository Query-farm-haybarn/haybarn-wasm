export interface PThread {
    /** Idle pool workers, not currently hosting a pthread. */
    unusedWorkers: Worker[];
    /**
     * Workers currently hosting a pthread, keyed by `pthread_t` pointer.
     * emscripten 6.0.0 removed the parallel `runningWorkers` array; this map is
     * the only record of running workers now.
     */
    pthreads: Record<number, Worker>;
}

/** The workers currently hosting a pthread. */
export function runningWorkers(pthread: PThread): Worker[] {
    return Object.values(pthread.pthreads);
}

export interface DuckDBModule extends EmscriptenModule {
    stackSave: typeof stackSave;
    stackAlloc: typeof stackAlloc;
    stackRestore: typeof stackRestore;
    lengthBytesUTF8: typeof lengthBytesUTF8;
    stringToUTF8: typeof stringToUTF8;

    ccall: typeof ccall;
    PThread: PThread;
}
