#!/usr/bin/env bash

# Generate a "Haybarn vX.Y.Z" SVG badge from the engine submodule's
# git-describe output. The factual reference to the underlying DuckDB
# version is encoded in the engine repo's tag (haybarn-v<duckdb>-<rc>),
# so we use that directly.

set -euo pipefail

PROJECT_ROOT="$(cd $(dirname "$BASH_SOURCE[0]") && cd .. && pwd)" &> /dev/null
BADGEGEN=${PROJECT_ROOT}/node_modules/.bin/badge

cd ${PROJECT_ROOT}/submodules/duckdb
RAW=$(git describe --tags --abbrev=0 2>/dev/null || echo "haybarn-vunknown")
# Strip the haybarn- prefix and any leading v: haybarn-v1.5.2-rc13 → 1.5.2-rc13
VERSION=${RAW#haybarn-}
VERSION=${VERSION#v}

BADGE_LABEL_COLOR="#555"
BADGE_VALUE_COLOR="#58a6ff"

${BADGEGEN} haybarn "v${VERSION}" ${BADGE_VALUE_COLOR} ${BADGE_LABEL_COLOR}
