#!/bin/bash
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
export NATIVE_CACHE="${NATIVE_CACHE:-$ROOT/cache/native-build}"
BUILD_DIR="${BUILD_DIR:-$ROOT/native-cli/build}"
[ "$#" -eq 0 ] || { echo 'Usage: NATIVE_CACHE=... BUILD_DIR=... scripts/build-native.sh' >&2; exit 1; }
/usr/sbin/taskpolicy -b bash "$ROOT/native-cli/bootstrap.sh"
/usr/sbin/taskpolicy -b cmake -S "$ROOT/native-cli" -B "$BUILD_DIR" \
  -DCMAKE_BUILD_TYPE=Release -DNATIVE_CACHE="$NATIVE_CACHE" \
  -DCMAKE_INSTALL_PREFIX="$BUILD_DIR/dist"
/usr/sbin/taskpolicy -b cmake --build "$BUILD_DIR" --parallel 2
/usr/sbin/taskpolicy -b cmake --install "$BUILD_DIR"
printf 'Built native distribution: %s/dist\n' "$BUILD_DIR"
