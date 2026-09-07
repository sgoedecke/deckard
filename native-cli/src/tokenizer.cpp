#include "tokenizer.hpp"

#include <stdexcept>
#include <utility>

namespace {

struct Ids {
    uint32_t* data;
    std::size_t len;
};

struct Bytes {
    uint8_t* data;
    std::size_t len;
};

// Buffers are length-delimited, not NUL-terminated, and allocated only by Rust.
// A successful empty result is {nullptr, 0}; failures also clear the output.
extern "C" {
int32_t aih_tokenizer_open(const uint8_t*, std::size_t, void**);
int32_t aih_tokenizer_close(void*);
int32_t aih_tokenizer_encode(const void*, const uint8_t*, std::size_t, Ids*);
int32_t aih_tokenizer_decode(const void*, const uint32_t*, std::size_t, Bytes*);
int32_t aih_tokenizer_wrap(const void*, const uint32_t*, std::size_t, Ids*);
int32_t aih_tokenizer_free_ids(Ids*);
int32_t aih_tokenizer_free_bytes(Bytes*);
}

void check(int32_t status) {
    if (status != 0) {
        // Do not expose library diagnostics, input text, or local paths.
        throw std::runtime_error("Tokenizer operation failed (code " + std::to_string(status) + ")");
    }
}

struct OwnedIds {
    Ids value{nullptr, 0};
    ~OwnedIds() { (void)aih_tokenizer_free_ids(&value); }
    std::vector<uint32_t> copy() const {
        if (!value.len) return {};
        return {value.data, value.data + value.len};
    }
};

struct OwnedBytes {
    Bytes value{nullptr, 0};
    ~OwnedBytes() { (void)aih_tokenizer_free_bytes(&value); }
    std::string copy() const {
        if (!value.len) return {};
        return {reinterpret_cast<const char*>(value.data), value.len};
    }
};

} // namespace

namespace aihider {

Tokenizer::Tokenizer(const std::filesystem::path& tokenizer_json) {
    const auto path = tokenizer_json.u8string();
    check(aih_tokenizer_open(reinterpret_cast<const uint8_t*>(path.data()), path.size(), &handle_));
}

Tokenizer::~Tokenizer() noexcept {
    (void)aih_tokenizer_close(handle_);
}

Tokenizer::Tokenizer(Tokenizer&& other) noexcept : handle_(std::exchange(other.handle_, nullptr)) {}

Tokenizer& Tokenizer::operator=(Tokenizer&& other) noexcept {
    if (this != &other) {
        (void)aih_tokenizer_close(handle_);
        handle_ = std::exchange(other.handle_, nullptr);
    }
    return *this;
}

std::vector<uint32_t> Tokenizer::encode(const std::string& text) {
    OwnedIds result;
    check(aih_tokenizer_encode(handle_, reinterpret_cast<const uint8_t*>(text.data()), text.size(), &result.value));
    return result.copy();
}

std::string Tokenizer::decode(const std::vector<uint32_t>& ids) {
    OwnedBytes result;
    check(aih_tokenizer_decode(handle_, ids.data(), ids.size(), &result.value));
    return result.copy();
}

std::vector<uint32_t> Tokenizer::wrap(const std::vector<uint32_t>& ids) {
    OwnedIds result;
    check(aih_tokenizer_wrap(handle_, ids.data(), ids.size(), &result.value));
    return result.copy();
}

} // namespace aihider
