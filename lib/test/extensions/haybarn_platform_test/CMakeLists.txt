cmake_minimum_required(VERSION 3.5...3.29)

# Haybarn: a test-only side module that calls every platform function the engine provides extensions (vgi, grainlift).
# Built into the local extension repository by the loadable CI jobs (HAYBARN_WASM_TEST_EXTENSIONS), never published.
project(HaybarnPlatformTestExtension)

include_directories(src/include)

build_extension_library(haybarn_platform_test src/haybarn_platform_test_extension.cpp)
