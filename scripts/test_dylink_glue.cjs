#!/usr/bin/env node
// Check the dynamic-linking behaviour that loadable extensions rely on, using hand-written side
// modules (scripts/dylink_fixtures). Run against a loadable build's dist; it must pass with or
// without patch_dylink_glue.cjs applied.
//
//   node scripts/test_dylink_glue.cjs packages/duckdb-wasm/dist
//
// It calls libc dlopen/dlsym/dlerror through the main module's raw exports, so it exercises the
// emscripten glue directly rather than DuckDB's LOAD. Each fixture .so is built from its .wat:
//   wat2wasm x.wat -o x.wasm && node scripts/dylink_fixtures/mkso.cjs x.wasm x.wat x.so
'use strict';
const fs = require('fs');
const path = require('path');

const dist = path.resolve(process.argv[2] || 'packages/duckdb-wasm/dist');
const FIXTURES = path.join(__dirname, 'dylink_fixtures');

// Capture the main module's raw exports when the bindings instantiate it
let X = null;
const instantiate = WebAssembly.instantiate;
WebAssembly.instantiate = async function (...args) {
    const result = await instantiate.apply(this, args);
    const instance = result instanceof WebAssembly.Instance ? result : result.instance;
    if (instance && instance.exports.duckdb_web_open) X = instance.exports;
    return result;
};

// Track the side-module bytes the glue compiles, to check they can be freed after dlopen
const v8 = require('v8');
v8.setFlagsFromString('--expose-gc');
const gc = require('vm').runInNewContext('gc');
const compiledBytes = [];
const WasmModule = WebAssembly.Module;
WebAssembly.Module = new Proxy(WasmModule, {
    construct(target, args, newTarget) {
        const bytes = args[0];
        // Side modules start with a dylink.0 section; addFunction() also compiles small thunks
        if (ArrayBuffer.isView(bytes) && Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 32)).includes('dylink.0')) {
            compiledBytes.push(new WeakRef(bytes));
        }
        return Reflect.construct(target, args, newTarget === WebAssembly.Module ? target : newTarget);
    },
});

// Count writes to immutable globals, which is how isImmutableGlobal probes each exported global
let immutableWrites = 0;
const globalValue = Object.getOwnPropertyDescriptor(WebAssembly.Global.prototype, 'value');
Object.defineProperty(WebAssembly.Global.prototype, 'value', {
    ...globalValue,
    set(v) {
        try {
            globalValue.set.call(this, v);
        } catch (e) {
            immutableWrites++;
            throw e;
        }
    },
});

