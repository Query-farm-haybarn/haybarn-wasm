# Browser VGI transports

`installVgiWebWorkerBridge` supports two SharedArrayBuffer-backed target forms:

-   `worker:<url>` keeps the legacy behavior: Haybarn authorizes the URL and creates the Worker.
-   `iroh://<64-lowercase-hex-EndpointId>` routes raw VGI RPC through one Iroh adapter Worker created and owned by the application.
-   `httpi://<64-lowercase-hex-EndpointId>[/base-path]` keeps VGI's HTTP auth, cookie, compression, continuation, and error semantics while delegating request execution to the same adapter Worker over `iroh-http/2`.

```ts
const irohAdapter = new Worker(new URL('./iroh-vgi-adapter.js', import.meta.url), {
    type: 'module',
});

const endpointIdFromTarget = (target: string): string | null =>
    /^(?:iroh|httpi):\/\/([0-9a-f]{64})(?:\/.*)?$/.exec(target)?.[1] ?? null;

const onWorkerCreated = installVgiWebWorkerBridge({
    irohAdapterWorker: irohAdapter,
    resolveIrohTarget: target => {
        const endpointId = endpointIdFromTarget(target);
        return endpointId !== null && allowedEndpointIds.has(endpointId) ? target : null;
    },
});
```

The resolver is optional and runs before the adapter sees a target. It may return a canonical target of the same scheme or `null` to deny the request. Haybarn rejects malformed targets and never falls back to URL spawning for `iroh://` or `httpi://`.

The first accepted target is sent in `vgi-init`; later targets use `vgi-register-target`. Each canonical raw or HTTP target owns a separate SAB region, but all regions are served by the same Worker. The adapter should therefore create one local Iroh endpoint identity and multiplex remote EndpointIds and protocols over it—not create an endpoint per SQL target. The application remains responsible for the Worker's lifecycle; Haybarn does not terminate it.
