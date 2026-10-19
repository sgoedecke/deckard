#include "onnx_gradient.hpp"

#include "gradient_backend.hpp"
#include "onnx_runtime.hpp"

#include <cmath>
#include <functional>

namespace aihider {
namespace {

// Owns one ONNX Runtime object and releases it with the matching Release call.
template <typename T>
using Owned = std::unique_ptr<T, std::function<void(T*)>>;

}  // namespace

struct OnnxGradient::Impl {
  const OrtApi& api;
  Owned<OrtEnv> env;
  Owned<OrtMemoryInfo> memory;
  Owned<OrtSession> session;

  explicit Impl(const OrtApi& runtime) : api(runtime) {}

  template <typename T>
  Owned<T> own(T* object, void (*release)(T*)) {
    return Owned<T>(object, [release](T* value) { if (value) release(value); });
  }

  Owned<OrtSession> open(const fs::path& model) {
    OrtSessionOptions* raw_options = nullptr;
    onnx_check(api, api.CreateSessionOptions(&raw_options), "onnx_unavailable", "Cannot create session options");
    auto options = own(raw_options, api.ReleaseSessionOptions);
    onnx_check(api, api.SetSessionGraphOptimizationLevel(options.get(), ORT_ENABLE_ALL), "onnx_unavailable",
               "Cannot configure the session");
    OrtSession* raw_session = nullptr;
    onnx_check(api, api.CreateSession(env.get(), model.c_str(), options.get(), &raw_session), "onnx_unavailable",
               "Cannot open model.onnx");
    return own(raw_session, api.ReleaseSession);
  }
};

OnnxGradient::OnnxGradient(const fs::path& model_directory, const fs::path& cache_directory) {
  verify_model_assets(model_directory, false);
  if (!fs::is_regular_file(model_directory / "model.onnx"))
    throw Error("missing_assets", "The ONNX Runtime backend needs model.onnx in the model directory.");
  require_model_file(model_directory, "model.onnx");

  impl_ = std::make_unique<Impl>(onnx_runtime(cache_directory));
  const OrtApi& api = impl_->api;
  OrtEnv* env = nullptr;
  onnx_check(api, api.CreateEnv(ORT_LOGGING_LEVEL_WARNING, "deckard", &env), "onnx_unavailable",
             "Cannot create the ONNX Runtime environment");
  impl_->env = impl_->own(env, api.ReleaseEnv);
  OrtMemoryInfo* memory = nullptr;
  onnx_check(api, api.CreateCpuMemoryInfo(OrtArenaAllocator, OrtMemTypeDefault, &memory), "onnx_unavailable",
             "Cannot describe CPU memory");
  impl_->memory = impl_->own(memory, api.ReleaseMemoryInfo);

  impl_->session = impl_->open(model_directory / "model.onnx");
}

OnnxGradient::~OnnxGradient() = default;

double OnnxGradient::logit(const std::vector<std::uint32_t>& ids, const std::vector<std::uint32_t>& mask) {
  validate_gradient_input(ids, mask);
  const OrtApi& api = impl_->api;
  // The export takes int64 input_ids and attention_mask of shape [1, tokens].
  std::vector<int64_t> input_ids(ids.begin(), ids.end());
  std::vector<int64_t> attention_mask(mask.begin(), mask.end());
  const int64_t shape[2] = {1, static_cast<int64_t>(ids.size())};
  auto tensor = [&](std::vector<int64_t>& values) {
    OrtValue* value = nullptr;
    onnx_check(api, api.CreateTensorWithDataAsOrtValue(impl_->memory.get(), values.data(),
                                                       values.size() * sizeof(int64_t), shape, 2,
                                                       ONNX_TENSOR_ELEMENT_DATA_TYPE_INT64, &value),
               "inference_failed", "Cannot create an input tensor");
    return impl_->own(value, api.ReleaseValue);
  };
  auto ids_tensor = tensor(input_ids);
  auto mask_tensor = tensor(attention_mask);

  const char* input_names[] = {"input_ids", "attention_mask"};
  const char* output_names[] = {"logits"};
  const OrtValue* inputs[] = {ids_tensor.get(), mask_tensor.get()};
  OrtValue* raw_output = nullptr;
  onnx_check(api, api.Run(impl_->session.get(), nullptr, input_names, inputs, 2, output_names, 1, &raw_output),
             "inference_failed", "ONNX Runtime inference failed");
  auto output = impl_->own(raw_output, api.ReleaseValue);
  OrtTensorTypeAndShapeInfo* raw_info = nullptr;
  onnx_check(api, api.GetTensorTypeAndShape(output.get(), &raw_info), "inference_failed", "Cannot describe the logits");
  auto info = impl_->own(raw_info, api.ReleaseTensorTypeAndShapeInfo);
  ONNXTensorElementDataType type = ONNX_TENSOR_ELEMENT_DATA_TYPE_UNDEFINED;
  size_t count = 0;
  onnx_check(api, api.GetTensorElementType(info.get(), &type), "inference_failed", "Cannot describe the logits");
  onnx_check(api, api.GetTensorShapeElementCount(info.get(), &count), "inference_failed", "Cannot describe the logits");
  if (type != ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT || count != 1)
    throw Error("invalid_output", "The ONNX gradient model must return one float logit.");
  float* logits = nullptr;
  onnx_check(api, api.GetTensorMutableData(output.get(), reinterpret_cast<void**>(&logits)), "inference_failed",
             "Cannot read the logits");
  if (!logits || !std::isfinite(logits[0]))
    throw Error("invalid_output", "The ONNX gradient model returned a non-finite logit.");
  return logits[0];
}

}  // namespace aihider
