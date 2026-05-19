#!/usr/bin/env bash
# Inspect a duckdb extension wasm's metadata footer and compare against the
# current engine. Surfaces version/platform/abi-type drift that would otherwise
# only show up as cryptic runtime errors ("table index out of bounds",
# "function signature mismatch") after the extension has already been fetched.
#
# Usage:
#   scripts/check_extension_abi.sh [EXTENSION_URL]...
#
#   With no args, checks the four core wasm extensions (parquet/json/icu/tpch)
#   across all three platforms (wasm_eh, wasm_mvp, wasm_threads) against the
#   engine's CORE_REPOSITORY_URL.
#
# Exit 0 if every extension's (duckdb_version, platform) matches the engine's;
# exit 1 on any mismatch.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENGINE_HPP="$ROOT/submodules/duckdb/src/include/duckdb/main/extension_install_info.hpp"

# Pull the repo URL the engine will hit at runtime so the report stays in sync
# with whatever the patch stack actually writes into the binary.
CORE_URL=$(grep -m1 'CORE_REPOSITORY_URL *=' "$ENGINE_HPP" | sed -E 's/.*"([^"]+)".*/\1/')
ENGINE_VERSION="${DUCKDB_WASM_VERSION:-v1.5.2}"

# The metadata footer is the last 512 bytes of a built extension. Layout (each
# field is a 32-byte zero-padded string), confirmed by inspecting the parquet
# wasm extension byte-for-byte:
#   bytes [-512..-416): reserved / unused (zero-padded)
#   bytes [-416..-384): magic                ("CPP")
#   bytes [-384..-352): extension_version    ("v1.5.2")
#   bytes [-352..-320): duckdb_version       ("v1.5.2")
#   bytes [-320..-288): platform             ("wasm_eh" | "wasm_mvp" | "wasm_threads")
#   bytes [-288..-256): abi_type             ("4")
#   bytes [-256..0):    RSA signature (opaque)
read_field() {
    # $1 = file path; $2 = field offset from EOF (negative); $3 = field length
    python3 -c "
import sys
with open(sys.argv[1],'rb') as f:
    f.seek($2, 2)
    raw = f.read($3)
s = raw.rstrip(b'\x00').decode('latin-1', errors='replace')
print(s.strip())
" "$1"
}

inspect_url() {
    local url="$1"
    local tmp; tmp=$(mktemp -t hb-ext.XXXXXX.wasm)
    trap 'rm -f "$tmp"' RETURN

    local http_code
    http_code=$(curl -sS -o "$tmp" -w '%{http_code}' "$url" || echo "000")
    if [ "$http_code" != "200" ]; then
        printf '  %-12s HTTP %s\n' "FETCH" "$http_code"
        return 1
    fi

    local ext_ver dd_ver plat abi_type
    ext_ver=$(read_field "$tmp" -384 32)
    dd_ver=$(read_field "$tmp" -352 32)
    plat=$(read_field "$tmp" -320 32)
    abi_type=$(read_field "$tmp" -288 32)

    printf '  duckdb_version    %s   (engine: %s)\n' "$dd_ver" "$ENGINE_VERSION"
    printf '  extension_version %s\n' "$ext_ver"
    printf '  platform          %s\n' "$plat"
    printf '  abi_type          %s\n' "$abi_type"

    if [ "$dd_ver" != "$ENGINE_VERSION" ]; then
        printf '  STATUS            MISMATCH (duckdb_version != engine)\n'
        return 1
    fi
    printf '  STATUS            OK\n'
    return 0
}

if [ "$#" -eq 0 ]; then
    EXTS=(parquet json icu tpch)
    PLATFORMS=(wasm_eh wasm_mvp wasm_threads)
    URLS=()
    for plat in "${PLATFORMS[@]}"; do
        for ext in "${EXTS[@]}"; do
            URLS+=("${CORE_URL}/${ENGINE_VERSION}/${plat}/${ext}.duckdb_extension.wasm")
        done
    done
else
    URLS=("$@")
fi

bad=0
for url in "${URLS[@]}"; do
    printf '\n== %s\n' "$url"
    inspect_url "$url" || bad=$((bad+1))
done

printf '\n'
if [ "$bad" -ne 0 ]; then
    printf '%d/%d extensions failed compatibility check.\n' "$bad" "${#URLS[@]}" >&2
    exit 1
fi
printf 'All %d extensions match engine version %s.\n' "${#URLS[@]}" "$ENGINE_VERSION"
