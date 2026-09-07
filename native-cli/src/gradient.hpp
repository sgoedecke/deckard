#pragma once

#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <memory>
#include <vector>

namespace aihider {

// Pinned Gradient DeBERTa-v3-large, MLX affine q4/group64, batch one.
// Callers supply complete token IDs (including special tokens), without padding
// unless padding is intended. Tokenization and document windowing live outside.
class Gradient {
 public:
  static constexpr std::size_t source_parameter_count = 435062785;
  static constexpr std::size_t packed_tensor_count = 690;

  struct Memory {
    std::size_t active_bytes;
    std::size_t cache_bytes;
    std::size_t peak_bytes;
    std::size_t parameter_bytes;
    std::size_t position_cache_bytes;
    bool compiled;
  };

  explicit Gradient(const std::filesystem::path& packed_weights, bool compiled = true);
  ~Gradient();
  Gradient(Gradient&&) noexcept;
  Gradient& operator=(Gradient&&) noexcept;
  Gradient(const Gradient&) = delete;
  Gradient& operator=(const Gradient&) = delete;

  // Synchronously returns one finite logit, not a sigmoid probability.
  float logit(const std::vector<std::uint32_t>& ids, const std::vector<std::uint32_t>& mask);
  Memory memory() const;

  // Strict FP32 HF checkpoint -> rounded FP16 -> exact MLX affine q4/group64.
  // Refuses existing output files and publishes the completed file atomically.
  // The installer must verify the pinned download's identity before calling.
  static void quantize_checkpoint(
      const std::filesystem::path& fp32_weights,
      const std::filesystem::path& packed_output);

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace aihider
