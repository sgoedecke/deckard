cmake_minimum_required(VERSION 3.24)
project(ai_hider VERSION 0.2.0 LANGUAGES CXX)
if(NOT APPLE OR NOT CMAKE_SYSTEM_PROCESSOR MATCHES "arm64|aarch64")
  message(FATAL_ERROR "The MLX Metal backend requires Apple Silicon macOS.")
endif()
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_OSX_DEPLOYMENT_TARGET "15.0")
set(CMAKE_BUILD_WITH_INSTALL_RPATH ON)
set(CMAKE_INSTALL_RPATH "@executable_path/../lib")
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/bin")
get_filename_component(AI_HIDER_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/.." ABSOLUTE)
set(NATIVE_CACHE "${AI_HIDER_ROOT}/cache/native-build")
set(MLX_DIR "${NATIVE_CACHE}/mlx-sdk/mlx/share/cmake/MLX" CACHE PATH "Pinned native MLX SDK")
find_package(MLX 0.32.2 EXACT REQUIRED CONFIG)
add_library(ai_hider_json INTERFACE)
target_include_directories(ai_hider_json INTERFACE "${NATIVE_CACHE}/json/include")

set(CARGO "${NATIVE_CACHE}/cargo/bin/cargo" CACHE FILEPATH "Cargo executable")
set(RUST_TARGET "${CMAKE_CURRENT_BINARY_DIR}/rust")
add_custom_command(
  OUTPUT "${RUST_TARGET}/release/libai_hider_tokenizer.a"
  COMMAND "${CMAKE_COMMAND}" -E env
    "CARGO_HOME=${NATIVE_CACHE}/cargo" "RUSTUP_HOME=${NATIVE_CACHE}/rustup"
    "RUSTUP_TOOLCHAIN=1.90.0" "CARGO_TARGET_DIR=${RUST_TARGET}" "CARGO_BUILD_JOBS=2"
    "${CARGO}" build --release --locked --manifest-path "${CMAKE_CURRENT_SOURCE_DIR}/tokenizer/Cargo.toml"
  DEPENDS tokenizer/Cargo.toml tokenizer/Cargo.lock tokenizer/src/lib.rs
  VERBATIM)
add_custom_target(tokenizer_build DEPENDS "${RUST_TARGET}/release/libai_hider_tokenizer.a")
add_library(tokenizer_native STATIC IMPORTED)
set_target_properties(tokenizer_native PROPERTIES IMPORTED_LOCATION "${RUST_TARGET}/release/libai_hider_tokenizer.a")
add_dependencies(tokenizer_native tokenizer_build)
add_custom_target(dependency_notices ALL
  COMMAND "${CMAKE_COMMAND}" "-DNATIVE_CACHE=${NATIVE_CACHE}"
    "-DTOKENIZER_DIR=${CMAKE_CURRENT_SOURCE_DIR}/tokenizer"
    -P "${CMAKE_CURRENT_SOURCE_DIR}/collect-licenses.cmake"
  DEPENDS tokenizer_build VERBATIM)

add_executable(ai-hider src/main.cpp src/gradient.cpp src/tokenizer.cpp src/support.cpp src/host.cpp)
target_include_directories(ai-hider PRIVATE src)
target_compile_options(ai-hider PRIVATE -Wall -Wextra)
target_link_libraries(ai-hider PRIVATE mlx tokenizer_native ai_hider_json "-lcurl" "-framework Security" "-framework CoreFoundation")
add_custom_command(TARGET ai-hider POST_BUILD
  COMMAND "${CMAKE_COMMAND}" -E make_directory "${CMAKE_CURRENT_BINARY_DIR}/lib"
  COMMAND "${CMAKE_COMMAND}" -E copy_if_different "${MLX_LIBRARY_DIRS}/libmlx.dylib" "${CMAKE_CURRENT_BINARY_DIR}/lib/"
  COMMAND "${CMAKE_COMMAND}" -E copy_if_different "${MLX_LIBRARY_DIRS}/mlx.metallib" "${CMAKE_CURRENT_BINARY_DIR}/lib/"
  VERBATIM)
install(TARGETS ai-hider RUNTIME DESTINATION bin)
install(FILES "${MLX_LIBRARY_DIRS}/libmlx.dylib" "${MLX_LIBRARY_DIRS}/mlx.metallib" DESTINATION lib)
install(DIRECTORY "${NATIVE_CACHE}/licenses/" DESTINATION share/licenses)

enable_testing()
add_test(NAME cli_help COMMAND ai-hider --help)
add_test(NAME native_unit COMMAND ai-hider self-test)
