#ifndef INCLUDE_DUCKDB_WEB_MAIN_THREAD_H_
#define INCLUDE_DUCKDB_WEB_MAIN_THREAD_H_

#include <atomic>
#include <functional>
#include <type_traits>

/// The runtime (file handles, the OPFS scratch, js_buffer:// files, UDFs) lives in the JavaScript context of the
/// main runtime thread. With pthreads, DuckDB's worker threads run in their own workers with their own JavaScript
/// contexts: everything that reaches the runtime is proxied to the main thread, which serves the requests while it
/// waits for the query thread.
///
/// Without pthreads everything runs inline on the main thread.

namespace duckdb {
namespace web {
namespace main_thread {

/// Are we on the main runtime thread (or is there only one thread)?
bool IsMainThread();
/// Run a function on the main thread and wait for it. From the main thread it runs inline.
void RunSync(const std::function<void()> &fn);
/// Serve proxied calls until `done` becomes non-zero. Called on the main thread while another thread works.
void ServeUntil(std::atomic<int> &done);
/// Wake the main thread out of ServeUntil, after setting its `done` or after queueing work for it
void Wake();
/// Keep idle workers in emscripten's pthread pool, called on the main thread after a call. A pthread can only be
/// created synchronously on a worker the pool already holds, and a new worker loads only while the main thread is
/// in its event loop, so the pool is refilled between calls: with the threads that are alive plus a few more idle, a
/// call can relaunch the scheduler at the same size (the old threads are joined, but their workers return to the
/// pool only in the event loop) and extensions can start threads of their own. New workers join the pool once they
/// have loaded, which takes a moment: right after a call that exhausted the pool, the next ones may still find it
/// short. A no-op without pthreads and off the main thread.
void TopUpPool();

/// Run a callable on the main thread and return its result
template <typename F> auto OnMainThread(F &&fn) -> decltype(fn()) {
    using R = decltype(fn());
    if (IsMainThread()) return fn();
    if constexpr (std::is_void_v<R>) {
        RunSync([&] { fn(); });
    } else {
        std::optional<R> result;
        RunSync([&] { result.emplace(fn()); });
        return std::move(*result);
    }
}

}  // namespace main_thread
}  // namespace web
}  // namespace duckdb

#endif
