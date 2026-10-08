#pragma once

#include <cstdint>
#include <filesystem>
#include <memory>
#include <vector>

namespace aihider {

// One Gradient inference runtime: Core ML on macOS, Candle on Linux. The model
// and cache directories are read at construction; logit() scores one wrapped
// CLS..SEP sequence of at most 512 tokens.
class ModelBackend {
 public:
  virtual ~ModelBackend() = default;
  virtual double logit(const std::vector<std::uint32_t>& ids,
                       const std::vector<std::uint32_t>& mask) = 0;
};

// Opens the runtime of the platform this binary was built for.
std::unique_ptr<ModelBackend> create_model_backend(
    const std::filesystem::path& model_directory,
    const std::filesystem::path& cache_directory);

}  // namespace aihider
