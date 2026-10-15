#ifndef INCLUDE_DUCKDB_WEB_UTILS_BUFFER_H_
#define INCLUDE_DUCKDB_WEB_UTILS_BUFFER_H_

#include <cstdint>
#include <memory>

namespace duckdb {
namespace web {

/// A block of bytes returned to JS, kept alive by whatever owns its memory
class Buffer {
   public:
    Buffer(uint8_t* data, int64_t size, std::shared_ptr<void> owner)
        : data_(data), size_(size), owner_(std::move(owner)) {}

    /// Allocate an uninitialized buffer
    static std::shared_ptr<Buffer> Allocate(int64_t size) {
        std::shared_ptr<uint8_t[]> bytes{new uint8_t[size > 0 ? size : 1]};
        auto data = bytes.get();
        return std::make_shared<Buffer>(data, size, std::move(bytes));
    }

    const uint8_t* data() const { return data_; }
    uint8_t* mutable_data() { return data_; }
    int64_t size() const { return size_; }
    /// Shrink the visible size, e.g. after filling less than was allocated
    void Truncate(int64_t size) { size_ = size < size_ ? size : size_; }

   private:
    uint8_t* data_;
    int64_t size_;
    std::shared_ptr<void> owner_;
};

}  // namespace web
}  // namespace duckdb

#endif
