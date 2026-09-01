// Public surface of the VGI page-side bridges.
//
// These run on the PAGE's main thread, not in a worker. The engine's wasm stub
// (`vgi_wasm_ensure_worker`) posts a request up here and blocks on Atomics.wait;
// the bridge spawns the worker, hands it DuckDB's SharedArrayBuffer, and signals
// the engine to continue. They ship with the engine because they implement the
// page half of the same transport ABI — versioning them apart lets the two drift.
export {
    installVgiWebWorkerBridge,
    composeWorkerBridges,
    type VgiAdapterTarget,
    type VgiWebWorkerBridgeOptions,
} from './webworker-bridge';
export { installVgiOAuthBridge } from './oauth-bridge';
