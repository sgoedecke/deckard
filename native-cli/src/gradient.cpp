#include "gradient.hpp"

#include <mlx/array.h>
#include <mlx/backend/metal/metal.h>
#include <mlx/compile.h>
#include <mlx/device.h>
#include <mlx/fast.h>
#include <mlx/io.h>
#include <mlx/memory.h>
#include <mlx/ops.h>
#include <mlx/stream.h>
#include <mlx/transforms.h>

#include <algorithm>
#include <cerrno>
#include <cmath>
#include <fcntl.h>
#include <functional>
#include <map>
#include <mutex>
#include <stdexcept>
#include <string>
#include <system_error>
#include <unordered_map>
#include <utility>
#include <unistd.h>

namespace aihider {
namespace {

namespace mx = mlx::core;
using Weights = std::unordered_map<std::string, mx::array>;

constexpr int hidden = 1024;
constexpr int intermediate = 4096;
constexpr int heads = 16;
constexpr int head_dimension = 64;
constexpr int layer_count = 24;
constexpr int vocabulary = 128100;
constexpr int maximum_length = 512;
constexpr int position_span = 256;
constexpr int quantization_bits = 4;
constexpr int group_size = 64;
constexpr float layer_norm_epsilon = 1e-7f;
constexpr std::size_t parameter_storage_bytes = 245189442;
constexpr std::size_t memory_limit_bytes = std::size_t{4} << 30;
constexpr std::size_t cache_limit_bytes = std::size_t{32} << 20;
constexpr const char* model_repo = "ShantanuT01/gradient-ai-text-detector";
constexpr const char* model_revision = "c2e8b6df87f8a211cbffb713fa9873a0c3a9713f";

struct SourceSpec {
  std::string source;
  std::string target;
  mx::Shape shape;
  bool quantized;
};

struct PackedSpec {
  mx::Shape shape;
  mx::Dtype dtype;
};

std::size_t elements(const mx::Shape& shape) {
  std::size_t count = 1;
  for (const auto dimension : shape) {
    if (dimension <= 0) {
      throw std::logic_error("Nonpositive pinned Gradient dimension.");
    }
    count *= static_cast<std::size_t>(dimension);
  }
  return count;
}

std::vector<SourceSpec> source_specification() {
  std::vector<SourceSpec> spec;
  const auto norm = [&spec](const std::string& source, const std::string& target) {
    spec.push_back({source + ".weight", target + ".weight", {hidden}, false});
    spec.push_back({source + ".bias", target + ".bias", {hidden}, false});
  };
  const auto linear = [&spec](const std::string& source, const std::string& target, int in, int out) {
    spec.push_back({source + ".weight", target + ".weight", {out, in}, true});
    spec.push_back({source + ".bias", target + ".bias", {out}, false});
  };
  spec.push_back({"deberta.embeddings.word_embeddings.weight",
                  "embeddings.word.weight", {vocabulary, hidden}, true});
  norm("deberta.embeddings.LayerNorm", "embeddings.norm");
  spec.push_back({"deberta.encoder.rel_embeddings.weight",
                  "relative_embeddings.weight", {2 * position_span, hidden}, true});
  norm("deberta.encoder.LayerNorm", "relative_norm");
  for (int index = 0; index < layer_count; ++index) {
    const auto source = "deberta.encoder.layer." + std::to_string(index);
    const auto target = "layers." + std::to_string(index);
    for (const auto* projection : {"query", "key", "value"}) {
      linear(source + ".attention.self." + projection + "_proj",
             target + ".attention." + projection, hidden, hidden);
    }
    linear(source + ".attention.output.dense", target + ".attention_output", hidden, hidden);
    norm(source + ".attention.output.LayerNorm", target + ".attention_norm");
    linear(source + ".intermediate.dense", target + ".intermediate", hidden, intermediate);
    linear(source + ".output.dense", target + ".output", intermediate, hidden);
    norm(source + ".output.LayerNorm", target + ".output_norm");
  }
  linear("pooler.dense", "pooler", hidden, hidden);
  linear("classifier", "classifier", hidden, 1);
  std::size_t count = 0;
  std::map<std::string, bool> source_names;
  std::map<std::string, bool> target_names;
  for (const auto& entry : spec) {
    count += elements(entry.shape);
    if (!source_names.emplace(entry.source, true).second ||
        !target_names.emplace(entry.target, true).second) {
      throw std::logic_error("Non-bijective pinned Gradient weight mapping.");
    }
  }
  if (spec.size() != 394 || count != Gradient::source_parameter_count) {
    throw std::logic_error("Pinned Gradient source parameter count mismatch.");
  }
  return spec;
}

std::map<std::string, PackedSpec> packed_specification() {
  std::map<std::string, PackedSpec> packed;
  for (const auto& source : source_specification()) {
    if (source.quantized) {
      const auto rows = source.shape.at(0);
      const auto columns = source.shape.at(1);
      const auto module = source.target.substr(0, source.target.size() - 7);
      if (columns % group_size || columns % (32 / quantization_bits)) {
        throw std::logic_error("Pinned quantization dimensions are not divisible.");
      }
      packed.emplace(source.target, PackedSpec{{rows, columns / (32 / quantization_bits)}, mx::uint32});
      packed.emplace(module + ".scales", PackedSpec{{rows, columns / group_size}, mx::float16});
      packed.emplace(module + ".biases", PackedSpec{{rows, columns / group_size}, mx::float16});
    } else {
      packed.emplace(source.target, PackedSpec{source.shape, mx::float16});
    }
  }
  std::size_t bytes = 0;
  for (const auto& [name, entry] : packed) {
    bytes += elements(entry.shape) * (entry.dtype == mx::uint32 ? 4 : 2);
  }
  if (packed.size() != Gradient::packed_tensor_count || bytes != parameter_storage_bytes) {
    throw std::logic_error("Pinned Gradient packed tensor count/storage mismatch.");
  }
  return packed;
}

void validate_packed(const Weights& weights) {
  const auto spec = packed_specification();
  if (weights.size() != spec.size()) {
    throw std::invalid_argument("Gradient q4 checkpoint must contain exactly 690 packed tensors.");
  }
  for (const auto& [name, expected] : spec) {
    const auto found = weights.find(name);
    if (found == weights.end() || found->second.shape() != expected.shape ||
        found->second.dtype() != expected.dtype) {
      throw std::invalid_argument("Gradient packed name/shape/dtype mismatch: " + name);
    }
  }
}

void validate_fp32(const Weights& weights) {
  const auto spec = source_specification();
  if (weights.size() != spec.size()) {
    throw std::invalid_argument("Gradient source must contain exactly 394 original HF tensors.");
  }
  for (const auto& entry : spec) {
    const auto found = weights.find(entry.source);
    if (found == weights.end() || found->second.shape() != entry.shape ||
        found->second.dtype() != mx::float32) {
      throw std::invalid_argument("Original FP32 Gradient checkpoint mismatch: " + entry.source);
    }
  }
}

void configure_metal() {
  if (!mx::metal::is_available()) {
    throw std::runtime_error("Gradient requires MLX Metal GPU; CPU fallback is not supported.");
  }
  mx::set_default_device(mx::Device::gpu);
  mx::set_memory_limit(memory_limit_bytes);
  mx::set_cache_limit(cache_limit_bytes);
}

void require_file(const std::filesystem::path& path) {
  if (!std::filesystem::is_regular_file(path)) {
    throw std::invalid_argument("Gradient checkpoint is not a regular file: " + path.string());
  }
}

std::vector<mx::array> weight_arrays(const Weights& weights) {
  std::vector<mx::array> arrays;
  arrays.reserve(weights.size());
  for (const auto& [name, value] : weights) {
    arrays.push_back(value);
  }
  return arrays;
}

int bucket_position(int relative) {
  const int distance = std::abs(relative);
  constexpr int mid = position_span / 2;
  if (distance <= mid) {
    return relative;
  }
  const int bucket = static_cast<int>(std::ceil(
      std::log(static_cast<double>(distance) / mid) /
      std::log(static_cast<double>(maximum_length - 1) / mid) * (mid - 1))) + mid;
  return relative > 0 ? bucket : -bucket;
}

mx::array split_heads(const mx::array& x) {
  return mx::transpose(mx::reshape(x, {1, -1, heads, head_dimension}), {0, 2, 1, 3});
}

mx::array merge_heads(const mx::array& x) {
  return mx::reshape(mx::transpose(x, {0, 2, 1, 3}), {1, -1, hidden});
}

mx::array gelu(const mx::array& x) {
  const auto y = mx::astype(x, mx::float32);
  const auto cdf = mx::add(
      mx::array(1.0f), mx::erf(mx::divide(y, mx::array(static_cast<float>(std::sqrt(2.0))))));
  return mx::astype(mx::multiply(mx::multiply(y, cdf), mx::array(0.5f)), x.dtype());
}

// A sibling staging file is exclusively owned, never reused or silently
// overwritten. Publishing by hard link refuses a concurrently created output.
class StagingFile {
 public:
  explicit StagingFile(const std::filesystem::path& output) : path_(output) {
    // MLX appends this extension when absent; reserve the actual output path.
    path_ += ".partial-" + std::to_string(::getpid()) + ".safetensors";
    const int descriptor = ::open(path_.c_str(), O_WRONLY | O_CREAT | O_EXCL, 0600);
    if (descriptor < 0) {
      throw std::system_error(errno, std::generic_category(), "Create Gradient staging file");
    }
    ::close(descriptor);
  }

