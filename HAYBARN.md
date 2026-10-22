# Haybarn-Wasm — fork structure & rebase notes

This repository is a **hard fork** of
[duckdb/duckdb-wasm](https://github.com/duckdb/duckdb-wasm). It is not
configured as a GitHub fork (no upstream "parent" relationship in the
GitHub UI), because we want the repository to read as an independent
project published by Query Farm LLC, not a derivative attached to the
upstream organization.

Git, however, still tracks upstream as a regular remote on every
developer's clone:

```
origin    https://github.com/Query-farm-haybarn/haybarn-wasm.git
upstream  https://github.com/duckdb/duckdb-wasm.git
```

## Branches

| Branch        | Line | Based on | Engine |
|---------------|------|----------|--------|
| `haybarn`     | 1.5  | upstream duckdb-wasm 1.5 | `haybarn-v1.5.*` |
| `haybarn-2.0` | 2.0  | upstream `main` at `1f85a503` (duckdb-wasm has no 2.0 tag; `main` pins DuckDB v2.0.0, `d54cbbe3df`) | `haybarn-v2.0.0-rc3` |

Each branch is a curated, linear stack of Haybarn commits on top of its
upstream base, one concern per commit.

## What the fork changes (2.0)

| Layer                         | Files / surface                          |
|-------------------------------|------------------------------------------|
| **Package rebrand**           | `package.json` (all workspaces), npm imports, Makefile, scripts, Rust shell crate `wasm_bindgen` module strings |
| **Engine submodule swap**     | `.gitmodules` (URL → `Query-farm-haybarn/haybarn`), `submodules/duckdb` pointer, `libhaybarn_static.a`, default version `v2.0.0` (`lib/cmake/duckdb.cmake`) |
| **Extension provider**        | `lib/src/extension_provider.cc`: https for `haybarn-extensions.query.farm`, `INSTALL … VERSION` pins |
| **Threads bundle loading**    | `patches/duckdb/extension_signature_hash_on_calling_thread.patch` (signature hashing without a thread per MiB); `patches/duckdb/wait_for_tasks_instead_of_spinning.patch` (a query thread that spun while a scheduler thread ran a `LOAD` never synced the side module, so the load deadlocked); the `SET threads=1` bracket around `LOAD`/`INSTALL` is opt-in (`DuckDBConfig.singleThreadedExtensionLoad`) |
| **Threads bundle pthread pool** | `lib/src/main_thread.cc`: strict pool (`PTHREAD_POOL_SIZE_STRICT=2`, a thread beyond it fails with `EAGAIN` instead of hanging), refilled between calls with the live threads plus 4 idle workers (at most 64) |
| **Toolchain**                 | emscripten 6.0.13 (same as the Haybarn 2.0 extension builds) |
| **Shell + app**               | Haybarn banner, default extensions at startup, Haybarn branding, Cloudflare Pages hosting (`_worker.js`, `_headers`) |
| **Docs**                      | `README.md`, `NOTICE`, `HAYBARN.md`, `CLAUDE.md`, package README |
| **CI**                        | `.github/workflows/main.yml`, `npm_tags.yml`, `.github/actions/haybarn-wasm-ci-env` |

The C++ library in `lib/`, the TypeScript bindings in
`packages/duckdb-wasm/src/`, and the public API are otherwise unchanged,
so duckdb-wasm consumer code ports via a single import rewrite
(`@duckdb/duckdb-wasm` → `@haybarn/haybarn-wasm`). This is the wasm-side
equivalent of the engine's "keep the `duckdb::` namespace" rule.

## What the fork does NOT change

* Public TypeScript API surface (class names, function names, types)
* The wasm platform strings (`wasm_eh` for `base`, `wasm_threads` for `threads`)
* Internal C++ symbols, `.duckdb_extension.wasm`, `DUCKDB_*` macros

## Not yet on the 2.0 line

The 1.5 line carries Haybarn runtime features that upstream 2.0 rewrote
the ground under (HTTP client, threading model, extension loading). They
are not ported yet:

* the VGI runtime: `worker:` SharedArrayBuffer transport, OAuth popup API,
  page-origin / Web Crypto js-stubs, the Iroh/httpi browser adapters, and the
  app's VGI bridges
* the EM_JS HTTP client rewrite with in-flight abort and the query interrupt flag
* SAB query cancellation, query progress binding (the single-threaded
  extension LOAD from the same series is ported)
* the dynamic-linking glue patches (lazy exports, global mutability, freeing
  side-module bytes), extension prefetch, code caching of the engine wasm
* the emscripten_yield override and the 1.5 COI pthread worker rewrite

Upstream 2.0 covers some of the same ground differently (extension loading
on the main thread, pending-query cancellation, the HTTP client registered
as httplib capability), so each needs re-deciding rather than a straight port.

## Rebasing onto a new upstream

1. `git fetch upstream`
2. Rebase the stack: `git rebase upstream/main haybarn-2.0` (most conflicts
   are in `package.json` files, `main.yml` and `README.md`)
3. Bump the engine submodule pointer if needed:

   ```bash
   git -C submodules/duckdb fetch --depth=1 origin tag <new-haybarn-tag>
   git -C submodules/duckdb checkout <new-haybarn-tag>
   git add submodules/duckdb
   ```

   and the default `DUCKDB_EXPLICIT_VERSION` in `lib/cmake/duckdb.cmake` and
   `OVERRIDE_GIT_DESCRIBE` in `main.yml` when the DuckDB release changes.
4. Bump `version` in every workspace `package.json` (and `yarn.lock`'s two
   workspace entries, `app.tsx`'s `HAYBARN_WASM_VERSION`, `_worker.js`'s
   engine path) to the new `<duckdb-version>-rc<N>`
5. Check `make apply_patches` still applies `patches/duckdb/*` to the engine
6. Let CI build and test before tagging

## Why a hard fork instead of using duckdb-wasm directly?

The trust root for extension installation is compiled into the engine.
An extension installed at runtime against a non-Haybarn build of
duckdb-wasm won't validate against Haybarn's signing key, and a Haybarn
extension built with a different emscripten won't link into a DuckDB-built
main module. To ship a coherent distribution where `INSTALL …` just works,
the wasm binary is compiled against our engine with our toolchain.

## License

MIT. See `LICENSE` (upstream copyright) and `NOTICE` (Haybarn attribution).
