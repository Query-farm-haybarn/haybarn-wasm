import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { Versus } from './pages/versus';
import { Shell } from './pages/shell';
import { Route, Routes, Navigate, BrowserRouter } from 'react-router-dom';
import { DuckDBConnectionProvider, DuckDBPlatform, DuckDBProvider } from '@haybarn/react-haybarn';

import '../static/fonts/fonts.module.css';
import './globals.css';
import 'bootstrap/dist/css/bootstrap.min.css';
import 'xterm/css/xterm.css';
import 'react-popper-tooltip/dist/styles.css';

import * as duckdb from '@haybarn/haybarn-wasm';

// Load the wasm engine + workers from the jsDelivr CDN copy of the published
// @haybarn/haybarn-wasm npm package at runtime, rather than bundling the
// workspace build into this app. Pinned to the rc the shell is shipped
// against so the deployed shell is unambiguously running that release.
const HAYBARN_WASM_VERSION = '1.5.2-rc2';
const CDN = `https://cdn.jsdelivr.net/npm/@haybarn/haybarn-wasm@${HAYBARN_WASM_VERSION}/dist`;

const DUCKDB_BUNDLES: duckdb.DuckDBBundles = {
    mvp: {
        mainModule: `${CDN}/duckdb-mvp.wasm`,
        mainWorker: `${CDN}/duckdb-browser-mvp.worker.js`,
    },
    eh: {
        mainModule: `${CDN}/duckdb-eh.wasm`,
        mainWorker: `${CDN}/duckdb-browser-eh.worker.js`,
    },
    coi: {
        mainModule: `${CDN}/duckdb-coi.wasm`,
        mainWorker: `${CDN}/duckdb-browser-coi.worker.js`,
        pthreadWorker: `${CDN}/duckdb-browser-coi.pthread.worker.js`,
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
        <DuckDBProvider>
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
