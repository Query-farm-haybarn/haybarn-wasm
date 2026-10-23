#!/usr/bin/env node
// Check that LOAD doesn't copy an extension onto the wasm heap, which never shrinks: the provider hands the
// download to emscripten's file system, and dlopen compiles it from there. A copy on the heap stays there after it is
// freed, until the memory is reused, so the check looks for a piece of each extension's code section on the heap
// after loading it. Code is compiled, never copied into memory (unlike data segments), so only a copy of the file
// puts it there.
//
//   node scripts/test_extension_load_memory.cjs packages/duckdb-wasm/dist build/extension_repository
//
// Runs the base bundle in Node with the local repository's wasm_eh extensions, loaded by path, and reads the heap
// through the main module's raw exports.
'use strict';
const fs = require('fs');
const path = require('path');

const dist = path.resolve(process.argv[2] || 'packages/duckdb-wasm/dist');
const repository = path.resolve(process.argv[3] || 'build/extension_repository');
const EXTENSIONS = ['parquet', 'tpcds', 'icu', 'tpch', 'json'];
const PROBE_SIZE = 4096;

/** 4 KiB from the middle of a module's code section */
function codeProbe(bytes) {
    let offset = 8;
    const leb = () => {
        let value = 0;
        for (let shift = 0; ; shift += 7) {
            const byte = bytes[offset++];
            value += (byte & 127) * 2 ** shift;
            if (!(byte & 128)) return value;
        }
    };
    while (offset < bytes.length) {
        const id = bytes[offset++];
        const size = leb();
        if (id === 10) {
            const middle = offset + Math.floor((size - PROBE_SIZE) / 2);
            return bytes.subarray(middle, middle + PROBE_SIZE);
        }
        offset += size;
    }
    throw new Error('no code section');
}

let X = null;
const instantiate = WebAssembly.instantiate;
WebAssembly.instantiate = async function (...args) {
    const result = await instantiate.apply(this, args);
    const instance = result instanceof WebAssembly.Instance ? result : result.instance;
    if (instance && instance.exports.duckdb_web_open) X = instance.exports;
    return result;
};

(async () => {
    const duckdb = require(path.join(dist, 'duckdb-node-blocking.cjs'));
    const base = { mainModule: path.join(dist, 'duckdb-base.wasm'), mainWorker: '' };
    const db = await duckdb.createDuckDB({ base }, new duckdb.VoidLogger(), duckdb.NODE_RUNTIME);
    await db.instantiate();
    db.open({ allowUnsignedExtensions: true });
    const conn = db.connect();
    if (!X || !X.dlopen) throw new Error('not a loadable (MAIN_MODULE) build');
    conn.query('SELECT 1');

    let failures = 0;
    for (const name of EXTENSIONS) {
        const file = path.join(repository, 'v2.0.0', 'wasm_eh', `${name}.duckdb_extension.wasm`);
        const probe = codeProbe(fs.readFileSync(file));
        conn.query(`LOAD '${file}'`);
        const heap = Buffer.from(X.memory.buffer);
        const found = heap.indexOf(probe);
        if (found >= 0) failures++;
        console.log(`${found < 0 ? 'ok  ' : 'FAIL'} LOAD ${name}: ${found < 0 ? 'its code is not on the heap' : `its code is on the heap at ${found}`}`);
    }
    if (failures) {
        console.error(`${failures} load(s) copied the extension onto the heap`);
        process.exit(1);
    }
    console.log('all checks passed');
})().catch(e => {
    console.error(e);
    process.exit(1);
});
