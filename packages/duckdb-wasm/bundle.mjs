import esbuild from 'esbuild';
import fs, { writeFile } from 'fs';
import path from 'path';
import { rimrafSync } from 'rimraf';
import mkdir from 'make-dir';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

// -------------------------------
// Current bundling strategy
//
// We actually aim to be an ESM-only package but thats not possible for several reasons today.
//
// A) Karma does not support esm tests which has the following consequences:
// A.1) tests-browser.js needs to be an iife
// A.2) The worker scripts need to stay a iife since Karma can't import them otherwise (import.meta.url)
// B) Users that bundle our main modules might not want to also bundle our workers themselves, therefore:
// B.1) The workers remain self-contained iife and don't need to be bundled.
// B.2) That also allows us to host the iife workers on jsdelivr/unpkg.
// C) On node, we dynamically require "stream" (via apache-arrow) so node bundles have to stay commonjs for now.
//
// Bundles:
//   duckdb-browser.mjs                           - ESM Default Browser Bundle
//   duckdb-browser-blocking.mjs                  - ESM Blocking Browser Bundle (synchronous API, unstable)
//   duckdb-browser-vgi.{mjs,cjs}                 - Page bridges for extensions (OAuth, VGI worker:), the ./vgi export
//   duckdb-browser-base.worker.js                - IIFE Web Worker
//   duckdb-browser-threads.worker.js             - IIFE Web Worker with threads
//   duckdb-browser-threads.pthread.worker.js     - Compatibility alias for the threads worker
//   duckdb-node.cjs                              - CommonJS Default Node Bundle
//   duckdb-node-blocking.cjs                     - CommonJS Blocking Node Bundle (synchronous API, unstable)
//   duckdb-node-base.worker.cjs                  - CommonJS Worker
//   tests-browser.js                             - IIFE Jasmine Karma tests
//   tests-node.cjs                               - CommonJS Jasmine Node tests
//
// The lack of alternatives for Karma won't allow us to bundle workers and tests as ESM.
// We should upgrade all CommonJS bundles to ESM as soon as the dynamic requires are resolved.

// Emscripten >= 4 emits BigInt literals (WASM_BIGINT), which need chrome 67 / firefox 68 / safari 14
const TARGET_BROWSER = ['chrome67', 'edge79', 'firefox68', 'safari14'];
const TARGET_BROWSER_TEST = ['es2020'];
const TARGET_NODE = ['node14.6'];
const EXTERNALS_NODE = ['apache-arrow'];
// Emscripten requires node builtins as "node:*" in branches that only run under NodeJS
const EXTERNALS_BROWSER = ['apache-arrow', 'module', 'node:*'];
const EXTERNALS_WEBWORKER = ['module', 'node:*'];
const EXTERNALS_TEST_BROWSER = ['module', 'node:*'];

// The Node worker bundle is CommonJS, but web-worker >= 1.5 runs a classic
// worker (no `{ type: 'module' }`) as a plain script: it reads the file and
// calls `vm.runInThisContext`, so there is no `module`, `exports`, `require`
// or `__dirname`, and the bundle dies at `module.exports = ...`
// (developit/web-worker#55). Older web-worker versions `require()` the file
// and are fine. Passing `{ type: 'module' }` to `new Worker()` is the
// documented fix; this guard is a fallback for callers who don't.
//
// When `module` is missing, the guard finds this script's own path from the
// filename the script was evaluated under (the V8 call site, not web-worker
// internals) and loads the same file again through Node's CommonJS loader,
// where the real bundle runs with `module`/`require`/`__dirname` as usual.
// Getting `require` from plain script code needs `process.getBuiltinModule`
// (Node >= 20.16 / 22.3); without it, or when the script was not evaluated
// under an absolute path (e.g. a data: URL worker), the guard throws a clear
// error instead of crashing on `module`. In the normal CommonJS path the bundle runs inside a
// function called with the module's `this`, which changes nothing: Node already
// wraps every CommonJS file in a function, and the bundle's own "use strict"
// stays the first statement of that function body, so it still applies.
//
// The Node worker bundle only. Remove once web-worker#55 is fixed and released.
const NODE_WORKER_CJS_GUARD = {
    banner: {
        js:
            'if(typeof module>"u"){(function(){' +
            'var g=typeof process<"u"&&process.getBuiltinModule,p=Error.prepareStackTrace,l=Error.stackTraceLimit,f;' +
            'try{Error.prepareStackTrace=function(_,s){return s};Error.stackTraceLimit=1;' +
            'f=new Error().stack[0].getFileName()}catch(e){}finally{Error.prepareStackTrace=p;Error.stackTraceLimit=l}' +
            'if(!g||!f||!g("node:path").isAbsolute(f))throw new Error("Haybarn\'s Node worker is CommonJS and was run as a plain script ' +
            "(web-worker >= 1.5 does this for classic workers). Pass { type: 'module' } to new Worker(), " +
            'or use Node >= 20.16 / 22.3.");' +
            'g("node:module").createRequire(f)(f)' +
            '})()}else(function(){',
    },
    footer: { js: '}).call(this);' },
};

