// The root Makefile, a thin wrapper around the scripts and the deckard CLI.
// Targets that run deckard take DECKARD (the binary), BUILD and EXPORT (their
// build and model.onnx prerequisites) and MODEL_CACHE/MODEL_DIR, so these
// tests use a stub binary and stand-in model files instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const makefile = fs.readFileSync(path.join(root, 'Makefile'), 'utf8');
const linux = process.platform === 'linux';
const linuxOnly = { skip: !linux && 'Linux only' };
const modelFiles = ['config.json', 'model.safetensors', 'tokenizer.json', 'model.onnx'];
const make = (args, env = {}) => spawnSync('make', ['--no-print-directory', '-C', root, ...args],
  { encoding: 'utf8', env: { ...process.env, ...env } });

// A stub deckard that appends its arguments to `log`, a model cache with
// stand-in model files and the directory make links them into.
function stub(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deckard-make-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'calls');
  const deckard = path.join(dir, 'deckard');
  fs.writeFileSync(deckard, `#!/bin/sh\necho "$*" >> "${log}"\n`, { mode: 0o755 });
  const cache = path.join(dir, 'cache');
  fs.mkdirSync(cache);
  for (const name of modelFiles) fs.writeFileSync(path.join(cache, name), name);
  const model = path.join(dir, 'test-model');
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);
  return { dir, deckard, cache, model, calls,
    args: [`DECKARD=${deckard}`, 'BUILD=', 'EXPORT=', `MODEL_CACHE=${cache}`, `MODEL_DIR=${model}`,
      `CANDLE_MODEL_DIR=${dir}/candle-model`] };
}

