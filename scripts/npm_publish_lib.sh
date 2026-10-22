#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd $(dirname "$BASH_SOURCE[0]") && cd .. && pwd)" &> /dev/null

cd ${PROJECT_ROOT}/packages/duckdb-wasm
mkdir -p ./dist/img
cp ${PROJECT_ROOT}/misc/haybarn-icon.png   ./dist/img/haybarn-icon.png
cp ${PROJECT_ROOT}/misc/haybarn-banner.png ./dist/img/haybarn-banner.png
${PROJECT_ROOT}/scripts/build_haybarn_badge.sh > ./dist/img/haybarn_version_badge.svg

# Publish @haybarn/haybarn-wasm. OIDC Trusted Publisher provides the
# auth — no NPM_TOKEN needed when this runs in CI. TAG comes from the
# workflow (latest on tag, next on push).
npm publish --ignore-scripts --access public --provenance --tag ${TAG}
