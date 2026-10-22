#!/usr/bin/env bash

# Set every workspace package's version from the current git ref.
#
# Haybarn tags are `haybarn-v<duckdb-version>[-rc<N>]`. We strip the
# `haybarn-` prefix and the leading `v` so npm sees a clean semver.
#
#   haybarn-v2.0.0-rc1 → 2.0.0-rc1
#   haybarn-v2.0.0     → 2.0.0
#
# Only haybarn-v* tags count: the fork also carries upstream's v* tags,
# which name duckdb-wasm releases, not Haybarn ones. With no haybarn-v
# tag reachable (a new release line before its first tag) the committed
# version is kept.

set -euo pipefail

PROJECT_ROOT="$(cd $(dirname "$BASH_SOURCE[0]") && cd .. && pwd)" &> /dev/null

if ! RAW=$(git describe --tags --abbrev=0 --match 'haybarn-v*' 2>/dev/null); then
    echo "no haybarn-v* tag reachable, keeping the committed versions"
    exit 0
fi
git describe --tags --long --match 'haybarn-v*'
DEV=$(git describe --tags --long --match 'haybarn-v*' | rev | cut -f2 -d- | rev)

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
node "${PROJECT_ROOT}/scripts/sync_versions.mjs"
