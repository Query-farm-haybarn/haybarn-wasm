// VGI `worker:` SAB transport — the ring protocol in JS, byte-exact to
// vgi/docs/sab_transport_abi.md + vgi/src/include/vgi_sab_abi.hpp. The
// emscripten js-library slot stubs (in js-stubs.js) are thin wrappers over these
// functions operating on `Module.HEAPU8.buffer` (DuckDB's shared linear memory,
// decision #1); the same functions are unit-tested in Node over a SharedArrayBuffer.
//
// SPSC duplex ring, monotonic positions, blocking Atomics flow control — the same
// protocol proven natively (vgi_sab_native_ring.cpp) and in the Node spike.
'use strict';

// ---- ABI constants (must match vgi_sab_abi.hpp) ----
const MAGIC = 0x42534756; // 'VGSB'
const VERSION = 1;
// header i32 lanes
const HDR_MAGIC = 0,
    HDR_VERSION = 1,
    HDR_N_SLOTS = 2,
    HDR_RING_CAP = 3,
    HDR_SLOT_STRIDE = 4,
    HDR_SLOTS_OFF = 5;
const HDR_FEATURES = 6;
const HDR_CLAIM_SEQ = 8; // monotonic global claim-id counter (unique STATE per claim)
const HEADER_BYTES = 64;
// slot control i32 lanes (relative to slot base)
const SLOT_STATE = 0,
    C2W_WRITE = 1,
    C2W_READ = 2,
    C2W_CLOSED = 3,
    W2C_WRITE = 4,
    W2C_READ = 5,
    W2C_CLOSED = 6;
const TERMINAL_CLAIM = 7,
    TERMINAL_CODE = 8,
    TERMINAL_DETAIL = 9,
    SLOT_RESERVATION = 10;
const FEATURE_TERMINAL_ERROR = 1 << 0;
const SAB_TERMINAL_ERROR = -3;
const SLOT_CONTROL_BYTES = 64;
const SLOT_FREE = 0,
    SLOT_CLAIMED = 1;
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
    i32[h + HDR_FEATURES] = FEATURE_TERMINAL_ERROR;
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

