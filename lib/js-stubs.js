// A JavaScript error in a runtime call becomes a C++ exception (duckdb_web_fail_with throws one): it then unwinds
// on the C++ side, and with threads it reaches the thread that made the call. A C++ exception passing through
// (a WebAssembly.Exception) is left alone. Emscripten matches the parameter lists against the signatures, so the
// guard is written out in every stub.
addToLibrary({
    duckdb_web_test_platform_feature__sig: 'ii',
    duckdb_web_test_platform_feature: function (feature) {
        try {
            return globalThis.DUCKDB_RUNTIME.testPlatformFeature(Module, feature);
        } catch (e) {
            if (typeof WebAssembly !== 'undefined' && e instanceof WebAssembly.Exception) throw e;
            Module.ccall('duckdb_web_fail_with', null, ['string'], [String((e && e.message) || e)]);
        }
    },
    duckdb_web_fs_get_default_data_protocol__sig: 'i',
    duckdb_web_fs_get_default_data_protocol: function (Module) {
        try {
            return globalThis.DUCKDB_RUNTIME.getDefaultDataProtocol(Module);
        } catch (e) {
            if (typeof WebAssembly !== 'undefined' && e instanceof WebAssembly.Exception) throw e;
            Module.ccall('duckdb_web_fail_with', null, ['string'], [String((e && e.message) || e)]);
        }
    },
    duckdb_web_fs_file_open__sig: 'pii',
    duckdb_web_fs_file_open: function (fileId, flags) {
        try {
            return globalThis.DUCKDB_RUNTIME.openFile(Module, fileId, flags);
        } catch (e) {
            if (typeof WebAssembly !== 'undefined' && e instanceof WebAssembly.Exception) throw e;
            Module.ccall('duckdb_web_fail_with', null, ['string'], [String((e && e.message) || e)]);
        }
    },
    duckdb_web_fs_file_sync__sig: 'vi',
    duckdb_web_fs_file_sync: function (fileId) {
        try {
            return globalThis.DUCKDB_RUNTIME.syncFile(Module, fileId);
        } catch (e) {
            if (typeof WebAssembly !== 'undefined' && e instanceof WebAssembly.Exception) throw e;
            Module.ccall('duckdb_web_fail_with', null, ['string'], [String((e && e.message) || e)]);
        }
    },
    duckdb_web_fs_file_drop_file__sig: 'vpi',
    duckdb_web_fs_file_drop_file: function (fileName, fileNameLen) {
        try {
            fileName = fileName >>> 0;
            return globalThis.DUCKDB_RUNTIME.dropFile(Module, fileName, fileNameLen);
        } catch (e) {
            if (typeof WebAssembly !== 'undefined' && e instanceof WebAssembly.Exception) throw e;
            Module.ccall('duckdb_web_fail_with', null, ['string'], [String((e && e.message) || e)]);
        }
    },
    duckdb_web_fs_file_close__sig: 'vi',
    duckdb_web_fs_file_close: function (fileId) {
        try {
            return globalThis.DUCKDB_RUNTIME.closeFile(Module, fileId);
        } catch (e) {
            if (typeof WebAssembly !== 'undefined' && e instanceof WebAssembly.Exception) throw e;
            Module.ccall('duckdb_web_fail_with', null, ['string'], [String((e && e.message) || e)]);
        }
    },
    duckdb_web_fs_file_truncate__sig: 'vid',
    duckdb_web_fs_file_truncate: function (fileId, newSize) {
        try {
            return globalThis.DUCKDB_RUNTIME.truncateFile(Module, fileId, newSize);
        } catch (e) {
            if (typeof WebAssembly !== 'undefined' && e instanceof WebAssembly.Exception) throw e;
            Module.ccall('duckdb_web_fail_with', null, ['string'], [String((e && e.message) || e)]);
        }
    },
    duckdb_web_fs_file_read__sig: 'iipid',
    duckdb_web_fs_file_read: function (fileId, buf, size, location) {
        try {
            buf = buf >>> 0;
            return globalThis.DUCKDB_RUNTIME.readFile(Module, fileId, buf, size, location);
        } catch (e) {
            if (typeof WebAssembly !== 'undefined' && e instanceof WebAssembly.Exception) throw e;
            Module.ccall('duckdb_web_fail_with', null, ['string'], [String((e && e.message) || e)]);
        }
    },
    duckdb_web_fs_file_write__sig: 'iipid',
    duckdb_web_fs_file_write: function (fileId, buf, size, location) {
        try {
            buf = buf >>> 0;
            return globalThis.DUCKDB_RUNTIME.writeFile(Module, fileId, buf, size, location);
        } catch (e) {
            if (typeof WebAssembly !== 'undefined' && e instanceof WebAssembly.Exception) throw e;
            Module.ccall('duckdb_web_fail_with', null, ['string'], [String((e && e.message) || e)]);
        }
    },
    duckdb_web_fs_file_get_last_modified_time__sig: 'di',
    duckdb_web_fs_file_get_last_modified_time: function (fileId) {
        try {
            return globalThis.DUCKDB_RUNTIME.getLastFileModificationTime(Module, fileId);
        } catch (e) {
            if (typeof WebAssembly !== 'undefined' && e instanceof WebAssembly.Exception) throw e;
            Module.ccall('duckdb_web_fail_with', null, ['string'], [String((e && e.message) || e)]);
        }
    },
    duckdb_web_fs_directory_exists__sig: 'ipi',
    duckdb_web_fs_directory_exists: function (path, pathLen) {
        try {
            path = path >>> 0;
            return globalThis.DUCKDB_RUNTIME.checkDirectory(Module, path, pathLen);
        } catch (e) {
            if (typeof WebAssembly !== 'undefined' && e instanceof WebAssembly.Exception) throw e;
            Module.ccall('duckdb_web_fail_with', null, ['string'], [String((e && e.message) || e)]);
        }
    },
    duckdb_web_fs_directory_create__sig: 'vpi',
    duckdb_web_fs_directory_create: function (path, pathLen) {
        try {
            path = path >>> 0;
            return globalThis.DUCKDB_RUNTIME.createDirectory(Module, path, pathLen);
        } catch (e) {
            if (typeof WebAssembly !== 'undefined' && e instanceof WebAssembly.Exception) throw e;
            Module.ccall('duckdb_web_fail_with', null, ['string'], [String((e && e.message) || e)]);
        }
    },
    duckdb_web_fs_directory_remove__sig: 'vpi',
    duckdb_web_fs_directory_remove: function (path, pathLen) {
        try {
            path = path >>> 0;
            return globalThis.DUCKDB_RUNTIME.removeDirectory(Module, path, pathLen);
        } catch (e) {
            if (typeof WebAssembly !== 'undefined' && e instanceof WebAssembly.Exception) throw e;
            Module.ccall('duckdb_web_fail_with', null, ['string'], [String((e && e.message) || e)]);
        }
    },
    duckdb_web_fs_directory_list_files__sig: 'ipi',
    duckdb_web_fs_directory_list_files: function (path, pathLen) {
        try {
            path = path >>> 0;
            return globalThis.DUCKDB_RUNTIME.listDirectoryEntries(Module, path, pathLen);
        } catch (e) {
            if (typeof WebAssembly !== 'undefined' && e instanceof WebAssembly.Exception) throw e;
            Module.ccall('duckdb_web_fail_with', null, ['string'], [String((e && e.message) || e)]);
        }
    },
    duckdb_web_fs_glob__sig: 'vpi',
    duckdb_web_fs_glob: function (path, pathLen) {
        try {
            path = path >>> 0;
            return globalThis.DUCKDB_RUNTIME.glob(Module, path, pathLen);
        } catch (e) {
            if (typeof WebAssembly !== 'undefined' && e instanceof WebAssembly.Exception) throw e;
            Module.ccall('duckdb_web_fail_with', null, ['string'], [String((e && e.message) || e)]);
        }
    },
    duckdb_web_fs_file_move__sig: 'vpipi',
    duckdb_web_fs_file_move: function (from, fromLen, to, toLen) {
        try {
            from = from >>> 0; to = to >>> 0;
            return globalThis.DUCKDB_RUNTIME.moveFile(Module, from, fromLen, to, toLen);
        } catch (e) {
            if (typeof WebAssembly !== 'undefined' && e instanceof WebAssembly.Exception) throw e;
            Module.ccall('duckdb_web_fail_with', null, ['string'], [String((e && e.message) || e)]);
        }
    },
    duckdb_web_fs_file_exists__sig: 'ipi',
    duckdb_web_fs_file_exists: function (path, pathLen) {
        try {
            path = path >>> 0;
            return globalThis.DUCKDB_RUNTIME.checkFile(Module, path, pathLen);
        } catch (e) {
            if (typeof WebAssembly !== 'undefined' && e instanceof WebAssembly.Exception) throw e;
            Module.ccall('duckdb_web_fail_with', null, ['string'], [String((e && e.message) || e)]);
        }
    },
    duckdb_web_fs_file_remove__sig: 'vpi',
    duckdb_web_fs_file_remove: function (path, pathLen) {
        try {
            path = path >>> 0;
            return globalThis.DUCKDB_RUNTIME.removeFile(Module, path, pathLen);
        } catch (e) {
            if (typeof WebAssembly !== 'undefined' && e instanceof WebAssembly.Exception) throw e;
            Module.ccall('duckdb_web_fail_with', null, ['string'], [String((e && e.message) || e)]);
        }
    },
    duckdb_web_udf_scalar_call__sig: 'vpipipi',
    duckdb_web_udf_scalar_call: function (response, funcId, descPtr, descSize, ptrsPtr, ptrsSize) {
        try {
            response = response >>> 0; descPtr = descPtr >>> 0; ptrsPtr = ptrsPtr >>> 0;
            return globalThis.DUCKDB_RUNTIME.callScalarUDF(Module, response, funcId, descPtr, descSize, ptrsPtr, ptrsSize);
        } catch (e) {
            if (typeof WebAssembly !== 'undefined' && e instanceof WebAssembly.Exception) throw e;
            Module.ccall('duckdb_web_fail_with', null, ['string'], [String((e && e.message) || e)]);
        }
    },

    // ========================================================================
    // Haybarn platform stubs for extensions (side modules cannot define their own EM_JS). The C entry points are in
    // src/platform_stubs.cc: the ones below that read the worker's globals or post to the page run on the main runtime
    // thread, where the page's messages arrive, so platform_stubs.cc proxies them there from a pthread. These are the
    // *_js halves. Every returned string is malloc'd, the caller frees it. Pointers are unsigned (`>>> 0`).
    // ========================================================================

    // Open an OAuth authorization URL in a popup on the page and wait for the authorization code. Returns the code,
    // or 0 on failure or timeout (the reason is in duckdb_wasm_get_auth_error). The page's installVgiOAuthBridge
    // hands the worker a SharedArrayBuffer first (`init-oauth-sab`, handled in the worker's entry point), laid out as
    // [flag:Int32][dataLen:Int32][data:UTF-8...]: flag 0 waiting, 1 code in data, -1 error string in data. We post
    // {type: 'open-auth-url', url} and wait on the flag in 2 s steps, so a timeout is noticed even if no answer comes.
    duckdb_wasm_open_auth_url_js__deps: ['$UTF8ToString', 'malloc'],
    duckdb_wasm_open_auth_url_js__sig: 'ppi',
    duckdb_wasm_open_auth_url_js: function (url_ptr, timeout_ms) {
        var url = UTF8ToString(url_ptr >>> 0);
        var sab = globalThis.oauthSAB;
        if (!sab) {
            globalThis._duckdb_wasm_auth_error = 'OAuth is not available: the page did not install the OAuth bridge';
            return 0;
        }
        var flags = new Int32Array(sab);
        var bytes = new Uint8Array(sab);
        Atomics.store(flags, 0, 0);
        postMessage({ type: 'open-auth-url', url: url });
        var elapsed = 0;
        var interval = 2000;
        while (Atomics.load(flags, 0) === 0) {
            if (Atomics.wait(flags, 0, 0, interval) === 'timed-out') {
                elapsed += interval;
                if (timeout_ms > 0 && elapsed >= timeout_ms) {
                    globalThis._duckdb_wasm_auth_error = 'Authentication timed out';
                    return 0;
                }
            }
        }
        var flag = Atomics.load(flags, 0);
        var len = new DataView(sab).getInt32(4, true);
        if (len <= 0) return 0;
        if (flag === -1) {
            globalThis._duckdb_wasm_auth_error = new TextDecoder().decode(bytes.slice(8, 8 + len));
            return 0;
        }
        var buf = _malloc(len + 1) >>> 0;
        if (buf === 0) return 0;
        var heap = new Uint8Array(wasmMemory.buffer);
        heap.set(bytes.subarray(8, 8 + len), buf);
        heap[buf + len] = 0;
        return buf;
    },
    // The last error of duckdb_wasm_open_auth_url (timeout, popup blocked or closed, refused by the server), or 0.
    // `unused` keeps the signature of 1.5.
    duckdb_wasm_get_auth_error_js__deps: ['$lengthBytesUTF8', '$stringToUTF8', 'malloc'],
    duckdb_wasm_get_auth_error_js__sig: 'pi',
    duckdb_wasm_get_auth_error_js: function (unused) {
        var err = globalThis._duckdb_wasm_auth_error || '';
        if (!err) return 0;
        var len = lengthBytesUTF8(err) + 1;
        var buf = _malloc(len) >>> 0;
        if (buf === 0) return 0;
        stringToUTF8(err, buf, len);
        return buf;
    },
    // The page origin (e.g. "https://shell.example.com") for OAuth redirect URIs. globalThis._duckdb_page_origin
    // overrides it for workers started from a blob: URL, whose own origin is the blob's. Returns 0 for a blob: or
    // opaque ("null") origin, so the caller fails instead of building a redirect URI no server accepts.
    duckdb_wasm_get_page_origin_js__deps: ['$lengthBytesUTF8', '$stringToUTF8', 'malloc'],
    duckdb_wasm_get_page_origin_js__sig: 'p',
    duckdb_wasm_get_page_origin_js: function () {
        var origin =
            globalThis._duckdb_page_origin || (typeof self !== 'undefined' && self.location ? self.location.origin : '');
        if (!origin || origin === 'null' || origin.startsWith('blob:')) return 0;
        var len = lengthBytesUTF8(origin) + 1;
        var buf = _malloc(len) >>> 0;
        if (buf === 0) return 0;
        stringToUTF8(origin, buf, len);
        return buf;
    },
    // Cryptographically secure random bytes, on any thread. crypto.getRandomValues rejects views of a
    // SharedArrayBuffer (the threads bundle's memory) and more than 65536 bytes per call, so it fills a private
    // buffer in chunks, which is copied into the live memory (a pthread's cached heap view can predate a growth).
    duckdb_wasm_crypto_random__sig: 'vpi',
    duckdb_wasm_crypto_random: function (buf, len) {
        buf = buf >>> 0;
        var tmp = new Uint8Array(len);
        for (var off = 0; off < len; off += 65536) {
            crypto.getRandomValues(tmp.subarray(off, Math.min(off + 65536, len)));
        }
        new Uint8Array(wasmMemory.buffer).set(tmp, buf);
    },

    // ========================================================================
    // VGI `worker:` SAB transport (vgi's src/include/vgi_sab_abi.hpp, byte-exact; lib/vgi-sab-ring.js is the
    // Node-tested reference of the same ring math). A channel region is malloc'd in DuckDB's shared linear memory, so
    // only the threads bundle can use it; every operation carries its byte offset. The ring operations are pure Atomics
    // on the live memory and run on whatever thread calls them. Offsets and pointers are unsigned (`>>> 0`, `>>> 2`):
    // memory can grow past 2 GiB.
    // ========================================================================
    $vgiSab: {
        base: 0, // channel byte offset (vgi_wasm_set_channel, kept for ABI-v1 worker modules)
        // header lanes / feature bits
        HDR_FEATURES: 6,
        HDR_READY: 7,
        HDR_CLAIM_SEQ: 8,
        FEATURE_TERMINAL_ERROR: 1,
        // slot control i32 lanes (relative to the slot's control block)
        STATE: 0,
        C2W_W: 1,
        C2W_R: 2,
        C2W_CL: 3,
        W2C_W: 4,
        W2C_R: 5,
        W2C_CL: 6,
        TERMINAL_CLAIM: 7,
        TERMINAL_CODE: 8,
        TERMINAL_DETAIL: 9,
        // Client-only slot-open lock. STATE stays zero while the winner resets the slot and gets the claim id only
        // once the reset is complete, so a worker never observes a half-reset claim.
        RESERVATION: 10,
        CTRL_BYTES: 64,
        // Views of the LIVE memory, never a cached HEAP* view: on a pthread that was busy through a memory growth the
        // cached views alias the old buffer, and Atomics on them never see the other side's stores.
        buf: function () {
            return wasmMemory.buffer;
        },
        i32: function () {
            return new Int32Array(wasmMemory.buffer);
        },
        u8: function () {
            return new Uint8Array(wasmMemory.buffer);
        },
        hdr: function (base) {
            var i = this.i32();
            var h = base >>> 2;
            // header i32 lanes: [2]=n_slots [3]=ring_cap [4]=slot_stride [5]=slots_off
            return { nSlots: i[h + 2], ringCap: i[h + 3], slotStride: i[h + 4], slotsOff: i[h + 5] };
        },
        slotByte: function (base, hdr, slot) {
            return base + hdr.slotsOff + slot * hdr.slotStride;
        },
        // Blocking SPSC ring write of n bytes from linear-memory srcPtr (control lanes writeLane/readLane at the i32
        // index ctl, data at dataByte)
        ringWrite: function (ctl, writeLane, readLane, dataByte, ringCap, srcPtr, n) {
            var i = this.i32();
            var u = this.u8();
            var off = 0;
            while (off < n) {
                var w = Atomics.load(i, ctl + writeLane);
                var r = Atomics.load(i, ctl + readLane);
                var free = ringCap - (w - r);
                if (free === 0) {
                    Atomics.wait(i, ctl + readLane, r, 250);
                    continue;
                }
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
        // SPSC ring read of up to n bytes into linear-memory dstPtr. Returns the bytes read (> 0), 0 on EOS (closed
        // and drained), or -2 (WOULD_BLOCK) after one bounded (250 ms) wait on an empty ring: the C++ caller polls the
        // query's interrupt and retries, so a read running as a DuckDB task can be cancelled.
        ringRead: function (ctl, writeLane, readLane, closedLane, dataByte, ringCap, dstPtr, n) {
            var i = this.i32();
            var u = this.u8();
            // EOS only if the worker closed w2c for THIS claim: W2C_CLOSED holds the closing worker's claim id, so the
            // late close of a stale worker (previous claim of a reclaimed slot) doesn't end the new claim
            var isEos = function () {
                var cl = Atomics.load(i, ctl + closedLane);
                return cl !== 0 && cl === Atomics.load(i, ctl); // ctl + 0 = STATE, our claim
            };
            // EOS only once the ring is drained AFTER the close was seen: the writer publishes its last bytes, then
            // closes, so a close observed after an empty read of the write position may follow bytes written since.
            // Reading the position again after the close sees them (Atomics are sequentially consistent).
            var drainedAtEos = function () {
                return isEos() && Atomics.load(i, ctl + writeLane) === r;
            };
            var r = Atomics.load(i, ctl + readLane);
            var w = Atomics.load(i, ctl + writeLane);
            if (w === r) {
                if (drainedAtEos()) return 0;
                w = Atomics.load(i, ctl + writeLane);
                if (w === r) {
                    Atomics.wait(i, ctl + writeLane, w, 250);
                    w = Atomics.load(i, ctl + writeLane);
                    if (w === r) {
                        if (drainedAtEos()) return 0;
                        w = Atomics.load(i, ctl + writeLane);
                        if (w === r) return -2;
                    }
                }
            }
            var avail = w - r;
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
    vgi_wasm_set_channel__deps: ['$vgiSab'],
    vgi_wasm_set_channel__sig: 'vi',
    vgi_wasm_set_channel: function (offset) {
        vgiSab.base = offset >>> 0;
    },
    // The JavaScript half of vgi_wasm_ensure_worker (src/platform_stubs.cc runs it on the main runtime thread): make
    // sure the VGI Web Worker for `location` runs and serves the channel region. Posts {type: 'vgi-ensure-worker',
    // location, offset, buffer, readySab} to the page's installVgiWebWorkerBridge and waits on readySab until the bridge
    // reports the worker up (1) or failed (-1), for at most 30 s. `buffer` is the live shared memory the region was
    // malloc'd in, so the worker sees the same region. Once a region's worker is up, header lane 7 says so and later
    // calls return at once. Returns 0 or -1.
    vgi_wasm_ensure_worker_js__deps: ['$vgiSab', '$UTF8ToString'],
    vgi_wasm_ensure_worker_js__sig: 'ipi',
    vgi_wasm_ensure_worker_js: function (locationPtr, regionOffset) {
        regionOffset = regionOffset >>> 0;
        var location = UTF8ToString(locationPtr >>> 0);
        var chan = vgiSab.i32();
        var readyLane = (regionOffset >>> 2) + vgiSab.HDR_READY;
        if (Atomics.load(chan, readyLane) === 1) return 0;
        if (typeof SharedArrayBuffer === 'undefined' || !(vgiSab.buf() instanceof SharedArrayBuffer)) return -1;
        var readySab = new SharedArrayBuffer(8);
        var readyI32 = new Int32Array(readySab);
        postMessage({
            type: 'vgi-ensure-worker',
            location: location,
            offset: regionOffset,
            buffer: vgiSab.buf(),
            readySab: readySab,
        });
        // 0 = pending, 1 = ready, -1 = error
        var waited = 0;
        while (Atomics.load(readyI32, 0) === 0) {
            Atomics.wait(readyI32, 0, 0, 1000);
            waited += 1000;
            if (waited >= 30000) return -1;
        }
        if (Atomics.load(readyI32, 0) === 1) {
            Atomics.store(chan, readyLane, 1);
            return 0;
        }
        return -1;
    },
    vgi_wasm_slot_open__deps: ['$vgiSab'],
    vgi_wasm_slot_open__sig: 'ipi',
    vgi_wasm_slot_open: function (locationPtr, regionOffset) {
        regionOffset = regionOffset >>> 0;
        var i = vgiSab.i32();
        var hdr = vgiSab.hdr(regionOffset);
        // A UNIQUE nonzero claim id (the global counter in header lane 8), so the worker dispatcher can tell "still my
        // claim" from "reclaimed by the next scan": STATE id -> 0 -> id would be an ABA. 0 means free.
        var claimSeqLane = (regionOffset >>> 2) + vgiSab.HDR_CLAIM_SEQ;
        var id = (Atomics.add(i, claimSeqLane, 1) + 1) | 0;
        if (id === 0) id = 1;
        for (var s = 0; s < hdr.nSlots; s++) {
            var sb = vgiSab.slotByte(regionOffset, hdr, s) >>> 2;
            // Serialize openers without publishing STATE: a worker dispatcher watches only STATE, so it stays parked
            // until the reset below is visible and the final STATE store publishes the claim
            if (Atomics.compareExchange(i, sb + vgiSab.RESERVATION, 0, id) === 0) {
                if (Atomics.load(i, sb + vgiSab.STATE) !== 0) {
                    Atomics.store(i, sb + vgiSab.RESERVATION, 0);
                    Atomics.notify(i, sb + vgiSab.RESERVATION);
                    continue;
                }
                // W2C_CLOSED back to 0 (open): the worker closes it with THIS claim id, a stale worker's old token
                // can't end the new claim
                Atomics.store(i, sb + vgiSab.C2W_W, 0);
                Atomics.store(i, sb + vgiSab.C2W_R, 0);
                Atomics.store(i, sb + vgiSab.C2W_CL, 0);
                Atomics.store(i, sb + vgiSab.W2C_W, 0);
                Atomics.store(i, sb + vgiSab.W2C_R, 0);
                Atomics.store(i, sb + vgiSab.W2C_CL, 0);
                Atomics.store(i, sb + vgiSab.TERMINAL_CLAIM, 0);
                Atomics.store(i, sb + vgiSab.TERMINAL_CODE, 0);
                Atomics.store(i, sb + vgiSab.TERMINAL_DETAIL, 0);
                // The publication point: a worker that sees id in STATE also sees the completed reset
                Atomics.store(i, sb + vgiSab.STATE, id);
                Atomics.store(i, sb + vgiSab.RESERVATION, 0);
                Atomics.notify(i, sb + vgiSab.RESERVATION);
                Atomics.notify(i, sb + vgiSab.STATE);
                return s;
            }
        }
        return -1;
    },
    vgi_wasm_slot_write__deps: ['$vgiSab'],
    vgi_wasm_slot_write__sig: 'iiipi',
    vgi_wasm_slot_write: function (regionOffset, slot, dataPtr, n) {
        regionOffset = regionOffset >>> 0;
        var hdr = vgiSab.hdr(regionOffset);
        var sb = vgiSab.slotByte(regionOffset, hdr, slot);
        return vgiSab.ringWrite(sb >>> 2, vgiSab.C2W_W, vgiSab.C2W_R, sb + vgiSab.CTRL_BYTES, hdr.ringCap, dataPtr >>> 0, n);
    },
    vgi_wasm_slot_write_eos__deps: ['$vgiSab'],
    vgi_wasm_slot_write_eos__sig: 'vii',
    vgi_wasm_slot_write_eos: function (regionOffset, slot) {
        regionOffset = regionOffset >>> 0;
        var i = vgiSab.i32();
        var hdr = vgiSab.hdr(regionOffset);
        var sb = vgiSab.slotByte(regionOffset, hdr, slot) >>> 2;
        Atomics.store(i, sb + vgiSab.C2W_CL, 1);
        Atomics.notify(i, sb + vgiSab.C2W_W);
    },
    vgi_wasm_slot_read__deps: ['$vgiSab'],
    vgi_wasm_slot_read__sig: 'iiipi',
    vgi_wasm_slot_read: function (regionOffset, slot, dataPtr, n) {
        regionOffset = regionOffset >>> 0;
        var i = vgiSab.i32();
        var hdr = vgiSab.hdr(regionOffset);
        var sb = vgiSab.slotByte(regionOffset, hdr, slot);
        var result = vgiSab.ringRead(
            sb >>> 2,
            vgiSab.W2C_W,
            vgiSab.W2C_R,
            vgiSab.W2C_CL,
            sb + vgiSab.CTRL_BYTES + hdr.ringCap,
            hdr.ringCap,
            dataPtr >>> 0,
            n,
        );
        // -3: the worker ended this claim with a terminal transport error (vgi_wasm_slot_terminal_error has it)
        if (
            result === 0 &&
            (Atomics.load(i, (regionOffset >>> 2) + vgiSab.HDR_FEATURES) & vgiSab.FEATURE_TERMINAL_ERROR) !== 0 &&
            Atomics.load(i, (sb >>> 2) + vgiSab.STATE) !== 0 &&
            Atomics.load(i, (sb >>> 2) + vgiSab.TERMINAL_CLAIM) === Atomics.load(i, (sb >>> 2) + vgiSab.STATE)
        ) {
            return -3;
        }
        return result;
    },
    vgi_wasm_slot_terminal_error__deps: ['$vgiSab'],
    vgi_wasm_slot_terminal_error__sig: 'iiipp',
    vgi_wasm_slot_terminal_error: function (regionOffset, slot, codePtr, detailPtr) {
        regionOffset = regionOffset >>> 0;
        codePtr = codePtr >>> 0;
        detailPtr = detailPtr >>> 0;
        var i = vgiSab.i32();
        var hdr = vgiSab.hdr(regionOffset);
        var sb = vgiSab.slotByte(regionOffset, hdr, slot) >>> 2;
        if ((Atomics.load(i, (regionOffset >>> 2) + vgiSab.HDR_FEATURES) & vgiSab.FEATURE_TERMINAL_ERROR) === 0)
            return 0;
        var claim = Atomics.load(i, sb + vgiSab.STATE);
        if (claim === 0 || Atomics.load(i, sb + vgiSab.TERMINAL_CLAIM) !== claim) return 0;
        var code = Atomics.load(i, sb + vgiSab.TERMINAL_CODE);
        var detail = Atomics.load(i, sb + vgiSab.TERMINAL_DETAIL);
        // Release or reclaim can replace the metadata between the token check and the loads: the token is a
        // seqlock, a snapshot counts only if both claim lanes are unchanged afterwards
        if (Atomics.load(i, sb + vgiSab.STATE) !== claim || Atomics.load(i, sb + vgiSab.TERMINAL_CLAIM) !== claim)
            return 0;
        if (codePtr) Atomics.store(i, codePtr >>> 2, code);
        if (detailPtr) Atomics.store(i, detailPtr >>> 2, detail);
        return 1;
    },
    vgi_wasm_slot_release__deps: ['$vgiSab'],
    vgi_wasm_slot_release__sig: 'vii',
    vgi_wasm_slot_release: function (regionOffset, slot) {
        regionOffset = regionOffset >>> 0;
        var i = vgiSab.i32();
        var hdr = vgiSab.hdr(regionOffset);
        var sb = vgiSab.slotByte(regionOffset, hdr, slot) >>> 2;
        Atomics.store(i, sb + vgiSab.STATE, 0);
        // wake the dispatcher waiting for this slot's release
        Atomics.notify(i, sb + vgiSab.STATE);
    },
});
