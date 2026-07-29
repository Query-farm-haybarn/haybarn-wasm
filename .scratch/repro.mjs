// Reproduce the shell.haybarn.query.farm httpfs LOAD failure in Node.
//
//   IO Error: Extension ".../wasm_threads/httpfs.duckdb_extension.wasm" could not
//   be loaded: could not load dynamic lib: httpfs
//   TypeError: undefined is not an object (evaluating 'r.value')
//
// The failing op is emscripten's loadWebAssemblyModule() relocating the httpfs
// side-module against the COI engine. It throws because the side module imports
// a runtime symbol the engine does not provide. We reproduce that here by
// resolving the side module's imports against the engine's exports, exactly the
// way the dynamic linker does.
import { readFile } from 'node:fs/promises';

const S = '/Users/rusty/Development/haybarn/haybarn-wasm/.scratch';
const extBytes = await readFile(`${S}/httpfs-th.wasm`);       // wasm_threads httpfs
const engBytes = await readFile(`${S}/coi-deployed.wasm`);    // deployed duckdb-coi.wasm

const extMod = await WebAssembly.compile(extBytes);
const engMod = await WebAssembly.compile(engBytes);

// What the side module imports from env (functions only), and what the engine exports.
const extEnvImports = WebAssembly.Module.imports(extMod)
  .filter(i => i.module === 'env' && i.kind === 'function')
  .map(i => i.name);
const engExports = new Set(WebAssembly.Module.exports(engMod).map(e => e.name));

const unresolved = extEnvImports.filter(n => !engExports.has(n));

console.log(`ext env-function imports : ${extEnvImports.length}`);
console.log(`engine exports           : ${engExports.size}`);
console.log(`unresolved (the cause)   : ${JSON.stringify(unresolved)}`);

// Now actually instantiate the side module the way the dynamic linker does:
// build an env import object from the engine's exports. The one symbol that is
// missing will be absent, so instantiation fails -> the real failure.
const env = { memory: new WebAssembly.Memory({ initial: 1, maximum: 65536, shared: true }) };
// (We don't have the engine instance's real exports here, so we stub everything
//  the extension imports EXCEPT the genuinely-missing one, to prove that symbol
//  is what breaks the link.)
for (const imp of WebAssembly.Module.imports(extMod)) {
  if (imp.module !== 'env') continue;
  if (imp.name === 'memory') continue;
  if (engExports.has(imp.name)) {
    if (imp.kind === 'function') env[imp.name] = () => 0;
    else if (imp.kind === 'global') env[imp.name] = 0;
  }
  // deliberately leave the unresolved symbol(s) out -> mirrors the engine
}
const imports = { env, 'GOT.mem': new Proxy({}, { get: () => new WebAssembly.Global({ value: 'i32', mutable: true }, 0) }),
                  'GOT.func': new Proxy({}, { get: () => new WebAssembly.Global({ value: 'i32', mutable: true }, 0) }),
                  wasi_snapshot_preview1: new Proxy({}, { get: () => () => 0 }) };
try {
  await WebAssembly.instantiate(extMod, imports);
  console.log('UNEXPECTED: instantiated without error');
} catch (e) {
  console.log(`instantiation error      : ${e.constructor.name}: ${e.message}`);
}
