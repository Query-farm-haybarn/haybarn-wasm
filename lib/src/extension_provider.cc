#include "duckdb/web/extension_provider.h"

#include <dlfcn.h>
#include <emscripten.h>

#include <cstdio>
#include <vector>

#include "duckdb/common/exception.hpp"
#include "duckdb/common/file_system.hpp"
#include "duckdb/common/string_util.hpp"
#include "duckdb/main/config.hpp"
#include "duckdb/main/database.hpp"
#include "duckdb/main/error_manager.hpp"
#include "duckdb/main/extension.hpp"
#include "duckdb/main/extension_helper.hpp"
#include "duckdb/main/extension_repository_manager.hpp"
#include "duckdb/main/settings.hpp"
#include "duckdb/web/main_thread.h"
#include "mbedtls_wrapper.hpp"

namespace duckdb {
namespace web {

namespace {

constexpr const char* EXTENSION_SUFFIX = ".duckdb_extension.wasm";

/// The chunk size of the engine's two-level signature hash (extension_load.cpp)
constexpr idx_t SIGNATURE_HASH_CHUNK_SIZE = 1024 * 1024;

/// An extension fetched into emscripten's file system. The file system owns the downloaded bytes, so they are never
/// copied onto the wasm heap (which never shrinks): dlopen reads them from the file, and the file is removed once
/// dlopen has compiled it, or when the load fails.
struct FetchedExtension {
    /// The path of the file
    string path;
    /// The size of the file
    idx_t size = 0;
    /// The metadata footer at the end of the file, signature included
    char footer[ParsedExtensionMetaData::FOOTER_SIZE] = {0};
    /// The worker prefetched the file: the two-level signature hash it computed with WebCrypto (32 bytes) and whether
    /// it holds a module compiled from the same bytes
    char prefetched_hash[32] = {0};
    bool has_prefetched_hash = false;
    bool has_prefetched_module = false;

