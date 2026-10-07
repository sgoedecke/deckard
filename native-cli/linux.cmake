# Linux x86_64 build of the deckard binary, included from CMakeLists.txt.
#
# Inference runs on the Candle backend (candle/), a Rust staticlib that loads the
# pinned fp32 Hugging Face checkpoint (config.json + model.safetensors) on the
# CPU. It is built offline with the same pinned toolchain and registry snapshot
# as the tokenizer. This file sets DECKARD_PLATFORM_SOURCES,
# DECKARD_PLATFORM_LIBRARIES and EXTRA_CARGO_LOCKS for the shared target.

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

set(DECKARD_PLATFORM_SOURCES)
# SHA-256 comes from OpenSSL's libcrypto EVP API on Linux (CommonCrypto on
# macOS). The Rust staticlibs' std needs libdl on glibc older than 2.34.
set(DECKARD_PLATFORM_LIBRARIES candle_native "-lcrypto" ${CMAKE_DL_LIBS})
set(EXTRA_CARGO_LOCKS "${CANDLE_SOURCE}/Cargo.lock")
