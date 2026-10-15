#ifndef INCLUDE_DUCKDB_WEB_JSON_TYPEDEF_H_
#define INCLUDE_DUCKDB_WEB_JSON_TYPEDEF_H_

#include <string>
#include <utility>

#include "arrow/result.h"
#include "duckdb/common/types.hpp"
#include "rapidjson/document.h"

namespace duckdb {
namespace web {
namespace json {

/// Read a type
arrow::Result<duckdb::LogicalType> SQLToDuckDBType(const rapidjson::Value::ConstObject& obj);
/// Read a named field from a json object
arrow::Result<std::pair<std::string, duckdb::LogicalType>> SQLToDuckDBField(const rapidjson::Value& obj);
/// Read named fields from a json array
arrow::Result<duckdb::child_list_t<duckdb::LogicalType>> SQLToDuckDBFields(const rapidjson::Value::ConstArray& fields);
/// Serialize a SQL type as string
arrow::Result<rapidjson::Value> WriteSQLType(rapidjson::Document& doc, const duckdb::LogicalType& type);
/// Serialize a SQL type as string
arrow::Result<rapidjson::Value> WriteSQLField(rapidjson::Document& doc, std::string_view name,
                                              const duckdb::LogicalType& type, bool nullable);

}  // namespace json
}  // namespace web
}  // namespace duckdb

#endif
