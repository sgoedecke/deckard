#pragma once

#include <cstdint>
#include <filesystem>
#include <memory>
#include <vector>

namespace aihider {

// The pinned FP16 Core ML program, batch one, CPU and Neural Engine only.
// Inputs include special tokens; shorter inputs are padded to 512 positions.
class CoreMLGradient {
 public:
  CoreMLGradient(const std::filesystem::path& model_directory,
                 const std::filesystem::path& cache_directory);
  ~CoreMLGradient();
  CoreMLGradient(const CoreMLGradient&) = delete;
  CoreMLGradient& operator=(const CoreMLGradient&) = delete;

  double logit(const std::vector<std::uint32_t>& ids,
               const std::vector<std::uint32_t>& mask);

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace aihider
