#include "duckdb/web/arrow_casts.h"

#include <cmath>

#include "nanoarrow/nanoarrow.hpp"

namespace duckdb {
namespace web {

ArrowErrorCode ArrowResultCasts::Plan(ArrowSchema* schema, const QueryConfig& config, ArrowError* error) {
    root_ = Node{};
    if (!config.hasAnyCast()) return NANOARROW_OK;
    return PlanNode(schema, config, root_, error);
}

ArrowErrorCode ArrowResultCasts::PlanNode(ArrowSchema* schema, const QueryConfig& config, Node& node,
                                          ArrowError* error) {
    ArrowSchemaView view;
    NANOARROW_RETURN_NOT_OK(ArrowSchemaViewInit(&view, schema, error));
    switch (view.type) {
        case NANOARROW_TYPE_STRUCT:
        case NANOARROW_TYPE_LIST:
        case NANOARROW_TYPE_LARGE_LIST:
        case NANOARROW_TYPE_FIXED_SIZE_LIST:
            node.children.resize(schema->n_children);
            for (int64_t i = 0; i < schema->n_children; ++i) {
                NANOARROW_RETURN_NOT_OK(PlanNode(schema->children[i], config, node.children[i], error));
                node.any |= node.children[i].any;
            }
            return NANOARROW_OK;
        case NANOARROW_TYPE_INT64:
            if (config.cast_bigint_to_double.value_or(false)) node.cast = Cast::INT64_TO_DOUBLE;
            break;
        case NANOARROW_TYPE_UINT64:
            if (config.cast_bigint_to_double.value_or(false)) node.cast = Cast::UINT64_TO_DOUBLE;
            break;
        case NANOARROW_TYPE_DECIMAL128:
            if (config.cast_decimal_to_double.value_or(false)) node.cast = Cast::DECIMAL128_TO_DOUBLE;
            break;
        case NANOARROW_TYPE_TIMESTAMP:
            if (config.cast_timestamp_to_date.value_or(false)) node.cast = Cast::TIMESTAMP_TO_DATE64;
            break;
        case NANOARROW_TYPE_DURATION:
            if (config.cast_duration_to_time64.value_or(false)) node.cast = Cast::DURATION_TO_TIME64;
            break;
        default:
            break;
    }
    node.time_unit = view.time_unit;
    node.decimal_scale = view.decimal_scale;
    node.any = node.cast != Cast::NONE;

    switch (node.cast) {
        case Cast::NONE:
            break;
        case Cast::INT64_TO_DOUBLE:
        case Cast::UINT64_TO_DOUBLE:
        case Cast::DECIMAL128_TO_DOUBLE:
            NANOARROW_RETURN_NOT_OK(ArrowSchemaSetType(schema, NANOARROW_TYPE_DOUBLE));
            break;
        case Cast::TIMESTAMP_TO_DATE64:
            NANOARROW_RETURN_NOT_OK(ArrowSchemaSetType(schema, NANOARROW_TYPE_DATE64));
            break;
        case Cast::DURATION_TO_TIME64:
            // Nanosecond durations stay in nanoseconds, coarser units are converted to microseconds
            NANOARROW_RETURN_NOT_OK(ArrowSchemaSetTypeDateTime(
                schema, NANOARROW_TYPE_TIME64,
                view.time_unit == NANOARROW_TIME_UNIT_NANO ? NANOARROW_TIME_UNIT_NANO : NANOARROW_TIME_UNIT_MICRO,
                nullptr));
            break;
    }
    return NANOARROW_OK;
}

ArrowErrorCode ArrowResultCasts::Apply(ArrowArray* array, ArrowError* error) const {
    if (empty()) return NANOARROW_OK;
    return ApplyNode(root_, array, error);
}

ArrowErrorCode ArrowResultCasts::ApplyNode(const Node& node, ArrowArray* array, ArrowError* error) {
    if (!node.any) return NANOARROW_OK;
    if (node.cast != Cast::NONE) return CastArray(node, array, error);
    for (size_t i = 0; i < node.children.size(); ++i) {
        NANOARROW_RETURN_NOT_OK(ApplyNode(node.children[i], array->children[i], error));
    }
    return NANOARROW_OK;
}

namespace {

template <typename In, typename Out, typename Fn>
void CastValues(const ArrowArray* array, ArrowBuffer* out, Fn fn) {
    auto in = static_cast<const In*>(array->buffers[1]);
    auto values = reinterpret_cast<Out*>(out->data);
    for (int64_t i = 0; i < array->offset + array->length; ++i) {
        values[i] = fn(in[i]);
    }
}

double Decimal128ToDouble(const uint64_t* words, double divisor) {
    auto value = static_cast<__int128>(static_cast<unsigned __int128>(words[1]) << 64 | words[0]);
    return static_cast<double>(value) / divisor;
}

}  // namespace

ArrowErrorCode ArrowResultCasts::CastArray(const Node& node, ArrowArray* array, ArrowError* error) {
    // Build the cast array with the same length, offset and validity
    nanoarrow::UniqueArray out;
    auto out_type = node.cast == Cast::TIMESTAMP_TO_DATE64  ? NANOARROW_TYPE_DATE64
                    : node.cast == Cast::DURATION_TO_TIME64 ? NANOARROW_TYPE_TIME64
                                                            : NANOARROW_TYPE_DOUBLE;
    NANOARROW_RETURN_NOT_OK(ArrowArrayInitFromType(out.get(), out_type));
    auto n = array->offset + array->length;
    if (array->null_count != 0 && array->buffers[0] != nullptr) {
        NANOARROW_RETURN_NOT_OK(ArrowBufferAppend(ArrowArrayBuffer(out.get(), 0), array->buffers[0], (n + 7) / 8));
    }
    auto data = ArrowArrayBuffer(out.get(), 1);
    NANOARROW_RETURN_NOT_OK(ArrowBufferResize(data, n * 8, 0));

    switch (node.cast) {
        case Cast::NONE:
            break;
        case Cast::INT64_TO_DOUBLE:
            CastValues<int64_t, double>(array, data, [](int64_t v) { return static_cast<double>(v); });
            break;
        case Cast::UINT64_TO_DOUBLE:
            CastValues<uint64_t, double>(array, data, [](uint64_t v) { return static_cast<double>(v); });
            break;
        case Cast::DECIMAL128_TO_DOUBLE: {
            auto in = static_cast<const uint64_t*>(array->buffers[1]);
            auto values = reinterpret_cast<double*>(data->data);
            auto divisor = std::pow(10.0, node.decimal_scale);
            for (int64_t i = 0; i < n; ++i) {
                values[i] = Decimal128ToDouble(in + 2 * i, divisor);
            }
            break;
        }
        case Cast::TIMESTAMP_TO_DATE64:
            // date64 counts milliseconds
            switch (node.time_unit) {
                case NANOARROW_TIME_UNIT_SECOND:
                    CastValues<int64_t, int64_t>(array, data, [](int64_t v) { return v * 1000; });
                    break;
                case NANOARROW_TIME_UNIT_MILLI:
                    CastValues<int64_t, int64_t>(array, data, [](int64_t v) { return v; });
                    break;
                case NANOARROW_TIME_UNIT_MICRO:
                    CastValues<int64_t, int64_t>(array, data, [](int64_t v) { return v / 1000; });
                    break;
                case NANOARROW_TIME_UNIT_NANO:
                    CastValues<int64_t, int64_t>(array, data, [](int64_t v) { return v / (1000 * 1000); });
                    break;
            }
            break;
        case Cast::DURATION_TO_TIME64:
            switch (node.time_unit) {
                case NANOARROW_TIME_UNIT_SECOND:
                    CastValues<int64_t, int64_t>(array, data, [](int64_t v) { return v * 1000 * 1000; });
                    break;
                case NANOARROW_TIME_UNIT_MILLI:
                    CastValues<int64_t, int64_t>(array, data, [](int64_t v) { return v * 1000; });
                    break;
                case NANOARROW_TIME_UNIT_MICRO:
                case NANOARROW_TIME_UNIT_NANO:
                    CastValues<int64_t, int64_t>(array, data, [](int64_t v) { return v; });
                    break;
            }
            break;
    }

    out->length = array->length;
    out->offset = array->offset;
    out->null_count = array->null_count;
    NANOARROW_RETURN_NOT_OK(ArrowArrayFinishBuilding(out.get(), NANOARROW_VALIDATION_LEVEL_NONE, error));

    // Swap the cast array into place. DuckDB's parent arrays release children through their callbacks.
    array->release(array);
    out.move(array);
    return NANOARROW_OK;
}

}  // namespace web
}  // namespace duckdb
