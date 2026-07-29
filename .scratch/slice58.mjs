import { readFile, writeFile } from 'node:fs/promises';
const F = '/Users/rusty/Development/haybarn/haybarn-wasm/packages/duckdb-wasm/dist/duckdb-node-eh.worker.cjs';
const s = await readFile(F, 'utf8');
const lines = s.split('\n');
const L = lines[57]; // line 58 (1-based)
let out = `line58 length: ${L ? L.length : 'NO LINE 58'}\n\n`;
for (const col of [71576, 71614, 69147, 65294]) {
  out += `=== col ${col} ===\n` + (L ? L.slice(col - 90, col + 60) : '') + '\n\n';
}
await writeFile('/Users/rusty/Development/haybarn/haybarn-wasm/.scratch/slice58.txt', out, 'utf8');
console.log('ok len', L ? L.length : -1);
