# Linux x86_64 build of the deckard binary, included from CMakeLists.txt.
#
# Inference runs on the Candle backend (candle/), a Rust staticlib that loads the
# pinned fp32 Hugging Face checkpoint (config.json + model.safetensors) on the
# CPU. It is built offline with the same pinned toolchain and registry snapshot
# as the tokenizer. This file sets DECKARD_PLATFORM_SOURCES,
# DECKARD_PLATFORM_LIBRARIES and EXTRA_CARGO_LOCKS for the shared target.
#
# ONNX Runtime runs the pinned model.onnx when it is installed (see
# docs/LINUX.md). Its shared library is embedded in deckard and written to the
# user cache on first use (onnx_runtime.cpp), so no system package is needed.

set(CANDLE_SOURCE "${CMAKE_CURRENT_SOURCE_DIR}/candle")
set(CANDLE_TARGET "${CMAKE_CURRENT_BINARY_DIR}/candle-rust")
set(CANDLE_LIBRARY "${CANDLE_TARGET}/release/libai_hider_candle.a")
add_custom_command(
  OUTPUT "${CANDLE_LIBRARY}"
  COMMAND "${CMAKE_COMMAND}" -E env
    "CARGO_HOME=${BUILD_CARGO_HOME}" "RUSTUP_HOME=${NATIVE_CACHE}/rustup"
    "RUSTC=${RUST_TOOLCHAIN}/bin/rustc"
    "CARGO_ENCODED_RUSTFLAGS=${RUST_PATH_FLAGS}"
    "RUSTUP_TOOLCHAIN=1.90.0" "CARGO_TARGET_DIR=${CANDLE_TARGET}" "CARGO_BUILD_JOBS=2"
    "${CARGO}" build --release --locked --offline --manifest-path "${CANDLE_SOURCE}/Cargo.toml"
  DEPENDS "${CANDLE_SOURCE}/Cargo.toml" "${CANDLE_SOURCE}/Cargo.lock" "${CANDLE_SOURCE}/src/lib.rs"
  VERBATIM)
add_custom_target(candle_build DEPENDS "${CANDLE_LIBRARY}")
# Both crates share one CARGO_HOME; building them one after the other avoids
# concurrent writes to its package cache.
add_dependencies(candle_build tokenizer_build)
add_library(candle_native STATIC IMPORTED)
set_target_properties(candle_native PROPERTIES IMPORTED_LOCATION "${CANDLE_LIBRARY}")
add_dependencies(candle_native candle_build)

# The model.onnx pin has its own file: install.json records the SHA-256 of
# model-assets-linux.json, so editing that file would leave existing
# installations unable to upgrade or uninstall.
set(ONNX_ASSETS_FILE "${CMAKE_CURRENT_SOURCE_DIR}/model-assets-onnx.json")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${ONNX_ASSETS_FILE}")
file(READ "${ONNX_ASSETS_FILE}" ONNX_ASSETS_JSON)
configure_file(src/onnx_assets.hpp.in "${CMAKE_CURRENT_BINARY_DIR}/generated/onnx_assets.hpp" @ONLY)

# Embeds the ONNX Runtime library as the read-only symbols
# _binary_onnxruntime_bin_start/_end; onnx_runtime.cpp checks the copy it
# writes out against ONNXRUNTIME_SHA256. The version must match bootstrap-linux.sh.
set(ONNXRUNTIME_VERSION 1.24.1)
set(ONNXRUNTIME "${NATIVE_CACHE}/onnxruntime-${ONNXRUNTIME_VERSION}")
set(ONNXRUNTIME_LIBRARY "${ONNXRUNTIME}/lib/libonnxruntime.so.${ONNXRUNTIME_VERSION}")
set(ONNXRUNTIME_OBJECT "${CMAKE_CURRENT_BINARY_DIR}/onnxruntime.o")
add_custom_command(
  OUTPUT "${ONNXRUNTIME_OBJECT}"
  COMMAND "${CMAKE_COMMAND}" -E copy "${ONNXRUNTIME_LIBRARY}" onnxruntime.bin
  COMMAND objcopy -I binary -O elf64-x86-64 -B i386:x86-64
    --rename-section .data=.rodata,alloc,load,readonly,data,contents onnxruntime.bin onnxruntime.o
  COMMAND "${CMAKE_COMMAND}" -E remove onnxruntime.bin
  WORKING_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}"
  DEPENDS "${ONNXRUNTIME_LIBRARY}"
  VERBATIM)
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${ONNXRUNTIME_LIBRARY}")
file(SHA256 "${ONNXRUNTIME_LIBRARY}" ONNXRUNTIME_SHA256)
set_source_files_properties(src/onnx_runtime.cpp PROPERTIES
  COMPILE_DEFINITIONS "ONNXRUNTIME_VERSION=\"${ONNXRUNTIME_VERSION}\";ONNXRUNTIME_SHA256=\"${ONNXRUNTIME_SHA256}\"")

set(DECKARD_PLATFORM_SOURCES src/onnx_runtime.cpp src/onnx_gradient.cpp "${ONNXRUNTIME_OBJECT}")
set(DECKARD_PLATFORM_INCLUDES "${ONNXRUNTIME}/include")
# SHA-256 comes from OpenSSL's libcrypto EVP API on Linux (CommonCrypto on
# macOS). The Rust staticlibs' std needs libdl on glibc older than 2.34.
set(DECKARD_PLATFORM_LIBRARIES candle_native "-lcrypto" ${CMAKE_DL_LIBS})
set(EXTRA_CARGO_LOCKS "${CANDLE_SOURCE}/Cargo.lock")