  ~StagingFile() {
    std::error_code ignored;
    std::filesystem::remove(path_, ignored);
  }

  const std::filesystem::path& path() const { return path_; }
  StagingFile(const StagingFile&) = delete;
  StagingFile& operator=(const StagingFile&) = delete;

 private:
  std::filesystem::path path_;
};

}  // namespace

struct Gradient::Impl {
  Weights weights;
  std::vector<std::pair<mx::array, mx::array>> positions;
  mx::array position_lookup;
  bool compiled;
  std::function<std::vector<mx::array>(const std::vector<mx::array>&)> forward;
  std::mutex inference_mutex;

  explicit Impl(const std::filesystem::path& path, bool compile_core)
      : weights(load_packed(path)), position_lookup(make_position_lookup()), compiled(compile_core) {
    // Final installed weights are evaluated before generating any position cache.
    mx::eval(weight_arrays(weights));
    const auto relative = norm("relative_norm", embedding(
        "relative_embeddings", mx::arange(2 * position_span, mx::int32)));
    positions.reserve(layer_count);
    for (int index = 0; index < layer_count; ++index) {
      const auto prefix = "layers." + std::to_string(index) + ".attention.";
      const auto expanded = mx::expand_dims(relative, 0);
      auto query = split_heads(linear(prefix + "query", expanded));
      auto key = split_heads(linear(prefix + "key", expanded));
      mx::eval(query, key);
      positions.emplace_back(std::move(query), std::move(key));
    }
    forward = [this](const std::vector<mx::array>& arguments) {
      if (arguments.size() != 4) {
        throw std::invalid_argument("Gradient compiled core requires four arrays.");
      }
      return std::vector<mx::array>{
          core(arguments[0], arguments[1], arguments[2], arguments[3])};
    };
    if (compiled) {
      forward = mx::compile(forward, true);
    }
    mx::synchronize();
    mx::clear_cache();
  }

