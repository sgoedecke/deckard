// scripts/ci-fetch-model.sh on macOS, run as a copy in a scratch repository
// with stub uname, shasum and gh. The stub gh answers the repository lookup
// (SOURCE: the root of the fork network, empty for an original repository),
// serves a tiny release bundle and records its arguments.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/ci-fetch-model.sh', import.meta.url));
const linux = process.platform === 'linux';
const sha256 = text => createHash('sha256').update(text).digest('hex');
const files = { 'model.mlpackage/weights.bin': 'weights', 'tokenizer.json': 'tokenizer' };
const archive = 'deckard-v1-macos-arm64.tar.gz';

// A scratch repository with the script, a manifest pinning `files`, stubs on
// PATH and a release bundle for gh to serve.
function repository(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deckard-fetch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name, content, mode) => fs.writeFileSync(path.join(root, name), content, { mode });
  for (const dir of ['scripts', 'native-cli', 'bin', 'release/models/model.mlpackage'])
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.copyFileSync(script, path.join(root, 'scripts/ci-fetch-model.sh'));
  write('native-cli/model-assets.json', JSON.stringify({
    format: 1, files: Object.fromEntries(Object.entries(files).map(([n, c]) => [n, sha256(c)])) }));
  for (const [name, content] of Object.entries(files)) write(`release/models/${name}`, content);
  spawnSync('tar', ['-czf', path.join(root, 'release', archive), '-C', path.join(root, 'release'), 'models']);
  write('release/SHA256SUMS', `${sha256(fs.readFileSync(path.join(root, 'release', archive)))}  ${archive}\n`);
  write('bin/uname', '#!/bin/sh\necho Darwin\n', 0o755);
  write('bin/shasum', '#!/bin/sh\nshift 2\nexec sha256sum "$@"\n', 0o755);
  write('bin/gh', `#!/bin/bash
echo "$*" >> "${root}/gh.log"
[ "$1" = api ] && { [ -z "$SOURCE" ] || echo "$SOURCE"; exit 0; }
while [ "$#" -gt 0 ]; do
  [ "$1" = -D ] && dest=$2
  shift
done
cp "${root}/release/SHA256SUMS" "${root}/release/${archive}" "$dest"
`, 0o755);
  const out = path.join(root, 'output');
  const run = (dir, repository, source) => spawnSync(path.join(root, 'scripts/ci-fetch-model.sh'), [dir], { encoding: 'utf8',
    env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, GITHUB_REPOSITORY: repository, SOURCE: source,
      GITHUB_OUTPUT: out } });
  const downloads = () => fs.readFileSync(path.join(root, 'gh.log'), 'utf8').split('\n').filter(line => line.startsWith('release'));
  return { root, out, run, downloads };
}

const options = { skip: !linux && 'Linux only' };

test('ci-fetch-model.sh takes the macOS model from the releases of the repository a fork came from', options, t => {
  const { root, out, run, downloads } = repository(t);
  const dir = path.join(root, 'model');
  const result = run(dir, 'someone/deckard', 'maintainer/deckard');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(downloads().map(line => line.split(' ').slice(0, 4).join(' ')), ['release download -R maintainer/deckard']);
  for (const [name, content] of Object.entries(files)) assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), content);
  assert.equal(fs.readFileSync(out, 'utf8'), `model_dir=${dir}\n`);
});

test('ci-fetch-model.sh takes the macOS model from the repository itself when it is no fork', options, t => {
  const { root, run, downloads } = repository(t);
  const result = run(path.join(root, 'model'), 'maintainer/deckard', '');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(downloads().map(line => line.split(' ').slice(0, 4).join(' ')), ['release download -R maintainer/deckard']);
});
