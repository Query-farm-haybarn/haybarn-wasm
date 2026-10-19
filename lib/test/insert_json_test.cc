#include <sstream>

#include "duckdb/common/types/date.hpp"
#include "duckdb/common/types/timestamp.hpp"
#include "duckdb/web/io/ifstream.h"
#include "duckdb/web/io/memory_filesystem.h"
#include "duckdb/web/test/config.h"
#include "duckdb/web/webdb.h"
#include "gtest/gtest.h"

using namespace duckdb;
using namespace duckdb::web;
using namespace duckdb::web::test;

namespace {

struct JSONInsertTest {
    struct TestPrinter {
        std::string operator()(const ::testing::TestParamInfo<JSONInsertTest>& info) const {
            return std::string{info.param.name};
        }
    };
    std::string_view name;
    std::string_view input;
    std::string_view options;
    std::string_view query;
    vector<vector<Value>> expected_output;
};

struct JSONInsertTestSuite : public testing::TestWithParam<JSONInsertTest> {};

TEST_P(JSONInsertTestSuite, TestImport) {
    constexpr const char* path = "TEST";

    auto& test = GetParam();
    std::vector<char> input_buffer{test.input.data(), test.input.data() + test.input.size()};
    auto memory_filesystem = std::make_unique<io::MemoryFileSystem>();
    ASSERT_TRUE(memory_filesystem->RegisterFileBuffer(path, std::move(input_buffer)).ok());

    auto db = std::make_shared<WebDB>(NATIVE, std::move(memory_filesystem));
    WebDB::Connection conn{*db};
    auto maybe_ok = conn.InsertJSONFromPath(path, test.options);
    ASSERT_TRUE(maybe_ok.ok()) << maybe_ok.message();

    auto result = conn.connection().Query(std::string{test.query});
    ASSERT_TRUE(!result->HasError()) << result->GetError();
    for (idx_t col_idx = 0; col_idx < test.expected_output.size(); col_idx++) {
        ASSERT_TRUE(CHECK_COLUMN(*result, col_idx, test.expected_output[col_idx]));
    }
}

// clang-format off
static std::vector<JSONInsertTest> JSON_IMPORT_TEST = {
    {
        .name = "rows_integers",
        .input = R"JSON([
    {"a":1, "b":2, "c":3},
    {"a":4, "b":5, "c":6},
    {"a":7, "b":8, "c":9},
])JSON",
        .options = R"JSON({
            "schema": "main",
            "name": "foo"
        })JSON",
        .query = "SELECT * FROM main.foo",
        .expected_output = {
            {1, 4, 7},
            {2, 5, 8},
            {3, 6, 9}
        }
    },
    {
        .name = "cols_integers",
        .input = R"JSON({
    "a": [1, 4, 7],
    "b": [2, 5, 8],
    "c": [3, 6, 9]
})JSON",
        .options = R"JSON({
            "schema": "main",
            "name": "foo"
        })JSON",
        .query = "SELECT * FROM main.foo",
        .expected_output = {
            {1, 4, 7},
            {2, 5, 8},
            {3, 6, 9}
        }
    },
    {
        .name = "options_1",
        .input = R"JSON([
    {"a":1, "b":2, "c":3},
    {"a":4, "b":5, "c":6},
    {"a":7, "b":8, "c":9},
])JSON",
        .options = R"JSON({
            "schema": "main",
            "name": "foo",
            "shape": "row-array",
            "columns": [
                { "name": "a", "sqlType": "int32" },
                { "name": "b", "sqlType": "int16" },
                { "name": "c", "sqlType": "utf8" }
            ]
        })JSON",
        .query = "SELECT * FROM main.foo",
        .expected_output = {
            {1, 4, 7},
            {2, 5, 8},
            {3, 6, 9}
        }
    },
    {
        .name = "cols_ragged",
        .input = R"JSON({
    "a": [1, 2, 3],
    "b": ["x"],
})JSON",
        .options = R"JSON({
            "schema": "main",
            "name": "foo"
        })JSON",
        .query = "SELECT * FROM main.foo",
        .expected_output = {
            {1, 2, 3},
            {"x", Value(), Value()}
        }
    },
    {
        .name = "cols_typed",
        .input = R"JSON({
    "a": [1, 4, 7],
    "b": [2, 5, 8]
})JSON",
        .options = R"JSON({
            "schema": "main",
            "name": "foo",
            "shape": "column-object",
            "columns": [
                { "name": "a", "sqlType": "utf8" },
                { "name": "b", "sqlType": "int16" }
            ]
        })JSON",
        .query = "SELECT typeof(a), typeof(b), a FROM main.foo",
        .expected_output = {
            {"VARCHAR", "VARCHAR", "VARCHAR"},
            {"SMALLINT", "SMALLINT", "SMALLINT"},
            {"1", "4", "7"}
        }
    },
    {
        .name = "rows_missing_keys",
        .input = R"JSON(  [
    {"a":1},
    {"a":2, "b":"x"},
    {"b":"y", "c":null}
])JSON",
        .options = R"JSON({
            "schema": "main",
            "name": "foo"
        })JSON",
        .query = "SELECT a, b FROM main.foo",
        .expected_output = {
            {1, 2, Value()},
            {Value(), "x", "y"}
        }
    },
    {
        .name = "rows_nested",
        .input = R"JSON([
    {"a":{"x":1,"y":[1,2]}, "b":NaN},
    {"a":{"x":2,"y":[]}, "b":1.5}
])JSON",
        .options = R"JSON({
            "schema": "main",
            "name": "foo"
        })JSON",
        .query = "SELECT a.x, len(a.y), isnan(b) FROM main.foo",
        .expected_output = {
            {1, 2},
            {2, 0},
            {true, false}
        }
    },
    {
        .name = "rows_empty_typed",
        .input = R"JSON([])JSON",
        .options = R"JSON({
            "schema": "main",
            "name": "foo",
            "columns": [
                { "name": "a", "sqlType": "int32" }
            ]
        })JSON",
        .query = "SELECT count(*), (SELECT data_type FROM information_schema.columns WHERE table_name = 'foo') FROM main.foo",
        .expected_output = {
            {0},
            {"INTEGER"}
        }
    },
};
// clang-format on

