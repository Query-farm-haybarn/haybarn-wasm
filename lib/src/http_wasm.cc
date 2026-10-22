#include "duckdb/web/http_wasm.h"

#include <emscripten.h>

#include <cstdlib>
#include <cstring>

#include "duckdb/common/http_util.hpp"
#include "duckdb/main/database.hpp"
#include "duckdb/web/config.h"
#include "duckdb_static_extension.h"

namespace duckdb {

//===--------------------------------------------------------------------===//
// Response parsing
//===--------------------------------------------------------------------===//

/// The response buffer of the XHR helpers below and of the fetch helper (http_fetch.h):
///   [status:2 LE][headers length:4 LE][headers][body length:4 LE][body]
/// Takes ownership of `buffer`. A null buffer is a request that got no HTTP response: no XHR in this environment, a
/// network error or a CORS refusal (status 0), or no memory for the response.
static unique_ptr<HTTPResponse> ParseWasmResponse(char *buffer) {
    if (!buffer) {
        auto res = make_uniq<HTTPResponse>(HTTPStatusCode::NotFound_404);
        res->reason = "Please consult the browser console for details, might be potentially a CORS error";
        return res;
    }
    auto p = reinterpret_cast<const uint8_t *>(buffer);
    uint16_t status_code = p[0] | (p[1] << 8);
    p += 2;
    uint32_t headers_len = p[0] | (p[1] << 8) | (p[2] << 16) | (static_cast<uint32_t>(p[3]) << 24);
    p += 4;
    string raw_headers(reinterpret_cast<const char *>(p), headers_len);
    p += headers_len;
    uint32_t body_len = p[0] | (p[1] << 8) | (p[2] << 16) | (static_cast<uint32_t>(p[3]) << 24);
    p += 4;

    auto res = make_uniq<HTTPResponse>(HTTPUtil::ToStatusCode(status_code));
    res->reason = HTTPUtil::GetStatusMessage(res->status);
    if (body_len > 0) {
        res->body = string(reinterpret_cast<const char *>(p), body_len);
    }
    for (auto &line : StringUtil::Split(raw_headers, "\r\n")) {
        auto colon = line.find(':');
        if (colon == string::npos) continue;
        auto key = line.substr(0, colon);
        auto value = line.substr(colon + 1);
        StringUtil::Trim(key);
        StringUtil::Trim(value);
        if (!key.empty()) {
            res->headers.Insert(key, value);
        }
    }
    free(buffer);
    return res;
}

//===--------------------------------------------------------------------===//
// URL normalization
//===--------------------------------------------------------------------===//

static string NormalizeUrl(const string &url, const string &host_port) {
    string path = url;
    if (!path.empty() && path[0] == '/') {
        path = host_port + url;
    }
    if (!web::experimental_s3_tables_global_proxy.empty()) {
        if (url.rfind(web::experimental_s3_tables_global_proxy, 0) != 0) {
            auto id_table = path.find("--table-s3.s3.");
            auto id_aws = path.find(".amazonaws.com/");
            if (id_table != std::string::npos && id_aws != std::string::npos && id_table < id_aws) {
                path = web::experimental_s3_tables_global_proxy + path.substr(8);
            }
        }
    }
    if (path.rfind("https://", 0) != 0 && path.rfind("http://", 0) != 0) {
        path = "https://" + path;
    }
    return path;
}

//===--------------------------------------------------------------------===//
// Request headers on the wasm heap, for JS
//===--------------------------------------------------------------------===//

/// The request's headers as a char* array of name, value, name, value, ... in wasm memory
struct WasmHeaderArray {
    char **ptrs = nullptr;
    int count = 0;

