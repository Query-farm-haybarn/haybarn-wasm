// Focused concurrency-contract tests for the Emscripten SAB stubs and their
// Node reference implementation. No DuckDB build is required.
'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const ring = require('./vgi-sab-ring.js');

const HEADER_BYTES = 64;
const SLOT_STATE = 0;
const C2W_WRITE = 1;
const C2W_READ = 2;
const W2C_WRITE = 4;
const W2C_CLOSED = 6;
const TERMINAL_CLAIM = 7;
const TERMINAL_CODE = 8;
const TERMINAL_DETAIL = 9;
const SLOT_RESERVATION = 10;
const RING_CAP = 64;
const SLOT_STRIDE = 64 + 2 * RING_CAP;
const SLOT_BASE_I32 = HEADER_BYTES >> 2;

function initStubBuffer() {
    const sab = new SharedArrayBuffer(512);
    const i32 = new Int32Array(sab);
    i32[0] = 0x42534756;
    i32[1] = 1;
    i32[2] = 1;
    i32[3] = RING_CAP;
    i32[4] = SLOT_STRIDE;
    i32[5] = HEADER_BYTES;
    i32[6] = 1;
    return { sab, i32 };
}

function loadStubLibrary(sab, atomics = Atomics) {
    let library;
    const context = {
        addToLibrary(value) {
            library = value;
        },
        Atomics: atomics,
        SharedArrayBuffer,
        Int32Array,
        Uint8Array,
        Module: { HEAPU8: new Uint8Array(sab) },
        wasmMemory: { buffer: sab },
        UTF8ToString() {
            return 'worker:test';
        },
        globalThis: {},
    };
    vm.runInNewContext(fs.readFileSync(require.resolve('./js-stubs.js'), 'utf8'), context, {
        filename: 'js-stubs.js',
    });
    context.vgiSab = library.$vgiSab;
    return { context, library };
}

// Preserve the latest explicit-region host ABI. This catches an accidental
// fallback to the released selector-only arities while testing the new lane.
{
    const { sab } = initStubBuffer();
    const { library } = loadStubLibrary(sab);
    assert.strictEqual(library.vgi_wasm_set_channel.length, 1);
    assert.strictEqual(library.vgi_wasm_ensure_worker.length, 2);
    assert.strictEqual(library.vgi_wasm_slot_open.length, 2);
    assert.strictEqual(library.vgi_wasm_slot_write.length, 4);
    assert.strictEqual(library.vgi_wasm_slot_write_eos.length, 2);
    assert.strictEqual(library.vgi_wasm_slot_read.length, 4);
    assert.strictEqual(library.vgi_wasm_slot_terminal_error.length, 4);
    assert.strictEqual(library.vgi_wasm_slot_release.length, 2);
}

// Observe the exact STATE publication store. Every reset lane must already be
// zero at that instant, while the reservation still belongs to this opener.
{
    const { sab, i32 } = initStubBuffer();
    for (let lane = C2W_WRITE; lane <= TERMINAL_DETAIL; lane++) i32[SLOT_BASE_I32 + lane] = 0x51515151;
    let observedPublication = false;
    const instrumented = {
        add: Atomics.add,
        compareExchange: Atomics.compareExchange,
        load: Atomics.load,
        notify: Atomics.notify,
        wait: Atomics.wait,
        store(view, index, value) {
            if (index === SLOT_BASE_I32 + SLOT_STATE && value !== 0) {
                observedPublication = true;
                for (let lane = C2W_WRITE; lane <= TERMINAL_DETAIL; lane++) {
                    assert.strictEqual(Atomics.load(view, SLOT_BASE_I32 + lane), 0, `lane ${lane} reset before STATE`);
                }
                assert.strictEqual(Atomics.load(view, SLOT_BASE_I32 + SLOT_RESERVATION), value);
            }
            return Atomics.store(view, index, value);
        },
    };
    const { library } = loadStubLibrary(sab, instrumented);
    assert.strictEqual(library.vgi_wasm_slot_open(0, 0), 0);
    assert.ok(observedPublication, 'STATE publication was observed');
    assert.notStrictEqual(Atomics.load(i32, SLOT_BASE_I32 + SLOT_STATE), 0);
    assert.strictEqual(Atomics.load(i32, SLOT_BASE_I32 + SLOT_RESERVATION), 0);
}

