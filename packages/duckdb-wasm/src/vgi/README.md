# Browser VGI transports

`installVgiWebWorkerBridge` supports two SharedArrayBuffer-backed target forms:

-   `worker:<url>` keeps the legacy behavior: Haybarn authorizes the URL and creates the Worker.
-   `iroh://<64-lowercase-hex-EndpointId>` routes through one Iroh adapter Worker created and owned by the application.

```ts
const irohAdapter = new Worker(new URL('./iroh-vgi-adapter.js', import.meta.url), {
    type: 'module',
});

const onWorkerCreated = installVgiWebWorkerBridge({
    irohAdapterWorker: irohAdapter,
    resolveIrohTarget: target => (allowedEndpointIds.has(target.slice('iroh://'.length)) ? target : null),
});
```

The resolver is optional and runs before the adapter sees a target. It may return a canonical Iroh target or `null` to deny the request. Haybarn rejects malformed targets and never falls back to URL spawning for `iroh://`.

The first accepted target is sent in `vgi-init`; later targets use `vgi-register-target`. Each target owns a separate SAB region, but all regions are served by the same Worker. The adapter should therefore create one local Iroh endpoint identity and multiplex remote EndpointIds over it—not create an endpoint per SQL target. The application remains responsible for the Worker's lifecycle; Haybarn does not terminate it.
