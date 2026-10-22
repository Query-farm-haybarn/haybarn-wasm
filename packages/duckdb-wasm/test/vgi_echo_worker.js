// Haybarn: a VGI worker for test/index_platform.ts. installVgiWebWorkerBridge spawns it for a `worker:` location
// and hands it the engine's shared memory and the channel region (vgi-init). It serves every slot claim with the ring
// model of lib/vgi-sab-ring.js, worker side: reads the request to its EOS and answers "echo:<request>". The request
// "fail" ends the claim with terminal transport error 7/9, and "hang" never answers (until the client releases the
// slot), for the interrupt test.
importScripts('/base/lib/vgi-sab-ring.js');

const STATE = 0;
const NAP = new Int32Array(new SharedArrayBuffer(4));

self.onmessage = event => {
    const message = event.data;
    if (!message || message.type !== 'vgi-init') return;
    const { buffer, offset } = message;
    self.postMessage({ type: 'vgi-ready' });
    setTimeout(() => serve(buffer, offset), 0);
};

function serve(buffer, base) {
    const i32 = new Int32Array(buffer);
    const hdr = header(buffer, base);
    const stateIndex = slot => (base + hdr.slotsOff + slot * hdr.slotStride) / 4 + STATE;
    const served = new Array(hdr.nSlots).fill(0);
    for (;;) {
        let busy = false;
        for (let slot = 0; slot < hdr.nSlots; slot++) {
            const claim = Atomics.load(i32, stateIndex(slot));
            if (claim === 0 || claim === served[slot]) continue;
            served[slot] = claim;
            busy = true;
            answer(buffer, base, slot, claim, () => Atomics.load(i32, stateIndex(slot)) !== claim);
        }
        if (!busy) Atomics.wait(i32, stateIndex(0), Atomics.load(i32, stateIndex(0)), 1);
    }
}

function answer(buffer, base, slot, claim, released) {
    const chunks = [];
    const chunk = new Uint8Array(64);
    for (;;) {
        const n = workerRead(buffer, base, slot, chunk, 0, chunk.length, claim);
        if (n === 0) break;
        chunks.push(chunk.slice(0, n));
    }
    const request = new TextDecoder().decode(concat(chunks));
    if (request === 'fail') {
        workerCloseError(buffer, base, slot, 7, 9, claim);
        return;
    }
    if (request === 'hang') {
        while (!released()) Atomics.wait(NAP, 0, 0, 5);
        return;
    }
    const response = new TextEncoder().encode(`echo:${request}`);
    workerWrite(buffer, base, slot, response, 0, response.length, claim);
    workerCloseW2c(buffer, base, slot, claim);
}

function concat(chunks) {
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) {
        out.set(c, at);
        at += c.length;
    }
    return out;
}
