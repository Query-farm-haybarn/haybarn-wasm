import { readFile, writeFile } from 'node:fs/promises';
const S = '/Users/rusty/Development/haybarn/haybarn-wasm/.scratch';

async function imps(p) {
  const m = await WebAssembly.compile(await readFile(p));
  return WebAssembly.Module.imports(m).filter(i => i.module === 'env' && i.kind === 'function').map(i => i.name);
}
async function exps(p) {
  const m = await WebAssembly.compile(await readFile(p));
  return new Set(WebAssembly.Module.exports(m).map(e => e.name));
}

const upHttpfsEh = await imps(`${S}/up-httpfs-eh.wasm`);
const hbHttpfsEh = await imps(`${S}/httpfs-eh.wasm`);
const upHttpfsTh = await imps(`${S}/up-httpfs-th.wasm`);
const hbHttpfsTh = await imps(`${S}/httpfs-th.wasm`);

const upEngEh = await exps(`${S}/up-eng-duckdb-eh.wasm`);
const upEngCoi = await exps(`${S}/up-eng-duckdb-coi.wasm`);
const hbEngCoi = await exps(`${S}/coi-rc10.wasm`);          // published haybarn coi
// haybarn eh engine from local bindings
let hbEngEh = new Set();
try { hbEngEh = await exps('/Users/rusty/Development/haybarn/haybarn-wasm/packages/duckdb-wasm/src/bindings/duckdb-eh.wasm'); } catch {}

const unresolved = (imps, exps) => imps.filter(n => n.startsWith('_Z') && !exps.has(n));

const r = {
  'UP httpfs_eh vs UP engine_eh': unresolved(upHttpfsEh, upEngEh).length,
  'HB httpfs_eh vs UP engine_eh': unresolved(hbHttpfsEh, upEngEh).length,
  'HB httpfs_eh vs HB engine_eh': unresolved(hbHttpfsEh, hbEngEh).length,
  'UP httpfs_th vs UP engine_coi': unresolved(upHttpfsTh, upEngCoi).length,
  'HB httpfs_th vs UP engine_coi': unresolved(hbHttpfsTh, upEngCoi).length,
  'HB httpfs_th vs HB engine_coi(rc10)': unresolved(hbHttpfsTh, hbEngCoi).length,
};

// Of the symbols HB httpfs_th needs that HB engine lacks: how many does the UPSTREAM engine have?
const hbThUnresolvedVsHb = unresolved(hbHttpfsTh, hbEngCoi);
const coveredByUpstream = hbThUnresolvedVsHb.filter(n => upEngCoi.has(n));
// And of UP httpfs_th's needs, what does UP engine provide that HB engine doesn't?
const upEngExtraOverHb = [...upEngCoi].filter(n => n.startsWith('_Z') && !hbEngCoi.has(n));

await writeFile(`${S}/diff2.json`, JSON.stringify({
  counts: r,
  hb_th_unresolved_vs_hb_engine: hbThUnresolvedVsHb.length,
  of_those_covered_by_upstream_engine: coveredByUpstream.length,
  upstream_coi_exports: upEngCoi.size,
  haybarn_coi_exports: hbEngCoi.size,
  upstream_engine_Zexports_not_in_haybarn: upEngExtraOverHb.length,
  sample_covered_by_upstream: coveredByUpstream.slice(0, 15),
}, null, 2));
console.log('done');
