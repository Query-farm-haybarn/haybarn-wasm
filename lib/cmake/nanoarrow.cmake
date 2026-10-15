# nanoarrow is vendored as a bundled (amalgamated) source distribution, see third_party/nanoarrow/README.md
set(NANOARROW_DIR "${CMAKE_SOURCE_DIR}/third_party/nanoarrow")

add_library(
  nanoarrow STATIC
  ${NANOARROW_DIR}/src/nanoarrow.c
  ${NANOARROW_DIR}/src/nanoarrow_ipc.c
  ${NANOARROW_DIR}/src/flatcc.c)
target_include_directories(nanoarrow SYSTEM PUBLIC ${NANOARROW_DIR}/include)
target_include_directories(nanoarrow PRIVATE ${NANOARROW_DIR}/include/nanoarrow ${NANOARROW_DIR}/src)
set_target_properties(nanoarrow PROPERTIES C_STANDARD 11)

# The flags above are only set for C++; build the C sources with the same wasm features
# (threads, SIMD, bulk memory, exceptions) and optimization level so they link with the rest.
separate_arguments(NANOARROW_C_FLAGS UNIX_COMMAND "${CMAKE_CXX_FLAGS}")
list(FILTER NANOARROW_C_FLAGS EXCLUDE REGEX "^-std=")
string(TOUPPER "${CMAKE_BUILD_TYPE}" NANOARROW_BUILD_TYPE)
separate_arguments(NANOARROW_C_FLAGS_CONFIG UNIX_COMMAND "${CMAKE_CXX_FLAGS_${NANOARROW_BUILD_TYPE}}")
target_compile_options(nanoarrow PRIVATE ${NANOARROW_C_FLAGS} ${NANOARROW_C_FLAGS_CONFIG} -Wno-unused-command-line-argument)