test('make help lists every documented target, help first by default', () => {
  const documented = [...makefile.matchAll(/^([a-z-]+):.*## /gm)].map(match => match[1]).sort();
  const result = make([]);
  assert.equal(result.status, 0, result.stderr);
  const listed = result.stdout.replace(/\x1b\[[0-9;]*m/g, '').trim().split('\n')
    .map(line => line.trim().split(/\s+/)[0]).sort();
  assert.deepEqual(listed, documented);
  assert.equal(new Set(listed).size, listed.length, 'each target listed once');
  assert.ok(listed.includes('help'));
  assert.deepEqual(make(['help']).stdout, result.stdout);
});

test('every script and file the Makefile runs exists', () => {
  const paths = [...makefile.matchAll(/\b((?:scripts|native-cli\/tests\/fixtures)\/[\w./-]+)/g)].map(match => match[1]);
  assert.ok(paths.length > 0);
  for (const file of paths) assert.ok(fs.existsSync(path.join(root, file)), file);
});

test('make verify checks Candle and ONNX Runtime on a clean copy of the model cache', linuxOnly, t => {
  const { cache, model, calls, args } = stub(t);
  fs.mkdirSync(path.join(cache, 'onnxruntime-1.24.1'));  // written by ONNX Runtime, refused by verify
  const result = make(['verify', ...args]);
  assert.equal(result.status, 0, result.stderr);
  const fixtures = '--fixtures native-cli/tests/fixtures/linux-reference.json';
  assert.deepEqual(calls(), [`verify --model ${model} ${fixtures} --candle`, `verify --model ${model} ${fixtures} --onnx`]);
  assert.deepEqual(fs.readdirSync(model).sort(), [...modelFiles].sort());
  for (const name of modelFiles)
    assert.equal(fs.statSync(path.join(model, name)).ino, fs.statSync(path.join(cache, name)).ino, `${name} is linked`);
});

test('make verify without model.onnx says how to get it and runs nothing', linuxOnly, t => {
  const { cache, calls, args } = stub(t);
  fs.rmSync(path.join(cache, 'model.onnx'));
  const result = make(['verify', ...args]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No model\.onnx in .*: make install-onnx downloads and exports the model\./);
  assert.deepEqual(calls(), []);
});

test('make verify stops at the first failing runtime', linuxOnly, t => {
  const { deckard, args } = stub(t);
  fs.writeFileSync(deckard, '#!/bin/sh\necho "$*" >&2\nexit 3\n');
  const result = make(['verify', ...args]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--candle/);
  assert.doesNotMatch(result.stderr, /--onnx/);
});

test('make export-onnx exports into MODEL_CACHE', linuxOnly, t => {
  const { dir } = stub(t);
  const result = make(['export-onnx', `MODEL_CACHE=${dir}/empty`]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(`No checkpoint in ${dir}/empty; run deckard install first\\.`));
});

test('make test-native runs the native tests with the binary and the model', t => {
  const { deckard, model, args } = stub(t);
  const bin = path.dirname(deckard);
  fs.writeFileSync(path.join(bin, 'npm'),
    '#!/bin/sh\necho "npm $* TMPDIR=$TMPDIR DECKARD_BIN=$DECKARD_BIN DECKARD_MODEL_DIR=${DECKARD_MODEL_DIR-unset}"\n', { mode: 0o755 });
  if (!linux) fs.mkdirSync(model);  // macOS uses an installed model as it is
  const result = make(['test-native', ...args], { PATH: `${bin}:${process.env.PATH}` });
  assert.equal(result.status, 0, result.stderr);
  if (linux) assert.deepEqual(fs.readdirSync(model).sort(), [...modelFiles].sort());
  assert.match(result.stdout, new RegExp(`Model tests use ${model}\\.`));
  assert.match(result.stdout, new RegExp(`npm run test:native TMPDIR=${root}native-cli/build/test-tmp ` +
    `DECKARD_BIN=${deckard} DECKARD_MODEL_DIR=${model}$`, 'm'));
});

test('make test-native on macOS without an installed model skips the model tests', { skip: linux && 'macOS only' }, t => {
  const { deckard, args } = stub(t);
  const bin = path.dirname(deckard);
  fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\necho "DECKARD_MODEL_DIR=${DECKARD_MODEL_DIR-unset}"\n', { mode: 0o755 });
  const result = make(['test-native', ...args], { PATH: `${bin}:${process.env.PATH}` });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /model tests are skipped \(make install first\)/);
  assert.match(result.stdout, /DECKARD_MODEL_DIR=unset$/m);
});

test('make install on Linux lists the two runtimes and installs nothing', linuxOnly, t => {
  const { calls, args } = stub(t);
  const result = make(['install', ...args]);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /make install-candle +Candle/);
  assert.match(result.stdout, /make install-onnx +ONNX Runtime/);
  assert.deepEqual(calls(), []);
});

test('make install-candle installs without model.onnx, keeping the export in the cache', linuxOnly, t => {
  const { dir, cache, calls, args } = stub(t);
  let result = make(['install-candle', ...args]);
  assert.equal(result.status, 0, result.stderr);
  const candle = path.join(dir, 'candle-model');
  assert.deepEqual(calls(), [`install --extension-dir extension --model-dir ${candle}`]);
  assert.deepEqual(fs.readdirSync(candle).sort(), ['config.json', 'model.safetensors', 'tokenizer.json']);
  assert.ok(fs.existsSync(path.join(cache, 'model.onnx')));

  // Without an export a plain install is Candle, and downloads what is missing.
  fs.rmSync(path.join(cache, 'model.onnx'));
  result = make(['install-candle', ...args]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls().slice(1), ['install --extension-dir extension']);
});

test('make install-onnx downloads the checkpoint first when the cache has none', linuxOnly, t => {
  const { cache, calls, args } = stub(t);
  let result = make(['install-onnx', ...args]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls(), ['install --extension-dir extension']);

  fs.rmSync(path.join(cache, 'model.safetensors'));
  result = make(['install-onnx', ...args]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Downloading the checkpoint/);
  assert.deepEqual(calls().slice(1), ['install --extension-dir extension', 'install --extension-dir extension']);
});

test('make package needs macOS and a model directory', t => {
  const { args } = stub(t);
  const result = make(['package', ...args.slice(0, 2)]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, linux ? /make package builds the macOS release/ : /Usage: make package RELEASE_MODEL_DIR=DIR/);
});
