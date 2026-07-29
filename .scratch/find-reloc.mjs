import { readFile, writeFile } from 'node:fs/promises';
const F = '/Users/rusty/Development/haybarn/haybarn-wasm/packages/duckdb-wasm/dist/duckdb-node-eh.worker.cjs';
const s = await readFile(F, 'utf8');

function windows(needle, pad = 140, max = 8) {
  const out = [];
  let i = 0, n = 0;
  while ((i = s.indexOf(needle, i)) !== -1 && n < max) {
    out.push(`@${i}: ...${s.slice(i - pad, i + pad)}...`);
    i += needle.length; n++;
  }
  return out;
}

let report = '';
report += '== resolveGlobalSymbol occurrences ==\n' + windows('resolveGlobalSymbol').join('\n') + '\n\n';
report += '== .value==-1 occurrences ==\n' + windows('.value==-1').join('\n') + '\n\n';
report += '== .value== -1 (spaced) ==\n' + windows('.value == -1').join('\n') + '\n\n';
report += '== reportUndefinedSymbols name ==\n' + windows('reportUndefinedSymbols').join('\n') + '\n\n';
await writeFile('/Users/rusty/Development/haybarn/haybarn-wasm/.scratch/reloc.txt', report, 'utf8');
console.log('done; resolveGlobalSymbol hits:', (s.match(/resolveGlobalSymbol/g)||[]).length);
