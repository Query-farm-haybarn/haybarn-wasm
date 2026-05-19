#!/usr/bin/env bash

set -euo pipefail

trap exit SIGINT

PROJECT_ROOT="$(cd $(dirname "$BASH_SOURCE[0]") && cd .. && pwd)" &> /dev/null
DUCKDB_SHELL="$(command -v duckdb || true)"
if [ -z "${DUCKDB_SHELL}" ]; then
    echo "duckdb CLI not on PATH; run scripts/install_tpch_tools.sh first" >&2
    exit 1
fi
SCALE_FACTOR=${1:-0.01}
SCALE_FACTOR_DIR=${SCALE_FACTOR/./_}
TPCH_DIR=${PROJECT_ROOT}/data/tpch
TPCH_SF_OUT=${TPCH_DIR}/${SCALE_FACTOR_DIR}
TPCH_SF_OUT_DUCKDB=${TPCH_SF_OUT}/duckdb
TPCH_SF_OUT_DUCKDB_DB=${TPCH_SF_OUT_DUCKDB}/db
DUCKDB_SCRIPT_FILE=${TPCH_SF_OUT_DUCKDB}/script.sql

mkdir -p ${TPCH_SF_OUT_DUCKDB}
rm -r ${TPCH_SF_OUT_DUCKDB}
mkdir -p ${TPCH_SF_OUT_DUCKDB}

cat << END >${DUCKDB_SCRIPT_FILE}
.open ${TPCH_SF_OUT_DUCKDB_DB}
install tpch;
load tpch;
call dbgen(sf = ${SCALE_FACTOR});
checkpoint;
.databases
.tables
END
${DUCKDB_SHELL} --echo < ${DUCKDB_SCRIPT_FILE}
echo "TPCH_SF_OUT_DUCKDB=${TPCH_SF_OUT_DUCKDB}/db"
