#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ "${1-}" = "--uninstall" ]; then
  shift
  PREFIX="${HOME:?HOME must be set}/Library/Application Support/AI Hider"
  EXPECT_HOME=false
  for arg do
    if [ "$EXPECT_HOME" = true ]; then
      PREFIX=$arg
      EXPECT_HOME=false
    elif [ "$arg" = "--home" ]; then
      EXPECT_HOME=true
    fi
  done
  for CLI in "$ROOT/native-cli/build/dist/bin/ai-hider" "$PREFIX/current/bin/ai-hider"; do
    if [ -x "$CLI" ] && "$CLI" --help 2>/dev/null | grep -q '^ai-hider uninstall'; then
      exec "$CLI" uninstall "$@"
    fi
  done
  echo "AI Hider: uninstall requires a current built or installed CLI with uninstall support." >&2
  echo "Build the updated native CLI first; no download, build, or deletion was attempted." >&2
  exit 1
fi
for arg do
  if [ "$arg" = "--uninstall" ]; then
    echo "Usage: ./install.sh --uninstall [--home DIR] [--manifest-dir DIR] (put --uninstall first)." >&2
    exit 1
  fi
done
/usr/sbin/taskpolicy -b sh "$ROOT/native-cli/bootstrap.sh"
cmake -S "$ROOT/native-cli" -B "$ROOT/native-cli/build" -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$ROOT/native-cli/build/dist"
/usr/sbin/taskpolicy -b cmake --build "$ROOT/native-cli/build" --parallel 2
cmake --install "$ROOT/native-cli/build"
USE_LOCAL=true
for arg do
  case "$arg" in --model-dir|--download) USE_LOCAL=false ;; esac
done
if [ "$USE_LOCAL" = true ] && [ -f "$ROOT/cache/gradient-accelerator/exports/mlx-q4/packed.safetensors" ]; then
  exec "$ROOT/native-cli/build/dist/bin/ai-hider" install --model-dir "$ROOT/cache/gradient-accelerator/exports/mlx-q4" "$@"
fi
exec "$ROOT/native-cli/build/dist/bin/ai-hider" install "$@"
