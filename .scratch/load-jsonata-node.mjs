// Smoke-test: can the locally built wasm_eh engine INSTALL/LOAD/EXECUTE the
// jsonata community extension from the published R2 catalog?
import { createRequire } from 'node:module';
const require = createRequire('/Users/rusty/Development/haybarn/haybarn-wasm/packages/duckdb-wasm/');

const Worker = require('web-worker');
const duckdb = require('./dist/duckdb-node.cjs');
const path = require('node:path');

const DIST = path.resolve('/Users/rusty/Development/haybarn/haybarn-wasm/packages/duckdb-wasm/dist');

const EH_BUNDLE = {
  mainModule: path.join(DIST, 'duckdb-eh.wasm'),
  mainWorker: path.join(DIST, 'duckdb-node-eh.worker.cjs'),
};

function log(...a) { console.log('[test]', ...a); }

const worker = new Worker(EH_BUNDLE.mainWorker);
const logger = new duckdb.ConsoleLogger();
const db = new duckdb.AsyncDuckDB(logger, worker);

try {
  log('instantiating eh engine:', EH_BUNDLE.mainModule);
  await db.instantiate(EH_BUNDLE.mainModule, EH_BUNDLE.mainWorker);
  log('engine version:', await db.getVersion());

  await db.open({});

  const conn = await db.connect();

  const plat = await conn.query(`PRAGMA platform;`);
  log('platform:', plat.toArray().map(r => r.toJSON()));

  log('INSTALL jsonata FROM community ...');
  await conn.query(`INSTALL jsonata FROM community;`);
  log('INSTALL ok. LOAD jsonata ...');
  await conn.query(`LOAD jsonata;`);
  log('LOAD ok. Executing a jsonata function ...');

  const res = await conn.query(`SELECT jsonata('$sum(orders.qty)', '{"orders":[{"qty":2},{"qty":3}]}') AS r;`);
  log('EXECUTE ok:', res.toArray().map(r => r.toJSON()));

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
