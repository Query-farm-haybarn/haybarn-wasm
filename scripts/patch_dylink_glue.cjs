#!/usr/bin/env node
// Make emscripten's MAIN_MODULE dynamic-linking glue (libdylink.js) resolve the main module's
// exports on first use, instead of walking all ~48k of them at startup.
//
//   node scripts/patch_dylink_glue.cjs <in.js> <out.js> [--check]
//
// Runs on the readable emcc output in wasm_build_lib.sh, before esbuild bundles and minifies it.
// The glue functions the patch relies on are compared exactly (ignoring comments and whitespace)
// against the emscripten version this was validated with. If any of them changed, the script
// fails, so an emsdk upgrade breaks the build instead of silently mis-patching.
//
// What changes at startup:
//   - The main module's exports are no longer copied into `wasmImports`. `wasmImports` becomes a
//     Proxy that falls back to them, with the same lookup precedence. The first enumeration
//     (dlsym on the main handle) copies them in once, so symbol indices stay deterministic.
//   - `updateGOT(mainExports)` only fills GOT entries that already exist (the main module's own GOT
//     imports). Every other main-module GOT entry is created on first use, with exactly the value
//     the eager pass would have given it, so the main module's definitions still win over
//     duplicate definitions in side modules.
//   - applySignatureConversions() overlays its ~350 pointer-return wrappers on the exports instead
//     of copying all of them with Object.assign.
// Undefined-symbol reporting is unchanged.
//
// What changes on dlopen:
//   - loadWebAssemblyModule drops its reference to the side module's bytes once they are compiled.
//     When a side module imports a symbol that isn't defined yet, the import gets a lazy stub whose
//     closure shares loadWebAssemblyModule's context, which holds `binary`, so the whole file stays
//     in memory for as long as the module is loaded (~26 MB for spatial). The async path already
//     replaces `binary` with the compiled module, so only the sync path changes. Needed until
//     https://github.com/emscripten-core/emscripten/pull/28002 lands.
'use strict';
const fs = require('fs');

// Compare code without comments or whitespace
const normalize = code => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').replace(/\s+/g, '');
const occurrences = (haystack, needle) => haystack.split(needle).length - 1;

// The glue code the injected runtime depends on, as emitted by emscripten 6.0.12
const REQUIRED = {
    receiveInstance: `wasmExports = instance.exports; var origExports = wasmExports; mergeLibSymbols(wasmExports, "main");`,
    receiveInstanceGOT: `assignWasmExports(wasmExports); updateGOT(origExports);`,
    GOTHandler: `var GOTHandler = { get(weakImports, symName) { var rtn = GOT[symName]; if (!rtn) { rtn = GOT[symName] = new WebAssembly.Global({ "value": "i32", "mutable": true }, -1); } if (!weakImports.has(symName)) { rtn.required = true; } return rtn; } };`,
    updateGOT: `var updateGOT = (exports, replace) => { for (var symName in exports) { if (isInternalSym(symName)) { continue; } var value = exports[symName]; var existingEntry = GOT[symName] && GOT[symName].value != -1; if (replace || !existingEntry) { var newValue; if (typeof value == "function") { newValue = addFunction(value); } else if (typeof value.value == "number") { newValue = value; } else { continue; } GOT[symName] ??= new WebAssembly.Global({ "value": "i32", "mutable": true }); GOT[symName].value = newValue; } } };`,
    isSymbolDefined: `var isSymbolDefined = symName => { var existing = wasmImports[symName]; if (!existing || existing.stub) { return false; }`,
    mergeLibSymbols: `var mergeLibSymbols = (exports, libName) => { for (var [sym, exp] of Object.entries(exports)) { const setImport = target => { if (!isSymbolDefined(target)) { wasmImports[target] = exp; } }; setImport(sym); } };`,
    ldsoInit: `var LDSO = { loadedLibsByName: {}, loadedLibsByHandle: {}, init() { newDSO("__main__", 0, wasmImports); } };`,
    isInternalSym: `var isInternalSym = symName => [`,
    // eh and mvp create wasmImports directly; coi (pthreads) creates it in assignWasmImports()
    wasmImports: [`var wasmImports = {`, `var wasmImports; function assignWasmImports() { wasmImports = {`],
    dlsymImport: `_dlsym_js: __dlsym_js,`,
    dlsymCatchupImport: `_dlsym_catchup_js: __dlsym_catchup_js,`,
    applySignatureConversions: `function applySignatureConversions(wasmExports) { wasmExports = Object.assign({}, wasmExports);`,
};
// The end of loadWebAssemblyModule's loadModule(), as emitted by emscripten 6.0.12. Matching through
// the closing brace shows nothing after the sync compile reads `binary` again.
const LOAD_MODULE_TAIL = `if (flags.loadAsync) { return ((async () => { var instance; if (binary instanceof WebAssembly.Module) { instance = new WebAssembly.Instance(binary, info); } else { ({ module: binary, instance } = await WebAssembly.instantiate(binary, info)); } return postInstantiation(binary, instance); }))(); } var module = binary instanceof WebAssembly.Module ? binary : new WebAssembly.Module(binary); var instance = new WebAssembly.Instance(module, info); return postInstantiation(module, instance); } flags = {`;
const FREE_BINARY_MARKER = '/* haybarn: free side-module bytes (scripts/patch_dylink_glue.cjs) */';
// Glue features the injected runtime doesn't handle
const UNSUPPORTED = {
    asyncify: 'asyncifyStubs', // isSymbolDefined has extra ASYNCIFY logic
    legalizedI64: 'orig$', // without WASM_BIGINT, updateGOT renames orig$ symbols
    dynCalls: 'registerDynCallSymbols', // with DYNCALLS, mergeLibSymbols does more work
    memory64: '"value":"i64"', // MEMORY64 GOT entries
};

