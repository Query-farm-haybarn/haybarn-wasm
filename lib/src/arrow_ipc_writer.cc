#include "duckdb/web/arrow_ipc_writer.h"

#include <cstring>

#include "duckdb/web/arrow_casts.h"
#include "nanoarrow/nanoarrow.hpp"
#include "nanoarrow/nanoarrow_ipc.hpp"

namespace duckdb {
namespace web {

namespace {

/// An arrow::Buffer that owns the memory of a nanoarrow buffer without copying it
class NanoarrowBuffer : public arrow::Buffer {
   public:
    explicit NanoarrowBuffer(nanoarrow::UniqueBuffer buffer) : arrow::Buffer(nullptr, 0), buffer_(std::move(buffer)) {
        data_ = buffer_->data;
        size_ = buffer_->size_bytes;
        capacity_ = buffer_->capacity_bytes;
    }

   private:
    nanoarrow::UniqueBuffer buffer_;
};

arrow::Status ToStatus(ArrowErrorCode code, const ArrowError& error) {
    if (code == NANOARROW_OK) return arrow::Status::OK();
    return arrow::Status::IOError("Arrow IPC serialization failed: ", error.message[0] ? error.message : strerror(code));
}

}  // namespace

#define RETURN_NANOARROW_NOT_OK(EXPR, ERROR)               \
    do {                                                   \
        ArrowErrorCode _code = (EXPR);                     \
        if (_code != NANOARROW_OK) {                       \
            return ToStatus(_code, ERROR);                 \
        }                                                  \
    } while (0)

struct ArrowIPCWriter::State {
    Format format;
    /// The bytes written and not yet taken. The writer's output stream points at this buffer.
    nanoarrow::UniqueBuffer output;
    nanoarrow::ipc::UniqueWriter writer;
    /// The schema as written, after any casts
    nanoarrow::UniqueSchema schema;
    nanoarrow::UniqueArrayView array_view;
    /// The configured result casts
    ArrowResultCasts casts;
    ArrowError error = {};
};

ArrowIPCWriter::ArrowIPCWriter(std::unique_ptr<State> state) : state_(std::move(state)) {}
ArrowIPCWriter::~ArrowIPCWriter() = default;

arrow::Result<std::unique_ptr<ArrowIPCWriter>> ArrowIPCWriter::Create(ArrowSchema* schema, const QueryConfig& config,
                                                                      Format format) {
    auto state = std::make_unique<State>();
    state->format = format;
    auto& error = state->error;
    nanoarrow::UniqueSchema input_schema{schema};

    // Casting changes the schema's types, so cast a copy owned by nanoarrow rather than DuckDB's schema
    if (config.hasAnyCast()) {
        RETURN_NANOARROW_NOT_OK(ArrowSchemaDeepCopy(input_schema.get(), state->schema.get()), error);
        RETURN_NANOARROW_NOT_OK(state->casts.Plan(state->schema.get(), config, &error), error);
    } else {
        state->schema = std::move(input_schema);
    }
    RETURN_NANOARROW_NOT_OK(ArrowArrayViewInitFromSchema(state->array_view.get(), state->schema.get(), &error), error);

    nanoarrow::ipc::UniqueOutputStream output_stream;
    RETURN_NANOARROW_NOT_OK(ArrowIpcOutputStreamInitBuffer(output_stream.get(), state->output.get()), error);
    RETURN_NANOARROW_NOT_OK(ArrowIpcWriterInit(state->writer.get(), output_stream.get()), error);
    if (format == Format::FILE) {
        RETURN_NANOARROW_NOT_OK(ArrowIpcWriterStartFile(state->writer.get(), &error), error);
    }
    RETURN_NANOARROW_NOT_OK(ArrowIpcWriterWriteSchema(state->writer.get(), state->schema.get(), &error), error);
    return std::unique_ptr<ArrowIPCWriter>(new ArrowIPCWriter(std::move(state)));
}

arrow::Status ArrowIPCWriter::Write(ArrowArray* array) {
    auto& error = state_->error;
    nanoarrow::UniqueArray batch{array};
    RETURN_NANOARROW_NOT_OK(state_->casts.Apply(batch.get(), &error), error);
    RETURN_NANOARROW_NOT_OK(ArrowArrayViewSetArray(state_->array_view.get(), batch.get(), &error), error);
    RETURN_NANOARROW_NOT_OK(
        ArrowIpcWriterWriteArrayViewWithDictionaries(state_->writer.get(), state_->array_view.get(), &error), error);
    return arrow::Status::OK();
}

arrow::Status ArrowIPCWriter::Finish() {
    auto& error = state_->error;
    if (state_->format == Format::FILE) {
        RETURN_NANOARROW_NOT_OK(ArrowIpcWriterFinalizeFile(state_->writer.get(), &error), error);
    }
    return arrow::Status::OK();
}

std::shared_ptr<arrow::Buffer> ArrowIPCWriter::TakeBytes() {
    // Moving the buffer out leaves an empty one in place for the output stream to keep appending to
    nanoarrow::UniqueBuffer bytes;
    ArrowBufferMove(state_->output.get(), bytes.get());
    return std::make_shared<NanoarrowBuffer>(std::move(bytes));
}

}  // namespace web
}  // namespace duckdb
