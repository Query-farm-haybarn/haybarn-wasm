#ifndef INCLUDE_DUCKDB_WEB_ARROW_IPC_WRITER_H_
#define INCLUDE_DUCKDB_WEB_ARROW_IPC_WRITER_H_

#include <memory>

#include "arrow/buffer.h"
#include "arrow/result.h"
#include "arrow/status.h"
#include "duckdb/common/arrow/arrow.hpp"
#include "duckdb/web/config.h"

namespace duckdb {
namespace web {

/// Serializes DuckDB's C Data Interface query results into Arrow IPC bytes with nanoarrow.
///
/// In file mode, the schema, batches and footer accumulate into a single buffer taken after Finish().
/// In stream mode, the bytes written since the last TakeBytes() are handed out after the schema and
/// after each batch, so a query result can be streamed one message group at a time. Dictionaries are
/// written before the batches that reference them, and unchanged dictionaries are not repeated.
class ArrowIPCWriter {
   public:
    enum class Format { FILE, STREAM };

    ~ArrowIPCWriter();

    /// Create a writer and write the schema, taking ownership of `schema`
    static arrow::Result<std::unique_ptr<ArrowIPCWriter>> Create(ArrowSchema* schema, const QueryConfig& config,
                                                                 Format format);
    /// Write a batch, taking ownership of `array`
    arrow::Status Write(ArrowArray* array);
    /// Finish the output (writes the footer in file mode)
    arrow::Status Finish();
    /// Take the bytes written so far
    std::shared_ptr<arrow::Buffer> TakeBytes();

   private:
    struct State;
    explicit ArrowIPCWriter(std::unique_ptr<State> state);
    std::unique_ptr<State> state_;
};

}  // namespace web
}  // namespace duckdb

#endif
