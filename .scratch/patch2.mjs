import { readFile, writeFile } from 'node:fs/promises';
const DIST = '/Users/rusty/Development/haybarn/haybarn-wasm/packages/duckdb-wasm/dist';
let s = await readFile(`${DIST}/duckdb-node-eh.worker.cjs`, 'utf8');

// Exact minified code at offset ~86824:
//   ...if(r.value==-1){var t=resolveGlobalSymbol(e,!0).sym;if(!t&&!r.required){r.value=0;continue}if(typeof t=="function")...
const needle = 'var t=resolveGlobalSymbol(e,!0).sym;if(!t&&!r.required){r.value=0;continue}';
const count = s.split(needle).length - 1;
if (count < 1) { console.log('NEEDLE COUNT =', count, '(expected >=1) — aborting'); process.exit(1); }
console.log('needle count =', count, '(patching all)');

const replacement =
  'var t=resolveGlobalSymbol(e,!0).sym;' +
  'if(!t){console.error("HB_UNRESOLVED\\t"+(r.required?"REQUIRED":"weak")+"\\t"+e);}' +
  'if(!t&&!r.required){r.value=0;continue}' +
  'if(!t&&r.required){throw new Error("HB_UNRESOLVED_REQUIRED: "+e);}';

s = s.split(needle).join(replacement);
await writeFile(`${DIST}/duckdb-node-eh.worker.instrumented.cjs`, s, 'utf8');
console.log('patched OK');