    explicit WasmHeaderArray(const HTTPHeaders &headers) {
        for (auto &h : headers) {
            (void)h;
            count++;
        }
        ptrs = static_cast<char **>(malloc(count * 2 * sizeof(char *)));
        int i = 0;
        for (auto &h : headers) {
            ptrs[i++] = strdup(h.first.c_str());
            ptrs[i++] = strdup(h.second.c_str());
        }
    }
    ~WasmHeaderArray() {
        for (int i = 0; i < count * 2; i++) {
            free(ptrs[i]);
        }
        free(ptrs);
    }
    WasmHeaderArray(const WasmHeaderArray &) = delete;
    WasmHeaderArray &operator=(const WasmHeaderArray &) = delete;
};

//===--------------------------------------------------------------------===//
// Synchronous XHR
//
// One helper for every method; it returns the response buffer ParseWasmResponse reads, or 0. Header rules:
//   - `Host` is sent as `X-Host-Override` (browsers forbid setting Host), `User-Agent` is dropped (forbidden too)
//   - header values are sent as they are: they are not URL components, and a quoted strong ETag in If-Match must
//     keep its quotes
// Pointers cross into JS as signed i32: past 2 GiB of heap they are negative, so every one is coerced with `>>> 0`
// (emscripten does that for the code it generates, not for EM_JS bodies). HEAPU8 and HEAP32 are the runtime's own
// views, which emscripten refreshes when the memory grows.
//===--------------------------------------------------------------------===//

// clang-format off
EM_JS(char *, duckdb_web_http_xhr,
      (const char *url_ptr, const char *method_ptr, int header_count, char **header_array, const char *body_ptr,
       int body_len), {
    if (typeof XMLHttpRequest === 'undefined') return 0;
    var method = UTF8ToString(method_ptr >>> 0);
    var xhr = new XMLHttpRequest();
    xhr.open(method, UTF8ToString(url_ptr >>> 0), false);
    xhr.responseType = 'arraybuffer';
    var base = (header_array >>> 0) >>> 2;
    for (var i = 0; i < header_count * 2; i += 2) {
        var name = UTF8ToString(HEAP32[base + i] >>> 0);
        if (name === 'User-Agent') continue;
        if (name === 'Host') name = 'X-Host-Override';
        try { xhr.setRequestHeader(name, UTF8ToString(HEAP32[base + i + 1] >>> 0)); }
        catch (e) { console.warn('Error while performing XMLHttpRequest.setRequestHeader()', e); }
    }
    try {
        var body = null;
        if (body_ptr) {
            var start = body_ptr >>> 0;
            body = HEAPU8.slice(start, start + body_len);
        }
        xhr.send(body);
    } catch (e) {
        return 0;
    }
    // Only a network error or a CORS refusal has status 0; every HTTP response, 4xx and 5xx included, comes back with
    // its headers and body, which callers such as OAuth flows and the Iceberg REST catalog read
    var status = xhr.status;
    if (status === 0) return 0;
    var response = xhr.response ? new Uint8Array(xhr.response) : new Uint8Array(0);
    var headers = new TextEncoder().encode(xhr.getAllResponseHeaders() || '');
    var buffer = _malloc(2 + 4 + headers.length + 4 + response.length) >>> 0;
    if (buffer === 0) return 0;
    var o = buffer;
    HEAPU8[o] = status & 0xFF; HEAPU8[o + 1] = (status >> 8) & 0xFF; o += 2;
    HEAPU8[o] = headers.length & 0xFF; HEAPU8[o + 1] = (headers.length >> 8) & 0xFF;
    HEAPU8[o + 2] = (headers.length >> 16) & 0xFF; HEAPU8[o + 3] = (headers.length >>> 24) & 0xFF; o += 4;
    HEAPU8.set(headers, o); o += headers.length;
    HEAPU8[o] = response.length & 0xFF; HEAPU8[o + 1] = (response.length >> 8) & 0xFF;
    HEAPU8[o + 2] = (response.length >> 16) & 0xFF; HEAPU8[o + 3] = (response.length >>> 24) & 0xFF; o += 4;
    HEAPU8.set(response, o);
    return buffer;
});
// clang-format on

//===--------------------------------------------------------------------===//
// HTTPWasmClient
//===--------------------------------------------------------------------===//

class HTTPWasmClient : public HTTPClient {
   public:
    explicit HTTPWasmClient(const string &proto_host_port) : HTTPClient(proto_host_port), host_port(proto_host_port) {}
    void Initialize(HTTPParams &) override {}
    string host_port;

