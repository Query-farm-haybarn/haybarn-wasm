#include "duckdb/web/json_typedef.h"

#include <arrow/result.h>

#include <algorithm>
#include <duckdb/common/types.hpp>
#include <duckdb/common/types/decimal.hpp>
#include <functional>
#include <iostream>
#include <memory>
#include <optional>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <variant>
#include <vector>

#include "arrow/status.h"
#include "rapidjson/document.h"
#include "rapidjson/istreamwrapper.h"
#include "rapidjson/rapidjson.h"
#include "rapidjson/writer.h"

using namespace arrow;

namespace duckdb {
namespace web {
namespace json {


namespace {

template <typename IntType = int>
Result<IntType> GetIntField(const rapidjson::Value::ConstObject& obj, std::string_view key, int default_value = 0) {
    const auto& it = obj.FindMember(rapidjson::StringRef(key.data(), key.length()));
    if (it == obj.MemberEnd()) return default_value;
    if (!it->value.IsInt()) return Status::Invalid("member is not an integer: ", key);
    return static_cast<IntType>(it->value.GetInt64());
}

Result<bool> GetBoolField(const rapidjson::Value::ConstObject& obj, std::string_view key, bool default_value = false) {
    const auto& it = obj.FindMember(rapidjson::StringRef(key.data(), key.length()));
    if (it == obj.MemberEnd()) return default_value;
    if (!it->value.IsBool()) return Status::Invalid("member is not a boolean: ", key);
    return it->value.GetBool();
}

/// Read an string member
Result<std::string_view> GetStringField(const rapidjson::Value::ConstObject& obj, std::string_view key,
                                        std::string_view default_value = "") {
    const auto& it = obj.FindMember(rapidjson::StringRef(key.data(), key.length()));
    if (it == obj.MemberEnd()) return "";
    if (!it->value.IsString()) return Status::Invalid("member is not a string: ", key);
    return std::string_view{it->value.GetString(), it->value.GetStringLength()};
}

Result<const rapidjson::Value::ConstArray> GetArrayField(const rapidjson::Value::ConstObject& obj, std::string_view key,
                                                         bool allow_absent = false) {
    static const auto empty_array = rapidjson::Value(rapidjson::kArrayType);

    const auto& it = obj.FindMember(rapidjson::StringRef(key.data(), key.length()));
    if (allow_absent && it == obj.MemberEnd()) {
        return empty_array.GetArray();
    }
    if (!it->value.IsArray()) return Status::Invalid("member is not an array: ", key);
    return it->value.GetArray();
}

Result<const rapidjson::Value::ConstObject> GetMemberObject(const rapidjson::Value::ConstObject& obj,
                                                            std::string_view key) {
    const auto& it = obj.FindMember(rapidjson::StringRef(key.data(), key.length()));
    if (it == obj.MemberEnd() || !it->value.IsObject()) return Status::Invalid("member is not an object: ", key);
    return it->value.GetObject();
}

Result<duckdb::LogicalType> ReadMemberType(const rapidjson::Value::ConstObject& obj, std::string_view key) {
    ARROW_ASSIGN_OR_RAISE(const auto member, GetMemberObject(obj, key));
    return SQLToDuckDBType(member);
}

Result<duckdb::LogicalType> ReadMapType(const rapidjson::Value::ConstObject& obj) {
    ARROW_ASSIGN_OR_RAISE(auto key_type, ReadMemberType(obj, "keyType"));
    ARROW_ASSIGN_OR_RAISE(auto value_type, ReadMemberType(obj, "valueType"));
    return duckdb::LogicalType::MAP(std::move(key_type), std::move(value_type));
}

Result<duckdb::LogicalType> ReadFixedSizeBinaryType(const rapidjson::Value::ConstObject& obj) {
    ARROW_ASSIGN_OR_RAISE(const int32_t byte_width, GetIntField<int32_t>(obj, "byteWidth", 0));
    if (byte_width <= 0) return Status::Invalid("FixedSizeBinary byteWidth must be > 0");
    return duckdb::LogicalType::BLOB;
}

Result<duckdb::LogicalType> ReadFixedSizeListType(const rapidjson::Value::ConstObject& obj) {
    ARROW_ASSIGN_OR_RAISE(auto value_type, ReadMemberType(obj, "valueType"));
    ARROW_ASSIGN_OR_RAISE(const int32_t list_size, GetIntField<int32_t>(obj, "listSize"));
    if (list_size <= 0) return Status::Invalid("FixedSizeList listSize must be > 0");
    return duckdb::LogicalType::LIST(std::move(value_type));
}

Result<duckdb::LogicalType> ReadListType(const rapidjson::Value::ConstObject& obj) {
    ARROW_ASSIGN_OR_RAISE(auto value_type, ReadMemberType(obj, "valueType"));
    return duckdb::LogicalType::LIST(std::move(value_type));
}

Result<duckdb::LogicalType> ReadDecimalType(const rapidjson::Value::ConstObject& obj, int32_t default_precision = 0,
                                            int32_t default_scale = 0) {
    ARROW_ASSIGN_OR_RAISE(const int32_t precision, GetIntField<int32_t>(obj, "precision", default_precision));
    ARROW_ASSIGN_OR_RAISE(const int32_t scale, GetIntField<int32_t>(obj, "scale", default_scale));
    if (precision <= 0 || precision > duckdb::Decimal::MAX_WIDTH_DECIMAL) {
        return Status::Invalid("Decimal precision must be between 1 and ", duckdb::Decimal::MAX_WIDTH_DECIMAL);
    }
    if (scale < 0 || scale > precision) return Status::Invalid("Decimal scale must be between 0 and the precision");
    return duckdb::LogicalType::DECIMAL(precision, scale);
}

Result<duckdb::LogicalType> ReadTimestampType(const rapidjson::Value::ConstObject& obj) {
    const auto& it_tz = obj.FindMember("timezone");
    if (it_tz != obj.MemberEnd() && !it_tz->value.IsString()) return Status::Invalid("timezone is not a string");
    return duckdb::LogicalType::TIMESTAMP;
}

Result<duckdb::LogicalType> ReadStructType(const rapidjson::Value::ConstObject& obj) {
    ARROW_ASSIGN_OR_RAISE(const auto children, GetArrayField(obj, "fields"));
    ARROW_ASSIGN_OR_RAISE(auto child_types, SQLToDuckDBFields(children));
    return duckdb::LogicalType::STRUCT(std::move(child_types));
}

}  // namespace

/// Read a type
arrow::Result<duckdb::LogicalType> SQLToDuckDBType(const rapidjson::Value::ConstObject& type) {
    ARROW_ASSIGN_OR_RAISE(const auto obj, GetStringField(type, "sqlType", ""));
    using TypeResolver = std::function<arrow::Result<duckdb::LogicalType>(const rapidjson::Value::ConstObject&)>;
    auto fixed = [](duckdb::LogicalType t) { return [t](auto&) -> arrow::Result<duckdb::LogicalType> { return t; }; };
    using duckdb::LogicalType;
    static std::unordered_map<std::string_view, TypeResolver> TYPE_MAPPING{
        {"binary", fixed(LogicalType::BLOB)},
        {"bool", fixed(LogicalType::BOOLEAN)},
        {"boolean", fixed(LogicalType::BOOLEAN)},
        {"date", fixed(LogicalType::DATE)},
        {"date32", fixed(LogicalType::DATE)},
        {"date32[d]", fixed(LogicalType::DATE)},
        {"date64", fixed(LogicalType::DATE)},
        {"date64[ms]", fixed(LogicalType::DATE)},
        {"daytimeinterval", fixed(LogicalType::INTERVAL)},
        {"decimal", [](auto& o) { return ReadDecimalType(o); }},
        {"decimal128", [](auto& o) { return ReadDecimalType(o); }},
        {"decimal256", [](auto& o) { return ReadDecimalType(o, 12, 2); }},
        {"double", fixed(LogicalType::DOUBLE)},
        {"duration", fixed(LogicalType::TIME)},
        {"duration[ms]", fixed(LogicalType::TIME)},
        {"duration[ns]", fixed(LogicalType::TIME)},
        {"duration[s]", fixed(LogicalType::TIME)},
        {"duration[us]", fixed(LogicalType::TIME)},
        {"fixedsizebinary", &ReadFixedSizeBinaryType},
        {"fixedsizelist", &ReadFixedSizeListType},
        {"float", fixed(LogicalType::FLOAT)},
        {"float16", fixed(LogicalType::FLOAT)},
        {"float32", fixed(LogicalType::FLOAT)},
        {"float64", fixed(LogicalType::DOUBLE)},
        {"halffloat", fixed(LogicalType::FLOAT)},
        {"int16", fixed(LogicalType::SMALLINT)},
        {"int32", fixed(LogicalType::INTEGER)},
        {"int64", fixed(LogicalType::BIGINT)},
        {"int8", fixed(LogicalType::TINYINT)},
        {"interval[dt]", fixed(LogicalType::INTERVAL)},
        {"interval[m]", fixed(LogicalType::INTERVAL)},
        {"largebinary", fixed(LogicalType::BLOB)},
        {"largeutf8", fixed(LogicalType::VARCHAR)},
        {"list", &ReadListType},
        {"map", &ReadMapType},
        {"monthinterval", fixed(LogicalType::INTERVAL)},
        {"null", fixed(LogicalType::SQLNULL)},
        {"string", fixed(LogicalType::VARCHAR)},
        {"struct", &ReadStructType},
        {"time", fixed(LogicalType::TIME)},
        {"time32[ms]", fixed(LogicalType::TIME)},
        {"time32[s]", fixed(LogicalType::TIME)},
        {"time64[ns]", fixed(LogicalType::TIME)},
        {"time64[us]", fixed(LogicalType::TIME)},
        {"time[ms]", fixed(LogicalType::TIME)},
        {"time[ns]", fixed(LogicalType::TIME)},
        {"time[s]", fixed(LogicalType::TIME)},
        {"time[us]", fixed(LogicalType::TIME)},
        {"timestamp", &ReadTimestampType},
        {"timestamp[s]", &ReadTimestampType},
        {"timestamp[ms]", &ReadTimestampType},
        {"timestamp[us]", &ReadTimestampType},
        {"timestamp[ns]", &ReadTimestampType},
        {"uint16", fixed(LogicalType::USMALLINT)},
        {"uint32", fixed(LogicalType::UINTEGER)},
        {"uint64", fixed(LogicalType::UBIGINT)},
        {"uint8", fixed(LogicalType::UTINYINT)},
        {"utf8", fixed(LogicalType::VARCHAR)},
    };

    // Get type resolver
    std::string objLower{obj.data(), obj.length()};
    std::transform(objLower.begin(), objLower.end(), objLower.begin(), [](unsigned char c) { return std::tolower(c); });
    if (objLower == "union") return Status::NotImplemented("union types are not supported");
    auto iter = TYPE_MAPPING.find(objLower);
    if (iter == TYPE_MAPPING.end()) return Status::Invalid("Unrecognized type name: ", obj);
    return iter->second(type);
}

/// Read a field
arrow::Result<std::pair<std::string, duckdb::LogicalType>> SQLToDuckDBField(const rapidjson::Value& field) {
    if (!field.IsObject()) {
        return Status::Invalid("Field was not a JSON object");
    }
    const auto& field_obj = field.GetObject();
    ARROW_ASSIGN_OR_RAISE(auto name, GetStringField(field_obj, "name", ""));
    if (name == "") return Status::Invalid("invalid field name");
    ARROW_ASSIGN_OR_RAISE(auto type, SQLToDuckDBType(field_obj));
    return std::make_pair(std::string{name}, std::move(type));
}

/// Read fields from an array
arrow::Result<duckdb::child_list_t<duckdb::LogicalType>> SQLToDuckDBFields(const rapidjson::Value::ConstArray& fields) {
    duckdb::child_list_t<duckdb::LogicalType> out;
    out.reserve(fields.Size());
    for (rapidjson::SizeType i = 0; i < fields.Size(); ++i) {
        ARROW_ASSIGN_OR_RAISE(auto field, SQLToDuckDBField(fields[i]));
        out.push_back(std::move(field));
    }
    return out;
}

/// Serialize a SQL type as string
arrow::Result<rapidjson::Value> WriteSQLType(rapidjson::Document& doc, const duckdb::LogicalType& type) {
    auto& alloc = doc.GetAllocator();
    rapidjson::Value out(rapidjson::kObjectType);
    switch (type.id()) {
        case duckdb::LogicalTypeId::UNBOUND:
        case duckdb::LogicalTypeId::GEOMETRY:
        case duckdb::LogicalTypeId::TYPE:
            throw "unsupported type";
        case duckdb::LogicalTypeId::INVALID:
            out.AddMember("sqlType", "invalid", alloc);
            break;
        case duckdb::LogicalTypeId::SQLNULL:
            out.AddMember("sqlType", "null", alloc);
            break;
        case duckdb::LogicalTypeId::UNKNOWN:
            out.AddMember("sqlType", "unknown", alloc);
            break;
        case duckdb::LogicalTypeId::ANY:
            out.AddMember("sqlType", "any", alloc);
            break;
        case duckdb::LogicalTypeId::BOOLEAN:
            out.AddMember("sqlType", "bool", alloc);
            break;
        case duckdb::LogicalTypeId::TINYINT:
            out.AddMember("sqlType", "int8", alloc);
            break;
        case duckdb::LogicalTypeId::SMALLINT:
            out.AddMember("sqlType", "int16", alloc);
            break;
        case duckdb::LogicalTypeId::INTEGER:
            out.AddMember("sqlType", "int32", alloc);
            break;
        case duckdb::LogicalTypeId::BIGINT:
            out.AddMember("sqlType", "int64", alloc);
            break;
        case duckdb::LogicalTypeId::DATE:
            out.AddMember("sqlType", "date32[d]", alloc);
            break;
        case duckdb::LogicalTypeId::TIME:
            out.AddMember("sqlType", "time[us]", alloc);
            break;
        case duckdb::LogicalTypeId::TIMESTAMP_SEC:
            out.AddMember("sqlType", "timestamp[s]", alloc);
            break;
        case duckdb::LogicalTypeId::TIMESTAMP_MS:
            out.AddMember("sqlType", "timestamp[ms]", alloc);
            break;
        case duckdb::LogicalTypeId::TIMESTAMP:
            out.AddMember("sqlType", "timestamp", alloc);
            break;
        case duckdb::LogicalTypeId::TIMESTAMP_NS:
            out.AddMember("sqlType", "timestamp[ns]", alloc);
            break;
        case duckdb::LogicalTypeId::FLOAT:
            out.AddMember("sqlType", "float", alloc);
            break;
        case duckdb::LogicalTypeId::DOUBLE:
            out.AddMember("sqlType", "double", alloc);
            break;
        case duckdb::LogicalTypeId::VARCHAR:
            out.AddMember("sqlType", "utf8", alloc);
            break;
        case duckdb::LogicalTypeId::STRUCT: {
            out.AddMember("sqlType", "struct", alloc);
            rapidjson::Value children(rapidjson::kArrayType);
            for (auto& child : duckdb::StructType::GetChildTypes(type)) {
                ARROW_ASSIGN_OR_RAISE(auto field, WriteSQLField(doc, child.first, child.second, true));
                children.PushBack(field, alloc);
            }
            out.AddMember("fields", children, alloc);
            break;
        }
        case duckdb::LogicalTypeId::LIST: {
            out.AddMember("sqlType", "list", alloc);
            rapidjson::Value children(rapidjson::kArrayType);
            ARROW_ASSIGN_OR_RAISE(auto value, WriteSQLType(doc, duckdb::ListType::GetChildType(type)));
            out.AddMember("valueType", value, alloc);
            break;
        }
        case duckdb::LogicalTypeId::MAP: {
            out.AddMember("sqlType", "map", alloc);
            rapidjson::Value children(rapidjson::kArrayType);
            ARROW_ASSIGN_OR_RAISE(auto key, WriteSQLType(doc, duckdb::MapType::KeyType(type)));
            ARROW_ASSIGN_OR_RAISE(auto value, WriteSQLType(doc, duckdb::MapType::ValueType(type)));
            out.AddMember("keyType", key, alloc);
            out.AddMember("valueType", value, alloc);
            break;
        }
        case duckdb::LogicalTypeId::DECIMAL:
        case duckdb::LogicalTypeId::INTERVAL:
        case duckdb::LogicalTypeId::UTINYINT:
        case duckdb::LogicalTypeId::USMALLINT:
        case duckdb::LogicalTypeId::UINTEGER:
        case duckdb::LogicalTypeId::UBIGINT:
        case duckdb::LogicalTypeId::TIMESTAMP_TZ:
        case duckdb::LogicalTypeId::TIME_TZ:
        case duckdb::LogicalTypeId::HUGEINT:
        case duckdb::LogicalTypeId::POINTER:
        case duckdb::LogicalTypeId::VALIDITY:
        case duckdb::LogicalTypeId::UUID:
        case duckdb::LogicalTypeId::ENUM:
        case duckdb::LogicalTypeId::BLOB:
        case duckdb::LogicalTypeId::CHAR:
        case duckdb::LogicalTypeId::TABLE:
        case duckdb::LogicalTypeId::AGGREGATE_STATE:
        case duckdb::LogicalTypeId::BIT:
        case duckdb::LogicalTypeId::LAMBDA:
        case duckdb::LogicalTypeId::STRING_LITERAL:
        case duckdb::LogicalTypeId::INTEGER_LITERAL:
        case duckdb::LogicalTypeId::UHUGEINT:
        case duckdb::LogicalTypeId::UNION:
        case duckdb::LogicalTypeId::ARRAY:
        case duckdb::LogicalTypeId::BIGNUM:
        case duckdb::LogicalTypeId::VARIANT:
        case duckdb::LogicalTypeId::TEMPLATE:
        case duckdb::LogicalTypeId::TIME_NS:
            break;
    }
    return out;
}

arrow::Result<rapidjson::Value> WriteSQLField(rapidjson::Document& doc, std::string_view name,
                                              const duckdb::LogicalType& type, bool nullable) {
    auto& alloc = doc.GetAllocator();
    ARROW_ASSIGN_OR_RAISE(auto out, WriteSQLType(doc, type));
    out.AddMember("name", rapidjson::StringRef(name.data(), name.length()), alloc);
    return out;
}

}  // namespace json
}  // namespace web
}  // namespace duckdb
