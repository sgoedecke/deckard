#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
: "${NATIVE_CACHE:?Set NATIVE_CACHE to the existing native dependency cache}"
SDK="$NATIVE_CACHE/mlx-sdk/mlx"
mkdir -p "$ROOT/cache/coreml/bin" "$ROOT/cache/coreml/lib"
bash "$ROOT/native-cli/coreml/build.sh"
xcrun clang++ -std=c++20 -O2 -Wall -Wextra -Werror -mmacosx-version-min=15.0 \
  -isystem "$SDK/include" -isystem "$NATIVE_CACHE/json/include" \
  "$ROOT/native-cli/coreml/power_mlx.cpp" "$ROOT/native-cli/src/gradient.cpp" \
  -L"$SDK/lib" -lmlx -Wl,-rpath,"$SDK/lib" \
  -o "$ROOT/cache/coreml/bin/deckard-power-mlx"
cp "$SDK/lib/mlx.metallib" "$ROOT/cache/coreml/lib/mlx.metallib"
