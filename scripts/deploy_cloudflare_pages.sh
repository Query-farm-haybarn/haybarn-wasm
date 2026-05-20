#!/usr/bin/env bash
#
# Build @haybarn/haybarn-wasm-app and deploy it to Cloudflare Pages
# (shell.haybarn.query.farm).
#
# The wasm engine + workers load from jsDelivr at runtime (the app's
# DUCKDB_BUNDLES point at @haybarn/haybarn-wasm@<rc> on the CDN), so the
# only thing this deploys is the app shell + the bundled xterm shell UI
# wasm + a _headers file (COOP/COEP for cross-origin isolation).
#
# Prerequisites (one-time, on whoever runs this / in CI secrets):
#   - CLOUDFLARE_API_TOKEN  : token with Pages:Edit on the account
#   - CLOUDFLARE_ACCOUNT_ID : the Cloudflare account id
#   - A Pages project named $CF_PAGES_PROJECT (default haybarn-shell);
#     create once with `wrangler pages project create haybarn-shell`
#   - The custom domain shell.haybarn.query.farm attached to that project
#     (Cloudflare dashboard → Pages → custom domains, or
#     `wrangler pages deployment ...`); DNS is a CNAME/Cloudflare-proxied
#     record for the subdomain.
#
# Usage:
#   ./scripts/deploy_cloudflare_pages.sh                # production deploy
#   CF_PAGES_BRANCH=preview ./scripts/deploy_cloudflare_pages.sh   # preview

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && cd .. && pwd)"
CF_PAGES_PROJECT="${CF_PAGES_PROJECT:-haybarn-shell}"
BUILD_DIR="${PROJECT_ROOT}/packages/duckdb-wasm-app/build/release"

echo "[ RUN ] Build @haybarn/haybarn-wasm-app (release)"
cd "${PROJECT_ROOT}"
yarn workspace @haybarn/haybarn-wasm-app build:release

if [ ! -f "${BUILD_DIR}/_headers" ]; then
    echo "ERROR: ${BUILD_DIR}/_headers missing — COOP/COEP won't be set and the" >&2
    echo "       cross-origin-isolated (threaded) shell variant will be disabled." >&2
    exit 1
fi

echo "[ RUN ] Deploy ${BUILD_DIR} to Cloudflare Pages project '${CF_PAGES_PROJECT}'"
DEPLOY_ARGS=(pages deploy "${BUILD_DIR}" --project-name "${CF_PAGES_PROJECT}")
if [ -n "${CF_PAGES_BRANCH:-}" ]; then
    DEPLOY_ARGS+=(--branch "${CF_PAGES_BRANCH}")
fi
npx --yes wrangler "${DEPLOY_ARGS[@]}"

echo "[ DONE ] Deployed. Production URL maps to the project's custom domain"
echo "         (shell.haybarn.query.farm once the domain is attached)."