  static Weights load_packed(const std::filesystem::path& path) {
    require_file(path);
    configure_metal();
    auto loaded = mx::load_safetensors(path.string());
    validate_packed(loaded.first);
    return std::move(loaded.first);
  }

  static mx::array make_position_lookup() {
    std::vector<std::int32_t> values;
    values.reserve(2 * maximum_length - 1);
    for (int relative = 1 - maximum_length; relative < maximum_length; ++relative) {
      values.push_back(bucket_position(relative));
    }
    return mx::array(values.begin(), {static_cast<int>(values.size())}, mx::int32);
  }

  mx::array norm(const std::string& name, const mx::array& x) const {
    return mx::astype(mx::fast::layer_norm(
        mx::astype(x, mx::float32),
        mx::astype(weights.at(name + ".weight"), mx::float32),
        mx::astype(weights.at(name + ".bias"), mx::float32),
        layer_norm_epsilon), x.dtype());
  }

  mx::array embedding(const std::string& name, const mx::array& ids) const {
    return mx::dequantize(
        mx::take(weights.at(name + ".weight"), ids, 0),
        mx::take(weights.at(name + ".scales"), ids, 0),
        mx::take(weights.at(name + ".biases"), ids, 0),
        group_size, quantization_bits, "affine");
  }

  mx::array linear(const std::string& name, const mx::array& x) const {
    if (x.ndim() != 2 && x.ndim() != 3) {
      throw std::invalid_argument("Gradient projection requires rank two or three.");
    }
    const auto& weight = weights.at(name + ".weight");
    const auto input = x.ndim() == 3 ? mx::reshape(x, {-1, x.shape(-1)}) : x;
    auto result = mx::add(
        mx::quantized_matmul(input, weight, weights.at(name + ".scales"),
                             weights.at(name + ".biases"), true,
                             group_size, quantization_bits, "affine"),
        weights.at(name + ".bias"));
    if (x.ndim() == 3) {
      result = mx::reshape(result, {1, -1, weight.shape(0)});
    }
    return result;
  }

