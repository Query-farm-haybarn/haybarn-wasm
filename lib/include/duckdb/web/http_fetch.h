#pragma once

#include <atomic>
#include <cstdint>
#include <string>

namespace duckdb {
namespace web {

// HTTP requests performed with fetch() by a helper Worker, so that a request in
// flight can be aborted.
//
// The XHR path is synchronous: once send() is entered the calling thread is
// blocked inside the browser until the whole response has arrived, so neither
// an interrupted query nor a timeout can end it. Here the calling thread hands
// the request to a helper Worker through a mailbox in (shared) wasm memory and
// waits in short slices, checking its cancellation flag and deadline between
// them; on either it raises the slot's abort lane, and the helper aborts the
// fetch. The timeout is one of inactivity, as for native httpfs. The helper is
// started by the bindings during instantiate on threads builds only (see
// bindings/http_fetch_helper.ts); until it reports ready, if it stops picking
// requests up, and on builds without shared memory, requests use the XHR path.
//
// Mailbox layout, in i32 lanes (the helper hard-codes the same numbers):
//   header (16 lanes):  [0] doorbell (bumped on every new request)
//                       [1] ready    (set once the helper is running)
//                       [2] slot count  [3] slot stride in lanes
//   slot i (16 lanes, at 16 + i*16):
//     [0] state   [1] abort   [2] url ptr   [3] url len   [4] method ptr
//     [5] method len  [6] header ptr array (name, value, name, value, ...)
//     [7] header count  [8] body ptr  [9] body len  [10] response size
//     [11] response buffer  [12] progress (bumped as the response arrives)
//     [13] copied (the helper has read every input)  [14] abandoned (the caller
//     left after an abort; whichever side sees the slot finished frees it)
// States: 0 free, 1 claimed, 2 request, 3 in flight, 4 needs buffer,
//         5 buffer provided, 6 done, 7 failed, 8 cancelled.
// The response buffer uses the XHR wire format ParseWasmResponse reads:
//   [status:2 LE][headers len:4 LE][headers][body len:4 LE][body]

enum class FetchOutcome {
    // No helper (not started, no shared memory, or every slot busy): use XHR.
    UNAVAILABLE,
    // `buffer` holds the response in wire format; the caller frees it.
    OK,
    // Network error, CORS refusal, or out of memory: like an XHR that returned 0.
    FAILED,
    CANCELLED,
    TIMED_OUT,
};

struct FetchResult {
    FetchOutcome outcome = FetchOutcome::UNAVAILABLE;
    char *buffer = nullptr;
};

// `headers` is a char* array of `header_count` name/value pairs (WasmHeaderArray).
// `cancellation` may be null; `timeout_seconds` 0 means no deadline.
FetchResult FetchViaHelper(const std::string &url, const char *method, char **headers, int header_count,
                           const char *body, int body_len, const std::atomic<bool> *cancellation,
                           uint64_t timeout_seconds);

}  // namespace web
}  // namespace duckdb
