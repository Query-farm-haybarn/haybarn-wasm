#include "duckdb/web/arrow_stream_buffer.h"

namespace duckdb {
namespace web {

namespace {

/// Release the reference a stream reader's input holds on the collected stream bytes
void ReleaseStreamBuffer(ArrowBufferAllocator* allocator, uint8_t*, int64_t) {
    delete static_cast<std::shared_ptr<ArrowIPCStreamBuffer>*>(allocator->private_data);
}

/// Read the collected stream bytes as an ArrowArrayStream
ArrowErrorCode OpenStream(const std::shared_ptr<ArrowIPCStreamBuffer>& buffer, ArrowArrayStream* out) {
    // The reader's input borrows the bytes and keeps the buffer alive until it is released
    nanoarrow::UniqueBuffer input_bytes;
    auto& bytes = buffer->bytes();
    NANOARROW_RETURN_NOT_OK(ArrowBufferSetAllocator(
        input_bytes.get(),
        ArrowBufferDeallocator(ReleaseStreamBuffer, new std::shared_ptr<ArrowIPCStreamBuffer>(buffer))));
    input_bytes->data = bytes.data;
    input_bytes->size_bytes = bytes.size_bytes;
    input_bytes->capacity_bytes = bytes.size_bytes;

    nanoarrow::ipc::UniqueInputStream input;
    NANOARROW_RETURN_NOT_OK(ArrowIpcInputStreamInitBuffer(input.get(), input_bytes.get()));
    return ArrowIpcArrayStreamReaderInit(out, input.get(), nullptr);
}

}  // namespace

duckdb::unique_ptr<duckdb::ArrowArrayStreamWrapper> ArrowIPCStreamBufferReader::CreateStream(
    uintptr_t buffer_ptr, duckdb::ArrowStreamParameters& parameters) {
    assert(buffer_ptr != 0);
    auto buffer = reinterpret_cast<std::shared_ptr<ArrowIPCStreamBuffer>*>(buffer_ptr);
    auto stream_wrapper = duckdb::make_uniq<duckdb::ArrowArrayStreamWrapper>();
    stream_wrapper->arrow_array_stream.release = nullptr;
    if (OpenStream(*buffer, &stream_wrapper->arrow_array_stream) != NANOARROW_OK) {
        return nullptr;
    }
    return stream_wrapper;
}

void ArrowIPCStreamBufferReader::GetSchema(uintptr_t buffer_ptr, duckdb::ArrowSchemaWrapper& schema) {
    assert(buffer_ptr != 0);
    auto buffer = reinterpret_cast<std::shared_ptr<ArrowIPCStreamBuffer>*>(buffer_ptr);
    nanoarrow::UniqueArrayStream stream;
    if (OpenStream(*buffer, stream.get()) != NANOARROW_OK) {
        return;
    }
    stream->get_schema(stream.get(), &schema.arrow_schema);
}

BufferingArrowIPCStreamDecoder::BufferingArrowIPCStreamDecoder(std::shared_ptr<ArrowIPCStreamBuffer> buffer)
    : buffer_(std::move(buffer)) {
    ArrowIpcDecoderInit(decoder_.get());
}

Status BufferingArrowIPCStreamDecoder::Consume(const uint8_t* data, size_t size) {
    if (buffer_->is_eos_) {
        return Status::Invalid("Arrow IPC stream continues after its end-of-stream marker");
    }
    auto& bytes = *buffer_->bytes_.get();
    if (ArrowBufferAppend(&bytes, data, static_cast<int64_t>(size)) != NANOARROW_OK) {
        return Status::OutOfMemory("failed to buffer Arrow IPC stream");
    }

    // Skip over every complete message to see whether the end-of-stream marker has arrived
    ArrowError error = {};
    while (true) {
        ArrowBufferView remaining;
        remaining.data.as_uint8 = bytes.data + next_message_offset_;
        remaining.size_bytes = bytes.size_bytes - next_message_offset_;
        switch (ArrowIpcDecoderVerifyHeader(decoder_.get(), remaining, &error)) {
            case NANOARROW_OK:
                break;
            case ENODATA:
                buffer_->is_eos_ = true;
                return Status::OK();
            case ESPIPE:
                // The header is incomplete
                return Status::OK();
            default:
                return Status::Invalid("Invalid Arrow IPC stream: ", error.message);
        }
        auto message_size = static_cast<int64_t>(decoder_->header_size_bytes) + decoder_->body_size_bytes;
        if (remaining.size_bytes < message_size) {
            // The body is incomplete
            return Status::OK();
        }
        next_message_offset_ += message_size;
    }
}

}  // namespace web
}  // namespace duckdb
