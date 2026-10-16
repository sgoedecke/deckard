#pragma once

#include <cstdint>
#include <filesystem>
#include <functional>
#include <iosfwd>
#include <memory>
#include <vector>

namespace aihider {

// One Gradient inference runtime: Core ML on macOS, Candle on Linux. The model
// and cache directories are read at construction; logit() scores one wrapped
// CLS..SEP sequence of at most 512 tokens.
// On Linux, ONNX Runtime is a second runtime (see Backend below).
class ModelBackend {
 public:
  virtual ~ModelBackend() = default;
  virtual double logit(const std::vector<std::uint32_t>& ids,
                       const std::vector<std::uint32_t>& mask) = 0;
  // The runtime that serves inference: the platform runtime_id ("native-coreml",
  // "native-candle") or "native-onnx".
  virtual const char* runtime() const;
};

// The Linux runtime to use. Auto prefers ONNX Runtime when the model
// directory holds the pinned model.onnx and falls back to Candle when ONNX
// Runtime cannot start or fails during inference. Candle and Onnx force one
// runtime without fallback. macOS always uses Core ML.
enum class Backend { Auto, Candle, Onnx };

// The runtime that Backend::Auto starts with for `model_directory`.
Backend resolve_backend(const std::filesystem::path& model_directory, Backend backend);

// Opens the runtime of the platform this binary was built for.
std::unique_ptr<ModelBackend> create_model_backend(
    const std::filesystem::path& model_directory,
    const std::filesystem::path& cache_directory,
    Backend backend = Backend::Auto);

#if defined(__linux__)
using BackendFactory = std::function<std::unique_ptr<ModelBackend>()>;

// Backend::Auto's fallback policy, with the runtimes supplied by the caller so
// the self-test can script them: serves with `onnx`, and switches to `candle`
// for the rest of the process when `onnx` cannot start or fails during
// inference, noting the reason on `log`. Integrity errors at start and invalid
// input are thrown instead: a fallback would hide them.
std::unique_ptr<ModelBackend> make_auto_backend(BackendFactory onnx, BackendFactory candle, std::ostream& log);
#endif

// Throws Error("invalid_input") unless `ids` is a CLS..SEP-wrapped sequence of
// 3 to 512 tokens with a mask of the same length.
void validate_gradient_input(const std::vector<std::uint32_t>& ids, const std::vector<std::uint32_t>& mask);

}  // namespace aihider
