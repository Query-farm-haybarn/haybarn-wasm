# Claude conventions — haybarn-wasm

This is the Haybarn fork of duckdb-wasm. Read `HAYBARN.md` for the full
fork structure; the notes below are the things to remember when you're
making changes.

## Primary branch

`haybarn`, not `main`. PR base, CI trigger, and submodule branch hint
all point at `haybarn`.

## Remotes

- `origin` → `Query-farm-haybarn/haybarn-wasm`
- `upstream` → `duckdb/duckdb-wasm` (for rebases only)

## What lives in the engine vs here

If a change is about **the engine** (extension URLs, trust root, SQL
features, performance), it goes in
[Query-farm-haybarn/haybarn](https://github.com/Query-farm-haybarn/haybarn).
This repo is **only** the wasm packaging layer.

The duckdb engine source is at `submodules/duckdb/`. **Never edit the
submodule from within this repo** — open a PR against the engine fork,
then bump the submodule pointer here in a separate commit.

## Trademark rules

Per the Haybarn compliance rules:

- Use "Haybarn", never "DuckDB Haybarn" or "Haybarn DuckDB"
- The canonical tagline is "Haybarn, powered by DuckDB"
- Don't add the DuckDB logo or any duck-derived imagery
- Factual references to DuckDB (e.g. "based on DuckDB v1.5.2") are fine
  and encouraged — Haybarn does not hide its lineage

## Public API compatibility

Don't rename exported TypeScript symbols (`AsyncDuckDB`, `DuckDB`,
`ConnectionWrapper`, `instantiate`, etc.) even though they contain
"DuckDB". They're the wasm-side equivalent of the C++ namespace —
renamed identifiers would break consumer code without adding compliance
value. The trademark concerns are satisfied by the *package name* and
*branding strings*, not API identifiers.

## When you add a Haybarn-only change

Try to be a thin layer. If a change can land upstream, send it upstream
instead of carrying it as a permanent patch — every commit on top of
upstream is a future rebase tax.

## Versioning

Workspace versions match the embedded engine version:
`<duckdb-major>.<duckdb-minor>.<duckdb-patch>-rc<N>` while we're in rc,
dropping the `-rc<N>` suffix when the engine cuts a stable tag.
Currently `1.5.2-rc3`.

## Local smoke-build setup

```bash
# 1. Install pinned emsdk (CI uses 5.0.7):
git clone --depth=1 https://github.com/emscripten-core/emsdk.git /tmp/emsdk
cd /tmp/emsdk && ./emsdk install 5.0.7 && ./emsdk activate 5.0.7

# 2. From haybarn-wasm root, smoke build (one variant is enough):
cd /path/to/haybarn-wasm
git submodule update --init --recursive    # fetches duckdb + arrow + rapidjson + …
cd submodules/duckdb && git fetch --depth 1 origin tag haybarn-v1.5.2-rc13 && cd ../..
make apply_patches                          # applies patches/duckdb/* to the engine
bash -c 'source /tmp/emsdk/emsdk_env.sh && \
  export PATH="/tmp/emsdk/upstream/emscripten:$PATH" && \
  CMAKE_POLICY_VERSION_MINIMUM=3.5 ./scripts/wasm_build_lib.sh relperf eh'

# Output: build/relperf/eh/duckdb_wasm.{wasm,js} copied to
#         packages/duckdb-wasm/src/bindings/duckdb-eh.{wasm,js}
```

Gotchas to know:
- The submodule needs the haybarn engine tag fetched explicitly — its
  recorded gitlink is a SHA, and `git describe` later in the build fails
  without a reachable tag.
- `CMAKE_POLICY_VERSION_MINIMUM=3.5` is needed because rapidjson's
  CMakeLists declares a pre-3.5 minimum, which modern CMake 4.x rejects.
- Homebrew's emscripten works on 5.x but is HEAD — pin to emsdk 5.0.7
  to match what CI uses. Older emsdk (≤ 3.1.x) won't work: the wasm-side
  preprocessor checks were updated to use `__EMSCRIPTEN__` (the standard
  reserved-namespace form), which is what 4.x+ defines.

## Out-of-tree references

| What                          | Where                                                |
|-------------------------------|------------------------------------------------------|
| Build status                  | https://haybarn-status.query.farm                    |
| Extension catalog (R2)        | https://haybarn-extensions.query.farm/{core,community}/v1.5.2/ |
| Haybarn engine                | https://github.com/Query-farm-haybarn/haybarn        |
| Extension CI workflows        | https://github.com/Query-farm-haybarn/haybarn-extension-ci-tools |
| Compliance / trademark rules  | Internal — `~/.claude/projects/-Users-rusty-Development-haybarn/memory/haybarn-compliance-rules.md` |
