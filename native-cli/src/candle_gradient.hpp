#pragma once

#include "support.hpp"
#include <cstdint>
#include <string>
#include <vector>

namespace aihider {

// C ABI of the Rust ai_hider_candle staticlib (native-cli/candle/src/lib.rs).
// Every call returns one of the status codes below.
extern "C" {
std::int32_t aih_candle_open(const char* config_path, size_t config_len, const char* weights_path,
                             size_t weights_len, void** out);
std::int32_t aih_candle_logit(void* handle, const std::uint32_t* ids, size_t ids_len,
                              const float* mask, size_t mask_len, double* out);
std::int32_t aih_candle_close(void* handle);
}

// The pinned fp32 DeBERTa-v2 checkpoint (config.json + model.safetensors) on
// the CPU through Candle, batch one. Unlike Core ML, inputs are not padded.
class CandleGradient {
 public:
  CandleGradient(const fs::path& model_directory, const fs::path& /*cache_directory*/) {
    // Like the Core ML backend, never load weights that do not match the pins.
    verify_model_assets(model_directory);
    const auto config = (model_directory / "config.json").string();
    const auto weights = (model_directory / "model.safetensors").string();
    check(aih_candle_open(config.data(), config.size(), weights.data(), weights.size(), &handle_),
          "The Candle gradient model failed to load.");
  }
  ~CandleGradient() { if (handle_) (void)aih_candle_close(handle_); }
  CandleGradient(const CandleGradient&) = delete;
  CandleGradient& operator=(const CandleGradient&) = delete;

  double logit(const std::vector<std::uint32_t>& ids, const std::vector<std::uint32_t>& mask) {
    if (ids.size() != mask.size())
      throw Error("invalid_input", "Gradient token ids and attention mask differ in length.");
    if (ids.size() > max_tokens)
      throw Error("invalid_input", "Gradient input exceeds the 512-token limit.");
    if (ids.size() < 3 || ids.front() != 1 || ids.back() != 2)
      throw Error("invalid_input", "Gradient input must be wrapped as CLS..SEP.");
    // The mask crosses the C ABI as f32, like the Core ML input.
    const std::vector<float> float_mask(mask.begin(), mask.end());
    double value = 0;
    check(aih_candle_logit(handle_, ids.data(), ids.size(), float_mask.data(), float_mask.size(), &value),
          "The Candle gradient inference failed.");
    return value;
  }

 private:
  static constexpr size_t max_tokens = 512;

  // Status codes of lib.rs. Messages never include text or paths.
  static void check(std::int32_t status, const char* message) {
    switch (status) {
      case 0: return;
      case 1: throw Error("invalid_input", message);
      case 2: throw Error("missing_assets", message);
      case 3: throw Error("load_failed", message);
      case 5: throw Error("invalid_output", message);
      default: throw Error("inference_failed", message);  // 4 forward failure, 6 caught panic
    }
  }

  void* handle_ = nullptr;
};

}  // namespace aihider
