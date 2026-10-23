#ifndef INCLUDE_DUCKDB_WEB_EXTENSION_PROVIDER_H_
#define INCLUDE_DUCKDB_WEB_EXTENSION_PROVIDER_H_

#include <mutex>
#include <unordered_map>

#include "duckdb/main/extension/external_extension_provider.hpp"
#include "duckdb/main/extension_install_info.hpp"

namespace duckdb {
namespace web {

/// Loads external extensions in DuckDB-Wasm.
/// There is no local extension directory: INSTALL only remembers the repository (and the version, for
/// INSTALL ... VERSION) an extension should come from, LOAD fetches the extension from its repository, verifies it
/// and opens it as a side module.
class WasmExtensionProvider : public ExternalExtensionProvider {
   public:
    string GetName() const override;
    bool SupportsExternalExtensions() const override;
    bool UsesExtensionDirectory() const override;
    unique_ptr<ExtensionInstallInfo> Install(DatabaseInstance &db, FileSystem &fs, const string &local_path,
                                             const string &extension, ExtensionInstallOptions &options,
                                             optional_ptr<ClientContext> context) override;
    bool TryInitialLoad(DatabaseInstance &db, FileSystem &fs, const string &extension, const string &repository_name,
                        bool core_only, ExtensionInitResult &result, string &error) override;
    void *OpenLibrary(const string &filename, const string &filebase) override;
    void *TryLoadFunction(void *library, const string &function_name) override;
    string GetLibraryError() override;

    /// The URL `LOAD <extension>` fetches, with the repository and version it would use
    string ExtensionUrl(DatabaseInstance &db, const string &extension);

   private:
    /// Where an extension is loaded from
    struct ResolvedExtension {
        bool direct_load = false;
        string name;
        string url;
        ExtensionRepository repository;
        string version;
    };
    /// Resolve the URL of `LOAD <extension> [FROM <repository_name>]`. Returns false with an error if the
    /// repository is unknown.
    bool ResolveExtension(DatabaseInstance &db, FileSystem &fs, const string &extension, const string &repository_name,
                          ResolvedExtension &out, string &error);

    /// Guards the installed repositories
    std::mutex mutex_;
    /// The repository each installed extension is to be loaded from
    std::unordered_map<string, ExtensionRepository> installed_repositories_;
    /// The version each installed extension is pinned to (Haybarn INSTALL ... VERSION)
    std::unordered_map<string, string> installed_versions_;
};

}  // namespace web
}  // namespace duckdb

#endif
