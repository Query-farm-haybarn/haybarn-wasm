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
Currently `1.5.3-rc14`.

Cutting an rc: bump the same ~12 files an existing `release: bump workspace
to <rc>` commit touched (`grep -rl <old-rc>` finds them: 9 `package.json`
version fields, `CLAUDE.md`, `_worker.js`'s `COI_WASM_UPSTREAM` engine path,
`app.tsx`'s `HAYBARN_WASM_VERSION`), then push tag `haybarn-v<version>`. The
tag fires `main.yml` **twice** — a `push` run and a `create` run. The
`create` run is the one that publishes (npm via OIDC + the COI engine wasm to
`engine/<rc>/duckdb-coi.wasm` on R2; the publish step is gated on the `create`
event). So `engine/<new-rc>/` 404s until the release runs — expected, the
release resolves its own path.

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

## Debugging extension load/run failures

`eh` and `coi` download **different** per-platform extension binaries
(`wasm_eh/` vs `wasm_threads/`) from
`haybarn-extensions.query.farm/{core,community}/v<engine-version>/…` — the
version dir is the *engine* version (`v1.5.3`), not the workspace rc. Never
assume "same binary, different variant."

If a Rust C-API extension throws an opaque `TypeError: c is not a function`
from the worker on `eh` while `coi` works, it's an exception-ABI mismatch:
the `wasm_eh` build was compiled against the **stable** precompiled `std`
(legacy emscripten EH — imports `invoke_*` / `__resumeException` /
`__cxa_find_matching_catch` / `getTempRet0`), but the engine uses **native**
wasm EH and provides none of those trampolines, so the first exception-path
call resolves to `undefined`. Diagnose against the published binary:

```bash
wasm-objdump -x <ext>.duckdb_extension.wasm \
  | grep -cE '<env\.(invoke_|__resumeException|getTempRet0)'
# 0 = native EH (matches engine); non-zero = legacy EH (broken on eh)
```

The fix is out-of-tree (the extension build's Rust toolchain in
haybarn-extension-ci-tools — extend the nightly + `-Z build-std` gating from
`wasm_threads` to `wasm_eh` so its `std` is also native-EH), not in this repo.
Full write-up: haybarn-wasm#9.

To test an extension **functionally**, use Node, not the browser: in-browser
`INSTALL` can't cache (browser `runtime_browser.ts` directory ops are
`console.log` stubs; `checkDirectory` always returns false) and `LOAD`-by-path
is rejected ("dynamic linking not enabled"). Node has a real FS and loads the
*same* `wasm_eh` engine + extension binary. Recipe: `require('web-worker')`
for the Worker, `dist/duckdb-node.cjs` `AsyncDuckDB`, offer only the `eh`
bundle (`duckdb-eh.wasm` + `duckdb-node-eh.worker.cjs`) so `selectBundle`
picks it, then `INSTALL … FROM community; LOAD …; SELECT …`.

### Stack-trace symbol names (`-g2`)

The shipped engine **and** extension wasm carry a wasm *name* section, so
trap/abort/uncaught-`RuntimeError` backtraces show function names instead of
anonymous `wasm-function[N]`. The names are **mangled** — pipe traces through
`llvm-cxxfilt` (Rust: `rustfilt`), or use Chrome's "C/C++ DevTools Support
(DWARF)" extension which demangles automatically. This does **not** add stacks
to ordinary SQL errors (those surface as Arrow status `e.what()` strings via
`lib/src/webdb.cc` → `wasm_response.cc`), and `-Oz`/`-O3` inlining means fewer,
larger frames than source.

The knob is `-g2` at the final `emcc` link, in three places:
- engine: `lib/CMakeLists.txt` (Release branch `WASM_LINK_FLAGS`)
- C-API + Rust extensions: haybarn-extension-ci-tools
  `makefiles/c_api_extensions/base.Makefile` (`link_wasm_release`)
- C++ extensions (e.g. httpfs): engine fork `extension/extension_build_tools.cmake`
  (the wasm `SIDE_MODULE` `POST_BUILD` link)

Confirm a binary has it with `wasm-objdump -h <file>.wasm | grep -i name`.
Trade-off: the name section adds size (text, compresses well) and fights
`relsize`'s intent; if that ever matters the lean alternative is a separate
`-gseparate-dwarf` side-car instead of in-binary names.

## Out-of-tree references

| What                          | Where                                                |
|-------------------------------|------------------------------------------------------|
| Build status                  | https://haybarn-status.query.farm                    |
| Extension catalog (R2)        | https://haybarn-extensions.query.farm/{core,community}/v1.5.2/ |
| Haybarn engine                | https://github.com/Query-farm-haybarn/haybarn        |
| Extension CI workflows        | https://github.com/Query-farm-haybarn/haybarn-extension-ci-tools |
| Compliance / trademark rules  | Internal — `~/.claude/projects/-Users-rusty-Development-haybarn/memory/haybarn-compliance-rules.md` |
