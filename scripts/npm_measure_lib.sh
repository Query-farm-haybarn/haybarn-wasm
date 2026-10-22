#!/usr/bin/env bash

PROJECT_ROOT="$(cd $(dirname "$BASH_SOURCE[0]") && cd .. && pwd)" &> /dev/null

cd ${PROJECT_ROOT}/packages/duckdb-wasm
mkdir -p ./dist/img
cp ${PROJECT_ROOT}/misc/haybarn-icon.png   ./dist/img/haybarn-icon.png
cp ${PROJECT_ROOT}/misc/haybarn-banner.png ./dist/img/haybarn-banner.png
${PROJECT_ROOT}/scripts/build_haybarn_badge.sh > ./dist/img/haybarn_version_badge.svg

npm install -g pkg-size
pkg-size . --sizes=size > output
cat output
tail -n2 output | grep " MB" | awk '{print ($1 < 200)}' | grep "1" || exit 1
