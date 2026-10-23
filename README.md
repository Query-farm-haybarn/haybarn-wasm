<div align="center">
  <h1>Haybarn-Wasm</h1>
  <p><em>Haybarn for WebAssembly — Haybarn, powered by DuckDB.</em></p>
</div>

<div align="center">
  <a href="https://www.npmjs.com/package/@haybarn/haybarn-wasm/v/latest">
    <img src="https://img.shields.io/npm/v/@haybarn/haybarn-wasm?logo=npm" alt="haybarn-wasm package on NPM">
  </a>
  <a href="https://github.com/Query-farm-haybarn/haybarn-wasm/actions">
    <img src="https://github.com/Query-farm-haybarn/haybarn-wasm/actions/workflows/main.yml/badge.svg?branch=haybarn-2.0" alt="Github Actions Badge">
  </a>
  <a href="https://haybarn-status.query.farm">
    <img src="https://img.shields.io/badge/status-haybarn--status.query.farm-58a6ff" alt="Haybarn build status">
  </a>
</div>
<h1></h1>

Haybarn is a derived distribution of [DuckDB](https://duckdb.org), the
in-process SQL OLAP database, published by Query Farm LLC. Haybarn-Wasm is the
WebAssembly distribution of Haybarn — the same engine, compiled for browsers
and Node.js, with the Haybarn extension repository wired in by default.

This is a hard fork of [duckdb/duckdb-wasm](https://github.com/duckdb/duckdb-wasm),
re-pointed at the [Haybarn engine](https://github.com/Query-farm-haybarn/haybarn)
submodule so the resulting wasm binary loads extensions from
`haybarn-extensions.query.farm` (Haybarn's extension repository) rather than
upstream's `extensions.duckdb.org`, and verifies them against the Haybarn
signing key.

## Install

```bash
npm install @haybarn/haybarn-wasm
```

The package exposes the same API surface as `@duckdb/duckdb-wasm`. Existing
duckdb-wasm consumer code can be ported by rewriting the import:

```ts
// before
import * as duckdb from '@duckdb/duckdb-wasm';

// after
import * as duckdb from '@haybarn/haybarn-wasm';
```

See [HAYBARN.md](HAYBARN.md) for the relationship to upstream duckdb-wasm,
the patch stack, and how to rebase onto a newer upstream.

## Haybarn engine version

This branch (`haybarn-2.0`) is built on the Haybarn engine tag
`haybarn-v2.0.0-rc5`: DuckDB v2.0.0 plus the Haybarn patch stack (extension
repository, trust root, branding). The 1.5 line lives on the `haybarn` branch.

## Wasm bundles

Haybarn-Wasm 2.0 ships the same two bundles as upstream duckdb-wasm 2.0:

| Bundle    | What you get | Extension platform | Hosting requirement |
|-----------|--------------|--------------------|---------------------|
| `base`    | WebAssembly with native exception handling | `wasm_eh` | None |
| `threads` | Exception handling + threads + SIMD via SharedArrayBuffer | `wasm_threads` | [Cross-origin isolation](https://developer.mozilla.org/en-US/docs/Web/API/Window/crossOriginIsolated) (COOP `same-origin`, COEP `require-corp`) |

The 1.5 `mvp`, `eh` and `coi` bundles are gone (upstream dropped them in 2.0).
`selectBundle()` picks the best bundle the browser can run.

## Loading extensions

Extensions are fetched from the Haybarn extension repository and checked
against the Haybarn signing key before they load:

```sql
INSTALL httpfs;             -- https://haybarn-extensions.query.farm/core/v2.0.0/wasm_eh/httpfs.duckdb_extension.wasm
LOAD httpfs;

INSTALL h3 FROM community;  -- .../community/v2.0.0/wasm_eh/h3.duckdb_extension.wasm
LOAD h3;
```

For the full extension catalog and per-platform availability, see
[haybarn-status.query.farm](https://haybarn-status.query.farm).

## Build from source

The build requires:

* Node.js and npm. Node.js 24 is required for the current browser test tooling.
* Yarn Classic. This repository uses a Yarn v1 lockfile.
* Emscripten 6.0.13 or a compatible 6.0.x release, CMake, and ccache.
* Rust and rustup for building the shell.
* The DuckDB CLI when generating the complete test dataset.

Install Yarn Classic and the Rust Wasm target before starting the build:

```shell
npm install --global yarn@1.22.22
yarn --version
rustup target add wasm32-unknown-unknown
```

```shell
git clone -b haybarn-2.0 https://github.com/Query-farm-haybarn/haybarn-wasm.git
cd haybarn-wasm
git submodule init
git submodule update
make apply_patches
make build_loadable TARGET=threads
make serve
```

During the Wasm build, the build script checks for `js-beautify` and installs
it globally with npm if it is missing. The initial
`js-beautify: command not found` message is therefore expected when the tool
is not already installed.

If the build stops with `make: yarn: No such file or directory`, install Yarn
Classic using the command above and run `make serve` again. There is no need
to run `make apply_patches` again.

The JavaScript bundle requires both the base and threaded Wasm bindings.
`make build_loadable TARGET=threads` generates the threaded bindings before
`make serve`. The `serve` target also ensures that both variants are built.

Node.js 26 can build the shell and application, but it is not currently
supported by the Karma/Puppeteer test toolchain and can fail with
`require is not defined in ES module scope` or a missing yargs module. Use
Node.js 24 when running browser tests.

Some browser tests require generated data files. Generate the small university
dataset used by the threads smoke test with:

```shell
./scripts/generate_uni.sh
```

Use `make build/data` to generate all test datasets. The data generator first
uses `DUCKDB_SHELL` when set, then looks for a native DuckDB CLI built in the
DuckDB submodule, and finally falls back to `duckdb` on `PATH`. CMake policy
warnings, Rust deprecation warnings, TypeDoc warnings, and Webpack asset-size
warnings may appear during a successful build; they are non-fatal if the
command exits successfully.

The development server uses port 8080 when available. If that port is already
in use, `http-server` selects another port; open the URL printed under
`Available on` in the terminal.

### Develop HTTPFS locally

HTTPFS is loaded as a separate Wasm side module. Build it with the same DuckDB
revision, Emscripten toolchain, and platform settings as the DuckDB-Wasm main
module.

Keep the HTTPFS checkout outside the generated `build/` directory. From the
DuckDB-Wasm repository, run:

```shell
make build_httpfs_local DUCKDB_HTTPFS_DIRECTORY=$PWD/duckdb-httpfs
```

`DUCKDB_HTTPFS_DIRECTORY` must point to the HTTPFS source root that contains
its top-level `CMakeLists.txt`. The target:

* validates and converts the path to an absolute path;
* reconfigures existing base and threaded builds to use that checkout;
* builds both DuckDB-Wasm main modules and HTTPFS side modules; and
* rebuilds the JavaScript package.

During configuration, confirm that CMake reports the expected source:

```text
Load extension 'httpfs' from local path ".../duckdb-httpfs"
```

The generated HTTPFS modules are placed at:

```text
build/extension_repository/<duckdb-revision>/wasm_eh/httpfs.duckdb_extension.wasm
build/extension_repository/<duckdb-revision>/wasm_threads/httpfs.duckdb_extension.wasm
```

#### Load the local extension in a browser

Local extension builds are unsigned. Configure both the local repository and
the unsigned-extension policy before opening the database.

For the React application:

```tsx
<DuckDBProvider
    config={{
        allowUnsignedExtensions: true,
        extensionRepository: `${window.location.origin}/extension_repository`,
    }}
>
```

For the direct JavaScript API:

```ts
await db.open({
    allowUnsignedExtensions: true,
    extensionRepository: new URL('/extension_repository', location.href).href,
});
```

These are startup options. SQL cannot enable unsigned extensions after the
database has been opened.

Build the modules, prepare the application, copy the local extension
repository, and start the development server with:

```shell
make serve_httpfs_local DUCKDB_HTTPFS_DIRECTORY=$PWD/duckdb-httpfs
```

The target opens `/index.html`. Use a fresh browser tab after rebuilding so
an older worker does not keep stale modules, then run:

```sql
INSTALL AND LOAD httpfs;
```

#### Troubleshooting

* A request to `https://haybarn-extensions.query.farm` means that the local
  `extensionRepository` setting was not applied.
* An unsigned-extension error means that `allowUnsignedExtensions` was not
  enabled before opening the database.
* An OpenSSL or `curl/curl.h` error means that the selected HTTPFS revision
  does not contain the required Emscripten build guards.
* The warning that HTTPFS has a `vcpkg.json` but the build does not use vcpkg
  is expected for this Emscripten build.

### Rebuild the web shell

After changing the Rust shell, rebuild both the shell package and the
application that embeds its Wasm file:

```shell
yarn workspace @haybarn/haybarn-wasm-shell build:debug
yarn workspace @haybarn/haybarn-wasm-app build:release
cp -R build/extension_repository packages/duckdb-wasm-app/build/release/
npx http-server packages/duckdb-wasm-app/build/release -c-1 -a 127.0.0.1 -p 8081
```

Open `/index.html` at the URL printed by `http-server` and hard-refresh the
page. The `-c-1` option disables the development server cache so an existing
browser does not reuse an older shell Wasm file or worker. Running `make serve`
performs the same rebuild as part of the complete build.

### Local build troubleshooting log

| Failure | Cause | Fix |
| ------- | ----- | --- |
| `duckdb-threads.js: No such file or directory` | Only the base Wasm binding was built. | Run `make build_loadable TARGET=threads`. The `serve` target now builds both base and threaded bindings. |
| `duckdb-threads.pthread.js: No such file or directory` | Emscripten 6 uses the main threads worker for pthreads and no longer emits the legacy file. | The bundler now creates the legacy filename as a compatibility alias of the main threads worker. |
| A repeated Wasm build fails while patching `markAsFinished` | The generated Emscripten glue had already been patched. | The glue patch is now idempotent and safely handles repeated builds. |
| `chmod: duckdb: No such file or directory` during `make build/data` | The data script detected the DuckDB CLI but invoked a nonexistent submodule build. | The script now prefers `DUCKDB_SHELL`, then a native CLI built from the DuckDB submodule, and finally `duckdb` from `PATH`. |
| `Arrow file does not contain correct footer`, or result queries such as `SELECT 42` hang | The Rust web shell used Arrow `FileReader`, while DuckDB now returns an Arrow IPC stream. | The shell now uses `StreamReader` and returns decoding errors instead of panicking. Rebuild the shell and application using the commands above. |
| A fixed query starts hanging again after rebuilding | An existing browser tab may still be running a cached shell Wasm file or worker. | `make serve` now disables HTTP caching. Restart the server, close old DuckDB-Wasm tabs, and open `/index.html` again. |
| `failed to create temp dir for cargo install wasm-bindgen` | `wasm-pack` cannot write to its temporary or Cargo installation directory. | Run the build in an environment with writable temporary and Cargo directories. |
| `listen EPERM` or an occupied port while starting `http-server` | The environment prevents binding the requested port, or another process already uses it. | Allow local port binding or select another port, for example `-p 8091`. |
| Puppeteer/Karma fails under Node.js 26 | The current test dependencies are incompatible with Node.js 26. | Run browser tests with Node.js 24. This does not prevent building the shell and app with Node.js 26. |

## Repository structure

| Subproject                                                   | Description    | Language   |
| ------------------------------------------------------------ | :------------- | :--------- |
| [`lib`](/lib)                                                | Wasm library   | C++        |
| [`@haybarn/haybarn-wasm`](/packages/duckdb-wasm)             | TypeScript API (published) | TypeScript |
| [`@haybarn/haybarn-wasm-shell`](/packages/duckdb-wasm-shell) | SQL shell      | Rust       |
| [`@haybarn/haybarn-wasm-app`](/packages/duckdb-wasm-app)     | Shell app      | TypeScript |
| [`@haybarn/react-haybarn`](/packages/react-duckdb)           | React hooks    | TypeScript |

Only `@haybarn/haybarn-wasm` is published to npm; the other packages are
private. Directory names match the upstream duckdb-wasm tree so rebases stay
small.

## License

MIT, same as upstream. See [LICENSE](LICENSE) for the Stichting DuckDB
Foundation copyright on the original work, and [NOTICE](NOTICE) for the
Haybarn-specific attribution.

DuckDB is a trademark of the DuckDB Foundation. Haybarn is an independent
derived distribution published by Query Farm LLC and is not affiliated with,
endorsed by, or sponsored by the DuckDB Foundation.
