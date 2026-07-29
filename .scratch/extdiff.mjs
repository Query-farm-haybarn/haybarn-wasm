import { readFile, writeFile } from 'node:fs/promises';
const S = '/Users/rusty/Development/haybarn/haybarn-wasm/.scratch';
async function imps(p) {
  const m = await WebAssembly.compile(await readFile(p));
  return WebAssembly.Module.imports(m).filter(i => i.module === 'env' && i.kind === 'function' && i.name.startsWith('_Z')).map(i => i.name);
}
const up = new Set(await imps(`${S}/up-httpfs-th.wasm`));
const hb = new Set(await imps(`${S}/httpfs-th.wasm`));
const onlyHb = [...hb].filter(n => !up.has(n));   // haybarn imports these, upstream doesn't
const onlyUp = [...up].filter(n => !hb.has(n));   // upstream imports these, haybarn doesn't
const common = [...hb].filter(n => up.has(n));
await writeFile(`${S}/extdiff.json`, JSON.stringify({
  upstream_th_imports: up.size,
  haybarn_th_imports: hb.size,
  common: common.length,
  only_haybarn_imports: onlyHb.length,
  only_upstream_imports: onlyUp.length,
  sample_only_haybarn: onlyHb.slice(0, 20),
  sample_only_upstream: onlyUp.slice(0, 20),
}, null, 2));
console.log('done');
