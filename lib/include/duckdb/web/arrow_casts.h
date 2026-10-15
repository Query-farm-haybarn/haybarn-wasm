#ifndef INCLUDE_DUCKDB_WEB_ARROW_CASTS_H_
#define INCLUDE_DUCKDB_WEB_ARROW_CASTS_H_

#include <vector>

#include "duckdb/web/config.h"
#include "nanoarrow/nanoarrow.h"

namespace duckdb {
namespace web {

/// The result casts a QueryConfig asks for (bigints and decimals to doubles, timestamps to date64, durations to
/// time64), applied to query results before they are serialized. Columns are cast at any depth inside structs and
/// lists; dictionary values are left as they are.
class ArrowResultCasts {
   public:
    /// Plan the casts for a schema and change its types to the cast types.
    /// The schema must be owned by nanoarrow (e.g. a deep copy), since its format strings are replaced.
    ArrowErrorCode Plan(ArrowSchema* schema, const QueryConfig& config, ArrowError* error);
    /// Is there anything to cast?
    bool empty() const { return !root_.any; }
    /// Cast the columns of an array matching the planned schema in place
    ArrowErrorCode Apply(ArrowArray* array, ArrowError* error) const;

   private:
    enum class Cast { NONE, INT64_TO_DOUBLE, UINT64_TO_DOUBLE, DECIMAL128_TO_DOUBLE, TIMESTAMP_TO_DATE64,
                      DURATION_TO_TIME64 };
    struct Node {
        Cast cast = Cast::NONE;
        ArrowTimeUnit time_unit = NANOARROW_TIME_UNIT_SECOND;
        int32_t decimal_scale = 0;
        /// Does this node or any of its children cast?
        bool any = false;
        std::vector<Node> children;
    };
    static ArrowErrorCode PlanNode(ArrowSchema* schema, const QueryConfig& config, Node& node, ArrowError* error);
    static ArrowErrorCode ApplyNode(const Node& node, ArrowArray* array, ArrowError* error);
    static ArrowErrorCode CastArray(const Node& node, ArrowArray* array, ArrowError* error);

    Node root_;
};

}  // namespace web
}  // namespace duckdb

#endif
