import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));

test('production build refuses stale MLX artifacts without changing existing output', async t => {
  const directory = await fs.mkdtemp(path.join(root, 'tests/.native-build-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const name of ['dist/lib/libmlx.dylib', 'dist/lib/mlx.metallib',
    'dist/share/licenses/MLX-LICENSE', 'licenses/MLX-LICENSE']) {
    const file = path.join(directory, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'preserved');
    const result = spawnSync('/bin/bash', [path.join(root, 'scripts/build-native.sh')], {
      cwd: directory, encoding: 'utf8', env: { ...process.env, BUILD_DIR: directory },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Choose a fresh BUILD_DIR; existing output was left untouched/);
    assert.equal(await fs.readFile(file, 'utf8'), 'preserved');
    await fs.rm(file);
  }
});

test('production bootstrap accepts a read-only Rust/JSON cache without MLX; research SDK is opt-in', async t => {
  const directory = await fs.mkdtemp(path.join(root, 'tests/.native-bootstrap-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const commands = path.join(directory, 'commands');
  const cache = path.join(directory, 'cache');
  await fs.mkdir(commands);
  const files = [
    'json/include/nlohmann/json.hpp',
    'cargo/registry/fixture',
    'rustup/toolchains/1.90.0-aarch64-apple-darwin/bin/cargo',
    'licenses/NLOHMANN-LICENSE',
  ];
  for (const name of files) {
    await fs.mkdir(path.dirname(path.join(cache, name)), { recursive: true });
    await fs.writeFile(path.join(cache, name), 'fixture');
  }
  for (const [name, content] of Object.entries({
    uname: 'case "$1" in -s) echo Darwin;; -m) echo arm64;; esac',
    sw_vers: 'echo 15.0',
    cmake: 'exit 0',
    xcrun: 'exit 0',
    curl: 'echo "Unexpected download" >&2; exit 99',
  })) await fs.writeFile(path.join(commands, name), `#!/bin/sh\n${content}\n`, { mode: 0o755 });
  const before = await fs.readdir(cache, { recursive: true });
  const run = mlx => spawnSync('/bin/sh', [path.join(root, 'native-cli/bootstrap.sh')], {
    cwd: directory, encoding: 'utf8', env: {
      ...process.env, PATH: `${commands}:/usr/bin:/bin`, NATIVE_CACHE: cache, DECKARD_BOOTSTRAP_MLX: mlx,
    },
  });
  let result = run('0');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /read-only native dependencies/);
  assert.deepEqual(await fs.readdir(cache, { recursive: true }), before);
  result = run('1');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /incomplete: mlx-sdk/);
  result = run('invalid');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be 0 or 1/);
  await fs.rm(path.join(cache, 'licenses/NLOHMANN-LICENSE'));
  result = run('0');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /incomplete: licenses\/NLOHMANN-LICENSE/);
});
