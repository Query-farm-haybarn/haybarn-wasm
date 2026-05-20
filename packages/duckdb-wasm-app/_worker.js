// Cloudflare Pages advanced-mode worker for the Haybarn shell.
//
// Two jobs:
//   1. Serve the threaded (COI) DuckDB wasm same-origin at /wasm/duckdb-coi.wasm.
//      It's ~34 MiB — over Pages' 25 MiB static-asset cap — and loading it
//      cross-origin from jsDelivr trips a shared-memory mismatch in the
//      duckdb worker. Streaming it through this worker makes it same-origin
//      with no size limit. The bytes themselves come from the pinned npm
//      package on jsDelivr.
//   2. Apply COOP/COEP (cross-origin isolation, required for the threaded
//      variant's SharedArrayBuffer) to every response. In advanced mode the
//      static `_headers` file is ignored, so the headers are set here.
//
// All other requests fall through to the static assets (env.ASSETS).
const COI_WASM_UPSTREAM = 'https://cdn.jsdelivr.net/npm/@haybarn/haybarn-wasm@1.5.2-rc3/dist/duckdb-coi.wasm';

function withCoiHeaders(resp, extra) {
    const h = new Headers(resp.headers);
    h.set('Cross-Origin-Opener-Policy', 'same-origin');
    h.set('Cross-Origin-Embedder-Policy', 'require-corp');
    if (extra) for (const [k, v] of Object.entries(extra)) h.set(k, v);
    return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (url.pathname === '/wasm/duckdb-coi.wasm') {
            const upstream = await fetch(COI_WASM_UPSTREAM, { cf: { cacheTtl: 31536000, cacheEverything: true } });
            if (!upstream.ok || !upstream.body) {
                return new Response(`upstream wasm fetch failed: ${upstream.status}`, { status: 502 });
            }
            return new Response(upstream.body, {
                status: 200,
                headers: {
                    'Content-Type': 'application/wasm',
                    'Cache-Control': 'public, max-age=31536000, immutable',
                    'Cross-Origin-Resource-Policy': 'same-origin',
                    'Cross-Origin-Opener-Policy': 'same-origin',
                    'Cross-Origin-Embedder-Policy': 'require-corp',
                },
            });
        }

        const resp = await env.ASSETS.fetch(request);
        // Content-hashed build assets are immutable; everything else stays
        // default-cached. COOP/COEP go on everything for cross-origin isolation.
        const extra = url.pathname.startsWith('/static/')
            ? { 'Cache-Control': 'public, max-age=31536000, immutable' }
            : undefined;
        return withCoiHeaders(resp, extra);
    },
};
