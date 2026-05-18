#!/usr/bin/env bash

# Set every workspace package's version from the current git ref.
#
# Haybarn tags are `haybarn-v<duckdb-version>[-rc<N>]`. We strip the
# `haybarn-` prefix and the leading `v` so npm sees a clean semver.
#
#   haybarn-v1.5.2-rc13 → 1.5.2-rc13
#   haybarn-v1.5.2      → 1.5.2

set -euo pipefail

PROJECT_ROOT="$(cd $(dirname "$BASH_SOURCE[0]") && cd .. && pwd)" &> /dev/null

git describe --tags --long
RAW=$(git describe --tags --abbrev=0)
DEV=$(git describe --tags --long | rev | cut -f2 -d- | rev)

VERSION=${RAW#haybarn-}
VERSION=${VERSION#v}

echo "VERSION=${VERSION}"
echo "DEV=${DEV}"

# Only bump @haybarn/haybarn-wasm — the other workspace packages are
# private:true and never published.
cd "${PROJECT_ROOT}/packages/duckdb-wasm"
if [[ "${DEV}" = "0" ]] ; then
    npm version "${VERSION}" --allow-same-version --no-git-tag-version
else
    npm version "${VERSION}" --allow-same-version --no-git-tag-version
    npm version prerelease --preid="dev${DEV}" --no-git-tag-version
fi

cd "${PROJECT_ROOT}"
if [ -f "${PROJECT_ROOT}/scripts/sync_versions.mjs" ]; then
    node "${PROJECT_ROOT}/scripts/sync_versions.mjs"
fi
