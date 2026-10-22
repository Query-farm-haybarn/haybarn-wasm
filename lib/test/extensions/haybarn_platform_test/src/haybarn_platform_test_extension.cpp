// Haybarn: a test extension for the platform functions the engine gives side modules (lib/src/platform_stubs.cc,
// lib/js-stubs.js). It imports all of them with the declarations vgi uses (vgi_oauth.cpp, vgi_sab_abi.hpp), so loading
// it proves they link, and each SQL function calls one from wherever DuckDB runs it: the query thread or a worker
// thread on the threads bundle. test/index_platform.ts drives it.

#include "haybarn_platform_test_extension.hpp"

#include "duckdb/common/exception.hpp"
#include "duckdb/function/scalar_function.hpp"
#include "duckdb/main/client_context.hpp"
#include "duckdb/main/extension/extension_loader.hpp"

#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <string>
#include <unordered_map>
#include <unistd.h>

extern "C" {
void duckdb_wasm_crypto_random(void *buf, int len);
void duckdb_wasm_sha256(const void *data, int len, void *out_hash);
char *duckdb_wasm_open_auth_url(const char *url, int timeout_ms);
char *duckdb_wasm_get_auth_error(int unused);
char *duckdb_wasm_get_page_origin(void);

int vgi_wasm_ensure_worker(const char *location, int region_offset);
int vgi_wasm_slot_open(const char *location, int region_offset);
int vgi_wasm_slot_write(int region_offset, int slot, const uint8_t *data, int n);
void vgi_wasm_slot_write_eos(int region_offset, int slot);
int vgi_wasm_slot_read(int region_offset, int slot, uint8_t *data, int n);
int vgi_wasm_slot_terminal_error(int region_offset, int slot, int *code, int *detail);
void vgi_wasm_slot_release(int region_offset, int slot);
void vgi_wasm_set_channel(int channel_offset);
}

