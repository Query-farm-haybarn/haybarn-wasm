#!/usr/bin/env bash
#
# Install the CLI tools the TPCH data-prep scripts need (sqlite3, duckdb).
#
# Intended to run inside the haybarn-wasm-base container before
# generate_tpch_{sqlite,duckdb}.sh. The container is Ubuntu 24.04, so
# sqlite3 comes from apt and duckdb comes from the upstream v1.5.2 CLI
# release (matches the engine version this repo embeds). Both end up at
# /usr/local/bin, making them resolvable by the generate scripts via
# plain `sqlite3` / `duckdb`.
#
# Idempotent: skips either step if the tool is already on PATH (so it's
# safe to call from multiple workflow steps without re-downloading).
#
# Why not bake these into haybarn-wasm-base? sqlite3 and duckdb are
# specifically needed by THIS repo's TPCH benchmark prep, not by the
# extension-build path the image was sized for. Keeping the install
# here means other consumers of the image don't pay for tools they
# don't use.

set -euo pipefail

DUCKDB_VERSION="${DUCKDB_VERSION:-v1.5.2}"

if ! command -v sqlite3 >/dev/null 2>&1; then
    echo "Installing sqlite3 via apt"
    apt-get update -qq
    apt-get install -y --no-install-recommends sqlite3
    sqlite3 --version
else
    echo "sqlite3 already installed: $(sqlite3 --version | head -1)"
fi

if ! command -v duckdb >/dev/null 2>&1; then
    arch="$(uname -m)"
    case "$arch" in
        x86_64) duckdb_asset="duckdb_cli-linux-amd64.zip" ;;
        aarch64|arm64) duckdb_asset="duckdb_cli-linux-arm64.zip" ;;
        *) echo "Unsupported arch for duckdb CLI install: $arch" >&2; exit 1 ;;
    esac
    url="https://github.com/duckdb/duckdb/releases/download/${DUCKDB_VERSION}/${duckdb_asset}"
    echo "Installing duckdb ${DUCKDB_VERSION} CLI from ${url}"
    tmp="$(mktemp -d)"
    curl -fsSL "$url" -o "$tmp/duckdb.zip"
    unzip -q "$tmp/duckdb.zip" -d "$tmp"
    install -m 0755 "$tmp/duckdb" /usr/local/bin/duckdb
    rm -rf "$tmp"
    duckdb --version
else
    echo "duckdb already installed: $(duckdb --version | head -1)"
fi