// Injected immediately before applySignatureConversions: after wasmImports, GOTHandler, updateGOT and
// mergeLibSymbols are defined, and before createWasm() runs.
const RUNTIME = `
/* haybarn: lazy MAIN_MODULE dylink glue (scripts/patch_dylink_glue.cjs) */
var __hbMainExports=null,__hbLazy=null,__hbGOTGet=GOTHandler.get,__hbUpdateGOT=updateGOT,__hbMerge=mergeLibSymbols;
function __hbGOTFromMain(s){if(__hbMainExports&&!GOT[s]&&typeof s=="string"&&s in __hbMainExports&&!isInternalSym(s)){var o={};o[s]=__hbMainExports[s];__hbUpdateGOT(o)}}
GOTHandler.get=function(w,s){__hbGOTFromMain(s);return __hbGOTGet.call(this,w,s)};
updateGOT=(e,r)=>{if(__hbMainExports){if(e===__hbMainExports&&!r){for(var s in GOT)if(s in e&&!isInternalSym(s)&&GOT[s].value==-1){var o={};o[s]=e[s];__hbUpdateGOT(o)}return}if(!r)for(var s in e)__hbGOTFromMain(s)}return __hbUpdateGOT(e,r)};
mergeLibSymbols=(e,r)=>{if(r!=="main"||__hbMainExports)return __hbMerge(e,r);__hbMainExports=e;var t=wasmImports,h=k=>{if(typeof k!="string"||!(k in e))return!1;var v=t[k];return!v||!!v.stub},H={get:(o,k)=>h(k)?e[k]:o[k],has:(o,k)=>k in o||h(k),getOwnPropertyDescriptor:(o,k)=>h(k)?{value:e[k],writable:!0,enumerable:!0,configurable:!0}:Reflect.getOwnPropertyDescriptor(o,k),ownKeys:o=>(__hbMaterialize(),Reflect.ownKeys(o))};__hbLazy={t,h,H};wasmImports=new Proxy(t,H)};
function __hbMaterialize(){var L=__hbLazy;if(!L)return;__hbLazy=null;var p=wasmImports,o=L.t,e=__hbMainExports;for(var k in e)L.h(k)&&(o[k]=e[k]);delete L.H.get;delete L.H.has;delete L.H.getOwnPropertyDescriptor;delete L.H.ownKeys;wasmImports=o;for(var n in LDSO.loadedLibsByName){var d=LDSO.loadedLibsByName[n];d.exports===p&&(d.exports=o)}}
function __hbWrapDlsym(){["_dlsym_js","_dlsym_catchup_js"].forEach(n=>{var f=wasmImports[n];var w=function(h){if(__hbLazy){var d=LDSO.loadedLibsByHandle[h>>>0];d&&d.exports===wasmImports&&__hbMaterialize()}return f.apply(this,arguments)};w.sig=f.sig;wasmImports[n]=w})}
if(wasmImports)__hbWrapDlsym();else{var __hbAssignWasmImports=assignWasmImports;assignWasmImports=function(){__hbAssignWasmImports();__hbWrapDlsym()}}
function __hbOverlay(s){var v={};return new Proxy(v,{get:(o,k)=>k in v?v[k]:s[k],set:(o,k,x)=>(v[k]=x,!0),has:(o,k)=>k in v||k in s,ownKeys:()=>Reflect.ownKeys(s),getOwnPropertyDescriptor:(o,k)=>k in v||k in s?{value:k in v?v[k]:s[k],writable:!0,enumerable:!0,configurable:!0}:void 0})}
`;

