// Pthread worker entry for the COI variant.
//
// emsdk 5.x changed the pthread worker model: instead of emitting a separate
// `duckdb_wasm.worker.js`, the main JS file (`duckdb-coi.js`) doubles as the
// worker script. When the main thread spawns a pthread worker, emscripten
// runs the same factory in worker context, detects `globalThis.name ===
// "em-pthread"` (set by emscripten's `new Worker(url, {name: "em-pthread"})`
// call), and synchronously installs `self.onmessage = handleMessage` to
// handle the pthread protocol (`load` / `run` / `checkMailbox`).
//
// This wrapper file is the URL emscripten uses to spawn workers (wired via
// `Module.mainScriptUrlOrBlob` in `bindings_browser_coi.ts`). Its job is to
// (a) inject `DUCKDB_RUNTIME` into the worker's globalThis so wasm-called
// JS-side runtime functions can find it, (b) invoke the bundled DuckDB
// factory so emscripten installs its pthread handler, and (c) wrap that
// handler to intercept Haybarn-specific commands (file-handle / UDF
// registration) before forwarding pthread protocol messages onward.
import DuckDB from '../bindings/duckdb-coi';
import { BROWSER_RUNTIME } from '../bindings/runtime_browser';

// Register the global DuckDB runtime in the worker's globalThis so any
// JS-library function the wasm module calls (via js-stubs.js) can resolve
// `globalThis.DUCKDB_RUNTIME.*` without a separate bootstrap.
globalThis.DUCKDB_RUNTIME = {};
for (const func of Object.getOwnPropertyNames(BROWSER_RUNTIME)) {
    if (func == 'constructor') continue;
    globalThis.DUCKDB_RUNTIME[func] = Object.getOwnPropertyDescriptor(BROWSER_RUNTIME, func)!.value;
}

// Trigger the emscripten factory. The pthread-mode body runs synchronously
// up to its first `await`; specifically the `self.onmessage = handleMessage`
// assignment happens before the factory yields. So by the time DuckDB({})
// returns control (even before its promise resolves), `self.onmessage` is
// the emscripten pthread handler and ready to be wrapped below.
DuckDB({});

// Wrap self.onmessage: handle Haybarn-specific commands locally, forward
// everything else (`load`, `run`, `checkMailbox`, …) to emscripten's
// handler. Order matters — these custom commands must be intercepted
// *before* emscripten's handler, which would log them as unknown and bail.
const emscriptenHandler = self.onmessage;
self.onmessage = (e: any) => {
    const cmd = e?.data?.cmd;
    if (cmd === 'registerFileHandle') {
        globalThis.DUCKDB_RUNTIME._files = globalThis.DUCKDB_RUNTIME._files || new Map();
        globalThis.DUCKDB_RUNTIME._files.set(e.data.fileName, e.data.fileHandle);
    } else if (cmd === 'dropFileHandle') {
        globalThis.DUCKDB_RUNTIME._files = globalThis.DUCKDB_RUNTIME._files || new Map();
        globalThis.DUCKDB_RUNTIME._files.delete(e.data.fileName);
    } else if (cmd === 'registerUDFFunction') {
        globalThis.DUCKDB_RUNTIME._udfFunctions = globalThis.DUCKDB_RUNTIME._udfFunctions || new Map();
        globalThis.DUCKDB_RUNTIME._udfFunctions.set(e.data.udf.name, e.data.udf);
    } else if (cmd === 'dropUDFFunctions') {
        globalThis.DUCKDB_RUNTIME._udfFunctions = globalThis.DUCKDB_RUNTIME._udfFunctions || new Map();
        for (const key of globalThis.DUCKDB_RUNTIME._udfFunctions.keys()) {
            if (globalThis.DUCKDB_RUNTIME._udfFunctions.get(key).connection_id == e.data.connectionId) {
                globalThis.DUCKDB_RUNTIME._udfFunctions.delete(key);
            }
        }
    } else if (emscriptenHandler) {
        emscriptenHandler.call(self, e);
    }
};
