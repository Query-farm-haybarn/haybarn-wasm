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
});