  std::pair<mx::array, mx::array> indices(int length) const {
    const auto sequence = mx::arange(length, mx::int32);
    const auto offsets = mx::add(
        mx::subtract(mx::expand_dims(sequence, 1), mx::expand_dims(sequence, 0)),
        mx::array(maximum_length - 1, mx::int32));
    const auto relative = mx::take(position_lookup, offsets, 0);
    const auto low = mx::array(0, mx::int32);
    const auto high = mx::array(2 * position_span - 1, mx::int32);
    const auto span = mx::array(position_span, mx::int32);
    const mx::Shape shape{1, heads, length, length};
    auto c2p = mx::broadcast_to(
        mx::expand_dims(mx::expand_dims(mx::clip(mx::add(relative, span), low, high), 0), 0), shape);
    auto p2c = mx::broadcast_to(
        mx::expand_dims(mx::expand_dims(mx::clip(mx::subtract(span, relative), low, high), 0), 0), shape);
    return {std::move(c2p), std::move(p2c)};
  }

  mx::array attention(int index, const mx::array& x, const mx::array& pair_mask,
                      const mx::array& c2p_index, const mx::array& p2c_index) const {
    const auto prefix = "layers." + std::to_string(index) + ".attention.";
    const auto query = split_heads(linear(prefix + "query", x));
    const auto key = split_heads(linear(prefix + "key", x));
    const auto value = split_heads(linear(prefix + "value", x));
    const auto& [pos_query, pos_key] = positions.at(index);
    const auto scale = mx::array(static_cast<float>(std::sqrt(head_dimension * 3.0)), mx::float16);
    // These FP16 rounding points match HF and the validated Python port.
    const auto content = mx::matmul(query, mx::divide(mx::swapaxes(key, -1, -2), scale));
    const auto c2p = mx::divide(mx::take_along_axis(
        mx::matmul(query, mx::swapaxes(pos_key, -1, -2)), c2p_index, -1), scale);
    const auto p2c = mx::divide(mx::swapaxes(mx::take_along_axis(
        mx::matmul(key, mx::swapaxes(pos_query, -1, -2)), p2c_index, -1), -1, -2), scale);
    auto scores = mx::add(content, mx::add(c2p, p2c));
    // Finite minimum preserves the reference's uniform fully masked rows.
    scores = mx::where(pair_mask, scores, mx::array(-65504.0f, mx::float16));
    const auto probabilities = mx::astype(mx::softmax(mx::astype(scores, mx::float32), -1), mx::float16);
    return merge_heads(mx::matmul(probabilities, value));
  }

  mx::array core(mx::array x, const mx::array& mask,
                 const mx::array& c2p_index, const mx::array& p2c_index) const {
    const auto expanded = mx::expand_dims(mask, 1);
    const auto pair_mask = mx::logical_and(mx::expand_dims(expanded, -1), mx::expand_dims(expanded, 2));
    for (int index = 0; index < layer_count; ++index) {
      const auto prefix = "layers." + std::to_string(index);
      const auto attended = attention(index, x, pair_mask, c2p_index, p2c_index);
      x = norm(prefix + ".attention_norm", mx::add(linear(prefix + ".attention_output", attended), x));
      x = norm(prefix + ".output_norm",
               mx::add(linear(prefix + ".output", gelu(linear(prefix + ".intermediate", x))), x));
    }
    const auto pooled = gelu(linear("pooler", mx::take(x, mx::array(0, mx::int32), 1)));
    return linear("classifier", pooled);
  }

