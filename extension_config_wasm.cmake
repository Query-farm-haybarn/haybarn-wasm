################################################################################
# DuckDB-Wasm extension base config
################################################################################
#

duckdb_extension_load(json)
duckdb_extension_load(parquet)
duckdb_extension_load(autocomplete)

duckdb_extension_load(icu)
duckdb_extension_load(tpcds)
duckdb_extension_load(tpch)

if(DEFINED ENV{DUCKDB_HTTPFS_DIRECTORY}
   AND NOT "$ENV{DUCKDB_HTTPFS_DIRECTORY}" STREQUAL "")
    include("${EXTENSION_CONFIG_BASE_DIR}/httpfs.cmake")
endif()

# Haybarn: a test extension that calls the platform functions for extensions, for the loadable test suites only
if(DEFINED ENV{HAYBARN_WASM_TEST_EXTENSIONS}
   AND NOT "$ENV{HAYBARN_WASM_TEST_EXTENSIONS}" STREQUAL "")
    duckdb_extension_load(haybarn_platform_test
                          SOURCE_DIR ${CMAKE_CURRENT_LIST_DIR}/lib/test/extensions/haybarn_platform_test
                          EXTENSION_VERSION v0.0.1)
endif()

# Arrow IPC reading and writing, linked statically into DuckDB-Wasm
duckdb_extension_load(nanoarrow
                      SOURCE_DIR ${DUCKDB_NANOARROW_DIR}
                      LINKED_LIBS "../../_deps/nanoarrow-build/lib*.a")
