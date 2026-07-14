// VGI `worker:` SAB transport — the ring protocol in JS, byte-exact to
// vgi/docs/sab_transport_abi.md + vgi/src/include/vgi_sab_abi.hpp. The
// emscripten js-library slot stubs (in js-stubs.js) are thin wrappers over these
// functions operating on `Module.HEAPU8.buffer` (DuckDB's shared linear memory,
// decision #1); the same functions are unit-tested in Node over a SharedArrayBuffer.
//
// SPSC duplex ring, monotonic positions, blocking Atomics flow control — the same
// protocol proven natively (vgi_sab_native_ring.cpp) and in the Node spike.
"use strict";

// ---- ABI constants (must match vgi_sab_abi.hpp) ----
const MAGIC = 0x42534756; // 'VGSB'
const VERSION = 1;
// header i32 lanes
const HDR_MAGIC = 0, HDR_VERSION = 1, HDR_N_SLOTS = 2, HDR_RING_CAP = 3, HDR_SLOT_STRIDE = 4, HDR_SLOTS_OFF = 5;
const HEADER_BYTES = 64;
// slot control i32 lanes (relative to slot base)
const SLOT_STATE = 0, C2W_WRITE = 1, C2W_READ = 2, C2W_CLOSED = 3, W2C_WRITE = 4, W2C_READ = 5, W2C_CLOSED = 6;
const SLOT_CONTROL_BYTES = 64;
const SLOT_FREE = 0, SLOT_CLAIMED = 1;
const WAIT_TIMEOUT_MS = 250; // bounded so a caller can poll interrupt/cancel

function alignUp(n, a) {
	return (n + (a - 1)) & ~(a - 1);
}
function slotStride(ringCap) {
	return alignUp(SLOT_CONTROL_BYTES + 2 * ringCap, 64);
}

// Initialize a channel header at byte offset `base` in `buf`. Zeroes slot state.
function initChannel(buf, base, nSlots, ringCap) {
	const i32 = new Int32Array(buf);
	const h = base >> 2;
	i32[h + HDR_MAGIC] = MAGIC;
	i32[h + HDR_VERSION] = VERSION;
	i32[h + HDR_N_SLOTS] = nSlots;
	i32[h + HDR_RING_CAP] = ringCap;
	i32[h + HDR_SLOT_STRIDE] = slotStride(ringCap);
	i32[h + HDR_SLOTS_OFF] = HEADER_BYTES;
	for (let s = 0; s < nSlots; s++) {
		const sb = (base + HEADER_BYTES + s * slotStride(ringCap)) >> 2;
		i32[sb + SLOT_STATE] = SLOT_FREE;
	}
	return channelBytes(nSlots, ringCap);
}
function channelBytes(nSlots, ringCap) {
	return HEADER_BYTES + nSlots * slotStride(ringCap);
}

// Read header fields for a channel at `base`.
function header(buf, base) {
	const i32 = new Int32Array(buf);
	const h = base >> 2;
	return {
		nSlots: i32[h + HDR_N_SLOTS],
		ringCap: i32[h + HDR_RING_CAP],
		slotStride: i32[h + HDR_SLOT_STRIDE],
		slotsOff: i32[h + HDR_SLOTS_OFF],
	};
}
function slotBase(base, hdr, slot) {
	return base + hdr.slotsOff + slot * hdr.slotStride; // byte offset (64-aligned)
}

// Claim a free slot (CAS state 0->1), reset both rings. Returns slot index or -1.
function slotOpen(buf, base) {
	const i32 = new Int32Array(buf);
	const hdr = header(buf, base);
	for (let s = 0; s < hdr.nSlots; s++) {
		const sb = slotBase(base, hdr, s) >> 2;
		if (Atomics.compareExchange(i32, sb + SLOT_STATE, SLOT_FREE, SLOT_CLAIMED) === SLOT_FREE) {
			i32[sb + C2W_WRITE] = 0; i32[sb + C2W_READ] = 0; i32[sb + C2W_CLOSED] = 0;
			i32[sb + W2C_WRITE] = 0; i32[sb + W2C_READ] = 0; i32[sb + W2C_CLOSED] = 0;
			return s;
		}
	}
	return -1;
}
function slotRelease(buf, base, slot) {
	const i32 = new Int32Array(buf);
	const hdr = header(buf, base);
	Atomics.store(i32, (slotBase(base, hdr, slot) >> 2) + SLOT_STATE, SLOT_FREE);
}