    ~FetchedExtension() {
        if (path.empty()) return;
        // Removes the file and drops a compiled module that was never used, after a failed load
        main_thread::OnMainThread([&] {
            // clang-format off
            EM_ASM({
                globalThis.__haybarnPendingModule = null;
                try { FS.unlink(UTF8ToString($0)); } catch (e) {}
            }, path.c_str());
            // clang-format on
        });
    }
};

/// Fetch an extension synchronously into the file at `out.path`, either from the worker's prefetched extensions, or
/// through XHR (web workers), or through the file system or a child process (NodeJS). Returns false if the extension
/// could not be fetched. Runs on the main thread, where the prefetched extensions are.
bool FetchExtension(const string& url, FetchedExtension& out) {
    int has_hash = 0;
    int has_module = 0;
    // clang-format off
    double size = EM_ASM_DOUBLE(
        {
            var url = UTF8ToString($0);
            var path = UTF8ToString($1);
            var bytes;
            globalThis.__haybarnPendingModule = null;
            // The worker may have prefetched this URL and hashed it with WebCrypto, over these same bytes. Taking the
            // entry removes it, so each prefetch serves one load.
            var take = globalThis.__haybarnTakePrefetchedExtension;
            var pre = typeof take === "function" ? take(url) : null;
            // Another thread may have grown the memory
            var heap = () => {
                if (typeof growMemViews === "function") growMemViews();
                return HEAPU8;
            };
            try {
                if (pre) {
                    bytes = pre.bytes;
                    if (pre.hash && pre.hash.length == 32) {
                        heap().set(pre.hash, $3 >>> 0);
                        heap()[$4 >>> 0] = 1;
                    }
                    if (pre.module) {
                        // dlopen only gets it once the signature has been checked, see OpenFetchedExtension
                        // (parenthesized: the preprocessor splits macro arguments at commas between braces)
                        globalThis.__haybarnPendingModule = ({ name: path, module: pre.module, bytes: pre.bytes });
                        heap()[$5 >>> 0] = 1;
                    }
                } else if (typeof XMLHttpRequest === "undefined") {
                    if (url.startsWith("http://") || url.startsWith("https://")) {
                        var script =
                            "fetch(process.argv[1]).then(r=>{if(!r.ok)process.exit(2);return r.arrayBuffer()})" +
                            ".then(b=>process.stdout.write(Buffer.from(b)),()=>process.exit(3))";
                        bytes = require("node:child_process").execFileSync(process.execPath, ["-e", script, url], {
                            maxBuffer: 1073741824,
                            stdio: ["ignore", "pipe", "ignore"]
                        });
                    } else {
                        bytes = require("node:fs").readFileSync(url);
                    }
                } else if (typeof document === "undefined") {
                    // A worker: a synchronous request with a binary response
                    var xhr = new XMLHttpRequest();
                    xhr.open("GET", url, false);
                    xhr.responseType = "arraybuffer";
                    xhr.send(null);
                    if (xhr.status != 200) return -1;
                    bytes = new Uint8Array(xhr.response);
                } else {
                    // The main thread of a page (blocking bindings) refuses a synchronous request with a binary
                    // response type: the bytes come as a text of code points below 256
                    var xhr = new XMLHttpRequest();
                    xhr.open("GET", url, false);
                    xhr.overrideMimeType("text/plain; charset=x-user-defined");
                    xhr.send(null);
                    if (xhr.status != 200) return -1;
                    var text = xhr.responseText;
                    bytes = new Uint8Array(text.length);
                    for (var i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
                }
                // The file takes the downloaded bytes as they are, without a copy
                FS.writeFile(path, bytes, { canOwn: true });
            } catch (e) {
                globalThis.__haybarnPendingModule = null;
                return -1;
            }
            var footerSize = $6;
            if (bytes.byteLength >= footerSize) {
                heap().set(bytes.subarray(bytes.byteLength - footerSize), $2 >>> 0);
            }
            return bytes.byteLength;
        },
        url.c_str(), out.path.c_str(), out.footer, out.prefetched_hash, &has_hash, &has_module,
        static_cast<int>(ParsedExtensionMetaData::FOOTER_SIZE));
    // clang-format on
    if (size < 0) {
        // Nothing was written
        out.path.clear();
        return false;
    }
    out.size = static_cast<idx_t>(size);
    out.has_prefetched_hash = has_hash != 0;
    out.has_prefetched_module = has_module != 0;
    return true;
}

/// The engine's two-level signature hash of a fetched extension: the SHA-256 of the SHA-256 digests of each 1 MiB
/// chunk of the file before its signature. The chunks are read from the file one at a time. Runs on the main thread,
/// where the file system is.
string HashFetchedExtension(const FetchedExtension& extension) {
    auto signed_size = extension.size - ParsedExtensionMetaData::SIGNATURE_SIZE;
    std::vector<char> chunk(MinValue<idx_t>(SIGNATURE_HASH_CHUNK_SIZE, MaxValue<idx_t>(signed_size, 1)));
    string digests;
    char digest[duckdb_mbedtls::MbedTlsWrapper::SHA256_HASH_LENGTH_BYTES];
    auto file = fopen(extension.path.c_str(), "rb");
    if (!file) return string();
    for (idx_t offset = 0; offset < signed_size; offset += SIGNATURE_HASH_CHUNK_SIZE) {
        auto length = MinValue<idx_t>(SIGNATURE_HASH_CHUNK_SIZE, signed_size - offset);
        if (fread(chunk.data(), 1, length, file) != length) {
            fclose(file);
            return string();
        }
        duckdb_mbedtls::MbedTlsWrapper::ComputeSha256Hash(chunk.data(), length, digest);
        digests.append(digest, sizeof(digest));
    }
    fclose(file);
    duckdb_mbedtls::MbedTlsWrapper::ComputeSha256Hash(digests.data(), digests.size(), digest);
    return string(digest, sizeof(digest));
}

/// Open a fetched extension as side module. A module the worker compiled while prefetching the same bytes is handed
/// to dlopen only now, after the signature check, so dlopen doesn't compile it again (scripts/patch_dylink_glue.cjs).
///
/// emscripten's dlopen reads a file it finds into linear memory, for other threads to load the module from, and never
/// frees that copy. Without pthreads there are no other threads: the module is compiled here from the file's bytes
/// (or taken from the prefetch), the file is removed and dlopen takes the module, so no copy of the extension stays
/// on the heap. With pthreads the running threads load the module from that copy, so dlopen reads the file.
void* OpenFetchedExtension(FetchedExtension& extension) {
#if defined(__EMSCRIPTEN_PTHREADS__)
    constexpr int compile_here = 0;
#else
    constexpr int compile_here = 1;
#endif
    // clang-format off
    EM_ASM({
        var path = UTF8ToString($0);
        var armed = globalThis.__haybarnPendingModule || null;
        globalThis.__haybarnPendingModule = null;
        if ($1) {
            try {
                if (!armed) {
                    var node = FS.lookupPath(path).node;
                    var bytes = node.contents.subarray(0, node.usedBytes);
                    armed = ({ name: path, module: new WebAssembly.Module(bytes), bytes: bytes });
                }
                FS.unlink(path);
            } catch (e) {
                // Not compilable here (e.g. too large on a page's main thread): dlopen reads the file and reports
                // what is wrong with it
                armed = null;
            }
        }
        globalThis.__haybarnArmedModule = armed;
    }, extension.path.c_str(), compile_here);
    // clang-format on
    auto handle = dlopen(extension.path.c_str(), RTLD_NOW | RTLD_LOCAL);
    // clang-format off
    EM_ASM({
        globalThis.__haybarnArmedModule = null;
        try { FS.unlink(UTF8ToString($0)); } catch (e) {}
    }, extension.path.c_str());
    // clang-format on
    extension.path.clear();
    return handle;
}

/// The repositories maintained by DuckDB are also served over https, which is required on https sites. So is the
/// Haybarn repository: the engine names it with http:// so the native bootstrap install of httpfs works without TLS,
/// but a page cannot fetch a http:// subresource, and a cross-origin isolated one blocks it outright.
string UpgradeToHTTPS(const string& url) {
    const string prefix = "http://";
    if (!StringUtil::StartsWith(url, prefix)) {
        return url;
    }
    auto host = url.substr(prefix.size(), url.find('/', prefix.size()) - prefix.size());
    if (!StringUtil::EndsWith(host, ".duckdb.org") && host != "haybarn-extensions.query.farm") {
        return url;
    }
    return "https://" + url.substr(prefix.size());
}

/// The URL template of an extension in a repository. The layout is the engine's (Haybarn puts a pinned version
/// below the platform: ${REVISION}/${PLATFORM}/${NAME}/<version>/), but DuckDB is built without
/// WASM_LOADABLE_EXTENSIONS and names the gzipped native file, so its suffix is swapped for the wasm one.
string ExtensionUrlTemplate(DatabaseInstance& db, const ExtensionRepository& repository, const string& version) {
    ExtensionRepository https_repository = repository;
    https_repository.path = UpgradeToHTTPS(repository.path);
    auto url_template = ExtensionHelper::ExtensionUrlTemplate(&db, https_repository, version);
    if (StringUtil::EndsWith(url_template, EXTENSION_SUFFIX)) {
        return url_template;
    }
    const string native_suffix = ".duckdb_extension.gz";
    if (!StringUtil::EndsWith(url_template, native_suffix)) {
        throw InternalException("Unexpected extension URL template \"%s\"", url_template);
    }
    return url_template.substr(0, url_template.size() - native_suffix.size()) + EXTENSION_SUFFIX;
}

}  // namespace

string WasmExtensionProvider::GetName() const { return "wasm"; }

bool WasmExtensionProvider::SupportsExternalExtensions() const { return true; }

bool WasmExtensionProvider::UsesExtensionDirectory() const { return false; }

unique_ptr<ExtensionInstallInfo> WasmExtensionProvider::Install(DatabaseInstance& db, FileSystem& fs,
                                                                const string& local_path, const string& extension,
                                                                ExtensionInstallOptions& options,
                                                                optional_ptr<ClientContext> context) {
    // Nothing is stored, but an explicit repository is remembered for when the extension is loaded, and so is a
    // version pin. Installing again without a version drops the pin, as a native reinstall would.
    if (ExtensionHelper::IsFullPath(extension)) {
        return nullptr;
    }
    auto extension_name = ExtensionHelper::ApplyExtensionAlias(StringUtil::Lower(extension));
    std::lock_guard<std::mutex> guard{mutex_};
    if (options.repository) {
        installed_repositories_[extension_name] = *options.repository;
    }
    if (options.version.empty()) {
        installed_versions_.erase(extension_name);
    } else {
        installed_versions_[extension_name] = options.version;
    }
    return nullptr;
}

bool WasmExtensionProvider::ResolveExtension(DatabaseInstance& db, FileSystem& fs, const string& extension,
                                             const string& repository_name, ResolvedExtension& out, string& error) {
    out.direct_load = ExtensionHelper::IsFullPath(extension);
    if (out.direct_load) {
        if (!repository_name.empty()) {
            error = "Cannot combine a FROM repository with a file path";
            return false;
        }
        if (!StringUtil::EndsWith(extension, EXTENSION_SUFFIX)) {
            throw PermissionException(
                "DuckDB-Wasm extensions are files ending with '%s', loading different files is not possible, error "
                "while loading from '%s'",
                EXTENSION_SUFFIX, extension);
        }
        out.name = ExtensionHelper::GetExtensionName(extension);
        out.url = extension;
        return true;
    }
    out.name = ExtensionHelper::ApplyExtensionAlias(StringUtil::Lower(extension));
    if (!repository_name.empty()) {
        // LOAD x FROM repository
        if (!ExtensionRepositoryManager::TryGetRepository(db, fs, repository_name, out.repository) &&
            !ExtensionRepository::TryGetKnownRepository(repository_name, out.repository)) {
            error = StringUtil::Format("'%s' is not a known extension repository", repository_name);
            return false;
        }
    } else {
        std::lock_guard<std::mutex> guard{mutex_};
        auto installed = installed_repositories_.find(out.name);
        if (installed != installed_repositories_.end()) {
            out.repository = installed->second;
        } else {
            out.repository = ExtensionHelper::GetAutoinstallRepository(db);
        }
    }
    {
        std::lock_guard<std::mutex> guard{mutex_};
        auto pinned = installed_versions_.find(out.name);
        if (pinned != installed_versions_.end()) {
            out.version = pinned->second;
        }
    }
    auto url_template = ExtensionUrlTemplate(db, out.repository, out.version);
    out.url = ExtensionHelper::ExtensionFinalizeUrlTemplate(url_template, out.name);
    return true;
}

string WasmExtensionProvider::ExtensionUrl(DatabaseInstance& db, const string& extension) {
    ResolvedExtension resolved;
    string error;
    if (!ResolveExtension(db, FileSystem::GetFileSystem(db), extension, string(), resolved, error)) {
        throw InvalidInputException(error);
    }
    return resolved.url;
}

bool WasmExtensionProvider::TryInitialLoad(DatabaseInstance& db, FileSystem& fs, const string& extension,
                                           const string& repository_name, bool core_only, ExtensionInitResult& result,
                                           string& error) {
    ResolvedExtension resolved;
    if (!ResolveExtension(db, fs, extension, repository_name, resolved, error)) {
        return false;
    }
    bool direct_load = resolved.direct_load;
    auto& extension_name = resolved.name;
    auto& url = resolved.url;
    auto& repository = resolved.repository;
    auto& version = resolved.version;

    // The fetch and the load run on the main thread: with pthreads this executes on the query thread, whose
    // JavaScript context (and emscripten file system) is its own, and dlopen is served by the main thread anyway
    FetchedExtension fetched;
    fetched.path = "/" + extension_name + EXTENSION_SUFFIX;
    if (!main_thread::OnMainThread([&] { return FetchExtension(url, fetched); })) {
        error = StringUtil::Format("Extension \"%s\" could not be fetched from \"%s\"", extension_name, url);
        return false;
    }
    if (fetched.size < ParsedExtensionMetaData::FOOTER_SIZE) {
        throw InvalidInputException(
            "File '%s' is not a DuckDB extension. Valid DuckDB extensions must be at least %llu bytes", url,
            ParsedExtensionMetaData::FOOTER_SIZE);
    }

    // Parse the extension metadata from the extension binary
    auto parsed_metadata = ExtensionHelper::ParseExtensionMetaData(fetched.footer);
    auto metadata_mismatch_error = parsed_metadata.GetInvalidMetadataError();
    if (!metadata_mismatch_error.empty()) {
        metadata_mismatch_error = StringUtil::Format("Failed to load '%s', %s", extension, metadata_mismatch_error);
    }

    if (!Settings::Get<AllowUnsignedExtensionsSetting>(db)) {
        // A bare load only trusts the core and community keys, a repository has to be named for its own keys
        bool bare_load = repository_name.empty();
        auto recorded_origin = direct_load ? ExtensionRepositoryType::CORE : repository.type;
        auto trusted_origin = ExtensionHelper::ResolveTrustedSignatureOrigin(!bare_load, core_only, recorded_origin);
        auto signing_repository_name = trusted_origin == recorded_origin ? repository.name : string();

        bool signature_valid = false;
        if (parsed_metadata.AppearsValid()) {
            // The worker hashed a prefetched file with WebCrypto, over the same bytes. Otherwise hash the file
            // chunk by chunk, so it isn't read onto the heap in one piece.
            auto hash = fetched.has_prefetched_hash
                            ? string(fetched.prefetched_hash, sizeof(fetched.prefetched_hash))
                            : main_thread::OnMainThread([&] { return HashFetchedExtension(fetched); });
            string signature(fetched.footer + ParsedExtensionMetaData::FOOTER_SIZE -
                                 ParsedExtensionMetaData::SIGNATURE_SIZE,
                             ParsedExtensionMetaData::SIGNATURE_SIZE);
            signature_valid = ExtensionHelper::CheckExtensionHashSignature(db, hash, signature, trusted_origin,
                                                                           signing_repository_name);
        }
        if (!metadata_mismatch_error.empty()) {
            throw InvalidInputException(metadata_mismatch_error);
        }
        if (!signature_valid) {
            throw IOException(db.config.error_manager->FormatException(ErrorType::UNSIGNED_EXTENSION, url));
        }
    } else if (!Settings::Get<AllowExtensionsMetadataMismatchSetting>(db)) {
        if (!metadata_mismatch_error.empty()) {
            throw InvalidInputException(metadata_mismatch_error);
        }
    }

    auto lib_hdl = main_thread::OnMainThread([&] { return OpenFetchedExtension(fetched); });
    if (!lib_hdl) {
        throw IOException("Extension \"%s\" could not be loaded: %s", url, GetLibraryError());
    }

    result.filebase = extension_name;
    result.filename = url;
    result.lib_hdl = lib_hdl;
    result.abi_type = parsed_metadata.abi_type;
    result.duckdb_capi_version = parsed_metadata.duckdb_capi_version;
    result.install_info = make_uniq<ExtensionInstallInfo>();
    result.install_info->full_path = url;
    result.install_info->version = parsed_metadata.extension_version;
    if (direct_load) {
        result.install_info->mode = ExtensionInstallMode::NOT_INSTALLED;
    } else {
        result.install_info->mode = ExtensionInstallMode::REPOSITORY;
        result.install_info->repository_url = repository.path;
        result.install_info->repository_type = repository.type;
        result.install_info->repository_name = repository.name;
        result.install_info->pinned_version = version;
    }
    return true;
}

void* WasmExtensionProvider::OpenLibrary(const string& filename, const string& filebase) {
    throw InternalException("WasmExtensionProvider opens extensions in TryInitialLoad");
}

void* WasmExtensionProvider::TryLoadFunction(void* library, const string& function_name) {
    return dlsym(library, function_name.c_str());
}

string WasmExtensionProvider::GetLibraryError() {
    auto message = dlerror();
    return message ? string(message) : string();
}

}  // namespace web
}  // namespace duckdb