const failures = [];
function check(name, ok, detail) {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` (${detail})`}`);
    if (!ok) failures.push(name);
}

(async () => {
    const bundle = path.join(dist, 'duckdb-node-blocking.cjs');
    // The lazy glue's dlsym hook survives minification as this string array
    const patched = /\[\s*"_dlsym_js"\s*,\s*"_dlsym_catchup_js"\s*\]/.test(fs.readFileSync(bundle, 'utf8'));
    console.log(`glue: ${patched ? 'patched (lazy)' : 'unpatched'}`);

    const duckdb = require(bundle);
    const bundleFor = name => ({ mainModule: path.join(dist, `duckdb-${name}.wasm`), mainWorker: '' });
    const db = await duckdb.createDuckDB({ mvp: bundleFor('mvp'), eh: bundleFor('eh') }, new duckdb.VoidLogger(), duckdb.NODE_RUNTIME);
    await db.instantiate();
    db.open({});
    const conn = db.connect();
    if (!X || !X.dlopen) throw new Error('not a loadable (MAIN_MODULE) build: dlopen is not exported');

    const table = X.__indirect_function_table;
    const heap = () => new Uint8Array(X.memory.buffer);
    const cstr = s => {
        const bytes = Buffer.from(s + '\0');
        const ptr = X.malloc(bytes.length) >>> 0;
        heap().set(bytes, ptr);
        return ptr;
    };
    const readCstr = ptr => {
        ptr >>>= 0;
        if (!ptr) return null;
        const m = heap();
        let end = ptr;
        while (m[end]) end++;
        return Buffer.from(m.subarray(ptr, end)).toString();
    };
    // The bindings only fetch modules they expect, so write the side module into MEMFS for dlopen
    const stage = (file, as = file) => {
        const bytes = fs.readFileSync(path.join(FIXTURES, file));
        const ptr = X.malloc(bytes.length) >>> 0;
        heap().set(bytes, ptr);
        const fp = X.fopen(cstr('/tmp/' + as), cstr('wb'));
        if (!fp) throw new Error('fopen failed');
        X.fwrite(ptr, 1, bytes.length, fp);
        X.fclose(fp);
        return '/tmp/' + as;
    };
    const RTLD_NOW = 2, RTLD_GLOBAL = 256;
    const dlopen = (file, as) => X.dlopen(cstr(stage(file, as)), RTLD_NOW | RTLD_GLOBAL) >>> 0;
    const dlsym = (handle, name) => X.dlsym(handle, cstr(name)) >>> 0;
    const call = (handle, name, ...args) => table.get(dlsym(handle, name))(...args);

    // Imports from GOT.func, GOT.mem and env resolve to the main module's definitions
    const good = dlopen('good.so');
    check('dlopen good.so', good !== 0, good ? undefined : readCstr(X.dlerror()));
    if (good) {
        const fn = call(good, 'hb_got_fn') >>> 0;
        const strlen = call(good, 'hb_got_strlen') >>> 0;
        check('GOT.func resolves to the main export', table.get(fn) === X.duckdb_web_get_version);
        check('GOT.func for a libc function resolves to the main export', table.get(strlen) === X.strlen);
        check('GOT.func for a main-module import is set', (call(good, 'hb_got_mainimp') >>> 0) !== 0);
        check('missing weak GOT import is 0', (call(good, 'hb_got_weak') >>> 0) === 0);
        check('GOT.mem typeinfo address matches', (call(good, 'hb_got_ti') >>> 0) === X._ZTIN6duckdb9ExceptionE.value >>> 0);
        check('GOT.mem vtable address matches', (call(good, 'hb_got_vt') >>> 0) === X._ZTVN6duckdb9ExceptionE.value >>> 0);
        const s = cstr('hello, haybarn');
        check('direct env import call', call(good, 'hb_strlen_direct', s) === 14);
        check('indirect call through GOT.func', call(good, 'hb_strlen_indirect', s) === 14);

        const mainSym = dlsym(0, 'duckdb_web_get_version');
        check('dlsym(RTLD_DEFAULT) finds a main export', mainSym !== 0 && table.get(mainSym) === X.duckdb_web_get_version);
        check('dlsym(RTLD_DEFAULT) is stable', dlsym(0, 'duckdb_web_get_version') === mainSym);
        check('dlsym(RTLD_DEFAULT) matches the GOT entry', dlsym(0, 'strlen') === strlen);
        const sideSym = dlsym(0, 'hb_got_fn');
        check('dlsym(RTLD_DEFAULT) finds a side-module export', sideSym !== 0 && (table.get(sideSym)() >>> 0) === fn);
        check('dlsym(RTLD_DEFAULT) of a missing symbol fails', dlsym(0, 'hb_no_such_symbol') === 0);
        check('dlsym(RTLD_DEFAULT) of a data symbol', dlsym(0, '_ZTIN6duckdb9ExceptionE') === X._ZTIN6duckdb9ExceptionE.value >>> 0);
    }

    // A missing env function still loads, and fails when it is called
    const missingEnv = dlopen('missing_env.so');
    check('dlopen with a missing env function succeeds', missingEnv !== 0);
    if (missingEnv) {
        let threw = false;
        try {
            call(missingEnv, 'hb_m3');
        } catch (e) {
            threw = true;
        }
        check('calling the missing function throws', threw);
    }

    // When a side module defines a symbol the main module also defines, the main module's copy wins
    const dup = dlopen('dup.so');
    check('dlopen dup.so', dup !== 0);
    if (dup) check("duplicate definition resolves to the main module's copy", table.get(call(dup, 'hb_dup_got') >>> 0) === X.duckdb_web_get_feature_flags);

    // Exported globals: an immutable data global is relocated, a mutable one is passed through.
    // With the mutable-globals rewrite, neither is probed by writing to it.
    const writesBefore = immutableWrites;
    const globals = dlopen('globals.so');
    const probes = immutableWrites - writesBefore;
    check('dlopen globals.so', globals !== 0, globals ? undefined : readCstr(X.dlerror()));
    if (globals) {
        check('exported data global is relocated', dlsym(globals, 'hb_data') === (call(globals, 'hb_data_addr') >>> 0));
        call(globals, 'hb_set_mut', 9);
        check('exported mutable global is passed through', dlsym(globals, 'hb_mut') === 9);
    }
    if (patched) check('exported globals are not probed by writing to them', probes === 0, `${probes} probes`);
    else console.log(`info exported globals probed by writing to them: ${probes}`);

    // The parser itself, on each fixture, from both byte types loadWebAssemblyModule passes it
    const { MUTABLE_GLOBALS_RUNTIME } = require('./patch_dylink_glue.cjs');
    const mutableGlobals = new Function('UTF8ArrayToString', `${MUTABLE_GLOBALS_RUNTIME}; return __hbMutableGlobals;`)(
        (bytes, start, len) => Buffer.from(bytes.buffer, bytes.byteOffset + start, len).toString());
    for (const file of fs.readdirSync(FIXTURES).filter(f => f.endsWith('.so')).sort()) {
        const bytes = fs.readFileSync(path.join(FIXTURES, file));
        const expected = file === 'globals.so' ? 'hb_mut' : '';
        const unsigned = mutableGlobals(new Uint8Array(bytes));
        const signed = mutableGlobals(new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length));
        const got = [unsigned, signed].map(set => (set ? [...set].join(',') : 'unparsed'));
        check(`mutable exported globals of ${file}`, got[0] === expected && got[1] === expected, got.join(' / '));
    }
    check('a compiled module is left to the probe', mutableGlobals(new WebAssembly.Module(fs.readFileSync(path.join(FIXTURES, 'good.so')))) === undefined);

    // dlopen uses a module the engine armed for that file (prefetched extensions), instead of compiling it
    const precompiled = fs.readFileSync(bundle, 'utf8').includes('__haybarnArmedModule');
    if (precompiled) {
        // Compiled with the original constructor, so only the glue's own compiles are counted
        const globalsBytes = new Uint8Array(fs.readFileSync(path.join(FIXTURES, 'globals.so')));
        const compiledBefore = compiledBytes.length;
        const probesBefore = immutableWrites;
        globalThis.__haybarnArmedModule = { name: 'globals-pre.so', module: new WasmModule(globalsBytes), bytes: globalsBytes };
        const pre = dlopen('globals.so', 'globals-pre.so');
        check('dlopen an armed module', pre !== 0, pre ? undefined : readCstr(X.dlerror()));
        check('the armed module is used, not compiled again', compiledBytes.length === compiledBefore, `${compiledBytes.length - compiledBefore} compiled`);
        check('the armed module is taken', globalThis.__haybarnArmedModule === null);
        if (pre) {
            check('armed module: exported data global is relocated', dlsym(pre, 'hb_data') === (call(pre, 'hb_data_addr') >>> 0));
            call(pre, 'hb_set_mut', 7);
            check('armed module: exported mutable global is passed through', dlsym(pre, 'hb_mut') === 7);
        }
        check('armed module: globals are read from its bytes, not probed', immutableWrites === probesBefore, `${immutableWrites - probesBefore} probes`);

        // A module armed for another file is left alone
        const other = { name: 'other.so', module: new WasmModule(globalsBytes), bytes: globalsBytes };
        globalThis.__haybarnArmedModule = other;
        const compiledBeforeGood = compiledBytes.length;
        const good2 = dlopen('good.so', 'good-copy.so');
        check('dlopen next to a module armed for another file', good2 !== 0);
        check('it compiles its own bytes', compiledBytes.length === compiledBeforeGood + 1);
        check('the other armed module is left', globalThis.__haybarnArmedModule === other);
        globalThis.__haybarnArmedModule = null;

        // The runtime on its own: a scan taken by a load that failed before using it is dropped by the next load
        const { PRECOMPILED_RUNTIME } = require('./patch_dylink_glue.cjs');
        const rt = new Function('__hbMutableGlobals', `${PRECOMPILED_RUNTIME}; return { take: __hbTakeArmedModule, next: () => __hbNextMut };`)(
            () => new Set(['scanned']));
        globalThis.__haybarnArmedModule = { name: 'a.so', module: {}, bytes: globalsBytes };
        check('the armed module is matched by file name', rt.take('/tmp/xa.so') === undefined && rt.take('/tmp/a.so') !== undefined);
        check('the armed module serves one load', rt.take('/tmp/a.so') === undefined);
        check('a scan left by a failed load is dropped', rt.next() === undefined);
    } else {
        console.log('info glue has no precompiled-module rewrite');
    }

    // A missing required GOT import fails dlopen
    check('dlopen with a missing GOT.func import fails', dlopen('missing_got.so') === 0);
    check('dlopen with a missing GOT.mem import fails', dlopen('missing_mem.so') === 0);

    // patch_dylink_glue.cjs makes loadWebAssemblyModule drop the bytes once they are compiled
    check('side modules were compiled from bytes', compiledBytes.length > 0, compiledBytes.length);
    gc();
    await new Promise(resolve => setTimeout(resolve, 0));
    gc();
    const retained = compiledBytes.filter(ref => ref.deref() !== undefined).length;
    if (patched) check('side-module bytes are freed after dlopen', retained === 0, `${retained} of ${compiledBytes.length} retained`);
    else console.log(`info side-module bytes retained after dlopen: ${retained} of ${compiledBytes.length}`);

    check('queries still work', conn.query('SELECT 40 + 2 AS v').toArray()[0].v === 42);

    if (failures.length) {
        console.error(`${failures.length} check(s) failed`);
        process.exit(1);
    }
    console.log('all checks passed');
})().catch(e => {
    console.error(e);
    process.exit(1);
});
