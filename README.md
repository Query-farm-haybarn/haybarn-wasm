<div align="center">
  <h1>Haybarn-Wasm</h1>
  <p><em>Haybarn for WebAssembly — Haybarn, powered by DuckDB.</em></p>
</div>

<div align="center">
  <a href="https://www.npmjs.com/package/@haybarn/haybarn-wasm/v/latest">
    <img src="https://img.shields.io/npm/v/@haybarn/haybarn-wasm?logo=npm" alt="haybarn-wasm package on NPM">
  </a>
  <a href="https://github.com/Query-farm-haybarn/haybarn-wasm/actions">
    <img src="https://github.com/Query-farm-haybarn/haybarn-wasm/actions/workflows/main.yml/badge.svg?branch=haybarn" alt="Github Actions Badge">
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
`haybarn-extensions.query.farm` (Haybarn's R2-backed extension channel) rather
than upstream's `extensions.duckdb.org`.

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
the patch stack, and how to rebase onto a newer upstream release.

## Haybarn engine version

This branch is built on top of the Haybarn engine `haybarn-v1.5.2-rc13` tag,
which corresponds to DuckDB v1.5.2 plus the Haybarn patch stack (trademark
strings, extension repository URLs, trust root).

## Wasm variants

Haybarn-Wasm ships three wasm binaries — same three variants as upstream:

| Variant | What you get | Hosting requirement |
|---------|--------------|---------------------|
| `mvp`   | Plain WebAssembly, broadest compatibility | None |
| `eh`    | Native [WebAssembly Exception Handling](https://github.com/WebAssembly/exception-handling) — ~20–40% faster on modern browsers | None |
| `coi`   | EH + threads + SIMD via SharedArrayBuffer | Requires [Cross-Origin Isolation](https://developer.mozilla.org/en-US/docs/Web/HTTP/Cross-Origin_Resource_Policy_(CORP)#cross-origin_isolation) HTTP headers (COOP=same-origin, COEP=require-corp) |

The bundle selector (`selectBundle()` in `@haybarn/haybarn-wasm`) picks the
best variant your browser can run, the same way upstream does.

## Loading extensions

Extensions are fetched lazily from the Haybarn extension channel:

```sql
INSTALL spatial;        -- → haybarn-extensions.query.farm/core/v1.5.2/wasm_eh/spatial.duckdb_extension.wasm
LOAD spatial;
```

Community extensions are addressed via the `community` shorthand:

```sql
INSTALL h3 FROM community;
LOAD h3;
```

For the full extension catalog and per-platform availability, see
[haybarn-status.query.farm](https://haybarn-status.query.farm).

## Build from source

```bash
git clone https://github.com/Query-farm-haybarn/haybarn-wasm.git
cd haybarn-wasm
git submodule update --init --recursive
make apply_patches
make serve
```

## Repository structure

| Subproject                                                 | Description    | Language   |
| ---------------------------------------------------------- | :------------- | :--------- |
| [`lib`](/lib)                                              | Wasm library   | C++        |
| [`@haybarn/haybarn-wasm`](/packages/duckdb-wasm)           | TypeScript API (published) | TypeScript |
| [`@haybarn/haybarn-wasm-shell`](/packages/duckdb-wasm-shell) | SQL shell    | Rust       |
| [`@haybarn/haybarn-wasm-app`](/packages/duckdb-wasm-app)   | Demo app       | TypeScript |
| [`@haybarn/react-haybarn`](/packages/react-duckdb)         | React hooks    | TypeScript |

Only `@haybarn/haybarn-wasm` is published to npm; the other packages are
private and used internally for testing + demos. Directory names match the
upstream duckdb-wasm tree so rebases stay small.

## License

MIT, same as upstream. See [LICENSE](LICENSE) for the Stichting DuckDB
Foundation copyright on the original work, and [NOTICE](NOTICE) for the
Haybarn-specific attribution.

DuckDB is a trademark of the DuckDB Foundation. Haybarn is an independent
derived distribution published by Query Farm LLC.