const isLazyPatched = src => src.includes('__hbMainExports');
const isFreeBinaryPatched = src => src.includes(FREE_BINARY_MARKER);
const isPatched = src => isLazyPatched(src) && isFreeBinaryPatched(src);

function checkGlue(code) {
    for (const [name, snippets] of Object.entries(REQUIRED)) {
        // A check passes when exactly one of its alternative forms occurs, exactly once
        const counts = [].concat(snippets).map(snippet => occurrences(code, normalize(snippet)));
        if (counts.reduce((a, b) => a + b, 0) !== 1) {
            throw new Error(`glue check '${name}' found ${counts.join('+')} matches, expected 1 (did emscripten change libdylink.js? re-validate the patch)`);
        }
    }
    for (const [name, marker] of Object.entries(UNSUPPORTED)) {
        if (code.includes(marker)) throw new Error(`unsupported glue feature present: ${name}`);
    }
}

// Load extensions without startup walking all main-module exports
function patchLazy(src) {
    checkGlue(normalize(src));
    const anchor = /function\s+applySignatureConversions\s*\(\s*wasmExports\s*\)\s*\{(\s*(?:\/\/[^\n]*\s*)*)wasmExports\s*=\s*Object\.assign\(\s*\{\s*\}\s*,\s*wasmExports\s*\)\s*;/;
    if (!anchor.test(src)) throw new Error('applySignatureConversions is not in the expected form');
    return src.replace(anchor, (_, between) => `${RUNTIME}function applySignatureConversions(wasmExports) {${between}wasmExports = __hbOverlay(wasmExports);`);
}

// Don't keep a side module's bytes alive after compiling it
function patchFreeBinary(src) {
    const found = occurrences(normalize(src), normalize(LOAD_MODULE_TAIL));
    if (found !== 1) {
        throw new Error(`glue check 'loadModuleTail' found ${found} matches, expected 1 (did emscripten change libdylink.js? re-validate the patch)`);
    }
    const anchor = /(var\s+module\s*=\s*binary\s+instanceof\s+WebAssembly\.Module\s*\?\s*binary\s*:\s*new\s+WebAssembly\.Module\(\s*binary\s*\)\s*;)/g;
    const matches = src.match(anchor);
    if (!matches || matches.length !== 1) throw new Error('loadModule sync compile is not in the expected form');
    return src.replace(anchor, `$1 binary = null; ${FREE_BINARY_MARKER}`);
}

// Apply each rewrite that isn't applied yet, so output from an older version of this script is
// brought up to date
function patch(src) {
    if (isPatched(src)) throw new Error('already patched');
    if (!isLazyPatched(src)) src = patchLazy(src);
    if (!isFreeBinaryPatched(src)) src = patchFreeBinary(src);
    return src;
}

if (require.main === module) {
    const args = process.argv.slice(2);
    const check = args.includes('--check');
    const [input, output] = args.filter(a => !a.startsWith('--'));
    try {
        const src = fs.readFileSync(input, 'utf8');
        // wasm_build_lib.sh reprocesses its previous output when the link step had nothing to do
        if (isPatched(src)) {
            if (!check && input !== output) fs.writeFileSync(output, src);
            console.error(`patch_dylink_glue: ${input}: already patched`);
            return;
        }
        const patched = patch(src);
        if (!check) fs.writeFileSync(output, patched);
        console.error(`patch_dylink_glue: ${input}: ${check ? 'checks passed' : 'patched'}`);
    } catch (e) {
        console.error(`patch_dylink_glue: ${input}: ${e.message}`);
        process.exit(1);
    }
}
module.exports = { patch, isPatched, FREE_BINARY_MARKER };
