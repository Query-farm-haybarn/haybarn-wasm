# Claude conventions — haybarn-wasm (2.0 line)

This is the Haybarn fork of duckdb-wasm. Read `HAYBARN.md` for the fork
structure; the notes below are the things to remember when making changes.

## Branches

`haybarn-2.0` is the 2.0 line (DuckDB v2.0.0). `haybarn` is the 1.5 line;
don't touch it from 2.0 work. Neither is `main`.

## Remotes

- `origin` → `Query-farm-haybarn/haybarn-wasm`
- `upstream` → `duckdb/duckdb-wasm` (for rebases only)

## What lives in the engine vs here

Changes to **the engine** (extension URLs, trust root, SQL features,
performance) go in
[Query-farm-haybarn/haybarn](https://github.com/Query-farm-haybarn/haybarn).
This repo is the wasm packaging layer. The engine source is at
`submodules/duckdb/`; never edit the submodule from here — change the engine
fork, then bump the pointer in its own commit. Wasm-only engine tweaks live in
`patches/duckdb/*.patch`, applied by `make apply_patches`, so a dirty
`submodules/duckdb` after a build is expected.

## Trademark rules

- Use "Haybarn", never "DuckDB Haybarn" or "Haybarn DuckDB"
- The canonical tagline is "Haybarn, powered by DuckDB"
- No DuckDB logo or duck-derived imagery
- Factual references to DuckDB ("based on DuckDB v2.0.0") are fine

## Public API compatibility

Don't rename exported TypeScript symbols (`AsyncDuckDB`, `DuckDBBundles`,
`selectBundle`, …) even though they contain "DuckDB". The trademark concerns
are satisfied by the package name and branding strings.

## Versioning and releases

Workspace versions are `<duckdb-version>-rc<N>` (currently `2.0.0-rc3`),
dropping `-rc<N>` for a stable release. Cutting an rc bumps the nine
`package.json` version fields, the two workspace entries in `yarn.lock`,
`app.tsx`'s `HAYBARN_WASM_VERSION` and `_worker.js`'s engine path, then a
`haybarn-v<version>` tag. Only the creation of a `haybarn-v2.*` tag runs the
release job in `main.yml` (npm publish of `@haybarn/haybarn-wasm`, the threads
wasm to R2, the shell to Cloudflare Pages); branch pushes, PRs and manual
dispatches never publish. An `-rcN` tag publishes under the npm dist-tag `rc`
and deploys the shell as the Pages preview `haybarn-2-0-rc.haybarn-shell.pages.dev`;
only a stable tag takes `latest` and production `shell.haybarn.query.farm`.

## Bundles and extension platforms

`base` loads `wasm_eh` extensions, `threads` loads `wasm_threads` ones, from
`https://haybarn-extensions.query.farm/{core,community}/v2.0.0/<platform>/`.
The version directory is the engine version (`v2.0.0`), not the workspace rc.
The engine names its repositories with `http://` (for the native httpfs
bootstrap); `lib/src/extension_provider.cc` upgrades them to https, which a
page needs.

Main module and side modules must come from the same emscripten: 6.0.13,
matching haybarn-extension-ci-tools `haybarn-2.0`. Bump both together.

## Building

Build on the EC2 box or in CI, not on a laptop. Native build (emcc on PATH):

```bash
git submodule update --init --depth=1 submodules/duckdb submodules/duckdb-nanoarrow submodules/rapidjson
make apply_patches
DUCKDB_PLATFORM=wasm_eh DUCKDB_WASM_LOADABLE_EXTENSIONS=1 GEN=ninja ./scripts/wasm_build_lib.sh relsize base
DUCKDB_PLATFORM=wasm_threads DUCKDB_WASM_LOADABLE_EXTENSIONS=signed GEN=ninja ./scripts/wasm_build_lib.sh relsize threads
yarn install && yarn workspace @haybarn/haybarn-wasm build:release
yarn workspace @haybarn/haybarn-wasm test:node
CHROME_BIN=$(which google-chrome) yarn workspace @haybarn/haybarn-wasm test:chrome:haybarn-repository
```

emsdk 6 needs Python >= 3.10 (`EMSDK_PYTHON`); Arrow is gone in 2.0, so no
CMake >= 3.25 requirement from it.

## Out-of-tree references

| What                          | Where                                                |
|-------------------------------|------------------------------------------------------|
| Build status                  | https://haybarn-status.query.farm                    |
| Extension repository          | https://haybarn-extensions.query.farm/{core,community}/v2.0.0/ |
| Haybarn engine                | https://github.com/Query-farm-haybarn/haybarn (`next-2.0`) |
| Extension CI workflows        | https://github.com/Query-farm-haybarn/haybarn-extension-ci-tools (`haybarn-2.0`) |