INSTANTIATE_TEST_SUITE_P(JSONInsertTest, JSONInsertTestSuite, testing::ValuesIn(JSON_IMPORT_TEST),
                         JSONInsertTest::TestPrinter());

TEST(JSONInsertTest, Errors) {
    constexpr const char* path = "TEST";
    std::vector<std::pair<std::string_view, std::string_view>> inputs = {
        {"[]", "specify 'columns' to insert an empty array"},
        {"[1, 2, 3]", "must contain objects"},
        {R"JSON({"a": [1], "b": 2})JSON", "field 'b' must be an array"},
        {"42", "must be an array of row objects or an object of column arrays"},
        {"", "must be an array of row objects or an object of column arrays"},
    };
    for (auto& [input, error] : inputs) {
        auto memory_filesystem = std::make_unique<io::MemoryFileSystem>();
        ASSERT_TRUE(memory_filesystem->RegisterFileBuffer(path, std::vector<char>{input.begin(), input.end()}).ok());
        auto db = std::make_shared<WebDB>(NATIVE, std::move(memory_filesystem));
        WebDB::Connection conn{*db};
        auto status = conn.InsertJSONFromPath(path, R"JSON({"name": "foo"})JSON");
        ASSERT_FALSE(status.ok()) << input;
        ASSERT_NE(status.message().find(error), std::string::npos) << input << ": " << status.message();
    }
}

TEST(JSONInsertTest, Append) {
    constexpr const char* path = "TEST";
    std::string_view input = R"JSON([{"a":1},{"a":2}])JSON";
    auto memory_filesystem = std::make_unique<io::MemoryFileSystem>();
    ASSERT_TRUE(memory_filesystem->RegisterFileBuffer(path, std::vector<char>{input.begin(), input.end()}).ok());
    auto db = std::make_shared<WebDB>(NATIVE, std::move(memory_filesystem));
    WebDB::Connection conn{*db};
    ASSERT_TRUE(conn.InsertJSONFromPath(path, R"JSON({"name": "foo"})JSON").ok());
    auto status = conn.InsertJSONFromPath(path, R"JSON({"name": "foo", "create": false})JSON");
    ASSERT_TRUE(status.ok()) << status.message();
    auto result = conn.connection().Query("SELECT sum(a) FROM foo");
    ASSERT_TRUE(CHECK_COLUMN(*result, 0, {6}));
}

TEST(JSONInsertTest, LargerThanDefaultObjectSize) {
    constexpr const char* path = "TEST";
    constexpr size_t ROWS = 400000;
    std::string input = "[";
    for (size_t i = 0; i < ROWS; ++i) {
        input += (i == 0 ? "" : ",");
        input += R"JSON({"id":)JSON" + std::to_string(i) + R"JSON(,"name":"some reasonably long string value"})JSON";
    }
    input += "]";
    ASSERT_GT(input.size(), 16 * 1024 * 1024);
    auto memory_filesystem = std::make_unique<io::MemoryFileSystem>();
    ASSERT_TRUE(memory_filesystem->RegisterFileBuffer(path, std::vector<char>{input.begin(), input.end()}).ok());
    auto db = std::make_shared<WebDB>(NATIVE, std::move(memory_filesystem));
    WebDB::Connection conn{*db};
    auto status = conn.InsertJSONFromPath(path, R"JSON({"name": "foo"})JSON");
    ASSERT_TRUE(status.ok()) << status.message();
    auto result = conn.connection().Query("SELECT count(*), max(id) FROM foo");
    ASSERT_TRUE(CHECK_COLUMN(*result, 0, {Value::BIGINT(ROWS)}));
    ASSERT_TRUE(CHECK_COLUMN(*result, 1, {Value::BIGINT(ROWS - 1)}));
}

}  // namespace
