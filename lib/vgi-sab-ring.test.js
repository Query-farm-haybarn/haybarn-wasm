// Node unit test for vgi-sab-ring.js: drive the ABI-exact duplex ring across two
// real threads (worker_threads) over a SharedArrayBuffer — request on c2w, a
// stream of framed batches (several larger than the ring) on w2c with blocking
// backpressure, EOS. Validates the browser stub core before the emscripten build.
"use strict";
const { Worker, isMainThread, workerData, parentPort } = require("worker_threads");
const ring = require("./vgi-sab-ring.js");

const RING_CAP = 256;
const N_SLOTS = 4;
// batch sizes; several exceed RING_CAP to force multi-cycle backpressure.
const SIZES = [8, RING_CAP - 1, RING_CAP, RING_CAP + 1, 800, 40];
const fillFor = (i) => (i * 37 + 5) & 0xff;

// Read exactly `n` bytes off w2c (client) or c2w (worker); null on EOS.
function readN(readFn, buf, base, slot, n) {
	const out = Buffer.alloc(n);
	let got = 0;
	while (got < n) {
		const k = readFn(buf, base, slot, out, got, n - got);
		if (k === 0) return got === 0 ? null : out; // EOS
		got += k;
	}
	return out;
}

if (!isMainThread) {
	// --- worker: read the request frame off c2w, then stream SIZES batches to w2c ---
	const { sab, base, slot } = workerData;
	const req = readN(ring.workerRead, sab, base, slot, 4);
	const reqLen = req.readUInt32LE(0);
	readN(ring.workerRead, sab, base, slot, reqLen); // consume request payload
	for (let i = 0; i < SIZES.length; i++) {
		const len = SIZES[i];
		const frame = Buffer.alloc(4 + len, fillFor(i));
		frame.writeUInt32LE(len, 0);
		ring.workerWrite(sab, base, slot, frame, 0, frame.length);
	}
	ring.workerCloseW2c(sab, base, slot);
	parentPort.postMessage("done");
	return;
}

// --- main/client ---
const bytes = ring.channelBytes(N_SLOTS, RING_CAP);
const sab = new SharedArrayBuffer(bytes);
ring.initChannel(sab, 0, N_SLOTS, RING_CAP);
const slot = ring.slotOpen(sab, 0);
if (slot < 0) throw new Error("slotOpen failed");

const worker = new Worker(__filename, { workerData: { sab, base: 0, slot } });

// send a small request frame on c2w, then EOS.
const payload = Buffer.from("INIT");
const reqFrame = Buffer.alloc(4 + payload.length);
reqFrame.writeUInt32LE(payload.length, 0);
payload.copy(reqFrame, 4);
ring.stubWrite(sab, 0, slot, reqFrame, 0, reqFrame.length);
ring.stubWriteEos(sab, 0, slot);

// read the streamed batches off w2c and verify byte-exact.
let count = 0;
let ok = true;
for (;;) {
	const hdr = readN(ring.stubRead, sab, 0, slot, 4);
	if (!hdr) break; // EOS
	const len = hdr.readUInt32LE(0);
	const body = readN(ring.stubRead, sab, 0, slot, len);
	if (!body || len !== SIZES[count] || !body.every((b) => b === fillFor(count))) {
		ok = false;
		console.log(`FAIL batch ${count}: len ${len} want ${SIZES[count]}`);
		break;
	}
	count++;
}
ring.slotRelease(sab, 0, slot);
worker.once("message", () => {
	const pass = ok && count === SIZES.length;
	console.log(`batches=${count}/${SIZES.length} ok=${ok}`);
	console.log(pass ? "RESULT: PASS" : "RESULT: FAIL");
	process.exit(pass ? 0 : 1);
});
