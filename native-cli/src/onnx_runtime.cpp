#include "onnx_runtime.hpp"

#include <dlfcn.h>
#include <unistd.h>

#include <fstream>
#include <mutex>
#include <optional>

// The ONNX Runtime library, embedded by linux.cmake with its version in
// ONNXRUNTIME_VERSION and its SHA-256 in ONNXRUNTIME_SHA256.
extern "C" const unsigned char _binary_onnxruntime_bin_start[], _binary_onnxruntime_bin_end[];

namespace aihider {
namespace {

constexpr const char* library_file = "libonnxruntime.so." ONNXRUNTIME_VERSION;

bool current(const fs::path& path) {
  std::error_code error;
  return fs::is_regular_file(fs::symlink_status(path, error)) && sha256(path) == ONNXRUNTIME_SHA256;
}

// Writes the library unless it is already there, through a temporary file and
// a rename, so a concurrent deckard never sees a partially written library.
void write_library(const fs::path& target) {
  if (current(target)) return;
  const fs::path temporary = target.parent_path() / ("." + target.filename().string() + "." + std::to_string(getpid()));
  {
    std::ofstream stream(temporary, std::ios::binary | std::ios::trunc);
    stream.write(reinterpret_cast<const char*>(_binary_onnxruntime_bin_start),
                 _binary_onnxruntime_bin_end - _binary_onnxruntime_bin_start);
    if (!stream) {
      std::error_code ignored;
      fs::remove(temporary, ignored);
      throw Error("onnx_unavailable", "Cannot write the ONNX Runtime library to " + target.parent_path().string() + ".");
    }
  }
  fs::rename(temporary, target);
  if (!current(target))
    throw Error("onnx_unavailable", std::string("The written ") + library_file + " does not match its pinned SHA-256.");
}

const OrtApi& load(const fs::path& directory) {
  fs::create_directories(directory);
  const fs::path library = directory / library_file;
  write_library(library);
  void* handle = dlopen(library.c_str(), RTLD_NOW | RTLD_LOCAL);
  if (!handle) throw Error("onnx_unavailable", std::string("Cannot load ONNX Runtime: ") + dlerror());
  using GetApiBase = const OrtApiBase* (*)();
  auto get_api_base = reinterpret_cast<GetApiBase>(dlsym(handle, "OrtGetApiBase"));
  const OrtApi* api = get_api_base ? get_api_base()->GetApi(ORT_API_VERSION) : nullptr;
  if (!api) throw Error("onnx_unavailable", "The embedded ONNX Runtime does not provide C API version " +
                                                std::to_string(ORT_API_VERSION) + ".");
  // The library stays loaded for the life of the process.
  return *api;
}

// Where the embedded library is written; one directory per version, so
// releases with different versions do not overwrite each other's library.
fs::path onnx_runtime_directory(const fs::path& cache_directory) {
  return cache_directory / ("onnxruntime-" ONNXRUNTIME_VERSION);
}

}  // namespace

const OrtApi& onnx_runtime(const fs::path& cache_directory) {
  static std::mutex mutex;
  static const OrtApi* api = nullptr;
  static std::optional<Error> failure;
  std::lock_guard<std::mutex> lock(mutex);
  if (api) return *api;
  if (failure) throw *failure;
  try {
    api = &load(onnx_runtime_directory(cache_directory));
    return *api;
  } catch (const Error& error) {
    failure = error;
    throw;
  } catch (const std::exception& error) {
    failure = Error("onnx_unavailable", std::string("Cannot prepare ONNX Runtime: ") + error.what());
    throw *failure;
  }
}

void onnx_check(const OrtApi& api, OrtStatus* status, const char* code, const std::string& context) {
  if (!status) return;
  const std::string message = context + ": " + api.GetErrorMessage(status);
  api.ReleaseStatus(status);
  throw Error(code, message);
}

}  // namespace aihider