// Read CLI flags
let is_debug = false;
let args = process.argv.slice(2);
if (args.length == 0) {
    console.warn('Usage: node bundle.mjs {debug/release}');
} else {
    if (args[0] == 'debug') is_debug = true;
}
console.log(`DEBUG=${is_debug}`);
function printErr(err) {
    if (err) return console.log(err);
}

// Patch broken arrow package.json
// XXX Remove this hack as soon as arrow fixes the exports
function patch_arrow() {
    const package_path = '../../node_modules/apache-arrow/package.json';
    const package_raw = fs.readFileSync(package_path);
    const package_json = JSON.parse(package_raw);
    package_json.exports = {
        node: {
            import: './Arrow.node.mjs',
            require: './Arrow.node.js',
        },
        import: './Arrow.dom.mjs',
        default: './Arrow.dom.js',
    };
    fs.writeFileSync(package_path, JSON.stringify(package_json));
}
patch_arrow();

// -------------------------------
// Cleanup output directory

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(__dirname, 'dist');
mkdir.sync(dist);
rimrafSync(`${dist}/*.wasm`);
rimrafSync(`${dist}/*.d.ts`);
rimrafSync(`${dist}/*.js`);
rimrafSync(`${dist}/*.js.map`);
rimrafSync(`${dist}/*.mjs`);
rimrafSync(`${dist}/*.mjs.map`);
rimrafSync(`${dist}/*.cjs`);
rimrafSync(`${dist}/*.cjs.map`);

// -------------------------------
// Copy WASM files

const src = path.resolve(__dirname, 'src');
fs.copyFile(path.resolve(src, 'bindings', 'duckdb-base.wasm'), path.resolve(dist, 'duckdb-base.wasm'), printErr);
fs.copyFile(path.resolve(src, 'bindings', 'duckdb-threads.wasm'), path.resolve(dist, 'duckdb-threads.wasm'), printErr);