// The reference implementation must enforce the same reserve/reset/publish
// order. Intercepting the STATE publication makes the ordering deterministic.
{
    const sab = new SharedArrayBuffer(ring.channelBytes(1, RING_CAP));
    ring.initChannel(sab, 0, 1, RING_CAP);
    const i32 = new Int32Array(sab);
    for (let lane = C2W_WRITE; lane <= TERMINAL_DETAIL; lane++) i32[SLOT_BASE_I32 + lane] = 0x61616161;
    const originalStore = Atomics.store;
    let observedPublication = false;
    Atomics.store = function (view, index, value) {
        if (index === SLOT_BASE_I32 + SLOT_STATE && value !== 0) {
            observedPublication = true;
            for (let lane = C2W_WRITE; lane <= TERMINAL_DETAIL; lane++) {
                assert.strictEqual(Atomics.load(view, SLOT_BASE_I32 + lane), 0, `reference lane ${lane} reset`);
            }
            assert.strictEqual(Atomics.load(view, SLOT_BASE_I32 + SLOT_RESERVATION), value);
        }
        return originalStore(view, index, value);
    };
    try {
        assert.strictEqual(ring.slotOpen(sab, 0), 0);
    } finally {
        Atomics.store = originalStore;
    }
    assert.ok(observedPublication, 'reference STATE publication was observed');
    assert.strictEqual(Atomics.load(i32, SLOT_BASE_I32 + ring.SLOT_RESERVATION), 0);
}

// Force a reclaim exactly after the old terminal payload is read. Both the
// Emscripten helper and the reference helper must reject the torn snapshot.
{
    const { sab, i32 } = initStubBuffer();
    const claim = 17;
    Atomics.store(i32, SLOT_BASE_I32 + SLOT_STATE, claim);
    Atomics.store(i32, SLOT_BASE_I32 + TERMINAL_CLAIM, claim);
    Atomics.store(i32, SLOT_BASE_I32 + TERMINAL_CODE, 41);
    Atomics.store(i32, SLOT_BASE_I32 + TERMINAL_DETAIL, 9001);
    const codePtr = 400;
    const detailPtr = 404;
    Atomics.store(i32, codePtr >> 2, -1);
    Atomics.store(i32, detailPtr >> 2, -1);
    let reclaimed = false;
    const instrumented = {
        add: Atomics.add,
        compareExchange: Atomics.compareExchange,
        notify: Atomics.notify,
        store: Atomics.store,
        wait: Atomics.wait,
        load(view, index) {
            const value = Atomics.load(view, index);
            if (!reclaimed && index === SLOT_BASE_I32 + TERMINAL_DETAIL) {
                reclaimed = true;
                Atomics.store(view, SLOT_BASE_I32 + SLOT_STATE, claim + 1);
                Atomics.store(view, SLOT_BASE_I32 + TERMINAL_CLAIM, 0);
            }
            return value;
        },
    };
    const { library } = loadStubLibrary(sab, instrumented);
    assert.strictEqual(library.vgi_wasm_slot_terminal_error(0, 0, codePtr, detailPtr), 0);
    assert.strictEqual(Atomics.load(i32, codePtr >> 2), -1);
    assert.strictEqual(Atomics.load(i32, detailPtr >> 2), -1);
}

{
    const sab = new SharedArrayBuffer(ring.channelBytes(1, RING_CAP));
    ring.initChannel(sab, 0, 1, RING_CAP);
    const slot = ring.slotOpen(sab, 0);
    const i32 = new Int32Array(sab);
    const claim = Atomics.load(i32, SLOT_BASE_I32 + SLOT_STATE);
    ring.workerCloseError(sab, 0, slot, 41, 9001, claim);
    const originalLoad = Atomics.load;
    let reclaimed = false;
    Atomics.load = function (view, index) {
        const value = originalLoad(view, index);
        if (!reclaimed && index === SLOT_BASE_I32 + TERMINAL_DETAIL) {
            reclaimed = true;
            Atomics.store(view, SLOT_BASE_I32 + SLOT_STATE, claim + 1);
            Atomics.store(view, SLOT_BASE_I32 + TERMINAL_CLAIM, 0);
        }
        return value;
    };
    try {
        assert.strictEqual(ring.stubTerminalError(sab, 0, slot), null);
    } finally {
        Atomics.load = originalLoad;
    }
}

