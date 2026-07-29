import { readFile, writeFile } from 'node:fs/promises';
const F = '/Users/rusty/Development/haybarn/haybarn-wasm/packages/duckdb-wasm/dist/duckdb-node-eh.worker.cjs';
const s = await readFile(F, 'utf8');
const i = s.indexOf('could not load dynamic lib');
const ctx = s.slice(i - 220, i + 220);
await writeFile('/Users/rusty/Development/haybarn/haybarn-wasm/.scratch/ctx.txt', ctx, 'utf8');
console.log('idx', i);
