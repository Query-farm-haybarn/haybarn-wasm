import { readFile, writeFile } from 'node:fs/promises';
const F = '/Users/rusty/Development/haybarn/haybarn-wasm/packages/duckdb-wasm/dist/duckdb-node-eh.worker.cjs';
const L = (await readFile(F, 'utf8')).split('\n')[57];
const col = 71576;
const left = L.slice(col - 340, col);
const here = L.slice(col, col + 1);
const right = L.slice(col + 1, col + 140);
const out =
  `CHAR AT ${col}: ${JSON.stringify(here)}\n\n` +
  `LEFT (…340 before):\n${left}\n\n` +
  `>>>HERE>>> ${here}\n\n` +
  `RIGHT (140 after):\n${right}\n`;
await writeFile('/Users/rusty/Development/haybarn/haybarn-wasm/.scratch/slice58b.txt', out, 'utf8');
console.log('ok');
