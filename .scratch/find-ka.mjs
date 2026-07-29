import { readFile, writeFile } from 'node:fs/promises';
const F = '/Users/rusty/Development/haybarn/haybarn-wasm/packages/duckdb-wasm/dist/duckdb-node-eh.worker.cjs';
const s = await readFile(F, 'utf8');

// The stack points at line 58 of the eval'd module. The worker embeds the
// emscripten glue and runs it; find the function `ka` and the `.value` reads.
// Locate definitions of `ka` (function ka( | ka=( | var ka=)
const defs = [...s.matchAll(/\bka\s*=\s*(?:function)?\s*\(|\bfunction ka\b/g)].map(m => m.index);
let out = `ka defs at: ${defs.join(', ')}\n\n`;
for (const d of defs.slice(0, 6)) {
  out += `=== def @${d} ===\n` + s.slice(d, d + 600) + '\n\n';
}
// Also: every `.value` read that is preceded by an undefinable lookup, near col region.
// Dump all short windows around `.value` occurrences that look like GOT/exports reads.
const valHits = [...s.matchAll(/[A-Za-z0-9_$\]]\.value\b/g)].map(m => m.index);
out += `\n.value reads: ${valHits.length}\n`;
for (const v of valHits.slice(0, 40)) {
  out += `@${v}: ...${s.slice(v - 60, v + 20)}...\n`;
}
await writeFile('/Users/rusty/Development/haybarn/haybarn-wasm/.scratch/ka.txt', out, 'utf8');
console.log('wrote', defs.length, 'defs,', valHits.length, '.value reads');
