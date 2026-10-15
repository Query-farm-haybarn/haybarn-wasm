#include <string>

#include "duckdb/web/utils/status.h"
#include "rapidjson/document.h"

namespace duckdb {
namespace web {

/// Get a type name
std::string_view GetTypeName(rapidjson::Type type);
/// Require a boolean field
Status RequireBoolField(const rapidjson::Value& value, std::string_view name);
/// Require a certain field type
Status RequireFieldType(const rapidjson::Value& value, rapidjson::Type type, std::string_view field);

}  // namespace web
}  // namespace duckdb
