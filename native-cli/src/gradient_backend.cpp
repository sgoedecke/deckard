#include "gradient_backend.hpp"

#if defined(__APPLE__)
#include "coreml_gradient.hpp"
#elif defined(__linux__)
#include "candle_gradient.hpp"
#else
#error "Deckard supports Apple Silicon macOS (Core ML) and Linux x86_64 (Candle) only."
#endif

namespace aihider {
namespace {

// Adapts a concrete runtime (CoreMLGradient, CandleGradient) to ModelBackend.
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

 private:
  Runtime runtime_;
};

}  // namespace

std::unique_ptr<ModelBackend> create_model_backend(
    const std::filesystem::path& model_directory,
    const std::filesystem::path& cache_directory) {
#if defined(__APPLE__)
  return std::make_unique<RuntimeBackend<CoreMLGradient>>(model_directory, cache_directory);
#else
  return std::make_unique<RuntimeBackend<CandleGradient>>(model_directory, cache_directory);
#endif
}

}  // namespace aihider