    unique_ptr<HTTPResponse> Get(GetRequestInfo &info) override {
        auto res = Perform(info, "GET");
        if (res->HasRequestError() || res->IsCancelled()) {
            return res;
        }
        if (info.response_handler && !info.response_handler(*res)) {
            return res;
        }
        // A range read answers 206 Partial Content; both it and 200 deliver the body
        if ((res->status == HTTPStatusCode::OK_200 || res->status == HTTPStatusCode::PartialContent_206) &&
            info.content_handler && !res->body.empty()) {
            info.content_handler(reinterpret_cast<const_data_ptr_t>(res->body.data()), res->body.size());
        }
        return res;
    }
    unique_ptr<HTTPResponse> Head(HeadRequestInfo &info) override { return Perform(info, "HEAD"); }
    unique_ptr<HTTPResponse> Post(PostRequestInfo &info) override {
        auto res = Perform(info, "POST", reinterpret_cast<const char *>(info.buffer_in), info.buffer_in_len);
        if (res->Success()) {
            info.buffer_out += res->body;
        }
        return res;
    }
    unique_ptr<HTTPResponse> Put(PutRequestInfo &info) override {
        // Neither XHR nor fetch adds a Content-Type for a binary body. S3 signs one into a PUT without passing it as a
        // header (application/octet-stream when the caller names none), so it must be sent
        HTTPHeaders headers = info.headers;
        if (!headers.HasHeader("Content-Type")) {
            headers.Insert("Content-Type", info.content_type.empty() ? "application/octet-stream" : info.content_type);
        }
        return Perform(info, "PUT", reinterpret_cast<const char *>(info.buffer_in), info.buffer_in_len, &headers);
    }
    unique_ptr<HTTPResponse> Delete(DeleteRequestInfo &info) override { return Perform(info, "DELETE"); }
    unique_ptr<HTTPResponse> Options(OptionsRequestInfo &info) override {
        // FIXME: implement OPTIONS requests
        throw NotImplementedException("OPTIONS requests are not supported in DuckDB-Wasm");
    }

   private:
    /// Every method goes through here. A request whose query was interrupted (HTTPUtil::CancellationRequested) is not
    /// sent, and a cancelled response is terminal: the retry loop does not repeat it.
    unique_ptr<HTTPResponse> Perform(BaseRequest &info, const char *method, const char *body = nullptr,
                                     idx_t body_len = 0, const HTTPHeaders *headers = nullptr) {
        if (HTTPUtil::CancellationRequested(info)) {
            return Cancelled(method);
        }
        auto url = NormalizeUrl(info.url, host_port);
        WasmHeaderArray h(headers ? *headers : info.headers);
        return ParseWasmResponse(
            duckdb_web_http_xhr(url.c_str(), method, h.count, h.ptrs, body, static_cast<int>(body_len)));
    }

    static unique_ptr<HTTPResponse> Cancelled(const char *method) {
        auto res = make_uniq<HTTPResponse>(HTTPStatusCode::INVALID);
        res->cancelled = true;
        res->request_error = StringUtil::Format("HTTP %s request was cancelled", method);
        return res;
    }
};

unique_ptr<HTTPClient> HTTPWasmUtil::InitializeClient(HTTPParams &, const string &proto_host_port) {
    return make_uniq<HTTPWasmClient>(proto_host_port);
}

string HTTPWasmUtil::GetName() const { return "WasmHTTPUtils"; }

static void RegisterHTTPWasmClient(DatabaseInstance &db) { db.config.SetHTTPUtil(make_shared_ptr<HTTPWasmUtil>()); }

}  // namespace duckdb

//! The HTTP client of DuckDB-Wasm, on XMLHttpRequest in browsers and a child process in NodeJS. It takes the place of
//! DuckDB's httplib capability, which is not linked, and registers under the same name for every database opened
//! afterwards. Extensions such as httpfs use it through HTTPUtil and provide no client of their own.
extern "C" int32_t duckdb_extension_httplib_describe(duckdb_extension_descriptor *descriptor) {
    if (descriptor->version < 2) {
        descriptor->set_error(descriptor, "httplib needs descriptor layout 2");
        return 1;
    }
    descriptor->version = 2;
    descriptor->name = "httplib";
    descriptor->database_callback = reinterpret_cast<void (*)(void)>(duckdb::RegisterHTTPWasmClient);
    return 0;
}
