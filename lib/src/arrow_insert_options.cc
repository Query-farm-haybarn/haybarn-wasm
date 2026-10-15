#include "duckdb/web/arrow_insert_options.h"

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

namespace {

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

enum FieldTag {
    CREATE,
    NAME,
    SCHEMA,
};

static std::unordered_map<std::string_view, FieldTag> FIELD_TAGS{
    {"create", FieldTag::CREATE},
    {"createNew", FieldTag::CREATE},
    {"name", FieldTag::NAME},
    {"schema", FieldTag::SCHEMA},
};

}  // namespace

/// Read from document
Status ArrowInsertOptions::ReadFrom(const rapidjson::Document& doc) {
    if (!doc.IsObject()) return Status::OK();
    for (auto iter = doc.MemberBegin(); iter != doc.MemberEnd(); ++iter) {
        std::string_view name{iter->name.GetString(), iter->name.GetStringLength()};

        auto tag_iter = FIELD_TAGS.find(name);
        if (tag_iter == FIELD_TAGS.end()) continue;

        switch (tag_iter->second) {
            case FieldTag::CREATE: {
                WEBDB_RETURN_NOT_OK(RequireBoolField(iter->value, name));
                create_new = iter->value.GetBool();
                break;
            }
            case FieldTag::NAME:
                WEBDB_RETURN_NOT_OK(RequireFieldType(iter->value, rapidjson::Type::kStringType, name));
                table_name = {iter->value.GetString(), iter->value.GetStringLength()};
                break;

            case FieldTag::SCHEMA:
                WEBDB_RETURN_NOT_OK(RequireFieldType(iter->value, rapidjson::Type::kStringType, name));
                schema_name = {iter->value.GetString(), iter->value.GetStringLength()};
                break;
        }
    }
    return Status::OK();
}

}  // namespace web
}  // namespace duckdb
