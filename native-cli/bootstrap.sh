#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
CACHE="${NATIVE_CACHE:-$ROOT/cache/native-build}"
SDK="$CACHE/mlx-sdk"
DOWNLOADS="$CACHE/downloads"
case "$(uname -s)/$(uname -m)" in
  Darwin/arm64) ;;
  *) echo "The Gradient Metal runtime requires Apple Silicon macOS 15 or newer." >&2; exit 1 ;;
esac
MAJOR=$(sw_vers -productVersion | cut -d. -f1)
[ "$MAJOR" -ge 15 ] || { echo "macOS 15 or newer is required." >&2; exit 1; }
command -v cmake >/dev/null || { echo "Install CMake first (for example: brew install cmake)." >&2; exit 1; }
xcrun --find clang++ >/dev/null
if [ "$CACHE" != "$ROOT/cache/native-build" ]; then
  for required in mlx-sdk/mlx/share/cmake/MLX/MLXConfig.cmake \
    json/include/nlohmann/json.hpp cargo/registry \
    rustup/toolchains/1.90.0-aarch64-apple-darwin/bin/cargo \
    licenses/MLX-LICENSE licenses/NLOHMANN-LICENSE; do
    [ -e "$CACHE/$required" ] || {
      echo "External NATIVE_CACHE is read-only and incomplete: $required" >&2
      exit 1
    }
  done
  echo "Using existing read-only native dependencies in $CACHE"
  exit 0
fi
mkdir -p "$DOWNLOADS" "$SDK"
mkdir -p "$CACHE/json/include/nlohmann" "$CACHE/licenses"

fetch() {
  url=$1
  file=$2
  expected=$3
  if [ ! -f "$file" ]; then
    curl --fail --location --proto '=https' --proto-redir '=https' \
      --connect-timeout 30 --max-time 900 --output "$file.partial" "$url"
    actual=$(shasum -a 256 "$file.partial" | cut -d' ' -f1)
    [ "$actual" = "$expected" ] || { echo "Download checksum mismatch." >&2; exit 1; }
    mv "$file.partial" "$file"
  fi
  actual=$(shasum -a 256 "$file" | cut -d' ' -f1)
  [ "$actual" = "$expected" ] || { echo "Cached dependency checksum mismatch: $file" >&2; exit 1; }
}

# Wheels are upstream ZIP distribution containers. Extract only C++ headers,
# native libraries and Metal resources: no Python bindings or interpreter.
fetch 'https://files.pythonhosted.org/packages/79/ec/34f37376e26d537fadffb99af3a760d6545e37f5e1a30a552baadf237fc5/mlx_metal-0.32.2-py3-none-macosx_15_0_arm64.whl' \
  "$DOWNLOADS/mlx-metal.whl" 55a369250d220b2cf10213a87a2ac1b1a420608c5b35b1df4e7147ac8e32f121
unzip -oq "$DOWNLOADS/mlx-metal.whl" 'mlx/include/*' 'mlx/share/*' 'mlx/lib/*' -d "$SDK"
unzip -p "$DOWNLOADS/mlx-metal.whl" 'mlx_metal-0.32.2.dist-info/licenses/LICENSE' > "$CACHE/licenses/MLX-LICENSE"
fetch 'https://raw.githubusercontent.com/nlohmann/json/9cca280a4d0ccf0c08f47a99aa71d1b0e52f8d03/single_include/nlohmann/json.hpp' \
  "$CACHE/json/include/nlohmann/json.hpp" 9bea4c8066ef4a1c206b2be5a36302f8926f7fdc6087af5d20b417d0cf103ea6
fetch 'https://raw.githubusercontent.com/nlohmann/json/9cca280a4d0ccf0c08f47a99aa71d1b0e52f8d03/LICENSE.MIT' \
  "$CACHE/licenses/NLOHMANN-LICENSE" 86b998c792894ccb911a1cb7994f7a9652894e7a094c0b5e45be2f553f45cf14
fetch 'https://huggingface.co/ShantanuT01/gradient-ai-text-detector/raw/c2e8b6df87f8a211cbffb713fa9873a0c3a9713f/README.md' \
  "$CACHE/licenses/GRADIENT-MODEL-CARD.md" a147869ab24ad59172bcdc7cc69cf716c646ddf0745a0e1fbb12515a2c6e752a

export CARGO_HOME="$CACHE/cargo"
export RUSTUP_HOME="$CACHE/rustup"
export RUSTUP_TOOLCHAIN=1.90.0
export CARGO_BUILD_JOBS=2
if [ ! -x "$CARGO_HOME/bin/cargo" ]; then
  rustup_url='https://static.rust-lang.org/rustup/archive/1.28.2/aarch64-apple-darwin/rustup-init'
  curl --fail --location --proto '=https' --proto-redir '=https' \
    --output "$DOWNLOADS/rustup-init.sha256" "$rustup_url.sha256"
  rustup_sha=$(cut -d' ' -f1 "$DOWNLOADS/rustup-init.sha256")
  [ "${#rustup_sha}" -eq 64 ] || { echo "Invalid Rust bootstrap checksum." >&2; exit 1; }
  case "$rustup_sha" in *[!0-9a-f]*) echo "Invalid Rust bootstrap checksum." >&2; exit 1 ;; esac
  fetch "$rustup_url" "$DOWNLOADS/rustup-init" "$rustup_sha"
  chmod 700 "$DOWNLOADS/rustup-init"
  "$DOWNLOADS/rustup-init" -y --no-modify-path --profile minimal --default-toolchain 1.90.0
fi
"$CARGO_HOME/bin/rustc" --version
"$CARGO_HOME/bin/cargo" fetch --locked --manifest-path "$ROOT/native-cli/tokenizer/Cargo.toml"
echo "Native dependencies ready in $CACHE"
