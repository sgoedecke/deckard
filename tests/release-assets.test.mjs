import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { archiveSizeLimit, checkArchiveSize, copyAssets, modelFiles, validatePins, verifyAssets } from '../scripts/release-assets.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const canonical = JSON.parse(await fs.readFile(path.join(root, 'native-cli/model-assets.json'), 'utf8'));
const digest = value => createHash('sha256').update(value).digest('hex');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(root, 'tests/.release-assets-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'input');
  const destination = path.join(directory, 'output');
  const hashes = {};
  for (const name of modelFiles) {
    await fs.mkdir(path.dirname(path.join(source, name)), { recursive: true });
    await fs.writeFile(path.join(source, name), name);
    hashes[name] = digest(name);
  }
  return { source, destination, hashes };
}

test('release asset pins are the shared Core ML manifest, not the original q4 weights', () => {
  assert.deepEqual(Object.keys(validatePins(canonical)).sort(), [...modelFiles].sort());
  assert.equal(canonical.source_weights_sha256, '85a9e02ebdcbbe1dd84cdbf893b708e44ee4691cadc7e1a4780039e22097ac98');
  for (const mutate of [
    pins => { pins.runtime = 'native-mlx'; },
    pins => { pins.files['../escape'] = '0'.repeat(64); },
    pins => { delete pins.files['tokenizer.json']; },
    pins => { pins.files['tokenizer.json'] = 'wrong'; },
    pins => { pins.model_package = '../model.mlpackage'; },
  ]) {
    const pins = structuredClone(canonical);
    mutate(pins);
    assert.throws(() => validatePins(pins), /Invalid Core ML/);
  }
});

test('copies only pinned nested files and checks the copied bytes', async t => {
  const { source, destination, hashes } = await fixture(t);
  await fs.writeFile(path.join(source, 'packed.safetensors'), 'do not ship');
  await copyAssets(source, destination, hashes);
  await verifyAssets(destination, hashes);
  await assert.rejects(fs.stat(path.join(destination, 'packed.safetensors')), { code: 'ENOENT' });
  for (const name of modelFiles) {
    assert.equal(await fs.readFile(path.join(destination, name), 'utf8'), name);
  }
});

test('every pinned asset must have its exact checksum', async t => {
  const { source, hashes } = await fixture(t);
  for (const name of modelFiles) {
    await fs.writeFile(path.join(source, name), 'tampered');
    await assert.rejects(verifyAssets(source, hashes), /Canonical model checksum mismatch/);
    await fs.writeFile(path.join(source, name), name);
  }
});

test('rejects symlinks in model directory, package components and leaf files', async t => {
  const { source, destination, hashes } = await fixture(t);
  await fs.symlink(source, destination);
  await assert.rejects(verifyAssets(destination, hashes), /links and special files/);
  for (const name of ['model.mlpackage', 'model.mlpackage/Data', 'model.mlpackage/Data/com.apple.CoreML/weights', 'tokenizer.json']) {
    const file = path.join(source, name);
    const saved = `${file}.original`;
    await fs.rename(file, saved);
    await fs.symlink(saved, file);
    await assert.rejects(verifyAssets(source, hashes), /links and special files/);
    await fs.unlink(file);
    await fs.rename(saved, file);
  }
});

test('rejects traversal and absolute asset paths before copying', async t => {
  const { source, destination } = await fixture(t);
  for (const name of ['../escape', '/absolute', 'model.mlpackage/../escape', './tokenizer.json', 'model.mlpackage//file']) {
    await assert.rejects(copyAssets(source, destination, { [name]: '0'.repeat(64) }), /Unsafe model asset path/);
  }
});

test('nested copying cannot follow destination symlinks or overwrite existing files', async t => {
  const { source, destination, hashes } = await fixture(t);
  await fs.symlink(source, destination);
  await assert.rejects(copyAssets(source, destination, hashes), /Unsafe model asset destination/);
  await fs.unlink(destination);
  await fs.mkdir(destination);
  await fs.symlink(path.join(source, 'model.mlpackage'), path.join(destination, 'model.mlpackage'));
  await assert.rejects(copyAssets(source, destination, hashes), /Unsafe model asset destination/);
  await fs.unlink(path.join(destination, 'model.mlpackage'));
  await fs.writeFile(path.join(destination, 'tokenizer.json'), 'existing');
  await assert.rejects(copyAssets(source, destination, hashes), { code: 'EEXIST' });
  assert.equal(await fs.readFile(path.join(destination, 'tokenizer.json'), 'utf8'), 'existing');
  await verifyAssets(source, hashes);
});

test('archive is strictly below the GitHub 2 GiB asset limit', () => {
  assert.equal(checkArchiveSize(archiveSizeLimit - 1), archiveSizeLimit - 1);
  assert.equal(checkArchiveSize(933 * 1024 ** 2), 933 * 1024 ** 2);
  for (const bytes of [0, -1, archiveSizeLimit, archiveSizeLimit + 1, NaN]) {
    assert.throws(() => checkArchiveSize(bytes), /must be under 2147483648 bytes/);
  }
});

test('release versions and production packaging remain aligned', async () => {
  for (const name of ['package.json', 'extension/manifest.json']) {
    assert.equal(JSON.parse(await fs.readFile(path.join(root, name), 'utf8')).version, '0.6.0');
  }
  const script = await fs.readFile(path.join(root, 'scripts/package-release.mjs'), 'utf8');
  assert.match(script, /const version = '0\.6\.0'/);
  assert.match(script, /native-cli\/model-assets\.json/);
  assert.match(script, /share\/licenses\/model-assets\.json/);
  assert.match(script, /checkArchiveSize\(\(await fs.stat\(archive\)\).size\)/);
  assert.doesNotMatch(script, /libmlx\.dylib|mlx\.metallib|packed\.safetensors/);
});