// Generic blocking SPSC ring write. ctl = i32 index of the slot control block.
// Writes all `n` bytes of src[srcOff..] into the ring at dataByteOff.
function ringWrite(buf, ctl, writeLane, readLane, dataByteOff, ringCap, src, srcOff, n) {
	const i32 = new Int32Array(buf);
	const u8 = new Uint8Array(buf);
	let off = 0;
	while (off < n) {
		const w = Atomics.load(i32, ctl + writeLane);
		const r = Atomics.load(i32, ctl + readLane);
		const free = ringCap - (w - r);
		if (free === 0) {
			Atomics.wait(i32, ctl + readLane, r, WAIT_TIMEOUT_MS); // block until reader advances
			continue;
		}
		const k = Math.min(free, n - off);
		const pos = w % ringCap;
		const first = Math.min(k, ringCap - pos);
		u8.set(src.subarray(srcOff + off, srcOff + off + first), dataByteOff + pos);
		if (k > first) {
			u8.set(src.subarray(srcOff + off + first, srcOff + off + k), dataByteOff);
		}
		Atomics.store(i32, ctl + writeLane, w + k);
		Atomics.notify(i32, ctl + writeLane);
		off += k;
	}
	return n;
}

// Generic blocking SPSC ring read of up to `n` bytes into dst[dstOff..].
// Returns bytes read (>0), or 0 on EOS (closed && drained).
function ringRead(buf, ctl, writeLane, readLane, closedLane, dataByteOff, ringCap, dst, dstOff, n) {
	const i32 = new Int32Array(buf);
	const u8 = new Uint8Array(buf);
	for (;;) {
		const w = Atomics.load(i32, ctl + writeLane);
		const r = Atomics.load(i32, ctl + readLane);
		const avail = w - r;
		if (avail === 0) {
			if (Atomics.load(i32, ctl + closedLane) === 1) {
				return 0; // EOS
			}
			Atomics.wait(i32, ctl + writeLane, w, WAIT_TIMEOUT_MS);
			continue;
		}
		const k = Math.min(avail, n);
		const pos = r % ringCap;
		const first = Math.min(k, ringCap - pos);
		dst.set(u8.subarray(dataByteOff + pos, dataByteOff + pos + first), dstOff);
		if (k > first) {
			dst.set(u8.subarray(dataByteOff, dataByteOff + k - first), dstOff + first);
		}
		Atomics.store(i32, ctl + readLane, r + k);
		Atomics.notify(i32, ctl + readLane);
		return k;
	}
}

function closeRing(buf, ctl, closedLane) {
	const i32 = new Int32Array(buf);
	Atomics.store(i32, ctl + closedLane, 1);
	Atomics.notify(i32, ctl); // wake a blocked reader (waits on writeLane==ctl+0? see below)
}

// ---- client-side stub ops (DuckDB extension side: c2w write, w2c read) ----
function stubWrite(buf, base, slot, src, srcOff, n) {
	const hdr = header(buf, base);
	const sb = slotBase(base, hdr, slot);
	return ringWrite(buf, sb >> 2, C2W_WRITE, C2W_READ, sb + SLOT_CONTROL_BYTES, hdr.ringCap, src, srcOff, n);
}
function stubWriteEos(buf, base, slot) {
	const hdr = header(buf, base);
	const sb = slotBase(base, hdr, slot);
	const i32 = new Int32Array(buf);
	Atomics.store(i32, (sb >> 2) + C2W_CLOSED, 1);
	Atomics.notify(i32, (sb >> 2) + C2W_WRITE); // wake worker blocked reading c2w
}
function stubRead(buf, base, slot, dst, dstOff, n) {
	const hdr = header(buf, base);
	const sb = slotBase(base, hdr, slot);
	return ringRead(buf, sb >> 2, W2C_WRITE, W2C_READ, W2C_CLOSED, sb + SLOT_CONTROL_BYTES + hdr.ringCap,
		hdr.ringCap, dst, dstOff, n);
}

// ---- worker-side ops (VGI worker module side: c2w read, w2c write) ----
function workerRead(buf, base, slot, dst, dstOff, n) {
	const hdr = header(buf, base);
	const sb = slotBase(base, hdr, slot);
	return ringRead(buf, sb >> 2, C2W_WRITE, C2W_READ, C2W_CLOSED, sb + SLOT_CONTROL_BYTES,
		hdr.ringCap, dst, dstOff, n);
}
function workerWrite(buf, base, slot, src, srcOff, n) {
	const hdr = header(buf, base);
	const sb = slotBase(base, hdr, slot);
	return ringWrite(buf, sb >> 2, W2C_WRITE, W2C_READ, sb + SLOT_CONTROL_BYTES + hdr.ringCap,
		hdr.ringCap, src, srcOff, n);
}
function workerCloseW2c(buf, base, slot) {
	const hdr = header(buf, base);
	const sb = slotBase(base, hdr, slot);
	const i32 = new Int32Array(buf);
	Atomics.store(i32, (sb >> 2) + W2C_CLOSED, 1);
	Atomics.notify(i32, (sb >> 2) + W2C_WRITE); // wake client blocked reading w2c
}

if (typeof module !== "undefined" && module.exports) {
	module.exports = {
		MAGIC, VERSION, HEADER_BYTES, slotStride, channelBytes, initChannel, header,
		slotOpen, slotRelease, stubWrite, stubWriteEos, stubRead,
		workerRead, workerWrite, workerCloseW2c,
	};
}
