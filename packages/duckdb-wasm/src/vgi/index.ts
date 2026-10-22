// Haybarn: the page halves of the engine's platform functions for extensions (vgi). They run on the page's main
// thread, not in a worker: install them on the engine Worker before instantiate. They ship with the engine because
// they implement the other side of its ABI (lib/js-stubs.js), so the two can't drift apart.
export {
    installVgiWebWorkerBridge,
    type VgiAdapterTarget,
    type VgiWebWorkerBridgeOptions,
} from './webworker-bridge';
export { installVgiOAuthBridge } from './oauth-bridge';
export { composeWorkerBridges } from './compose';
