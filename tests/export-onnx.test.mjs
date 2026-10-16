// scripts/export-onnx.sh, run as a copy in a scratch repository whose pin
// files pin small stand-in files, with a stub Python for the export. The real
// export runs in CI; native-cli/tests/linux-backends.test.mjs runs the script
// against the real pins.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/export-onnx.sh', import.meta.url));
const linux = process.platform === 'linux';
const sha256 = text => createHash('sha256').update(text).digest('hex');
const checkpoint = { 'config.json': '{"model_type": "deberta-v2"}', 'model.safetensors': 'weights' };
const pinned = 'pinned export';

// A scratch repository with the script, pin files for `checkpoint` and
// `pinned`, a stub python3.14 and an empty model directory.
function repository(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deckard-export-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pins = (name, files) => fs.writeFileSync(path.join(root, 'native-cli', name),
    JSON.stringify({ format: 1, files }, null, 2));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'native-cli'));
  fs.copyFileSync(script, path.join(root, 'scripts/export-onnx.sh'));
  pins('model-assets-onnx.json', { 'model.onnx': sha256(pinned) });
  pins('model-assets-linux.json', { ...Object.fromEntries(Object.entries(checkpoint).map(([n, c]) => [n, sha256(c)])),
    'tokenizer.json': sha256('tokenizer') });
  // `-m venv DIR` creates a venv whose pip does nothing and whose python
  // writes STUB_EXPORT to the --output of export.py.
  const python = path.join(root, 'python3.14');
  fs.writeFileSync(python, `#!/bin/bash
set -eu
[ "$1" = -m ] && [ "$2" = venv ]
mkdir -p "$3/bin"
printf '#!/bin/sh\\n' > "$3/bin/pip"
printf '#!/bin/bash\\nwhile [ "$1" != --output ]; do shift; done\\nprintf %%s "$STUB_EXPORT" > "$2"\\n' > "$3/bin/python"
chmod +x "$3/bin/pip" "$3/bin/python"
`, { mode: 0o755 });
  const model = path.join(root, 'model');
  fs.mkdirSync(model);
  const run = (args, env = {}) => spawnSync(path.join(root, 'scripts/export-onnx.sh'), args,
    { encoding: 'utf8', env: { ...process.env, PYTHON: python, STUB_EXPORT: pinned, ...env } });
  return { root, model, run };
}

function writeCheckpoint(model) {
  for (const [name, content] of Object.entries(checkpoint)) fs.writeFileSync(path.join(model, name), content);
}

const options = { skip: !linux && 'Linux only' };

test('export-onnx.sh takes at most one model directory', options, t => {
  const result = repository(t).run(['a', 'b']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage: scripts\/export-onnx\.sh \[MODEL_DIR\]/);
});

test('export-onnx.sh defaults to the model cache of deckard install', options, t => {
  const { root, run } = repository(t);
  const result = run([], { HOME: root });
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`No checkpoint in ${root}/\\.cache/deckard; run deckard install first\\.`));
});

test('export-onnx.sh leaves a pinned model.onnx alone, without Python', options, t => {
  const { model, run } = repository(t);
  fs.writeFileSync(path.join(model, 'model.onnx'), pinned);
  const result = run([model], { PYTHON: 'deckard-no-such-python' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /model\.onnx is already the pinned model\.onnx\./);
  assert.deepEqual(fs.readdirSync(model), ['model.onnx']);
});

test('export-onnx.sh needs the checkpoint that install downloads', options, t => {
  const { model, run } = repository(t);
  const result = run([model]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No checkpoint in .*\/model; run deckard install first\./);
  assert.deepEqual(fs.readdirSync(model), []);
});

test('export-onnx.sh refuses a checkpoint that misses its pin, before any download', options, t => {
  const { model, run } = repository(t);
  writeCheckpoint(model);
  fs.writeFileSync(path.join(model, 'model.safetensors'), 'truncated');
  const result = run([model], { PYTHON: 'deckard-no-such-python' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\/model\/model\.safetensors does not match model-assets-linux\.json; run deckard install first\./);
  assert.deepEqual(fs.readdirSync(model).sort(), ['config.json', 'model.safetensors']);
});

test('export-onnx.sh names a missing Python', options, t => {
  const { model, run } = repository(t);
  writeCheckpoint(model);
  const result = run([model], { PYTHON: 'deckard-no-such-python' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /deckard-no-such-python not found; the export needs Python 3\.14/);
  assert.deepEqual(fs.readdirSync(model).sort(), ['config.json', 'model.safetensors']);
});

test('export-onnx.sh replaces an outdated model.onnx with the pinned export', options, t => {
  const { model, run } = repository(t);
  writeCheckpoint(model);
  fs.writeFileSync(path.join(model, 'model.onnx'), 'model.onnx of an earlier pin');
  const result = run([model]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Exported the pinned .*\/model\/model\.onnx\./);
  assert.equal(fs.readFileSync(path.join(model, 'model.onnx'), 'utf8'), pinned);
  // The venv, created next to the model, is gone.
  assert.deepEqual(fs.readdirSync(model).sort(), ['config.json', 'model.onnx', 'model.safetensors']);
});

test('export-onnx.sh removes an export that misses the pin', options, t => {
  const { model, run } = repository(t);
  writeCheckpoint(model);
  const result = run([model], { STUB_EXPORT: 'other bytes' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`The exported model\\.onnx \\(${sha256('other bytes')}\\) does not match ` +
    `model-assets-onnx\\.json \\(${sha256(pinned)}\\)\\.`));
  assert.deepEqual(fs.readdirSync(model).sort(), ['config.json', 'model.safetensors']);
});