// Reserve a free slot, reset both rings while STATE remains free, then publish a
// unique claim id in STATE. Keeping reservation separate from publication means
// a worker that observes a nonzero STATE also observes the complete reset.
function slotOpen(buf, base) {
    const i32 = new Int32Array(buf);
    const hdr = header(buf, base);
    let id = (Atomics.add(i32, (base >> 2) + HDR_CLAIM_SEQ, 1) + 1) | 0;
    if (id === 0) id = 1;
    for (let s = 0; s < hdr.nSlots; s++) {
        const sb = slotBase(base, hdr, s) >> 2;
        if (Atomics.compareExchange(i32, sb + SLOT_RESERVATION, SLOT_FREE, id) === SLOT_FREE) {
            if (Atomics.load(i32, sb + SLOT_STATE) !== SLOT_FREE) {
                Atomics.store(i32, sb + SLOT_RESERVATION, SLOT_FREE);
                Atomics.notify(i32, sb + SLOT_RESERVATION);
                continue;
            }
            Atomics.store(i32, sb + C2W_WRITE, 0);
            Atomics.store(i32, sb + C2W_READ, 0);
            Atomics.store(i32, sb + C2W_CLOSED, 0);
            Atomics.store(i32, sb + W2C_WRITE, 0);
            Atomics.store(i32, sb + W2C_READ, 0);
            Atomics.store(i32, sb + W2C_CLOSED, 0);
            Atomics.store(i32, sb + TERMINAL_CLAIM, 0);
            Atomics.store(i32, sb + TERMINAL_CODE, 0);
            Atomics.store(i32, sb + TERMINAL_DETAIL, 0);
            Atomics.store(i32, sb + SLOT_STATE, id);
            Atomics.store(i32, sb + SLOT_RESERVATION, SLOT_FREE);
            Atomics.notify(i32, sb + SLOT_RESERVATION);
            Atomics.notify(i32, sb + SLOT_STATE);
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

// Worker operations use the same lane as slot-open reservation. Holding it over
// one copy + position publication prevents an opener from resetting positions
// underneath an operation that already validated its served claim. The served
// claim is captured by the worker dispatcher; a stale worker must never adopt a
// replacement claim merely by re-reading STATE.
function acquireWorkerOperation(i32, ctl, servedClaim) {
    if (servedClaim === SLOT_FREE) return false;
    const reservationLane = ctl + SLOT_RESERVATION;
    for (;;) {
        if (Atomics.load(i32, ctl + SLOT_STATE) !== servedClaim) return false;
        const owner = Atomics.compareExchange(i32, reservationLane, SLOT_FREE, servedClaim);
        if (owner === SLOT_FREE) {
            if (Atomics.load(i32, ctl + SLOT_STATE) === servedClaim) return true;
            Atomics.compareExchange(i32, reservationLane, servedClaim, SLOT_FREE);
            Atomics.notify(i32, reservationLane);
            return false;
        }
        Atomics.wait(i32, reservationLane, owner, WAIT_TIMEOUT_MS);
    }
}

function releaseWorkerOperation(i32, ctl, servedClaim) {
    Atomics.compareExchange(i32, ctl + SLOT_RESERVATION, servedClaim, SLOT_FREE);
    Atomics.notify(i32, ctl + SLOT_RESERVATION);
}

// Generic blocking SPSC ring write. ctl = i32 index of the slot control block.
// Writes all `n` bytes of src[srcOff..] into the ring at dataByteOff.
function ringWrite(buf, ctl, writeLane, readLane, dataByteOff, ringCap, src, srcOff, n, servedClaim) {
    const i32 = new Int32Array(buf);
    const u8 = new Uint8Array(buf);
    let off = 0;
    while (off < n) {
        if (servedClaim !== undefined && !acquireWorkerOperation(i32, ctl, servedClaim)) return off;
        let waitPosition;
        try {
            const w = Atomics.load(i32, ctl + writeLane);
            const r = Atomics.load(i32, ctl + readLane);
            const free = ringCap - (w - r);
            if (free === 0) {
                waitPosition = r;
            } else {
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
        } finally {
            if (servedClaim !== undefined) releaseWorkerOperation(i32, ctl, servedClaim);
        }
        if (waitPosition !== undefined) {
            Atomics.wait(i32, ctl + readLane, waitPosition, WAIT_TIMEOUT_MS); // block without owning reservation
        }
    }
    return n;
}

// Generic blocking SPSC ring read of up to `n` bytes into dst[dstOff..].
// Returns bytes read (>0), or 0 on EOS (closed && drained).
function ringRead(
    buf,
    ctl,
    writeLane,
    readLane,
    closedLane,
    dataByteOff,
    ringCap,
    dst,
    dstOff,
    n,
    claimSafeClose = false,
    servedClaim,
) {
    const i32 = new Int32Array(buf);
    const u8 = new Uint8Array(buf);
    for (;;) {
        if (servedClaim !== undefined && !acquireWorkerOperation(i32, ctl, servedClaim)) return 0;
        let waitPosition;
        try {
            const w = Atomics.load(i32, ctl + writeLane);
            const r = Atomics.load(i32, ctl + readLane);
            const avail = w - r;
            if (avail === 0) {
                const closed = Atomics.load(i32, ctl + closedLane);
                if (closed !== 0 && (!claimSafeClose || closed === Atomics.load(i32, ctl + SLOT_STATE))) {
                    return 0; // EOS
                }
                waitPosition = w;
            } else {
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
        } finally {
            if (servedClaim !== undefined) releaseWorkerOperation(i32, ctl, servedClaim);
        }
        if (waitPosition !== undefined) {
            Atomics.wait(i32, ctl + writeLane, waitPosition, WAIT_TIMEOUT_MS); // block without owning reservation
        }
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
    return ringRead(
        buf,
        sb >> 2,
        W2C_WRITE,
        W2C_READ,
        W2C_CLOSED,
        sb + SLOT_CONTROL_BYTES + hdr.ringCap,
        hdr.ringCap,
        dst,
        dstOff,
        n,
        true,
    );
}

function stubTerminalError(buf, base, slot) {
    const i32 = new Int32Array(buf);
    const hdr = header(buf, base);
    const sb = slotBase(base, hdr, slot) >> 2;
    if ((Atomics.load(i32, (base >> 2) + HDR_FEATURES) & FEATURE_TERMINAL_ERROR) === 0) return null;
    const claim = Atomics.load(i32, sb + SLOT_STATE);
    if (claim === SLOT_FREE || Atomics.load(i32, sb + TERMINAL_CLAIM) !== claim) return null;
    const code = Atomics.load(i32, sb + TERMINAL_CODE);
    const detail = Atomics.load(i32, sb + TERMINAL_DETAIL);
    if (Atomics.load(i32, sb + SLOT_STATE) !== claim || Atomics.load(i32, sb + TERMINAL_CLAIM) !== claim) return null;
    return { code, detail };
}

function stubReadWithTerminal(buf, base, slot, dst, dstOff, n) {
    const result = stubRead(buf, base, slot, dst, dstOff, n);
    return result === 0 && stubTerminalError(buf, base, slot) !== null ? SAB_TERMINAL_ERROR : result;
}

// ---- worker-side ops (VGI worker module side: c2w read, w2c write) ----
function workerRead(buf, base, slot, dst, dstOff, n, servedClaim) {
    const hdr = header(buf, base);
    const sb = slotBase(base, hdr, slot);
    const claim = servedClaim === undefined ? Atomics.load(new Int32Array(buf), sb >> 2) : servedClaim;
    return ringRead(
        buf,
        sb >> 2,
        C2W_WRITE,
        C2W_READ,
        C2W_CLOSED,
        sb + SLOT_CONTROL_BYTES,
        hdr.ringCap,
        dst,
        dstOff,
        n,
        false,
        claim,
    );
}
function workerWrite(buf, base, slot, src, srcOff, n, servedClaim) {
    const hdr = header(buf, base);
    const sb = slotBase(base, hdr, slot);
    const claim = servedClaim === undefined ? Atomics.load(new Int32Array(buf), sb >> 2) : servedClaim;
    return ringWrite(
        buf,
        sb >> 2,
        W2C_WRITE,
        W2C_READ,
        sb + SLOT_CONTROL_BYTES + hdr.ringCap,
        hdr.ringCap,
        src,
        srcOff,
        n,
        claim,
    );
}
function workerCloseW2c(buf, base, slot, servedClaim) {
    const hdr = header(buf, base);
    const sb = slotBase(base, hdr, slot);
    const i32 = new Int32Array(buf);
    const ctl = sb >> 2;
    const claim = servedClaim === undefined ? Atomics.load(i32, ctl + SLOT_STATE) : servedClaim;
    if (!acquireWorkerOperation(i32, ctl, claim)) return false;
    try {
        Atomics.store(i32, ctl + W2C_CLOSED, claim);
        Atomics.notify(i32, ctl + W2C_WRITE); // wake client blocked reading w2c
        return true;
    } finally {
        releaseWorkerOperation(i32, ctl, claim);
    }
}

function workerCloseError(buf, base, slot, code, detail, claim) {
    const hdr = header(buf, base);
    const sb = slotBase(base, hdr, slot) >> 2;
    const i32 = new Int32Array(buf);
    const terminalClaim = claim === undefined ? Atomics.load(i32, sb + SLOT_STATE) : claim;
    Atomics.store(i32, sb + TERMINAL_CODE, code);
    Atomics.store(i32, sb + TERMINAL_DETAIL, detail);
    Atomics.store(i32, sb + TERMINAL_CLAIM, terminalClaim);
    Atomics.store(i32, sb + W2C_CLOSED, terminalClaim);
    Atomics.notify(i32, sb + W2C_WRITE);
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        MAGIC,
        VERSION,
        HEADER_BYTES,
        SLOT_RESERVATION,
        FEATURE_TERMINAL_ERROR,
        SAB_TERMINAL_ERROR,
        slotStride,
        channelBytes,
        initChannel,
        header,
        slotOpen,
        slotRelease,
        stubWrite,
        stubWriteEos,
        stubRead,
        stubReadWithTerminal,
        stubTerminalError,
        workerRead,
        workerWrite,
        workerCloseW2c,
        workerCloseError,
    };
}
