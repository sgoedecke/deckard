#pragma once

#include "support.hpp"
#include <cstdint>
#include <memory>
#include <vector>

namespace aihider {

// The pinned model.onnx (an fp32 export of the Hugging Face checkpoint, see
// docs/LINUX.md) on ONNX Runtime's CPU provider, batch one.
class OnnxGradient {
 public:
  OnnxGradient(const fs::path& model_directory, const fs::path& cache_directory);
  ~OnnxGradient();
  OnnxGradient(const OnnxGradient&) = delete;
  OnnxGradient& operator=(const OnnxGradient&) = delete;

  double logit(const std::vector<std::uint32_t>& ids, const std::vector<std::uint32_t>& mask);
  const char* runtime() const { return "native-onnx"; }

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace aihider
