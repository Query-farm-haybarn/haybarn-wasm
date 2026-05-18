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
Currently `1.5.2-rc1`.

## Out-of-tree references

| What                          | Where                                                |
|-------------------------------|------------------------------------------------------|
| Build status                  | https://haybarn-status.query.farm                    |
| Extension catalog (R2)        | https://haybarn-extensions.query.farm/{core,community}/v1.5.2/ |
| Haybarn engine                | https://github.com/Query-farm-haybarn/haybarn        |
| Extension CI workflows        | https://github.com/Query-farm-haybarn/haybarn-extension-ci-tools |
| Compliance / trademark rules  | Internal — `~/.claude/projects/-Users-rusty-Development-haybarn/memory/haybarn-compliance-rules.md` |
