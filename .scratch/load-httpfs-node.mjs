// Reproduce the httpfs LOAD failure in Node against the real eh engine.
// Node has a real FS, so INSTALL can cache and LOAD reads the same wasm_eh
// engine + extension the browser would. We want the ACTUAL exception (and the
// real failing symbol), not a static imports/exports diff.
import { createRequire } from 'node:module';
const require = createRequire('/Users/rusty/Development/haybarn/haybarn-wasm/packages/duckdb-wasm/');

const Worker = require('web-worker');
const duckdb = require('./dist/duckdb-node.cjs');
const path = require('node:path');

const DIST = path.resolve('/Users/rusty/Development/haybarn/haybarn-wasm/packages/duckdb-wasm/dist');

const EH_BUNDLE = {
  mainModule: path.join(DIST, 'duckdb-eh.wasm'),
  mainWorker: path.join(DIST, 'duckdb-node-eh.worker.instrumented.cjs'),
};

function log(...a) { console.log('[test]', ...a); }

const worker = new Worker(EH_BUNDLE.mainWorker);
const logger = new duckdb.ConsoleLogger();
const db = new duckdb.AsyncDuckDB(logger, worker);

try {
  log('instantiating eh engine:', EH_BUNDLE.mainModule);
  await db.instantiate(EH_BUNDLE.mainModule, EH_BUNDLE.mainWorker);
  log('engine version:', await db.getVersion());

  // allow_unsigned_extensions must be set at DB-open config time.
  log('opening db with allowUnsignedExtensions=true ...');
  await db.open({ allowUnsignedExtensions: true });

  const conn = await db.connect();

  // Point the extension repo at the published catalog. The engine appends its
  // own `/v<engine-version>/wasm_eh/<ext>.duckdb_extension.wasm`, so the repo
  // base must NOT include the version (the doubled-version 404 earlier).
  log('configuring custom extension repository...');
  try {
    await conn.query(`SET custom_extension_repository = 'https://haybarn-extensions.query.farm/core';`);
  } catch (e) { log('set repo (non-fatal):', e.message); }
  try {
    await conn.query(`SET autoinstall_known_extensions = true;`);
    await conn.query(`SET autoload_known_extensions = true;`);
  } catch (e) { log('set autoload (non-fatal):', e.message); }

  log('INSTALL httpfs ...');
  await conn.query(`INSTALL httpfs;`);
  log('INSTALL ok. LOAD httpfs ...');
  await conn.query(`LOAD httpfs;`);
  log('LOAD ok — httpfs loaded successfully. (unexpected if reproducing the bug)');

  await conn.close();
} catch (e) {
  log('FAILURE:');
  console.log('  name   :', e?.name);
  console.log('  message:', e?.message);
  if (e?.stack) console.log('  stack  :\n' + e.stack.split('\n').map(l => '    ' + l).join('\n'));
} finally {
  await db.terminate();
  worker.terminate();
}
