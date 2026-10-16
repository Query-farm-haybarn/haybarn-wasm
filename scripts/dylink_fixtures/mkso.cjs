// node mkso.cjs in.wasm out.so : prepend the dylink.0 custom section given in the .wat's
// `(@custom "dylink.0" (before first) "<bytes>")` line (wabt here has no annotation support).
const fs = require('fs');
const [inp, wat, out] = process.argv.slice(2);
const m = fs.readFileSync(wat, 'utf8').match(/\(@custom "dylink\.0" \(before first\) "([^"]*)"\)/);
const payload = Buffer.from(m[1].replace(/\\([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
const leb = n => { const b = []; do { let x = n & 127; n >>>= 7; if (n) x |= 128; b.push(x); } while (n); return b; };
const name = Buffer.from('dylink.0');
const body = Buffer.concat([Buffer.from(leb(name.length)), name, payload]);
const sec = Buffer.concat([Buffer.from([0]), Buffer.from(leb(body.length)), body]);
const w = fs.readFileSync(inp);
fs.writeFileSync(out, Buffer.concat([w.subarray(0, 8), sec, w.subarray(8)]));
