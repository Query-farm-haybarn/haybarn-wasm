#ifndef INCLUDE_DUCKDB_WEB_ARROW_STREAM_BUFFER_H_
#define INCLUDE_DUCKDB_WEB_ARROW_STREAM_BUFFER_H_

#include <memory>

#include "duckdb/web/utils/status.h"
#include "duckdb/common/arrow/arrow.hpp"
#include "duckdb/common/arrow/arrow_wrapper.hpp"
#include "duckdb/function/table_function.hpp"
#include "nanoarrow/nanoarrow.hpp"
#include "nanoarrow/nanoarrow_ipc.hpp"

namespace duckdb {
struct ArrowStreamParameters;
namespace web {

/// The bytes of an Arrow IPC stream, collected until its end-of-stream marker
struct ArrowIPCStreamBuffer {
   protected:
    friend struct BufferingArrowIPCStreamDecoder;
    /// The stream bytes
    nanoarrow::UniqueBuffer bytes_;
    /// Is eos?
    bool is_eos_ = false;

   public:
    /// Is end of stream?
    bool is_eos() const { return is_eos_; }
    /// Return the stream bytes
    const ArrowBuffer& bytes() const { return *bytes_.get(); }
};

struct ArrowIPCStreamBufferReader {
    /// Create arrow array stream wrapper
    static duckdb::unique_ptr<duckdb::ArrowArrayStreamWrapper> CreateStream(uintptr_t buffer_ptr,
                                                                            duckdb::ArrowStreamParameters& parameters);
    /// Create arrow array stream wrapper
    static void GetSchema(uintptr_t buffer_ptr, duckdb::ArrowSchemaWrapper& schema);
};

/// Collects Arrow IPC stream bytes pushed in arbitrary pieces, tracking message boundaries to find the end of stream
struct BufferingArrowIPCStreamDecoder {
   protected:
    /// The buffer
    std::shared_ptr<ArrowIPCStreamBuffer> buffer_;
    /// The decoder used to read message headers
    nanoarrow::ipc::UniqueDecoder decoder_;
    /// The offset of the first message that is not yet complete
    int64_t next_message_offset_ = 0;

   public:
    /// Constructor
    BufferingArrowIPCStreamDecoder(std::shared_ptr<ArrowIPCStreamBuffer> buffer = std::make_shared<ArrowIPCStreamBuffer>());
    /// Consume stream bytes
    Status Consume(const uint8_t* data, size_t size);
    /// Get the buffer
    auto& buffer() const { return buffer_; }
};

}  // namespace web
}  // namespace duckdb

#endif  // INCLUDE_DUCKDB_WEB_ARROW_STREAM_BUFFER_H_
