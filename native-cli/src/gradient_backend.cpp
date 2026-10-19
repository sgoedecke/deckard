#include "gradient_backend.hpp"
#include "support.hpp"

#include <utility>

#if defined(__APPLE__)
#include "coreml_gradient.hpp"
#elif defined(__linux__)
#include "candle_gradient.hpp"
#include "onnx_gradient.hpp"
#include <iostream>
#else
#error "Deckard supports Apple Silicon macOS (Core ML) and Linux x86_64 (Candle, ONNX Runtime) only."
#endif

namespace aihider {
namespace {

// Adapts a concrete runtime (CoreMLGradient, CandleGradient, OnnxGradient) to
// ModelBackend.
template <typename Runtime>
class RuntimeBackend : public ModelBackend {
 public:
  RuntimeBackend(const std::filesystem::path& model_directory,
                 const std::filesystem::path& cache_directory)
      : runtime_(model_directory, cache_directory) {}

  double logit(const std::vector<std::uint32_t>& ids,
               const std::vector<std::uint32_t>& mask) override {
    return runtime_.logit(ids, mask);
  }
  const char* runtime() const override {
    if constexpr (requires { runtime_.runtime(); }) return runtime_.runtime();
    return ModelBackend::runtime();
  }

 private:
  Runtime runtime_;
};

#if defined(__linux__)
// Errors that mean the model files are wrong. They must surface: falling back
// to another runtime would hide a corrupt or tampered installation.
bool integrity_error(const Error& error) {
  return error.code == "missing_assets" || error.code == "asset_mismatch";
}

// Backend::Auto with model.onnx present: ONNX Runtime first, Candle when ONNX
// Runtime cannot start or fails during inference. Once Candle took over it
// stays for the life of the process.
class AutoBackend : public ModelBackend {
 public:
  AutoBackend(BackendFactory onnx, BackendFactory candle, std::ostream& log)
      : candle_factory_(std::move(candle)), log_(log) {
    try {
      onnx_ = onnx();
    } catch (const Error& error) {
      if (integrity_error(error)) throw;
      use_candle(error);
    }
  }

  double logit(const std::vector<std::uint32_t>& ids,
               const std::vector<std::uint32_t>& mask) override {
    if (onnx_) {
      try {
        return onnx_->logit(ids, mask);
      } catch (const Error& error) {
        if (error.code == "invalid_input") throw;
        use_candle(error);
      }
    }
    return candle_->logit(ids, mask);
  }
  const char* runtime() const override { return onnx_ ? onnx_->runtime() : candle_->runtime(); }

 private:
  void use_candle(const Error& reason) {
    onnx_.reset();
    log_ << "Deckard: onnx_fallback (" << reason.code << "); using Candle on the CPU.\n";
    candle_ = candle_factory_();
  }

  BackendFactory candle_factory_;
  std::ostream& log_;
  std::unique_ptr<ModelBackend> onnx_, candle_;
};
#endif

}  // namespace

const char* ModelBackend::runtime() const { return runtime_id; }

Backend resolve_backend(const std::filesystem::path& model_directory, Backend backend) {
  if (backend != Backend::Auto) return backend;
  return std::filesystem::is_regular_file(model_directory / "model.onnx") ? Backend::Onnx : Backend::Candle;
}

std::unique_ptr<ModelBackend> create_model_backend(
    const std::filesystem::path& model_directory,
    const std::filesystem::path& cache_directory,
    Backend backend) {
#if defined(__APPLE__)
  (void)backend;
  return std::make_unique<RuntimeBackend<CoreMLGradient>>(model_directory, cache_directory);
#else
  if (backend == Backend::Onnx)
    return std::make_unique<RuntimeBackend<OnnxGradient>>(model_directory, cache_directory);
  if (resolve_backend(model_directory, backend) == Backend::Onnx)
    return make_auto_backend(
        [=] { return std::make_unique<RuntimeBackend<OnnxGradient>>(model_directory, cache_directory); },
        [=] { return std::make_unique<RuntimeBackend<CandleGradient>>(model_directory, cache_directory); },
        std::cerr);
  return std::make_unique<RuntimeBackend<CandleGradient>>(model_directory, cache_directory);
#endif
}

#if defined(__linux__)
std::unique_ptr<ModelBackend> make_auto_backend(BackendFactory onnx, BackendFactory candle, std::ostream& log) {
  return std::make_unique<AutoBackend>(std::move(onnx), std::move(candle), log);
}
#endif

void validate_gradient_input(const std::vector<std::uint32_t>& ids, const std::vector<std::uint32_t>& mask) {
  if (ids.size() != mask.size())
    throw Error("invalid_input", "Gradient token ids and attention mask differ in length.");
  if (ids.size() > 512) throw Error("invalid_input", "Gradient input exceeds the 512-token limit.");
  if (ids.size() < 3 || ids.front() != 1 || ids.back() != 2)
    throw Error("invalid_input", "Gradient input must be wrapped as CLS..SEP.");
}

}  // namespace aihider
