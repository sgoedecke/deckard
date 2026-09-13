#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  echo "Experimental Core ML runner requires Apple Silicon macOS 15 or newer." >&2
  exit 1
fi

mkdir -p "$root/cache/coreml/bin" "$root/cache/coreml/build"
export TMPDIR="$root/cache/coreml/build"
xcrun clang++ -std=c++17 -O2 -fobjc-arc -Wall -Wextra -Werror \
  -mmacosx-version-min=15.0 \
  -framework Foundation -framework CoreML \
  "$root/native-cli/coreml/runner.mm" \
  -o "$root/cache/coreml/bin/deckard-coreml"
printf '%s\n' "$root/cache/coreml/bin/deckard-coreml"
