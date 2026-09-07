#pragma once

#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <string>
#include <vector>

namespace aihider {

class Tokenizer {
public:
    explicit Tokenizer(const std::filesystem::path& tokenizer_json);
    ~Tokenizer() noexcept;
    Tokenizer(const Tokenizer&) = delete;
    Tokenizer& operator=(const Tokenizer&) = delete;
    Tokenizer(Tokenizer&& other) noexcept;
    Tokenizer& operator=(Tokenizer&& other) noexcept;

    std::vector<uint32_t> encode(const std::string& text);
    std::string decode(const std::vector<uint32_t>& ids);
    std::vector<uint32_t> wrap(const std::vector<uint32_t>& ids);

    // Constructor verifies these IDs and wrapping against the loaded tokenizer.
    static constexpr uint32_t prefix = 1;
    static constexpr uint32_t suffix = 2;
    static constexpr std::size_t capacity = 510;

private:
    void* handle_ = nullptr;
};

} // namespace aihider
