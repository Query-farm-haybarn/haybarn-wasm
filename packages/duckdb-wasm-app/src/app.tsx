import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { Versus } from './pages/versus';
import { Shell } from './pages/shell';
import { Route, Routes, Navigate, BrowserRouter } from 'react-router-dom';
import { NavBarContainer } from './components/navbar';
import { DuckDBConnectionProvider, DuckDBPlatform, DuckDBProvider } from '@haybarn/react-haybarn';

import '../static/fonts/fonts.module.css';
import './globals.css';
import 'bootstrap/dist/css/bootstrap.min.css';
import 'xterm/css/xterm.css';
import 'react-popper-tooltip/dist/styles.css';

import * as duckdb from '@haybarn/haybarn-wasm';
import { composeWorkerBridges, installVgiOAuthBridge, installVgiWebWorkerBridge } from '@haybarn/haybarn-wasm/vgi';

// Haybarn: the page bridges of vgi's OAuth popup and its worker: transport, installed on the engine Worker before
// instantiate
const onWorkerCreated = composeWorkerBridges(installVgiOAuthBridge, installVgiWebWorkerBridge());

// Haybarn: the wasm engine binaries are not bundled. The base one loads at runtime from the jsDelivr copy of the
// published @haybarn/haybarn-wasm package, pinned to the release the shell ships with. The worker glue is bundled
// and served same-origin: a Worker cannot be constructed from a cross-origin script, and each worker fetches its
// mainModule with CORS (jsDelivr sends access-control-allow-origin: * and a cross-origin CORP header, so it also
// loads under COEP: require-corp).
const HAYBARN_WASM_VERSION = '2.0.0-rc5';
const CDN = `https://cdn.jsdelivr.net/npm/@haybarn/haybarn-wasm@${HAYBARN_WASM_VERSION}/dist`;

const DUCKDB_BUNDLES: duckdb.DuckDBBundles = {
    base: {
        mainModule: `${CDN}/duckdb-base.wasm`,
        mainWorker: new URL('@haybarn/haybarn-wasm/dist/duckdb-browser-base.worker.js', import.meta.url).toString(),
    },
    threads: {
        // The threads wasm exceeds Cloudflare Pages' 25 MiB static-file limit and has to be same-origin for its
        // shared memory: _worker.js streams it from Haybarn's R2 at /wasm/duckdb-threads.wasm. The path is the
        // same for every release and served immutable, so the version query gives each release its own cache entry.
        mainModule: `${window.location.origin}/wasm/duckdb-threads.wasm?v=${HAYBARN_WASM_VERSION}`,
        mainWorker: new URL('@haybarn/haybarn-wasm/dist/duckdb-browser-threads.worker.js', import.meta.url).toString(),
        pthreadWorker: new URL(
            '@haybarn/haybarn-wasm/dist/duckdb-browser-threads.pthread.worker.js',
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
        <DuckDBProvider onWorkerCreated={onWorkerCreated}>
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
