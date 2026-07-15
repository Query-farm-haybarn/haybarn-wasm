addToLibrary({
    duckdb_web_test_platform_feature__sig: 'ii',
    duckdb_web_test_platform_feature: function (feature) {
        return globalThis.DUCKDB_RUNTIME.testPlatformFeature(Module, feature);
    },
    duckdb_web_fs_get_default_data_protocol__sig: 'i',
    duckdb_web_fs_get_default_data_protocol: function (Module) {
        return globalThis.DUCKDB_RUNTIME.getDefaultDataProtocol(Module);
    },
    duckdb_web_fs_file_open__sig: 'pii',
    duckdb_web_fs_file_open: function (fileId, flags) {
        return globalThis.DUCKDB_RUNTIME.openFile(Module, fileId, flags);
    },
    duckdb_web_fs_file_sync__sig: 'vi',
    duckdb_web_fs_file_sync: function (fileId) {
        return globalThis.DUCKDB_RUNTIME.syncFile(Module, fileId);
    },
    duckdb_web_fs_file_drop_file__sig: 'vpi',
    duckdb_web_fs_file_drop_file: function (fileName, fileNameLen) {
        return globalThis.DUCKDB_RUNTIME.dropFile(Module, fileName, fileNameLen);
    },
    duckdb_web_fs_file_close__sig: 'vi',
    duckdb_web_fs_file_close: function (fileId) {
        return globalThis.DUCKDB_RUNTIME.closeFile(Module, fileId);
    },
    duckdb_web_fs_file_truncate__sig: 'vid',
    duckdb_web_fs_file_truncate: function (fileId, newSize) {
        return globalThis.DUCKDB_RUNTIME.truncateFile(Module, fileId, newSize);
    },
    duckdb_web_fs_file_read__sig: 'iipid',
    duckdb_web_fs_file_read: function (fileId, buf, size, location) {
        return globalThis.DUCKDB_RUNTIME.readFile(Module, fileId, buf, size, location);
    },
    duckdb_web_fs_file_write__sig: 'iipid',
    duckdb_web_fs_file_write: function (fileId, buf, size, location) {
        return globalThis.DUCKDB_RUNTIME.writeFile(Module, fileId, buf, size, location);
    },
    duckdb_web_fs_file_get_last_modified_time__sig: 'di',
    duckdb_web_fs_file_get_last_modified_time: function (fileId) {
        return globalThis.DUCKDB_RUNTIME.getLastFileModificationTime(Module, fileId);
    },
    duckdb_web_fs_directory_exists__sig: 'ipi',
    duckdb_web_fs_directory_exists: function (path, pathLen) {
        return globalThis.DUCKDB_RUNTIME.checkDirectory(Module, path, pathLen);
    },
    duckdb_web_fs_directory_create__sig: 'vpi',
    duckdb_web_fs_directory_create: function (path, pathLen) {
        return globalThis.DUCKDB_RUNTIME.createDirectory(Module, path, pathLen);
    },
    duckdb_web_fs_directory_remove__sig: 'vpi',
    duckdb_web_fs_directory_remove: function (path, pathLen) {
        return globalThis.DUCKDB_RUNTIME.removeDirectory(Module, path, pathLen);
    },
    duckdb_web_fs_directory_list_files__sig: 'ipi',
    duckdb_web_fs_directory_list_files: function (path, pathLen) {
        return globalThis.DUCKDB_RUNTIME.listDirectoryEntries(Module, path, pathLen);
    },
    duckdb_web_fs_glob__sig: 'vpi',
    duckdb_web_fs_glob: function (path, pathLen) {
        return globalThis.DUCKDB_RUNTIME.glob(Module, path, pathLen);
    },
    duckdb_web_fs_file_move__sig: 'vpipi',
    duckdb_web_fs_file_move: function (from, fromLen, to, toLen) {
        return globalThis.DUCKDB_RUNTIME.moveFile(Module, from, fromLen, to, toLen);
    },
    duckdb_web_fs_file_exists__sig: 'ipi',
    duckdb_web_fs_file_exists: function (path, pathLen) {
        return globalThis.DUCKDB_RUNTIME.checkFile(Module, path, pathLen);
    },
    duckdb_web_fs_file_remove: function (path, pathLen) {
        return globalThis.DUCKDB_RUNTIME.removeFile(Module, path, pathLen);
    },
    duckdb_web_udf_scalar_call__sig: 'vpipipi',
    duckdb_web_udf_scalar_call: function (funcId, descPtr, descSize, ptrsPtr, ptrsSize, response) {
        return globalThis.DUCKDB_RUNTIME.callScalarUDF(Module, funcId, descPtr, descSize, ptrsPtr, ptrsSize, response);
    },
    // Open an OAuth authorization URL on the main thread (popup window) and
    // block this Worker on a SharedArrayBuffer until the auth code comes back.
    // Returns malloc'd auth-code string on success or 0 on failure / timeout
    // (the C caller owns it and must free).
    //
    // Externally-provided globals (must be initialized by the Worker bootstrap
    // BEFORE any extension calls this — see the TypeScript wrapper that wires
    // up the SAB before importScripts/Module load):
    //   oauthSAB     — SharedArrayBuffer of at least 8 + maxPayloadLen bytes
    //   oauthInt32   — new Int32Array(oauthSAB)   (Atomics view)
    //   oauthBytes   — new Uint8Array(oauthSAB)   (byte view)
    //
    // SAB layout: [flag:Int32][dataLen:Int32][data:UTF-8...]
    //   flag == 0  — waiting (initial)
    //   flag == 1  — auth code ready in data
    //   flag == -1 — error string in data
    //
    // Caller flow:
    //   1. Worker resets flag to 0, postMessage({type:'open-auth-url', url}).
    //   2. Main thread opens popup, listens for postMessage / BroadcastChannel
    //      from the redirect target, writes code/error into SAB, Atomics.store
    //      flag to 1 or -1, Atomics.notify(oauthInt32, 0).
    //   3. Worker resumes here, copies bytes out, returns.
    duckdb_wasm_open_auth_url__sig: 'pii',
    duckdb_wasm_open_auth_url: function (url_ptr, timeout_ms) {
        var url = UTF8ToString(url_ptr);
        if (typeof oauthInt32 === 'undefined' || !oauthInt32) return 0;
        Atomics.store(oauthInt32, 0, 0);
        postMessage({ type: 'open-auth-url', url: url });
        // 2s polling intervals give main thread a chance to signal popup-closed
        // via flag = -1 even if no message ever arrives.
        var elapsed = 0;
        var interval = 2000;
        while (Atomics.load(oauthInt32, 0) === 0) {
            var result = Atomics.wait(oauthInt32, 0, 0, interval);
            if (result === 'timed-out') {
                elapsed += interval;
                if (timeout_ms > 0 && elapsed >= timeout_ms) {
                    globalThis._duckdb_wasm_auth_error = 'Authentication timed out';
                    return 0;
                }
            }
        }
        var flag = Atomics.load(oauthInt32, 0);
        var dv = new DataView(oauthSAB);
        var len = dv.getInt32(4, true);
        if (len <= 0) return 0;
        if (flag === -1) {
            globalThis._duckdb_wasm_auth_error = '';
            for (var i = 0; i < len; i++) {
                globalThis._duckdb_wasm_auth_error += String.fromCharCode(oauthBytes[8 + i]);
            }
            return 0;
        }
        var buf = _malloc(len + 1);
        if (buf === 0) return 0;
        for (var i = 0; i < len; i++) Module.HEAPU8[buf + i] = oauthBytes[8 + i];
        Module.HEAPU8[buf + len] = 0;
        return buf;
    },
    // Retrieve the most recent OAuth error string set by open_auth_url failures
    // (timeout, popup-closed, server-rejected). Returns malloc'd string or 0;
    // caller frees. `unused` arg lets the C signature match other char*-returning
    // stubs whose macro generators expect at least one parameter.
    duckdb_wasm_get_auth_error__sig: 'pi',
    duckdb_wasm_get_auth_error: function (unused) {
        var err = globalThis._duckdb_wasm_auth_error || '';
        if (!err) return 0;
        var len = lengthBytesUTF8(err) + 1;
        var buf = _malloc(len);
        if (buf === 0) return 0;
        stringToUTF8(err, buf, len);
        return buf;
    },
    // Return the page origin (e.g. "http://localhost:8765") so extensions can
    // build OAuth redirect URIs that match the deployment. Reads
    // globalThis._duckdb_page_origin first as an explicit override for blob:
    // URL Workers (which inherit a blob: origin from their parent); falls back
    // to self.location.origin. Returns malloc'd string or 0; caller frees.
    duckdb_wasm_get_page_origin__sig: 'p',
    duckdb_wasm_get_page_origin: function () {
        var origin = globalThis._duckdb_page_origin ||
                     (typeof self !== 'undefined' && self.location ? self.location.origin : '');
        if (!origin || origin === 'null' || origin.startsWith('blob:')) return 0;
        var len = lengthBytesUTF8(origin) + 1;
        var buf = _malloc(len);
        if (buf === 0) return 0;
        stringToUTF8(origin, buf, len);
        return buf;
    },
    // Cryptographically secure random bytes via Web Crypto. crypto.getRandomValues
    // rejects SharedArrayBuffer-backed views (rejected in the COI/threads build) —
    // fill a non-shared scratch buffer first and copy back.
    duckdb_wasm_crypto_random__sig: 'vpi',
    duckdb_wasm_crypto_random: function (buf, len) {
        var tmp = new Uint8Array(len);
        crypto.getRandomValues(tmp);
        Module.HEAPU8.set(tmp, buf);
    },
    // Override emscripten's busy-spin yield with Atomics.wait so Worker sleeps actually block.
    // Called by emscripten_thread_sleep() in a loop that checks elapsed time, so 100ms per
    // call is fine — outer loop handles the requested total. Affects all sleep paths in the
    // main module and side modules: std::this_thread::sleep_for, std::condition_variable::wait_for,
    // usleep, nanosleep. Atomics.wait throws on the main thread; we silently fall through to
    // the original no-op there.
    _emscripten_yield__sig: 'vd',
    _emscripten_yield: function (now) {
        if (typeof SharedArrayBuffer !== 'undefined') {
            try {
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
            } catch (e) {
                // main thread — fall through
            }
        }
    },

    // ========================================================================
    // VGI `worker:` SAB transport slot stubs. The duplex ring channel is a
    // malloc'd region in DuckDB's shared linear memory (decision #1); its byte
    // offset is pushed per-pthread by vgi_wasm_set_channel. Ring protocol
    // byte-exact to vgi/src/include/vgi_sab_abi.hpp; lib/vgi-sab-ring.js is the
    // Node-tested reference of the same math. `vgiSab` is an emscripten shared-
    // library helper (per-realm, so each pthread has its own `base`).
    // ========================================================================
    $vgiSab: {
        base: 0, // channel byte offset in linear memory (set by vgi_wasm_set_channel)
        // slot control i32 lanes (relative to the slot's control block)
        STATE: 0, C2W_W: 1, C2W_R: 2, C2W_CL: 3, W2C_W: 4, W2C_R: 5, W2C_CL: 6,
        CTRL_BYTES: 64,
        // The LIVE linear-memory buffer, NOT the cached Module.HEAPU8 view. On a pthread
        // that was mid-compute/blocked through a memory-growth event, emscripten's cached
        // Module.HEAP* views go stale (they alias an OLD buffer), so Atomics.load through
        // them never observes another thread's stores into the CURRENT buffer — the ring
        // read then sees avail=0 forever and hangs, even though the data is there (native
        // C++ pointers, which always use the live memory, see it fine). wasmMemory.buffer
        // is a live getter that returns the current buffer on every realm, so deriving the
        // typed-array views from it each op is stale-view-proof. Falls back to HEAPU8 if
        // wasmMemory isn't in scope.
        buf: function () {
            return (typeof wasmMemory !== 'undefined' && wasmMemory && wasmMemory.buffer)
                ? wasmMemory.buffer : Module.HEAPU8.buffer;
        },
        i32: function () { return new Int32Array(this.buf()); },
        u8: function () { return new Uint8Array(this.buf()); },
        hdr: function () {
            var i = this.i32(); var h = this.base >> 2;
            // header i32 lanes: [2]=n_slots [3]=ring_cap [4]=slot_stride [5]=slots_off
            return { nSlots: i[h + 2], ringCap: i[h + 3], slotStride: i[h + 4], slotsOff: i[h + 5] };
        },
        slotByte: function (hdr, slot) { return this.base + hdr.slotsOff + slot * hdr.slotStride; },
        // Blocking SPSC ring write of n bytes from linear-memory srcPtr into the
        // ring (control lanes writeLane/readLane at ctl, data at dataByte).
        ringWrite: function (ctl, writeLane, readLane, dataByte, ringCap, srcPtr, n) {
            var i = this.i32(); var u = this.u8(); var off = 0;
            while (off < n) {
                var w = Atomics.load(i, ctl + writeLane);
                var r = Atomics.load(i, ctl + readLane);
                var free = ringCap - (w - r);
                if (free === 0) { Atomics.wait(i, ctl + readLane, r, 250); continue; }
                var k = Math.min(free, n - off);
                var pos = w % ringCap;
                var first = Math.min(k, ringCap - pos);
                u.copyWithin(dataByte + pos, srcPtr + off, srcPtr + off + first);
                if (k > first) u.copyWithin(dataByte, srcPtr + off + first, srcPtr + off + k);
                Atomics.store(i, ctl + writeLane, w + k);
                Atomics.notify(i, ctl + writeLane);
                off += k;
            }
            return n;
        },
        // SPSC ring read of up to n bytes into linear-memory dstPtr. Returns bytes read
        // (>0), 0 on EOS (closed && drained), or -2 (WOULD_BLOCK) when the ring was empty
        // for one bounded (250ms) wait. It does NOT loop forever on empty: the C++ caller
        // (SabInputStream::Read) retries on -2 AFTER polling query cancellation, so a read
        // running as a DuckDB async prefetch task can be interrupted (else it would block
        // DuckDB's error/cancel busy-wait `while (executor_tasks > 0)` and freeze the whole
        // engine — the WASM analog of the subprocess WaitForReadableUntilCancel poll).
        ringRead: function (ctl, writeLane, readLane, closedLane, dataByte, ringCap, dstPtr, n) {
            var i = this.i32(); var u = this.u8();
            var w = Atomics.load(i, ctl + writeLane);
            var r = Atomics.load(i, ctl + readLane);
            var avail = w - r;
            if (avail === 0) {
                if (Atomics.load(i, ctl + closedLane) === 1) return 0; // EOS
                Atomics.wait(i, ctl + writeLane, w, 250);              // bounded wait
                w = Atomics.load(i, ctl + writeLane);
                avail = w - r;
                if (avail === 0) {
                    if (Atomics.load(i, ctl + closedLane) === 1) return 0; // EOS
                    return -2; // WOULD_BLOCK — caller polls cancellation, then retries
                }
            }
            var k = Math.min(avail, n);
            var pos = r % ringCap;
            var first = Math.min(k, ringCap - pos);
            u.copyWithin(dstPtr, dataByte + pos, dataByte + pos + first);
            if (k > first) u.copyWithin(dstPtr + first, dataByte, dataByte + k - first);
            Atomics.store(i, ctl + readLane, r + k);
            Atomics.notify(i, ctl + readLane);
            return k;
        },
    },
    // Push the channel offset onto this pthread's runtime (C++ reads it from a
    // shared linear-memory global and calls this per connection).
    vgi_wasm_set_channel__deps: ['$vgiSab'],
    vgi_wasm_set_channel: function (offset) { vgiSab.base = offset; },
    // Ensure the VGI Web Worker for `location` exists and is serving the channel.
    // Main-thread-proxied spawn (the OAuth pattern): postMessage a spawn request
    // up to the page's vgi-webworker-bridge with (location, channel byte offset,
    // DuckDB's shared linear memory buffer), then block on a ready-SAB until the
    // bridge reports the worker booted + is serving. Idempotent per (realm,
    // location): the first caller spawns, later callers no-op. Returns 0 ok, -1
    // on spawn/boot failure. `HEAPU8.buffer` under -pthread IS the shared
    // SharedArrayBuffer the channel was malloc'd into (decision #1), so handing it
    // to the worker gives it a view over the exact same memory + channel offset.
    vgi_wasm_ensure_worker__deps: ['$vgiSab'],
    vgi_wasm_ensure_worker: function (locationPtr) {
        var location = UTF8ToString(locationPtr);
        // Process-global dedup via a shared channel flag (header lane 7): once the
        // worker is up, every realm — including engine scan-pthreads, whose
        // postMessage may not reach the page bridge — returns immediately WITHOUT a
        // spawn request. The first caller (typically the main thread, whose
        // postMessage does reach the bridge) spawns it and publishes the flag.
        var chan = vgiSab.i32();
        var readyLane = (vgiSab.base >> 2) + 7;
        if (Atomics.load(chan, readyLane) === 1) return 0;
        globalThis.__vgiEnsured = globalThis.__vgiEnsured || {};
        if (globalThis.__vgiEnsured[location]) return 0;
        if (typeof SharedArrayBuffer === 'undefined') return -1;
        var readySab = new SharedArrayBuffer(8);
        var readyI32 = new Int32Array(readySab);
        postMessage({
            type: 'vgi-ensure-worker',
            location: location,
            offset: vgiSab.base,
            buffer: vgiSab.buf(), // live memory buffer (see $vgiSab.buf) — hand the worker the CURRENT SAB
            readySab: readySab,
        });
        // 0 = pending, 1 = ready, -1 = error. Poll with a bounded wait so a hung
        // bridge/worker can't wedge the thread forever (mirrors the OAuth stub).
        var waited = 0;
        while (Atomics.load(readyI32, 0) === 0) {
            Atomics.wait(readyI32, 0, 0, 1000);
            waited += 1000;
            if (waited >= 30000) return -1; // 30s boot timeout
        }
        if (Atomics.load(readyI32, 0) === 1) {
            globalThis.__vgiEnsured[location] = true;
            Atomics.store(chan, readyLane, 1); // publish to other realms/pthreads
            return 0;
        }
        return -1;
    },
    vgi_wasm_slot_open__deps: ['$vgiSab'],
    vgi_wasm_slot_open: function (locationPtr) {
        var i = vgiSab.i32(); var hdr = vgiSab.hdr();
        // A UNIQUE nonzero claim id (not a constant 1) so the worker dispatcher can
        // distinguish "still serving my claim" from "already reclaimed by the next
        // scan" — STATE id->0->newid must not read as an un-released claim (the ABA
        // that wedged the errored-slot handoff). Global monotonic counter in header
        // lane 8; guard the once-per-4-billion wrap to 0 (0 = free).
        var claimSeqLane = (vgiSab.base >> 2) + 8;
        var id = (Atomics.add(i, claimSeqLane, 1) + 1) | 0;
        if (id === 0) id = 1;
        for (var s = 0; s < hdr.nSlots; s++) {
            var sb = vgiSab.slotByte(hdr, s) >> 2;
            if (Atomics.compareExchange(i, sb + vgiSab.STATE, 0, id) === 0) {
                // Reset both rings (Atomics.store so the worker sees the zeros after
                // the notify's happens-before, before it starts serving).
                Atomics.store(i, sb + vgiSab.C2W_W, 0); Atomics.store(i, sb + vgiSab.C2W_R, 0);
                Atomics.store(i, sb + vgiSab.C2W_CL, 0);
                Atomics.store(i, sb + vgiSab.W2C_W, 0); Atomics.store(i, sb + vgiSab.W2C_R, 0);
                Atomics.store(i, sb + vgiSab.W2C_CL, 0);
                // Wake the worker dispatcher parked on this slot's STATE lane (a bare
                // compareExchange doesn't notify, so without this the dispatcher only
                // wakes on its safety-poll timeout).
                Atomics.notify(i, sb + vgiSab.STATE);
                return s;
            }
        }
        return -1;
    },
    vgi_wasm_slot_write__deps: ['$vgiSab'],
    vgi_wasm_slot_write: function (slot, dataPtr, n) {
        var hdr = vgiSab.hdr(); var sb = vgiSab.slotByte(hdr, slot);
        return vgiSab.ringWrite(sb >> 2, vgiSab.C2W_W, vgiSab.C2W_R, sb + vgiSab.CTRL_BYTES, hdr.ringCap, dataPtr, n);
    },
    vgi_wasm_slot_write_eos__deps: ['$vgiSab'],
    vgi_wasm_slot_write_eos: function (slot) {
        var i = vgiSab.i32(); var hdr = vgiSab.hdr(); var sb = vgiSab.slotByte(hdr, slot) >> 2;
        Atomics.store(i, sb + vgiSab.C2W_CL, 1); Atomics.notify(i, sb + vgiSab.C2W_W);
    },
    vgi_wasm_slot_read__deps: ['$vgiSab'],
    vgi_wasm_slot_read: function (slot, dataPtr, n) {
        var hdr = vgiSab.hdr(); var sb = vgiSab.slotByte(hdr, slot);
        return vgiSab.ringRead(sb >> 2, vgiSab.W2C_W, vgiSab.W2C_R, vgiSab.W2C_CL,
            sb + vgiSab.CTRL_BYTES + hdr.ringCap, hdr.ringCap, dataPtr, n);
    },
    vgi_wasm_slot_release__deps: ['$vgiSab'],
    vgi_wasm_slot_release: function (slot) {
        var i = vgiSab.i32(); var hdr = vgiSab.hdr();
        var sb = vgiSab.slotByte(hdr, slot) >> 2;
        Atomics.store(i, sb + vgiSab.STATE, 0);
        // Wake the dispatcher waiting for this slot's release (STATE 1 -> 0).
        Atomics.notify(i, sb + vgiSab.STATE);
    },
});
