// Haybarn: platform functions for extensions. A side module can't define EM_JS or EM_ASM of its own, so the engine
// provides what an extension needs from the browser: the OAuth popup, the page origin, Web Crypto random bytes and
// SHA-256 (vgi's OAuth flows and its result-cache keys). The JavaScript halves are in js-stubs.js.
//
// The functions that read the worker's globals or post a message to the page have to run on the main runtime thread:
// with pthreads an extension calls them from the query thread or a DuckDB worker, whose JavaScript context is a
// pthread's, and whose postMessage reaches emscripten's pthread handler instead of the page. They are proxied to the
// main thread, which serves proxied calls while a query runs (main_thread::ServeUntil). While it waits for the page
// (an OAuth login, a worker that boots) it serves nothing else, so the other runtime calls of that query wait too.
//
// This file is linked into the engine executable itself, not an archive, so the linker can't drop the symbols: no
// code of the engine calls them, extensions do.

#include <emscripten.h>

#include <cstddef>
#include <optional>

#include "duckdb/web/main_thread.h"
#include "mbedtls_wrapper.hpp"

namespace main_thread = duckdb::web::main_thread;

extern "C" {
// js-stubs.js
char *duckdb_wasm_open_auth_url_js(const char *url, int timeout_ms);
char *duckdb_wasm_get_auth_error_js(int unused);
char *duckdb_wasm_get_page_origin_js(void);
void duckdb_wasm_crypto_random(void *buf, int len);
int vgi_wasm_ensure_worker_js(const char *location, int region_offset);

/// Open an OAuth authorization URL in a popup on the page and wait up to timeout_ms (0: no limit) for the
/// authorization code. Returns the code (malloc'd, the caller frees it) or nullptr, see duckdb_wasm_get_auth_error.
EMSCRIPTEN_KEEPALIVE char *duckdb_wasm_open_auth_url(const char *url, int timeout_ms) {
    return main_thread::OnMainThread([&] { return duckdb_wasm_open_auth_url_js(url, timeout_ms); });
}

/// The last error of duckdb_wasm_open_auth_url (malloc'd) or nullptr
EMSCRIPTEN_KEEPALIVE char *duckdb_wasm_get_auth_error(int unused) {
    return main_thread::OnMainThread([&] { return duckdb_wasm_get_auth_error_js(unused); });
}

/// The origin of the page (malloc'd), or nullptr for a blob: or opaque origin
EMSCRIPTEN_KEEPALIVE char *duckdb_wasm_get_page_origin(void) {
    return main_thread::OnMainThread([] { return duckdb_wasm_get_page_origin_js(); });
}

/// VGI worker: transport: make sure the page runs the VGI Web Worker for `location`, serving the channel region at
/// region_offset. 0 or -1. The ring operations (vgi_wasm_slot_*) are in js-stubs.js and run on the calling thread.
EMSCRIPTEN_KEEPALIVE int vgi_wasm_ensure_worker(const char *location, int region_offset) {
    return main_thread::OnMainThread([&] { return vgi_wasm_ensure_worker_js(location, region_offset); });
}

/// SHA-256 of len bytes at data into the 32 bytes at out_hash, with the engine's mbedtls
EMSCRIPTEN_KEEPALIVE void duckdb_wasm_sha256(const void *data, int len, void *out_hash) {
    duckdb_mbedtls::MbedTlsWrapper::ComputeSha256Hash(static_cast<const char *>(data), static_cast<size_t>(len),
                                                      static_cast<char *>(out_hash));
}
}

// The JavaScript stubs are kept and exported because they are referenced here, crypto_random included
__attribute__((used)) static void *const haybarn_platform_stubs[] = {
    reinterpret_cast<void *>(&duckdb_wasm_crypto_random),
};

#if !defined(__EMSCRIPTEN_PTHREADS__)
// Without pthreads emscripten has no futex to sleep on, so emscripten_thread_sleep (usleep, nanosleep,
// std::this_thread::sleep_for) spins at full CPU for the whole sleep: vgi's device-code login polls the token endpoint
// every few seconds. The base bundle links with --wrap=emscripten_thread_sleep, and the sleep blocks in Atomics.wait
// instead, which a worker may do when the page is cross-origin isolated (SharedArrayBuffer exists). Otherwise it
// spins as before. With pthreads the real sleep already waits on a futex.
// clang-format off
EM_JS(int, haybarn_block_for, (double msecs), {
    if (typeof SharedArrayBuffer === 'undefined') return 0;
    try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, msecs);
        return 1;
    } catch (e) {
        return 0;
    }
});
// clang-format on

extern "C" void __real_emscripten_thread_sleep(double msecs);
extern "C" void __wrap_emscripten_thread_sleep(double msecs) {
    if (!haybarn_block_for(msecs)) {
        __real_emscripten_thread_sleep(msecs);
    }
}
#endif
