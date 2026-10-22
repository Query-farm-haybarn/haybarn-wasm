#include "duckdb/web/http_fetch.h"

#include "duckdb/common/file_opener.hpp"
#include "duckdb/main/client_context.hpp"

#include <atomic>
#include <chrono>
#include <climits>
#include <cstdlib>
#include <cstring>
#include <optional>

#if defined(__EMSCRIPTEN_PTHREADS__)
#include <emscripten/emscripten.h>
#include <emscripten/threading.h>
#endif

namespace duckdb {
namespace web {

namespace {
thread_local duckdb::weak_ptr<ClientContext> current_request_context;
}  // namespace

RuntimeRequestContext::Scope::Scope(const duckdb::weak_ptr<ClientContext> &context) {
    if (context.expired()) return;
    set_ = true;
    previous_ = current_request_context;
    current_request_context = context;
}

RuntimeRequestContext::Scope::~Scope() {
    if (set_) current_request_context = previous_;
}

duckdb::weak_ptr<ClientContext> RuntimeRequestContext::Current() { return current_request_context; }

duckdb::weak_ptr<ClientContext> RuntimeRequestContext::Of(optional_ptr<FileOpener> opener) {
    auto context = FileOpener::TryGetClientContext(opener);
    if (!context) return {};
    return context->shared_from_this();
}

bool RuntimeRequestContext::Interrupted() {
    auto context = current_request_context.lock();
    return context && context->IsInterrupted();
}

/// Perform a request of the JS runtime (runtime_http.ts) through the fetch helper, on the main thread inside a
/// runtime call. The request is aborted when the query of the current request context is interrupted. Writes the
/// FetchOutcome to `outcome` and returns the response buffer for OK; UNAVAILABLE means: use XHR.
extern "C" char *duckdb_web_http_fetch_runtime(const char *url, const char *method, char **headers, int header_count,
                                               const char *body, int body_len, int32_t *outcome) {
    auto result = FetchViaHelper(url, method, headers, header_count, body, body_len,
                                 [] { return RuntimeRequestContext::Interrupted(); }, 0);
    *outcome = static_cast<int32_t>(result.outcome);
    return result.buffer;
}

#if defined(__EMSCRIPTEN_PTHREADS__)
namespace {

constexpr int kHeaderLanes = 16;
constexpr int kSlotLanes = 16;
constexpr int kSlots = 64;

enum Lane : int {
    STATE = 0,
    ABORT = 1,
    URL = 2,
    URL_LEN = 3,
    METHOD = 4,
    METHOD_LEN = 5,
    HEADERS = 6,
    HEADER_COUNT = 7,
    BODY = 8,
    BODY_LEN = 9,
    SIZE = 10,
    BUFFER = 11,
    PROGRESS = 12,
    COPIED = 13,
    ABANDONED = 14,
};

enum State : int32_t {
    FREE = 0,
    CLAIMED = 1,
    REQUEST = 2,
    IN_FLIGHT = 3,
    NEEDS_BUFFER = 4,
    BUFFER_PROVIDED = 5,
    DONE = 6,
    FAILED = 7,
    CANCELLED = 8,
};

// How often a waiting caller wakes to look at its cancellation flag and deadline.
constexpr double kWaitSliceMs = 50;
// After raising abort, how long to wait for the helper to let go of the slot.
// A helper that never answers keeps the slot (and the request's memory) rather
// than risk writing into memory that has been freed and reused.
constexpr auto kAbortGrace = std::chrono::seconds(10);
// The helper picks a request up within milliseconds. One that sits unclaimed
// this long means the helper is gone; from then on requests use XHR.
constexpr auto kPickupTimeout = std::chrono::seconds(2);

alignas(64) std::atomic<int32_t> g_mailbox[kHeaderLanes + kSlots * kSlotLanes];

std::atomic<int32_t> &SlotLane(int slot, Lane lane) {
    return g_mailbox[kHeaderLanes + slot * kSlotLanes + lane];
}

int32_t Pointer(const void *ptr) {
    return static_cast<int32_t>(reinterpret_cast<uintptr_t>(ptr));
}

void Wake(std::atomic<int32_t> &lane) {
    emscripten_futex_wake(&lane, INT_MAX);
}

}  // namespace

extern "C" uint32_t duckdb_web_http_fetch_mailbox() {
    g_mailbox[2].store(kSlots);
    g_mailbox[3].store(kSlotLanes);
    return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(&g_mailbox[0]));
}

extern "C" void duckdb_web_http_fetch_ready() {
    g_mailbox[1].store(1, std::memory_order_release);
}

FetchResult FetchViaHelper(const std::string &url, const char *method, char **headers, int header_count,
                           const char *body, int body_len, const std::function<bool()> &cancelled,
                           uint64_t timeout_seconds) {
    FetchResult result;
    if (g_mailbox[1].load(std::memory_order_acquire) != 1) {
        return result;
    }
    int slot = -1;
    for (int i = 0; i < kSlots; ++i) {
        int32_t expected = FREE;
        if (SlotLane(i, STATE).compare_exchange_strong(expected, CLAIMED, std::memory_order_acq_rel)) {
            slot = i;
            break;
        }
    }
    if (slot < 0) {
        return result;
    }
    auto &state = SlotLane(slot, STATE);
    auto &abort = SlotLane(slot, ABORT);
    SlotLane(slot, URL).store(Pointer(url.data()), std::memory_order_relaxed);
    SlotLane(slot, URL_LEN).store(static_cast<int32_t>(url.size()), std::memory_order_relaxed);
    SlotLane(slot, METHOD).store(Pointer(method), std::memory_order_relaxed);
    SlotLane(slot, METHOD_LEN).store(static_cast<int32_t>(strlen(method)), std::memory_order_relaxed);
    SlotLane(slot, HEADERS).store(Pointer(headers), std::memory_order_relaxed);
    SlotLane(slot, HEADER_COUNT).store(header_count, std::memory_order_relaxed);
    SlotLane(slot, BODY).store(Pointer(body), std::memory_order_relaxed);
    SlotLane(slot, BODY_LEN).store(body_len, std::memory_order_relaxed);
    SlotLane(slot, SIZE).store(0, std::memory_order_relaxed);
    SlotLane(slot, BUFFER).store(0, std::memory_order_relaxed);
    SlotLane(slot, PROGRESS).store(0, std::memory_order_relaxed);
    SlotLane(slot, COPIED).store(0, std::memory_order_relaxed);
    SlotLane(slot, ABANDONED).store(0, std::memory_order_relaxed);
    abort.store(0, std::memory_order_relaxed);
    state.store(REQUEST, std::memory_order_release);
    g_mailbox[0].fetch_add(1, std::memory_order_acq_rel);
    Wake(g_mailbox[0]);

    using clock = std::chrono::steady_clock;
    // The timeout is for inactivity, as native httpfs applies it (a stall timeout, not
    // a limit on the whole transfer): the helper bumps PROGRESS when the response head
    // arrives and for every body chunk, and each bump restarts the clock.
    const auto started = clock::now();
    auto last_activity = started;
    int32_t progress = 0;
    FetchOutcome abort_reason = FetchOutcome::CANCELLED;
    std::optional<clock::time_point> aborted_at;
    char *buffer = nullptr;
    for (;;) {
        auto current = state.load(std::memory_order_acquire);
        switch (current) {
        case NEEDS_BUFFER: {
            // The helper has the whole response and needs somewhere to put it. After
            // an abort, or if the allocation fails, hand it null: it then gives up.
            auto size = static_cast<uint32_t>(SlotLane(slot, SIZE).load(std::memory_order_relaxed));
            buffer = aborted_at ? nullptr : static_cast<char *>(malloc(size));
            SlotLane(slot, BUFFER).store(Pointer(buffer), std::memory_order_relaxed);
            state.store(BUFFER_PROVIDED, std::memory_order_release);
            Wake(state);
            continue;
        }
        case DONE:
            result.outcome = FetchOutcome::OK;
            result.buffer = buffer;
            state.store(FREE, std::memory_order_release);
            return result;
        case FAILED:
        case CANCELLED:
            if (buffer) {
                free(buffer);
                result.outcome = FetchOutcome::FAILED;
            } else if (aborted_at) {
                result.outcome = abort_reason;
            } else {
                // A null buffer without an abort is a failed allocation.
                result.outcome = FetchOutcome::FAILED;
            }
            state.store(FREE, std::memory_order_release);
            return result;
        default:
            break;
        }
        emscripten_futex_wait(&state, static_cast<uint32_t>(current), kWaitSliceMs);
        const auto now = clock::now();
        const auto seen = SlotLane(slot, PROGRESS).load(std::memory_order_relaxed);
        if (seen != progress) {
            progress = seen;
            last_activity = now;
        }
        if (state.load(std::memory_order_acquire) == REQUEST && now - started > kPickupTimeout) {
            // The helper has stopped serving (it died, or was collected). Take the request
            // back — nothing of ours has been read — and send this and every later
            // request over XHR rather than let each wait out its deadline.
            int32_t expected = REQUEST;
            if (state.compare_exchange_strong(expected, FREE, std::memory_order_acq_rel)) {
                g_mailbox[1].store(0, std::memory_order_release);
                EM_ASM({ console.warn('[http] fetch helper stopped responding; using synchronous XHR'); });
                return result;
            }
        }
        if (!aborted_at) {
            bool cancel = cancelled && cancelled();
            bool timed_out = timeout_seconds > 0 && now - last_activity >= std::chrono::seconds(timeout_seconds);
            if (cancel || timed_out) {
                abort_reason = cancel ? FetchOutcome::CANCELLED : FetchOutcome::TIMED_OUT;
                aborted_at = now;
                abort.store(1, std::memory_order_release);
                Wake(abort);
            }
        } else if (now - *aborted_at > kAbortGrace) {
            // Leave only once nothing of ours can still be read: either the helper never
            // claimed the request (take it back), or it has finished copying the inputs
            // (COPIED). In between it is reading them synchronously, so keep waiting.
            int32_t expected = REQUEST;
            if (state.compare_exchange_strong(expected, FREE, std::memory_order_acq_rel)) {
                result.outcome = abort_reason;
                return result;
            }
            if (SlotLane(slot, COPIED).load(std::memory_order_acquire) != 0) {
                // Hand the slot over: whichever side sees it finished frees it. A buffer
                // provided before the abort is left to the helper and leaks.
                SlotLane(slot, ABANDONED).store(1, std::memory_order_release);
                for (int32_t finished : {DONE, FAILED, CANCELLED}) {
                    int32_t value = finished;
                    state.compare_exchange_strong(value, FREE, std::memory_order_acq_rel);
                }
                result.outcome = abort_reason;
                return result;
            }
        }
    }
}

#else

// The base bundle has no shared memory and no helper; the bindings never start one there.
extern "C" uint32_t duckdb_web_http_fetch_mailbox() {
    return 0;
}

extern "C" void duckdb_web_http_fetch_ready() {
}

FetchResult FetchViaHelper(const std::string &, const char *, char **, int, const char *, int,
                           const std::function<bool()> &, uint64_t) {
    return {};
}

#endif

}  // namespace web
}  // namespace duckdb
