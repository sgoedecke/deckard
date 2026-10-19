#!/bin/bash
# Exports the pinned model.onnx into MODEL_DIR (default: ~/.cache/deckard,
# where deckard install downloads the checkpoint), so the next install runs
# ONNX Runtime. Does nothing when MODEL_DIR already has the pinned model.onnx.
# Checks the checkpoint against model-assets-linux.json, installs the
# hash-locked packages of native-cli/onnx/export/requirements.txt into a
# temporary venv in MODEL_DIR (on disk, not in a possibly RAM-backed /tmp),
# runs native-cli/onnx/export.py and removes the venv. Fails, removing the
# file, when the export does not match the pin.
# Usage: scripts/export-onnx.sh [MODEL_DIR]
# PYTHON names the Python 3.14 interpreter (default: python3.14).
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
[ "$#" -le 1 ] || { echo 'Usage: scripts/export-onnx.sh [MODEL_DIR]' >&2; exit 1; }
MODEL_DIR=${1:-$HOME/.cache/deckard}
PYTHON=${PYTHON:-python3.14}
OUTPUT="$MODEL_DIR/model.onnx"

# The SHA-256 that the pin file $1 records for the model file $2.
pin() { sed -n "s/^ *\"$2\": *\"\([0-9a-f]\{64\}\)\".*/\1/p" "$1"; }
sha256() { sha256sum "$1" | cut -d' ' -f1; }
EXPECTED=$(pin "$ROOT/native-cli/model-assets-onnx.json" model.onnx)
[ -n "$EXPECTED" ] || { echo "No model.onnx pin in native-cli/model-assets-onnx.json." >&2; exit 1; }

if [ -f "$OUTPUT" ] && [ "$(sha256 "$OUTPUT")" = "$EXPECTED" ]; then
  echo "$OUTPUT is already the pinned model.onnx."
  exit 0
fi

# The export reads config.json and model.safetensors: a wrong checkpoint would
# only show after minutes, as a model.onnx that misses its pin.
for name in config.json model.safetensors; do
  [ -f "$MODEL_DIR/$name" ] || { echo "No checkpoint in $MODEL_DIR; run deckard install first." >&2; exit 1; }
  [ "$(sha256 "$MODEL_DIR/$name")" = "$(pin "$ROOT/native-cli/model-assets-linux.json" "$name")" ] || {
    echo "$MODEL_DIR/$name does not match model-assets-linux.json; run deckard install first." >&2; exit 1; }
done
command -v "$PYTHON" > /dev/null || { echo "$PYTHON not found; the export needs Python 3.14 (set PYTHON)." >&2; exit 1; }

venv=$(mktemp -d "$MODEL_DIR/.export-venv.XXXXXX")
trap 'rm -rf "$venv"' EXIT
"$PYTHON" -m venv "$venv"
"$venv/bin/pip" install --quiet --no-cache-dir --require-hashes \
  --index-url https://download.pytorch.org/whl/cpu --extra-index-url https://pypi.org/simple \
  -r "$ROOT/native-cli/onnx/export/requirements.txt"
# --force replaces a model.onnx of an earlier pin.
"$venv/bin/python" -I "$ROOT/native-cli/onnx/export.py" --checkpoint "$MODEL_DIR" --output "$OUTPUT" --force

if [ "$(sha256 "$OUTPUT")" != "$EXPECTED" ]; then
  echo "The exported model.onnx ($(sha256 "$OUTPUT")) does not match model-assets-onnx.json ($EXPECTED)." >&2
  rm -f "$OUTPUT"
  exit 1
fi
echo "Exported the pinned $OUTPUT."
