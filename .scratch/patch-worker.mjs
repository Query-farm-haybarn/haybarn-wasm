import { readFile, writeFile } from 'node:fs/promises';
const DIST = '/Users/rusty/Development/haybarn/haybarn-wasm/packages/duckdb-wasm/dist';
let s = await readFile(`${DIST}/duckdb-node-eh.worker.cjs`, 'utf8');

const marker = 'could not load dynamic lib';
const mi = s.indexOf(marker);
if (mi < 0) { console.log('MARKER NOT FOUND'); process.exit(1); }
// find the first `+o+` after the marker (the caught error concatenation)
const at = s.indexOf('+o+', mi);
if (at < 0) { console.log('+o+ NOT FOUND after marker'); process.exit(1); }
// inject the stack right after `o`
const injected = s.slice(0, at) + '+o+"\\nJSSTACK:"+((o&&o.stack)||"")+' + s.slice(at + 3);
await writeFile(`${DIST}/duckdb-node-eh.worker.instrumented.cjs`, injected, 'utf8');
console.log('patched at offset', at, ' marker at', mi);
console.log('context after patch:', JSON.stringify(injected.slice(at - 40, at + 60)));