  float logit(const std::vector<std::uint32_t>& ids, const std::vector<std::uint32_t>& mask) {
    if (ids.empty() || ids.size() > maximum_length || mask.size() != ids.size()) {
      throw std::invalid_argument("Gradient requires matching token/mask lengths in 1..512.");
    }
    if (std::any_of(ids.begin(), ids.end(), [](auto id) { return id >= vocabulary; }) ||
        std::any_of(mask.begin(), mask.end(), [](auto value) { return value > 1; })) {
      throw std::invalid_argument("Gradient token IDs must be in vocabulary and masks binary.");
    }
    std::lock_guard<std::mutex> lock(inference_mutex);
    mx::set_default_device(mx::Device::gpu);
    const int length = static_cast<int>(ids.size());
    const auto input_ids = mx::array(ids.begin(), {1, length}, mx::int32);
    const auto input_mask = mx::array(mask.begin(), {1, length}, mx::bool_);
    const auto [c2p, p2c] = indices(length);
    const auto embedded = mx::multiply(
        norm("embeddings.norm", embedding("embeddings.word", input_ids)),
        mx::astype(mx::expand_dims(input_mask, -1), mx::float16));
    // Variable-length gather/index graphs must not enter the shapeless trace.
    mx::eval(embedded, input_mask, c2p, p2c);
    const auto outputs = forward({embedded, input_mask, c2p, p2c});
    if (outputs.size() != 1 || outputs[0].shape() != mx::Shape{1, 1}) {
      throw std::runtime_error("Gradient produced an invalid output shape.");
    }
    auto result = mx::astype(outputs[0], mx::float32);
    mx::eval(result);
    mx::synchronize();
    const float value = result.item<float>();
    if (!std::isfinite(value)) {
      throw std::runtime_error("Gradient produced a non-finite logit.");
    }
    return value;
  }
};

Gradient::Gradient(const std::filesystem::path& packed_weights, bool compiled)
    : impl_(std::make_unique<Impl>(packed_weights, compiled)) {}
Gradient::~Gradient() = default;
Gradient::Gradient(Gradient&&) noexcept = default;
Gradient& Gradient::operator=(Gradient&&) noexcept = default;

float Gradient::logit(const std::vector<std::uint32_t>& ids, const std::vector<std::uint32_t>& mask) {
  if (!impl_) {
    throw std::logic_error("Cannot use a moved-from Gradient instance.");
  }
  return impl_->logit(ids, mask);
}

Gradient::Memory Gradient::memory() const {
  if (!impl_) {
    throw std::logic_error("Cannot inspect a moved-from Gradient instance.");
  }
  std::size_t position_bytes = 0;
  for (const auto& [query, key] : impl_->positions) {
    position_bytes += query.nbytes() + key.nbytes();
  }
  return {mx::get_active_memory(), mx::get_cache_memory(), mx::get_peak_memory(),
          parameter_storage_bytes, position_bytes, impl_->compiled};
}

void Gradient::quantize_checkpoint(const std::filesystem::path& fp32_weights,
                                   const std::filesystem::path& packed_output) {
  require_file(fp32_weights);
  if (packed_output.empty() || std::filesystem::exists(packed_output)) {
    throw std::invalid_argument("Gradient packed output must be a new file.");
  }
  const auto parent = packed_output.parent_path();
  if (!parent.empty()) {
    std::filesystem::create_directories(parent);
  }
  configure_metal();
  auto source = mx::load_safetensors(fp32_weights.string()).first;
  validate_fp32(source);
  Weights packed;
  packed.reserve(packed_tensor_count);
  for (const auto& entry : source_specification()) {
    auto half = mx::astype(source.at(entry.source), mx::float16);
    auto finite = mx::all(mx::isfinite(half));
    mx::eval(half, finite);
    if (!finite.item<bool>()) {
      throw std::invalid_argument("Gradient source does not round to finite FP16: " + entry.source);
    }
    if (entry.quantized) {
      auto values = mx::quantize(half, group_size, quantization_bits, "affine");
      if (values.size() != 3) {
        throw std::runtime_error("MLX affine quantization did not return weight/scales/biases.");
      }
      mx::eval(values);
      const auto module = entry.target.substr(0, entry.target.size() - 7);
      packed.emplace(entry.target, std::move(values[0]));
      packed.emplace(module + ".scales", std::move(values[1]));
      packed.emplace(module + ".biases", std::move(values[2]));
    } else {
      packed.emplace(entry.target, std::move(half));
    }
    source.erase(entry.source);
  }
  validate_packed(packed);
  mx::synchronize();
  StagingFile staging(packed_output);
  mx::save_safetensors(staging.path().string(), packed,
                      {{"aihider.format", "gradient-mlx-affine-q4-group64-v1"},
                       {"source.repo", model_repo}, {"source.revision", model_revision},
                       {"source.dtype", "float32"}, {"quantization.input_dtype", "float16"}});
  if (std::filesystem::file_size(staging.path()) < parameter_storage_bytes) {
    throw std::runtime_error("Native quantization did not write the complete packed checkpoint.");
  }
  validate_packed(mx::load_safetensors(staging.path().string()).first);
  std::filesystem::create_hard_link(staging.path(), packed_output);
  mx::clear_cache();
}

}  // namespace aihider
