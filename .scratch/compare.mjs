import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const S = '/Users/rusty/Development/haybarn/haybarn-wasm/.scratch';

async function info(path) {
  const buf = await readFile(path);
  const mod = await WebAssembly.compile(buf);
  const imports = WebAssembly.Module.imports(mod);
  const envFns = imports.filter(i => i.module === 'env' && i.kind === 'function').map(i => i.name);
  const duckdbImports = envFns.filter(n => n.startsWith('_Z'));
  return {
    size: buf.length,
    sha1: createHash('sha1').update(buf).digest('hex').slice(0, 12),
    envFnImports: envFns.length,
    duckdbImports: duckdbImports.length,
    _duckdb: duckdbImports,
  };
}

const files = {
  up_httpfs_eh: `${S}/up-httpfs-eh.wasm`,
  hb_httpfs_eh: `${S}/httpfs-eh.wasm`,
  up_httpfs_th: `${S}/up-httpfs-th.wasm`,
  hb_httpfs_th: `${S}/httpfs-th.wasm`,
};

const out = {};
for (const [k, p] of Object.entries(files)) {
  try { out[k] = await info(p); }
  catch (e) { out[k] = { error: String(e) }; }
}

// summary without the big arrays
const summary = Object.fromEntries(
  Object.entries(out).map(([k, v]) => [k, v.error ? v : {
    size: v.size, sha1: v.sha1, envFnImports: v.envFnImports, duckdbImports: v.duckdbImports,
  }])
);

await writeFile(`${S}/compare.json`, JSON.stringify({ summary, duckdb_hb_th: out.hb_httpfs_th?._duckdb ?? [] }, null, 2));
