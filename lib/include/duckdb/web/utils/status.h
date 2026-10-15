#ifndef INCLUDE_DUCKDB_WEB_UTILS_STATUS_H_
#define INCLUDE_DUCKDB_WEB_UTILS_STATUS_H_

#include <cassert>
#include <cstdint>
#include <new>
#include <sstream>
#include <string>
#include <type_traits>
#include <utility>

namespace duckdb {
namespace web {

/// Status codes, numbered as in Apache Arrow so codes passed to JS keep their values
enum class StatusCode : int8_t {
    OK = 0,
    OutOfMemory = 1,
    KeyError = 2,
    TypeError = 3,
    Invalid = 4,
    IOError = 5,
    UnknownError = 9,
    NotImplemented = 10,
    ExecutionError = 42,
};

/// The outcome of an operation that returns no value
class Status {
   public:
    Status() = default;
    Status(StatusCode code, std::string message) : code_(code), message_(std::move(message)) {}

    static Status OK() { return Status(); }
    template <typename... Args> static Status OutOfMemory(Args&&... args) {
        return Make(StatusCode::OutOfMemory, std::forward<Args>(args)...);
    }
    template <typename... Args> static Status KeyError(Args&&... args) {
        return Make(StatusCode::KeyError, std::forward<Args>(args)...);
    }
    template <typename... Args> static Status Invalid(Args&&... args) {
        return Make(StatusCode::Invalid, std::forward<Args>(args)...);
    }
    template <typename... Args> static Status IOError(Args&&... args) {
        return Make(StatusCode::IOError, std::forward<Args>(args)...);
    }
    template <typename... Args> static Status UnknownError(Args&&... args) {
        return Make(StatusCode::UnknownError, std::forward<Args>(args)...);
    }
    template <typename... Args> static Status NotImplemented(Args&&... args) {
        return Make(StatusCode::NotImplemented, std::forward<Args>(args)...);
    }
    template <typename... Args> static Status ExecutionError(Args&&... args) {
        return Make(StatusCode::ExecutionError, std::forward<Args>(args)...);
    }

    bool ok() const { return code_ == StatusCode::OK; }
    StatusCode code() const { return code_; }
    const std::string& message() const { return message_; }
    std::string ToString() const { return ok() ? "OK" : message_; }

   private:
    template <typename... Args> static Status Make(StatusCode code, Args&&... args) {
        std::ostringstream message;
        (message << ... << std::forward<Args>(args));
        return Status(code, message.str());
    }

    StatusCode code_ = StatusCode::OK;
    std::string message_;
};

/// A value, or the error status explaining why there is none
template <typename T> class Result {
    /// The value is stored without const and constructed in place, so that a Result can hold types like
    /// rapidjson values that std::optional can't (their copy assignment takes a non-const reference)
    using Value = std::remove_const_t<T>;

   public:
    Result(Status status) : status_(std::move(status)) { assert(!status_.ok()); }
    template <typename U, typename = std::enable_if_t<std::is_constructible_v<Value, U&&> &&
                                                      !std::is_same_v<std::decay_t<U>, Status> &&
                                                      !std::is_same_v<std::decay_t<U>, Result>>>
    Result(U&& value) {
        new (&storage_) Value(std::forward<U>(value));
    }
    Result(Result&& other) : status_(other.status_) {
        if (ok()) new (&storage_) Value(std::move(other.value()));
    }
    Result(const Result& other) : status_(other.status_) {
        if (ok()) new (&storage_) Value(other.value());
    }
    Result& operator=(Result&& other) {
        if (this != &other) {
            this->~Result();
            new (this) Result(std::move(other));
        }
        return *this;
    }
    ~Result() {
        if (ok()) value().~Value();
    }

    bool ok() const { return status_.ok(); }
    const Status& status() const { return status_; }

    const T& ValueUnsafe() const& { return value(); }
    T& ValueUnsafe() & { return value(); }
    T&& ValueUnsafe() && { return std::move(value()); }
    T ValueOrDie() && {
        assert(ok());
        return std::move(value());
    }
    const T& operator*() const& { return value(); }
    T& operator*() & { return value(); }
    const T* operator->() const { return &value(); }
    T* operator->() { return &value(); }

   private:
    Value& value() { return *std::launder(reinterpret_cast<Value*>(&storage_)); }
    const Value& value() const { return *std::launder(reinterpret_cast<const Value*>(&storage_)); }

    Status status_;
    alignas(Value) unsigned char storage_[sizeof(Value)];
};

template <typename T> Result(T) -> Result<T>;

namespace internal {
inline const Status& ToStatus(const Status& status) { return status; }
template <typename T> const Status& ToStatus(const Result<T>& result) { return result.status(); }
}  // namespace internal

}  // namespace web
}  // namespace duckdb

#define WEBDB_CONCAT_IMPL(x, y) x##y
#define WEBDB_CONCAT(x, y) WEBDB_CONCAT_IMPL(x, y)

/// Return the status of a Status or Result expression if it is an error
#define WEBDB_RETURN_NOT_OK(EXPR)                                                              \
    do {                                                                                       \
        const auto& _webdb_status = ::duckdb::web::internal::ToStatus(EXPR);                   \
        if (!_webdb_status.ok()) return _webdb_status;                                         \
    } while (false)

#define WEBDB_ASSIGN_OR_RAISE_IMPL(RESULT, LHS, REXPR) \
    auto&& RESULT = (REXPR);                           \
    if (!RESULT.ok()) return RESULT.status();          \
    LHS = std::move(RESULT).ValueUnsafe();

/// Assign the value of a Result expression to LHS, or return its status if it is an error
#define WEBDB_ASSIGN_OR_RAISE(LHS, REXPR) \
    WEBDB_ASSIGN_OR_RAISE_IMPL(WEBDB_CONCAT(_webdb_result_, __COUNTER__), LHS, REXPR)

#endif
