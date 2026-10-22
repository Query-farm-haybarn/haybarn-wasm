#include "duckdb/web/main_thread.h"

#include <exception>
#include <stdexcept>

#if defined(__EMSCRIPTEN_PTHREADS__)
#include <emscripten.h>
#include <emscripten/console.h>
#include <emscripten/proxying.h>
#include <emscripten/threading.h>
#include <errno.h>
#include <pthread.h>
#endif

#if defined(__EMSCRIPTEN_PTHREADS__)
/// Refill emscripten's pthread pool, see main_thread::TopUpPool
// clang-format off
EM_JS(void, duckdb_web_pthread_pool_top_up, (int spare, int max_workers), {
    // Threads that ended but were not cleaned up yet still hold their worker, it returns to the pool in the event loop
    var alive = 0;
    for (var ptr of Object.keys(PThread.pthreads)) {
        if (!PThread.finishedThreads || !PThread.finishedThreads.has(Number(ptr))) alive++;
    }
    PThread.haybarnLoadingWorkers = PThread.haybarnLoadingWorkers || 0;
    var total = PThread.unusedWorkers.length + PThread.haybarnLoadingWorkers + Object.keys(PThread.pthreads).length;
    while (PThread.unusedWorkers.length + PThread.haybarnLoadingWorkers < alive + spare && total < max_workers) {
        // A new worker loads (its script is fetched by this thread) only while this thread is in its event loop:
        // it joins the pool once loaded, a thread started on it during a call before that would wait for the call
        const worker = PThread.allocateUnusedWorker();
        PThread.unusedWorkers.splice(PThread.unusedWorkers.indexOf(worker), 1);
        PThread.haybarnLoadingWorkers++;
        total++;
        PThread.loadWasmModuleToWorker(worker).then(() => {
            PThread.haybarnLoadingWorkers--;
            PThread.unusedWorkers.push(worker);
        });
    }
});
// clang-format on
#endif

namespace duckdb {
namespace web {
namespace main_thread {

#if defined(__EMSCRIPTEN_PTHREADS__)

namespace {
/// Idle workers kept beyond the threads that are alive
constexpr int POOL_SPARE_WORKERS = 4;
/// No more workers than this, idle or not
constexpr int POOL_MAX_WORKERS = 64;

/// The queue of calls for the main thread
emscripten::ProxyingQueue &Queue() {
    static emscripten::ProxyingQueue queue;
    return queue;
}
/// The main thread waits on this word while it serves
std::atomic<int> main_wake{0};
}  // namespace

bool IsMainThread() { return emscripten_is_main_runtime_thread(); }

void Wake() {
    main_wake.store(1);
    emscripten_futex_wake(&main_wake, 1);
}

void RunSync(const std::function<void()> &fn) {
    if (IsMainThread()) {
        fn();
        return;
    }
    std::atomic<int> done{0};
    // An exception of the call is thrown on the calling thread, not on the main thread
    std::exception_ptr error;
    // Queued asynchronously, the main thread is woken through our own word: it waits in ServeUntil, not in the
    // event loop where the queue's own notification would reach it
    bool queued = Queue().proxyAsync(emscripten_main_runtime_thread_id(), [&] {
        try {
            fn();
        } catch (...) {
            error = std::current_exception();
        }
        done.store(1);
        emscripten_futex_wake(&done, 1);
    });
    if (!queued) {
        throw std::runtime_error("Cannot proxy a call to the main thread");
    }
    Wake();
    while (done.load() == 0) {
        emscripten_futex_wait(&done, 0, 1e9);
    }
    if (error) std::rethrow_exception(error);
}

void TopUpPool() {
    if (IsMainThread()) {
        duckdb_web_pthread_pool_top_up(POOL_SPARE_WORKERS, POOL_MAX_WORKERS);
    }
}

void ServeUntil(std::atomic<int> &done) {
    while (done.load() == 0) {
        main_wake.store(0);
        // Our calls, then what emscripten proxies to the main thread itself (dlopen from a pthread)
        Queue().execute();
        emscripten_proxy_execute_queue(emscripten_proxy_get_system_queue());
        if (done.load() != 0) break;
        // A wake that arrived since the store above is seen by the wait, the word is no longer 0
        emscripten_futex_wait(&main_wake, 0, 1.0);
    }
}

#else

bool IsMainThread() { return true; }
void Wake() {}
void TopUpPool() {}
void RunSync(const std::function<void()> &fn) { fn(); }
void ServeUntil(std::atomic<int> &done) {
    while (done.load() == 0) {
    }
}

#endif

}  // namespace main_thread
}  // namespace web
}  // namespace duckdb

#if defined(__EMSCRIPTEN_PTHREADS__)
/// pthread_create from a pthread asks the main thread through a message the main thread only sees in its event
/// loop; while it serves a query from ServeUntil the thread would never start (SET threads = N runs on the query
/// thread). Linked with --wrap=pthread_create: the creation itself is proxied to the main thread.
extern "C" int __real_pthread_create(pthread_t *thread, const pthread_attr_t *attr, void *(*start)(void *), void *arg);
extern "C" int __wrap_pthread_create(pthread_t *thread, const pthread_attr_t *attr, void *(*start)(void *), void *arg) {
    return duckdb::web::main_thread::OnMainThread([&] {
        auto rc = __real_pthread_create(thread, attr, start, arg);
        // The pool is strict (PTHREAD_POOL_SIZE_STRICT=2): no idle worker left fails with EAGAIN instead of
        // creating a worker that would only start after the call
        static bool warned = false;
        if (rc == EAGAIN && !warned) {
            warned = true;
            emscripten_console_warn(
                "pthread_create: the pthread pool is exhausted for this call, the thread was not started (EAGAIN)");
        }
        return rc;
    });
}
#endif
