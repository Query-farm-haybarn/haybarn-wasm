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