namespace duckdb {

namespace {

std::string Hex(const uint8_t *data, size_t n) {
    static const char *digits = "0123456789abcdef";
    std::string out;
    for (size_t i = 0; i < n; i++) {
        out += digits[data[i] >> 4];
        out += digits[data[i] & 15];
    }
    return out;
}

/// Take a malloc'd C string from the engine
Value TakeString(char *str) {
    if (!str) return Value();
    std::string result(str);
    free(str);
    return Value(result);
}

/// Apply fn to every row of a one-or-more column chunk, with the row's values
template <class F> void ForEachRow(DataChunk &args, Vector &result, F &&fn) {
    vector<Value> row(args.ColumnCount());
    for (idx_t i = 0; i < args.size(); i++) {
        for (idx_t c = 0; c < args.ColumnCount(); c++) row[c] = args.GetValue(c, i);
        result.SetValue(i, fn(row));
    }
}

// haybarn_platform_sha256(text): hex SHA-256 of the text
void Sha256(DataChunk &args, ExpressionState &, Vector &result) {
    ForEachRow(args, result, [](vector<Value> &row) -> Value {
        if (row[0].IsNull()) return Value();
        auto text = row[0].ToString();
        uint8_t hash[32];
        duckdb_wasm_sha256(text.data(), static_cast<int>(text.size()), hash);
        return Value(Hex(hash, 32));
    });
}

// haybarn_platform_random(n): n random bytes, hex
void RandomHex(DataChunk &args, ExpressionState &, Vector &result) {
    ForEachRow(args, result, [](vector<Value> &row) -> Value {
        auto n = row[0].GetValue<int32_t>();
        std::string buf(n, '\0');
        duckdb_wasm_crypto_random(&buf[0], n);
        return Value(Hex(reinterpret_cast<const uint8_t *>(buf.data()), buf.size()));
    });
}

// haybarn_platform_random_chunks(n): of n random bytes, how many 64 KiB chunks have a non-zero byte (all of them, if
// every chunk was filled)
void RandomChunks(DataChunk &args, ExpressionState &, Vector &result) {
    ForEachRow(args, result, [](vector<Value> &row) -> Value {
        auto n = row[0].GetValue<int32_t>();
        std::string buf(n, '\0');
        duckdb_wasm_crypto_random(&buf[0], n);
        int32_t filled = 0;
        for (int32_t off = 0; off < n; off += 65536) {
            auto end = std::min(off + 65536, n);
            for (int32_t i = off; i < end; i++) {
                if (buf[i] != 0) {
                    filled++;
                    break;
                }
            }
        }
        return Value::INTEGER(filled);
    });
}

// haybarn_platform_page_origin(): the page origin, NULL for blob: and opaque origins
void PageOrigin(DataChunk &args, ExpressionState &, Vector &result) {
    for (idx_t i = 0; i < args.size(); i++) result.SetValue(i, TakeString(duckdb_wasm_get_page_origin()));
}

// haybarn_platform_open_auth(url, timeout_ms): the authorization code, or 'error: <reason>'
void OpenAuth(DataChunk &args, ExpressionState &, Vector &result) {
    ForEachRow(args, result, [](vector<Value> &row) -> Value {
        auto url = row[0].ToString();
        auto code = duckdb_wasm_open_auth_url(url.c_str(), row[1].GetValue<int32_t>());
        if (code) return TakeString(code);
        auto error = TakeString(duckdb_wasm_get_auth_error(0));
        return Value("error: " + (error.IsNull() ? std::string("(none)") : error.ToString()));
    });
}

// The VGI worker: transport, the way vgi uses it: one channel region per location in shared memory, a claimed slot
// per call, the request written to c2w and the response read from w2c. vgi_sab_abi.hpp's layout.
constexpr int32_t HEADER_BYTES = 64;
constexpr int32_t SLOT_CONTROL_BYTES = 64;
constexpr int32_t N_SLOTS = 4;
constexpr int32_t RING_CAP = 256; // small, so a request of a few hundred bytes wraps the ring
constexpr int32_t SLOT_STRIDE = (SLOT_CONTROL_BYTES + 2 * RING_CAP + 63) & ~63;

int32_t RegionFor(const std::string &location) {
    static std::mutex lock;
    static std::unordered_map<std::string, int32_t> regions;
    std::lock_guard<std::mutex> guard(lock);
    auto it = regions.find(location);
    if (it != regions.end()) return it->second;
    auto bytes = HEADER_BYTES + N_SLOTS * SLOT_STRIDE;
    void *region = nullptr;
    if (posix_memalign(&region, 64, bytes) != 0) throw IOException("cannot allocate a channel region");
    memset(region, 0, bytes);
    auto *header = static_cast<int32_t *>(region);
    header[0] = 0x42534756; // magic 'VGSB'
    header[1] = 1;          // version
    header[2] = N_SLOTS;
    header[3] = RING_CAP;
    header[4] = SLOT_STRIDE;
    header[5] = HEADER_BYTES;
    header[6] = 1; // features: terminal transport errors
    auto offset = static_cast<int32_t>(reinterpret_cast<uintptr_t>(region));
    regions[location] = offset;
    return offset;
}

std::string Exchange(ClientContext &context, const std::string &location, const std::string &request) {
    auto region = RegionFor(location);
    vgi_wasm_set_channel(region);
    if (vgi_wasm_ensure_worker(location.c_str(), region) != 0) {
        throw IOException("vgi_wasm_ensure_worker failed for %s", location);
    }
    int slot;
    while ((slot = vgi_wasm_slot_open(location.c_str(), region)) < 0) {
        context.InterruptCheck();
        usleep(1000);
    }
    std::string response;
    try {
        auto data = reinterpret_cast<const uint8_t *>(request.data());
        if (vgi_wasm_slot_write(region, slot, data, static_cast<int>(request.size())) != int(request.size())) {
            throw IOException("short write to slot %d", slot);
        }
        vgi_wasm_slot_write_eos(region, slot);
        uint8_t buf[100];
        for (;;) {
            auto n = vgi_wasm_slot_read(region, slot, buf, sizeof(buf));
            if (n > 0) {
                response.append(reinterpret_cast<const char *>(buf), n);
            } else if (n == 0) {
                break;
            } else if (n == -2) {
                // the ring stayed empty for a bounded wait: a read can be interrupted
                context.InterruptCheck();
            } else if (n == -3) {
                int code = 0, detail = 0;
                if (vgi_wasm_slot_terminal_error(region, slot, &code, &detail) != 1) {
                    throw IOException("terminal error without metadata");
                }
                throw IOException("terminal transport error %d/%d", code, detail);
            } else {
                throw IOException("slot read failed: %d", n);
            }
        }
    } catch (...) {
        vgi_wasm_slot_release(region, slot);
        throw;
    }
    vgi_wasm_slot_release(region, slot);
    return response;
}

// haybarn_platform_vgi_exchange(location, request): the response of the VGI worker at location
void VgiExchange(DataChunk &args, ExpressionState &state, Vector &result) {
    auto &context = state.GetContext();
    ForEachRow(args, result, [&](vector<Value> &row) -> Value {
        return Value(Exchange(context, row[0].ToString(), row[1].ToString()));
    });
}

void Register(ExtensionLoader &loader, ScalarFunction fun) {
    fun.SetVolatile();
    loader.RegisterFunction(std::move(fun));
}

void LoadInternal(ExtensionLoader &loader) {
    using T = LogicalType;
    Register(loader, ScalarFunction("haybarn_platform_sha256", {T::VARCHAR}, T::VARCHAR, Sha256));
    Register(loader, ScalarFunction("haybarn_platform_random", {T::INTEGER}, T::VARCHAR, RandomHex));
    Register(loader, ScalarFunction("haybarn_platform_random_chunks", {T::INTEGER}, T::INTEGER, RandomChunks));
    Register(loader, ScalarFunction("haybarn_platform_page_origin", {}, T::VARCHAR, PageOrigin));
    Register(loader, ScalarFunction("haybarn_platform_open_auth", {T::VARCHAR, T::INTEGER}, T::VARCHAR, OpenAuth));
    Register(loader,
             ScalarFunction("haybarn_platform_vgi_exchange", {T::VARCHAR, T::VARCHAR}, T::VARCHAR, VgiExchange));
}

}  // namespace

void HaybarnPlatformTestExtension::Load(ExtensionLoader &loader) { LoadInternal(loader); }
std::string HaybarnPlatformTestExtension::Name() { return "haybarn_platform_test"; }
std::string HaybarnPlatformTestExtension::Version() const { return ""; }

}  // namespace duckdb

extern "C" {
DUCKDB_CPP_EXTENSION_ENTRY(haybarn_platform_test, loader) { duckdb::LoadInternal(loader); }
}
