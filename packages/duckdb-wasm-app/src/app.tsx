import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { Versus } from './pages/versus';
import { Shell } from './pages/shell';
import { Route, Routes, Navigate, BrowserRouter } from 'react-router-dom';
import { DuckDBConnectionProvider, DuckDBPlatform, DuckDBProvider } from '@haybarn/react-haybarn';
import { installVgiOAuthBridge } from './lib/vgi-oauth-bridge';

import '../static/fonts/fonts.module.css';
import './globals.css';
import 'bootstrap/dist/css/bootstrap.min.css';
import 'xterm/css/xterm.css';
import 'react-popper-tooltip/dist/styles.css';

import * as duckdb from '@haybarn/haybarn-wasm';

// Load the heavy wasm engine binary from the jsDelivr CDN copy of the
// published @haybarn/haybarn-wasm npm package at runtime (pinned to the rc
// the shell ships against). The small worker glue is still bundled into the
// app and served same-origin: a Worker can't be constructed from a
// cross-origin script URL (`new Worker('https://cdn.jsdelivr.net/...')`
// throws a SecurityError, and the COI pthread spawn has the same
// restriction), so the workers must be same-origin. Each worker fetches its
// `mainModule` .wasm from the CDN — that's a CORS request, which jsDelivr
// serves with `access-control-allow-origin: *` (+ a CORP header so it loads
// fine under our COEP: require-corp).
const HAYBARN_WASM_VERSION = '1.5.3-rc7';
const CDN = `https://cdn.jsdelivr.net/npm/@haybarn/haybarn-wasm@${HAYBARN_WASM_VERSION}/dist`;

const DUCKDB_BUNDLES: duckdb.DuckDBBundles = {
    mvp: {
        mainModule: `${CDN}/duckdb-mvp.wasm`,
        mainWorker: new URL('@haybarn/haybarn-wasm/dist/duckdb-browser-mvp.worker.js', import.meta.url).toString(),
    },
    eh: {
        mainModule: `${CDN}/duckdb-eh.wasm`,
        mainWorker: new URL('@haybarn/haybarn-wasm/dist/duckdb-browser-eh.worker.js', import.meta.url).toString(),
    },
    coi: {
        // The threaded COI wasm (~34 MiB) exceeds Cloudflare Pages' 25 MiB
        // per-static-file limit, so it can't ship as a bundled static asset.
        // The advanced-mode `_worker.js` streams it same-origin from the CDN
        // at /wasm/duckdb-coi.wasm (no size cap on the worker route). The
        // worker glue itself is bundled same-origin like the other variants.
        //
        // The `?v=` is load-bearing: the proxy response is served `immutable`,
        // but the path is stable across releases, so without a version key a
        // returning visitor would keep an old engine wasm cached forever (and
        // miss e.g. the http→https extension-repo fix). Keying the query on the
        // package version gives each release a distinct cache entry.
        mainModule: `${window.location.origin}/wasm/duckdb-coi.wasm?v=${HAYBARN_WASM_VERSION}`,
        mainWorker: new URL('@haybarn/haybarn-wasm/dist/duckdb-browser-coi.worker.js', import.meta.url).toString(),
        pthreadWorker: new URL(
            '@haybarn/haybarn-wasm/dist/duckdb-browser-coi.pthread.worker.js',
            import.meta.url,
        ).toString(),
    },
};
const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);

const paths = /(.*)(\/versus|\/docs\/.*|\/)$/;
const pathMatches = (window?.location?.pathname || '').match(paths);
let basename = '/';
if (pathMatches != null && pathMatches.length >= 2) {
    basename = pathMatches[1];
}

const element = document.getElementById('root');
const root = createRoot(element!);
root.render(
    <DuckDBPlatform logger={logger} bundles={DUCKDB_BUNDLES}>
        <DuckDBProvider onWorkerCreated={installVgiOAuthBridge}>
            <DuckDBConnectionProvider>
                <BrowserRouter basename={basename}>
                    <Routes>
                        <Route
                            index
                            element={
                                    <Shell padding={[16, 0, 0, 20]} backgroundColor="#333" />
                            }
                        />
                        <Route
                            path="/versus"
                            element={
                                    <Versus />
                            }
                        />
                        <Route path="*" element={<Navigate to="/" />} />
                    </Routes>
                </BrowserRouter>
            </DuckDBConnectionProvider>
        </DuckDBProvider>
    </DuckDBPlatform>,
);
