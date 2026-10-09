#!/bin/bash
# Fetches the pinned model files for this platform into DIR so CI can run the
# model-dependent native tests. macOS takes them from the latest release bundle,
# Linux from the pinned Hugging Face revision. Every file is checked against the
# platform's model-assets manifest; on a mismatch (for example a pin change not
# yet released) it warns and exits 0 without a model directory, so those tests
# are skipped. On success it records model_dir=DIR in $GITHUB_OUTPUT when set.
# Usage: scripts/ci-fetch-model.sh DIR
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
[ "$#" -eq 1 ] || { echo 'Usage: scripts/ci-fetch-model.sh DIR' >&2; exit 1; }
DIR=$1
case "$(uname -s)" in
  Darwin) MANIFEST="$ROOT/native-cli/model-assets.json"; sha() { shasum -a 256 "$1" | cut -d' ' -f1; } ;;
  Linux) MANIFEST="$ROOT/native-cli/model-assets-linux.json"; sha() { sha256sum "$1" | cut -d' ' -f1; } ;;
  *) echo "Unsupported platform." >&2; exit 1 ;;
esac

verified() {
  local name expected
  while IFS=$'\t' read -r name expected; do
    [ -f "$DIR/$name" ] && [ "$(sha "$DIR/$name")" = "$expected" ] || return 1
  done < <(jq -r '.files | to_entries[] | "\(.key)\t\(.value)"' "$MANIFEST")
}

if ! verified; then
  rm -rf "$DIR"
  mkdir -p "$DIR"
  if [ "$(uname -s)" = Darwin ]; then
    work=$(mktemp -d)
    trap 'rm -rf "$work"' EXIT
    gh release download -R "${GITHUB_REPOSITORY:-sgoedecke/deckard}" -D "$work" \
      -p 'deckard-v*-macos-arm64.tar.gz' -p SHA256SUMS >&2
    archive=$(cd "$work" && ls deckard-v*-macos-arm64.tar.gz)
    (cd "$work" && grep "  $archive\$" SHA256SUMS | shasum -a 256 -c -) >&2
    tar -xzf "$work/$archive" -C "$work" models
    cp -R "$work/models/." "$DIR"
  else
    base="https://huggingface.co/$(jq -r .model "$MANIFEST")/resolve/$(jq -r .revision "$MANIFEST")"
    for name in $(jq -r '.files | keys[]' "$MANIFEST"); do
      mkdir -p "$(dirname "$DIR/$name")"
      curl --fail --location --proto '=https' --proto-redir '=https' --retry 3 \
        --silent --show-error --output "$DIR/$name" "$base/$name"
    done
  fi
  if ! verified; then
    echo "::warning::Model files do not match $(basename "$MANIFEST"); model-dependent native tests will be skipped."
    exit 0
  fi
fi
echo "Verified model files in $DIR"
[ -z "${GITHUB_OUTPUT:-}" ] || printf 'model_dir=%s\n' "$DIR" >> "$GITHUB_OUTPUT"
