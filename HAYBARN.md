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

The primary branch is **`haybarn`**, not `main`. Rebases land on
`haybarn` as a linear commit stack on top of an upstream release.

## What the fork changes

The fork is a thin layer on top of upstream:

| Layer                         | Files / surface                          |
|-------------------------------|------------------------------------------|
| **Package rebrand**           | `package.json` (all workspaces), npm imports, Makefile, scripts, Rust shell crate `wasm_bindgen` module strings |
| **Engine submodule swap**     | `.gitmodules` (URL → `Query-farm-haybarn/haybarn`), `submodules/duckdb` pointer (haybarn-v1.5.2-rc13) |
| **Docs**                      | `README.md`, `NOTICE`, `HAYBARN.md`, `CLAUDE.md` |
| **CI**                        | `.github/workflows/main.yml`, `npm_tags.yml` — npm publish via OIDC Trusted Publisher, dropped most of the upstream test matrix |
| **Branding assets**           | `misc/` logos (TBD — currently still upstream assets), version badge generator |

The C++ library in `lib/`, the TypeScript bindings in
`packages/duckdb-wasm/src/`, and the public API are **deliberately
unchanged** so existing duckdb-wasm consumer code can port via a single
import rewrite (`@duckdb/duckdb-wasm` → `@haybarn/haybarn-wasm`). This is
the wasm-side equivalent of the engine's "keep the `duckdb::` namespace"
ABI compatibility rule.

## What the fork does NOT change

* Public TypeScript API surface (class names, function names, types)
* The wasm binary's platform string (`wasm_mvp / wasm_eh / wasm_threads`)
* Internal C++ symbols
* The wasm build toolchain (emsdk, build flags)

If a future Haybarn extension or feature needs an API change, it goes
upstream first if possible — the goal is to be a drop-in distribution,
not a divergent dialect.

## Where the Haybarn-specific behavior comes from

It's almost all in the engine submodule. The Haybarn engine
([Query-farm-haybarn/haybarn](https://github.com/Query-farm-haybarn/haybarn))
carries the patches that change extension repository URLs to
`haybarn-extensions.query.farm` and install the Haybarn trust root. When
we compile `submodules/duckdb/` to wasm, those defaults bake in. Nothing
in `packages/duckdb-wasm/src/` needs to be aware of Haybarn-specific URLs.

The two patches in `patches/duckdb/` (`all_of_them.patch`,
`invalid_arrow.patch`) are wasm-build-specific source tweaks inherited
from upstream — kept as-is unless they fail to apply against a future
engine bump.

## Rebasing onto a new upstream

1. `git fetch upstream`
2. `git rebase upstream/main haybarn` (resolve conflicts; most will be
   in `package.json` files and `README.md`)
3. Bump the engine submodule pointer if needed:

   ```bash
   cd submodules/duckdb
   git fetch origin
   git checkout <new-haybarn-tag>
   cd ../..
   git add submodules/duckdb
   ```

4. Bump `version` in every workspace `package.json` to match the new
   engine version + `-rc<N>` suffix
5. Run the build (`make apply_patches && make wasm_eh_relperf` for a
   smoke test) before tagging

When the haybarn engine cuts a stable (non-rc) tag, drop the `-rc<N>`
suffix from the package versions.

## Why a hard fork instead of using duckdb-wasm directly?

The trust root for extension installation is hard-coded into the engine
at compile time. Even with `extensionConfig` runtime overrides, an
extension installed at runtime against a non-Haybarn build of duckdb-wasm
won't validate against Haybarn's signing keys. To ship a coherent
distribution where extensions in `INSTALL …` calls Just Work, the wasm
binary needs to be compiled against our engine. Hence the submodule
swap.

## License

MIT. See `LICENSE` (upstream copyright) and `NOTICE` (Haybarn attribution).
