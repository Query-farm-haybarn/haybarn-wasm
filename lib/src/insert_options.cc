#include "duckdb/web/insert_options.h"

#include <iostream>
#include <memory>
#include <sstream>
#include <string>

#include "duckdb/web/utils/status.h"
#include "duckdb/web/json_typedef.h"
#include "rapidjson/document.h"
#include "rapidjson/error/en.h"
#include "rapidjson/istreamwrapper.h"

namespace duckdb {
namespace web {

/// Get a type name
std::string_view GetTypeName(rapidjson::Type type) {
    switch (type) {
        case rapidjson::Type::kArrayType:
            return "array";
        case rapidjson::Type::kTrueType:;
        case rapidjson::Type::kFalseType:
            return "boolean";
        case rapidjson::Type::kNumberType:
            return "number";
        case rapidjson::Type::kObjectType:
            return "object";
        case rapidjson::Type::kNullType:
            return "null";
        case rapidjson::Type::kStringType:
            return "string";
        default:
            return "?";
    }
}

/// Require a boolean field
Status RequireBoolField(const rapidjson::Value& value, std::string_view name) {
    if (!value.IsBool()) {
        std::stringstream msg;
        msg << "type mismatch for field '" << name << "': expected bool, received " << GetTypeName(value.GetType());
        return Status(StatusCode::Invalid, msg.str());
    }
    return Status::OK();
}

/// Require a certain field type
Status RequireFieldType(const rapidjson::Value& value, rapidjson::Type type, std::string_view field) {
    if (value.GetType() != type) {
        std::stringstream msg;
        msg << "type mismatch for field '" << field << "': expected " << GetTypeName(type) << ", received "
            << GetTypeName(value.GetType());
        return Status(StatusCode::Invalid, msg.str());
    }
    return Status::OK();
};

}  // namespace web
}  // namespace duckdb
