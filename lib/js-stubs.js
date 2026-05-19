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
});