(async () => {
    // Don't attempt to bundle NodeJS modules in the browser build.
    console.log('[ ESBUILD ] Patch bindings');
    patchFile('./src/bindings/duckdb-base.js', 'child_process');
    patchFile('./src/bindings/duckdb-threads.js', 'child_process');

    // -------------------------------
    // Browser bundles

    console.log('[ ESBUILD ] duckdb-browser.cjs');
    await esbuild.build({
        entryPoints: ['./src/targets/duckdb.ts'],
        outfile: 'dist/duckdb-browser.cjs',
        platform: 'browser',
        format: 'cjs',
        target: TARGET_BROWSER,
        bundle: true,
        minify: !is_debug,
        sourcemap: is_debug ? 'inline' : true,
        external: EXTERNALS_BROWSER,
        define: { 'process.release.name': '"browser"' },
    });

    console.log('[ ESBUILD ] duckdb-browser.mjs');
    await esbuild.build({
        entryPoints: ['./src/targets/duckdb.ts'],
        outfile: 'dist/duckdb-browser.mjs',
        platform: 'browser',
        format: 'esm',
        globalName: 'duckdb',
        target: TARGET_BROWSER,
        bundle: true,
        minify: !is_debug,
        sourcemap: is_debug ? 'inline' : true,
        external: EXTERNALS_BROWSER,
        define: { 'process.release.name': '"browser"' },
    });

    console.log('[ ESBUILD ] duckdb-browser-blocking.cjs');
    await esbuild.build({
        entryPoints: ['./src/targets/duckdb-browser-blocking.ts'],
        outfile: 'dist/duckdb-browser-blocking.cjs',
        platform: 'browser',
        format: 'cjs',
        target: TARGET_BROWSER,
        bundle: true,
        minify: !is_debug,
        sourcemap: is_debug ? 'inline' : true,
        external: EXTERNALS_BROWSER,
        define: {
            'process.release.name': '"browser"',
            'process.env.NODE_ENV': '"production"',
        },
    });

    console.log('[ ESBUILD ] duckdb-browser-blocking.mjs');
    await esbuild.build({
        entryPoints: ['./src/targets/duckdb-browser-blocking.ts'],
        outfile: 'dist/duckdb-browser-blocking.mjs',
        platform: 'browser',
        format: 'esm',
        target: TARGET_BROWSER,
        bundle: true,
        minify: !is_debug,
        sourcemap: is_debug ? 'inline' : true,
        external: EXTERNALS_BROWSER,
        define: {
            'process.release.name': '"browser"',
            'process.env.NODE_ENV': '"production"',
        },
    });

    // Haybarn: the page halves of the engine's platform functions for extensions, the `./vgi` export
    for (const [format, ext] of [
        ['esm', 'mjs'],
        ['cjs', 'cjs'],
    ]) {
        console.log(`[ ESBUILD ] duckdb-browser-vgi.${ext}`);
        await esbuild.build({
            entryPoints: ['./src/targets/duckdb-browser-vgi.ts'],
            outfile: `dist/duckdb-browser-vgi.${ext}`,
            platform: 'browser',
            format,
            target: TARGET_BROWSER,
            bundle: true,
            minify: !is_debug,
            sourcemap: is_debug ? 'inline' : true,
            external: EXTERNALS_BROWSER,
            define: { 'process.release.name': '"browser"' },
        });
    }

    console.log('[ ESBUILD ] duckdb-browser-base.worker.js');
    await esbuild.build({
        entryPoints: ['./src/targets/duckdb-browser-base.worker.ts'],
        outfile: 'dist/duckdb-browser-base.worker.js',
        platform: 'browser',
        format: 'iife',
        globalName: 'duckdb',
        target: TARGET_BROWSER,
        bundle: true,
        minify: !is_debug,
        sourcemap: is_debug ? 'inline' : true,
        external: EXTERNALS_WEBWORKER,
        define: { 'process.release.name': '"browser"' },
    });

    console.log('[ ESBUILD ] duckdb-browser-threads.worker.js');
    await esbuild.build({
        entryPoints: ['./src/targets/duckdb-browser-threads.worker.ts'],
        outfile: 'dist/duckdb-browser-threads.worker.js',
        platform: 'browser',
        format: 'iife',
        globalName: 'duckdb',
        target: TARGET_BROWSER,
        bundle: true,
        minify: !is_debug,
        sourcemap: is_debug ? 'inline' : true,
        external: EXTERNALS_WEBWORKER,
        define: { 'process.release.name': '"browser"' },
    });

    console.log('[ ESBUILD ] duckdb-browser-threads.pthread.worker.js');
    await esbuild.build({
        // Emscripten 6 runs pthreads from the main threads worker. Keep the
        // legacy filename as a compatibility alias for existing bundle configs.
        entryPoints: ['./src/targets/duckdb-browser-threads.worker.ts'],
        outfile: 'dist/duckdb-browser-threads.pthread.worker.js',
        platform: 'browser',
        format: 'iife',
        target: TARGET_BROWSER,
        bundle: true,
        minify: !is_debug,
        sourcemap: is_debug ? 'inline' : true,
        external: EXTERNALS_WEBWORKER,
        define: { 'process.release.name': '"browser"' },
    });

    // -------------------------------
    // Node bundles

    console.log('[ ESBUILD ] duckdb-node.cjs');
    await esbuild.build({
        entryPoints: ['./src/targets/duckdb.ts'],
        outfile: 'dist/duckdb-node.cjs',
        platform: 'node',
        format: 'cjs',
        globalName: 'duckdb',
        target: TARGET_NODE,
        bundle: true,
        minify: !is_debug,
        sourcemap: is_debug ? 'inline' : true,
        external: EXTERNALS_NODE,
    });

    console.log('[ ESBUILD ] duckdb-node-blocking.cjs');
    await esbuild.build({
        entryPoints: ['./src/targets/duckdb-node-blocking.ts'],
        outfile: 'dist/duckdb-node-blocking.cjs',
        platform: 'node',
        format: 'cjs',
        target: TARGET_NODE,
        bundle: true,
        minify: !is_debug,
        sourcemap: is_debug ? 'inline' : true,
        external: EXTERNALS_NODE,
    });

    console.log('[ ESBUILD ] duckdb-node-base.worker.cjs');
    await esbuild.build({
        entryPoints: ['./src/targets/duckdb-node-base.worker.ts'],
        outfile: 'dist/duckdb-node-base.worker.cjs',
        platform: 'node',
        format: 'cjs',
        ...NODE_WORKER_CJS_GUARD,
        target: TARGET_NODE,
        bundle: true,
        minify: !is_debug,
        sourcemap: is_debug ? 'inline' : true,
        external: EXTERNALS_NODE,
    });

    // -------------------------------
    // Test bundles

    console.log('[ ESBUILD ] tests-browser.js');
    await esbuild.build({
        entryPoints: ['./test/index_browser.ts'],
        outfile: 'dist/tests-browser.js',
        platform: 'browser',
        format: 'iife',
        globalName: 'duckdb',
        target: TARGET_BROWSER_TEST,
        bundle: true,
        sourcemap: is_debug ? 'inline' : true,
        external: EXTERNALS_TEST_BROWSER,
    });

    console.log('[ ESBUILD ] tests-tpch-scale.js');
    await esbuild.build({
        entryPoints: ['./test/index_tpch_scale.ts'],
        outfile: 'dist/tests-tpch-scale.js',
        platform: 'browser',
        format: 'iife',
        globalName: 'duckdb',
        target: TARGET_BROWSER_TEST,
        bundle: true,
        sourcemap: is_debug ? 'inline' : true,
        external: EXTERNALS_TEST_BROWSER,
    });

    console.log('[ ESBUILD ] tests-httpfs.js');
    await esbuild.build({
        entryPoints: ['./test/index_httpfs.ts'],
        outfile: 'dist/tests-httpfs.js',
        platform: 'browser',
        format: 'iife',
        target: TARGET_BROWSER_TEST,
        bundle: true,
        sourcemap: is_debug ? 'inline' : true,
        external: EXTERNALS_TEST_BROWSER,
    });

    console.log('[ ESBUILD ] tests-haybarn-repository.js');
    await esbuild.build({
        entryPoints: ['./test/index_haybarn_repository.ts'],
        outfile: 'dist/tests-haybarn-repository.js',
        platform: 'browser',
        format: 'iife',
        target: TARGET_BROWSER_TEST,
        bundle: true,
        sourcemap: is_debug ? 'inline' : true,
        external: EXTERNALS_TEST_BROWSER,
    });

    console.log('[ ESBUILD ] tests-threads-pool.js');
    await esbuild.build({
        entryPoints: ['./test/index_threads_pool.ts'],
        outfile: 'dist/tests-threads-pool.js',
        platform: 'browser',
        format: 'iife',
        target: TARGET_BROWSER_TEST,
        bundle: true,
        sourcemap: is_debug ? 'inline' : true,
        external: EXTERNALS_TEST_BROWSER,
    });

    console.log('[ ESBUILD ] tests-interrupt.js');
    await esbuild.build({
        entryPoints: ['./test/index_interrupt.ts'],
        outfile: 'dist/tests-interrupt.js',
        platform: 'browser',
        format: 'iife',
        target: TARGET_BROWSER_TEST,
        bundle: true,
        sourcemap: is_debug ? 'inline' : true,
        external: EXTERNALS_TEST_BROWSER,
    });

    console.log('[ ESBUILD ] tests-platform.js');
    await esbuild.build({
        entryPoints: ['./test/index_platform.ts'],
        outfile: 'dist/tests-platform.js',
        platform: 'browser',
        format: 'iife',
        target: TARGET_BROWSER_TEST,
        bundle: true,
        sourcemap: is_debug ? 'inline' : true,
        external: EXTERNALS_TEST_BROWSER,
    });

    console.log('[ ESBUILD ] tests-threads-smoke.js');
    await esbuild.build({
        entryPoints: ['./test/index_threads_smoke.ts'],
        outfile: 'dist/tests-threads-smoke.js',
        platform: 'browser',
        format: 'iife',
        globalName: 'duckdb',
        target: TARGET_BROWSER_TEST,
        bundle: true,
        sourcemap: is_debug ? 'inline' : true,
        external: EXTERNALS_TEST_BROWSER,
    });

    console.log('[ ESBUILD ] tests-threads-churn.js');
    await esbuild.build({
        entryPoints: ['./test/index_threads_churn.ts'],
        outfile: 'dist/tests-threads-churn.js',
        platform: 'browser',
        format: 'iife',
        globalName: 'duckdb',
        target: TARGET_BROWSER_TEST,
        bundle: true,
        sourcemap: is_debug ? 'inline' : true,
        external: EXTERNALS_TEST_BROWSER,
    });

    console.log('[ ESBUILD ] tests-node.cjs');
    await esbuild.build({
        entryPoints: ['./test/index_node.ts'],
        outfile: 'dist/tests-node.cjs',
        platform: 'node',
        format: 'cjs',
        target: TARGET_NODE,
        bundle: true,
        minify: false,
        sourcemap: is_debug ? 'inline' : true,
        // web-worker polyfill needs to be excluded from bundling due to their dynamic require messing with bundled modules
        external: [...EXTERNALS_NODE, 'web-worker'],
    });

    // -------------------------------
    // Write declaration files

    // Browser declarations
    await fs.promises.writeFile(
        path.join(dist, 'duckdb-browser.d.ts'),
        "export * from './types/src/targets/duckdb';",
        printErr,
    );
    await fs.promises.writeFile(
        path.join(dist, 'duckdb-browser-blocking.d.ts'),
        "export * from './types/src/targets/duckdb-browser-blocking';",
    );

    await fs.promises.writeFile(
        path.join(dist, 'duckdb-browser-vgi.d.ts'),
        "export * from './types/src/targets/duckdb-browser-vgi';",
    );

    // Node declarations
    await fs.promises.writeFile(
        path.join(dist, 'duckdb-node.d.ts'),
        "export * from './types/src/targets/duckdb';",
        printErr,
    );
    await fs.promises.writeFile(
        path.join(dist, 'duckdb-node-blocking.d.ts'),
        "export * from './types/src/targets/duckdb-node-blocking';",
    );

    // -------------------------------
    // Patch sourcemaps

    let files = await fs.promises.readdir(dist);
    for (const file of files) {
        if (!file.endsWith('js.map')) {
            continue;
        }
        const filePath = path.join(dist, file);
        const content = await (await fs.promises.readFile(filePath)).toString();
        const replaced = content.replace(/\.\.\/node_modules\//g, '');
        await fs.promises.writeFile(filePath, replaced, 'utf-8');
        console.log(`Patched ${file}`);
    }
})();

function patchFile(fileName, moduleName) {
    // Patch file to make sure ESBuild doesn't statically analyse and attempt to load "moduleName"
    // We replace both single and double-quoted module names. The character capture list complexity
    // is due to the single quote:
    // - the sed expression is executed within single quotes
    // - we have to terminate the quotes
    // - we have to escape the middle quote
    const sedCommand = `s/require(["'\\'']${moduleName}["'\\''])/["${moduleName}"].map(require)/g`;
    execSync(`sed -i.bak '${sedCommand}' ${fileName} && rm ${fileName}.bak`);
}
