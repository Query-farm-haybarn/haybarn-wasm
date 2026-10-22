/**
 * Compose several handlers for a freshly created engine Worker into one (e.g. the OAuth bridge and the worker:
 * bridge), since `<DuckDBProvider onWorkerCreated>` takes a single callback.
 */
export function composeWorkerBridges(...handlers: Array<(worker: Worker) => void>): (worker: Worker) => void {
    return (worker: Worker) => {
        for (const h of handlers) h(worker);
    };
}