// A stale worker may already be inside the copy/publish critical section when
// its claim is released. The opener must fail to reserve until that operation
// releases lane 10, then reset the old position before publishing the new claim.
{
    const sab = new SharedArrayBuffer(ring.channelBytes(1, RING_CAP));
    ring.initChannel(sab, 0, 1, RING_CAP);
    const i32 = new Int32Array(sab);
    const slot = ring.slotOpen(sab, 0);
    const oldClaim = Atomics.load(i32, SLOT_BASE_I32 + SLOT_STATE);
    const originalStore = Atomics.store;
    let openWhileWriteOwned;
    Atomics.store = function (view, index, value) {
        if (openWhileWriteOwned === undefined && index === SLOT_BASE_I32 + W2C_WRITE && value !== 0) {
            assert.strictEqual(Atomics.load(view, SLOT_BASE_I32 + SLOT_RESERVATION), oldClaim);
            ring.slotRelease(sab, 0, slot);
            openWhileWriteOwned = ring.slotOpen(sab, 0);
        }
        return originalStore(view, index, value);
    };
    try {
        assert.strictEqual(ring.workerWrite(sab, 0, slot, Buffer.from([7]), 0, 1, oldClaim), 1);
    } finally {
        Atomics.store = originalStore;
    }
    assert.strictEqual(openWhileWriteOwned, -1, 'opener cannot reset an in-flight write');
    assert.strictEqual(Atomics.load(i32, SLOT_BASE_I32 + SLOT_STATE), 0);
    assert.strictEqual(Atomics.load(i32, SLOT_BASE_I32 + SLOT_RESERVATION), 0);

    assert.strictEqual(ring.slotOpen(sab, 0), slot);
    const newClaim = Atomics.load(i32, SLOT_BASE_I32 + SLOT_STATE);
    assert.notStrictEqual(newClaim, oldClaim);
    assert.strictEqual(Atomics.load(i32, SLOT_BASE_I32 + W2C_WRITE), 0, 'reclaim resets stale write position');
    assert.strictEqual(ring.workerWrite(sab, 0, slot, Buffer.from([8]), 0, 1, oldClaim), 0);
    assert.strictEqual(Atomics.load(i32, SLOT_BASE_I32 + W2C_WRITE), 0, 'stale claim cannot write after reclaim');
    assert.strictEqual(ring.workerWrite(sab, 0, slot, Buffer.from([9]), 0, 1, newClaim), 1);
    assert.strictEqual(ring.workerCloseW2c(sab, 0, slot, oldClaim), false);
    assert.strictEqual(Atomics.load(i32, SLOT_BASE_I32 + W2C_CLOSED), 0, 'stale claim cannot close replacement');
    assert.strictEqual(ring.workerCloseW2c(sab, 0, slot, newClaim), true);
    const fresh = Buffer.alloc(1);
    assert.strictEqual(ring.stubRead(sab, 0, slot, fresh, 0, 1), 1);
    assert.deepStrictEqual([...fresh], [9]);
    ring.slotRelease(sab, 0, slot);
}

// Mirror the same deterministic reclaim at the worker-read position publish.
// The new claim must start at position zero and consume only its own byte.
{
    const sab = new SharedArrayBuffer(ring.channelBytes(1, RING_CAP));
    ring.initChannel(sab, 0, 1, RING_CAP);
    const i32 = new Int32Array(sab);
    const slot = ring.slotOpen(sab, 0);
    const oldClaim = Atomics.load(i32, SLOT_BASE_I32 + SLOT_STATE);
    ring.stubWrite(sab, 0, slot, Buffer.from([17]), 0, 1);
    const originalStore = Atomics.store;
    let openWhileReadOwned;
    Atomics.store = function (view, index, value) {
        if (openWhileReadOwned === undefined && index === SLOT_BASE_I32 + C2W_READ && value !== 0) {
            assert.strictEqual(Atomics.load(view, SLOT_BASE_I32 + SLOT_RESERVATION), oldClaim);
            ring.slotRelease(sab, 0, slot);
            openWhileReadOwned = ring.slotOpen(sab, 0);
        }
        return originalStore(view, index, value);
    };
    const oldByte = Buffer.alloc(1);
    try {
        assert.strictEqual(ring.workerRead(sab, 0, slot, oldByte, 0, 1, oldClaim), 1);
    } finally {
        Atomics.store = originalStore;
    }
    assert.deepStrictEqual([...oldByte], [17]);
    assert.strictEqual(openWhileReadOwned, -1, 'opener cannot reset an in-flight read');

    assert.strictEqual(ring.slotOpen(sab, 0), slot);
    const newClaim = Atomics.load(i32, SLOT_BASE_I32 + SLOT_STATE);
    assert.strictEqual(Atomics.load(i32, SLOT_BASE_I32 + C2W_WRITE), 0);
    assert.strictEqual(Atomics.load(i32, SLOT_BASE_I32 + C2W_READ), 0);
    ring.stubWrite(sab, 0, slot, Buffer.from([23]), 0, 1);
    const stale = Buffer.from([0xff]);
    assert.strictEqual(ring.workerRead(sab, 0, slot, stale, 0, 1, oldClaim), 0);
    assert.deepStrictEqual([...stale], [0xff]);
    assert.strictEqual(Atomics.load(i32, SLOT_BASE_I32 + C2W_READ), 0);
    const fresh = Buffer.alloc(1);
    assert.strictEqual(ring.workerRead(sab, 0, slot, fresh, 0, 1, newClaim), 1);
    assert.deepStrictEqual([...fresh], [23]);
    ring.slotRelease(sab, 0, slot);
}

console.log('RESULT: PASS — SAB reservation publication and terminal snapshots');
