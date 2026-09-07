import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = path.join(root, 'tests', `.bootstrap-${process.pid}`);
const commands = path.join(scratch, 'mock commands');
let template;
let archive;
let digest;
let sequence = 0;
const hash = data => createHash('sha256').update(data).digest('hex');
async function executable(name, content) {
  await fs.writeFile(path.join(commands, name), `#!/bin/bash\nset -eu\n${content}\n`, { mode: 0o755 });
}
before(async () => {
  await fs.mkdir(commands, { recursive: true });
  template = await fs.readFile(path.join(root, 'install.sh'), 'utf8');
  await executable('uname', 'case "$1" in -s) echo "${MOCK_OS:-Darwin}";; -m) echo "${MOCK_ARCH:-arm64}";; esac');
  await executable('sw_vers', 'echo "${MOCK_VERSION:-15.0}"');
  await executable('curl', `
printf '%s\\n' "$@" > "$CURL_LOG"
output=
while [ "$#" -gt 0 ]; do
  if [ "$1" = --output ]; then output=$2; shift 2; else shift; fi
done
cp "$MOCK_ARCHIVE" "$output"
`);
  const bundle = path.join(scratch, 'bundle');
  for (const dir of ['bin', 'lib', 'share/licenses', 'extension', 'models']) await fs.mkdir(path.join(bundle, dir), { recursive: true });
  await fs.writeFile(path.join(bundle, 'bin/deckard'), '#!/bin/bash\nprintf "%s\\n" "$@" > "$NATIVE_LOG"\nexit "${NATIVE_EXIT:-0}"\n', { mode: 0o755 });
  for (const file of ['lib/libmlx.dylib', 'share/licenses/LICENSE', 'extension/manifest.json', 'models/packed.safetensors', 'models/tokenizer.json']) {
    await fs.writeFile(path.join(bundle, file), 'fixture');
  }
  archive = path.join(scratch, 'bundle.tar.gz');
  const result = spawnSync('/usr/bin/tar', ['-czf', archive, '-C', bundle, 'bin', 'lib', 'share', 'extension', 'models']);
  assert.equal(result.status, 0, result.stderr?.toString());
  digest = hash(await fs.readFile(archive));
});
after(async () => fs.rm(scratch, { recursive: true, force: true }));

async function invoke(args = ['--yes', '--shell', 'none'], options = {}) {
  const directory = path.join(scratch, `case ${++sequence}`);
  await fs.mkdir(directory);
  const script = options.script ?? template.replace('@ARCHIVE_SHA256@', options.digest ?? digest);
  const scriptFile = path.join(directory, 'installer.sh');
  await fs.writeFile(scriptFile, script);
  const env = {
    PATH: `${commands}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: path.join(directory, 'isolated home'),
    SHELL: '/bin/zsh',
    MOCK_ARCHIVE: options.archive ?? archive,
    NATIVE_LOG: path.join(directory, 'native.log'),
    CURL_LOG: path.join(directory, 'curl.log'),
    BOOTSTRAP_FILE: scriptFile,
    TTY_ANSWER: options.answer ?? 'y',
    ...options.env,
  };
  const ttyScript = path.join(directory, 'tty.exp');
  if (options.tty) await fs.writeFile(ttyScript, `
set timeout 5
spawn /bin/bash -c {cat "$BOOTSTRAP_FILE" | /bin/bash -s -- "$@"} bootstrap {*}$argv
expect {
  -re {\\[y/N\\]} { send -- "$env(TTY_ANSWER)\\r" }
  timeout { exit 98 }
  eof { exit 99 }
}
expect eof
set result [wait]
exit [lindex $result 3]
`);
  const command = options.tty ? '/usr/bin/expect' : '/bin/bash';
  const commandArgs = options.tty
    ? [ttyScript, ...args]
    : ['-s', '--', ...args];
  const result = spawnSync(command, commandArgs, {
    input: options.tty ? `${options.answer ?? 'y'}\n` : script,
    env, cwd: directory, encoding: 'utf8', timeout: 10000,
  });
  const read = async name => fs.readFile(path.join(directory, name), 'utf8').catch(() => null);
  return { ...result, native: await read('native.log'), curl: await read('curl.log'), files: await fs.readdir(directory) };
}

test('curl-piped installer forwards spaces and options to native, which owns setup', async () => {
  const result = await invoke(['--yes', '--shell', 'bash', '--home', 'an isolated home', '--manifest-dir', 'manifest with spaces', '--extension-id', 'abcdefghijklmnopabcdefghijklmnop']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.native, /^install\n--home\nan isolated home\n--manifest-dir\nmanifest with spaces\n--extension-id\nabcdefghijklmnopabcdefghijklmnop\n--model-dir\n.*\/bundle\/models\n--extension-dir\n.*\/bundle\/extension\n--shell\nbash\n$/);
  assert.match(result.curl, /--proto\n=https\n--proto-redir\n=https\n/);
  assert.match(result.curl, /https:\/\/github\.com\/sgoedecke\/deckard\/releases\/download\/v0\.4\.1\/deckard-v0\.4\.1-macos-arm64\.tar\.gz/);
  assert.ok(!result.files.some(file => file.startsWith('.deckard-bootstrap.')));
});

test('supported SHELL basename is used with --yes', async () => {
  const result = await invoke(['--yes'], { env: { SHELL: '/custom/path/bash' } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.native, /--shell\nbash\n$/);
});

test('--yes --no-open installs without launching or probing Chrome', async () => {
  await executable('open', 'printf "unexpected browser launch\\n" > "$OPEN_LOG"; exit 88');
  await executable('osascript', 'printf "unexpected browser probe\\n" > "$OPEN_LOG"; exit 89');
  const openLog = path.join(scratch, 'unexpected-open.log');
  const result = await invoke(['--yes', '--no-open', '--shell', 'none'], { env: { OPEN_LOG: openLog } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.native, /^install\n/);
  assert.doesNotMatch(result.native, /--yes|--no-open/);
  await assert.rejects(fs.stat(openLog), { code: 'ENOENT' });
});

test('help documents explicit no-open and manual Chrome setup', async () => {
  const result = await invoke(['--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--no-open/);
  assert.match(result.stdout, /never opened automatically/);
  assert.match(result.stdout, /load the extension manually/);
  assert.equal(result.curl, null);
});

test('unsupported or missing shell requires an explicit choice', async () => {
  for (const shell of ['', '/bin/fish', '/bin/none']) {
    const result = await invoke(['--yes'], { env: { SHELL: shell } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Specify --shell/);
    assert.equal(result.curl, null);
  }
});

test('no controlling terminal fails clearly without --yes', async () => {
  const result = await invoke(['--shell', 'none']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No controlling terminal/);
  assert.equal(result.curl, null);
});

test('pipe prompts read from controlling tty, never script stdin', { skip: process.platform !== 'darwin' }, async () => {
  const result = await invoke(['--shell', 'none'], { tty: true });
  assert.equal(result.error, undefined);
  assert.match(result.stdout, /Install Deckard v0\.4\.1/);
  assert.match(result.native ?? '', /^install\n/);
});

test('tty decline performs no download or installation', { skip: process.platform !== 'darwin' }, async () => {
  const result = await invoke(['--shell', 'none'], { tty: true, answer: 'n' });
  assert.equal(result.error, undefined);
  assert.match(result.stdout, /Installation cancelled/);
  assert.equal(result.curl, null);
  assert.equal(result.native, null);
});

test('invalid options and missing values fail before download', async () => {
  for (const args of [['--uninstall'], ['--shell', 'fish'], ['--home'], ['--manifest-dir', '--yes'], ['--extension-id', ''], ['--unknown']]) {
    const result = await invoke(args);
    assert.notEqual(result.status, 0);
    assert.equal(result.curl, null);
  }
});

test('unsupported platforms fail before download', async () => {
  for (const env of [{ MOCK_OS: 'Linux' }, { MOCK_ARCH: 'x86_64' }, { MOCK_VERSION: '14.7' }, { MOCK_VERSION: 'invalid' }]) {
    const result = await invoke(undefined, { env });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /macOS/);
    assert.equal(result.curl, null);
  }
});

test('checksum mismatch prevents extraction and install, and cleans staging', async () => {
  const result = await invoke(undefined, { digest: '0'.repeat(64) });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /checksum mismatch/);
  assert.equal(result.native, null);
  assert.ok(!result.files.some(file => file.startsWith('.deckard-bootstrap.')));
});

test('source template fails closed before downloading', async () => {
  const result = await invoke(undefined, { script: template });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing pinned archive/);
  assert.equal(result.curl, null);
});

test('native installation errors propagate unchanged and staging is removed', async () => {
  const result = await invoke(undefined, { env: { NATIVE_EXIT: '42' } });
  assert.equal(result.status, 42);
  assert.match(result.native, /^install\n/);
  assert.ok(!result.files.some(file => file.startsWith('.deckard-bootstrap.')));
});

test('truncated pipeline never invokes installer code', async () => {
  for (const end of [100, template.indexOf('  expected='), template.lastIndexOf('deckard_bootstrap "$@"')]) {
    const result = await invoke(undefined, { script: template.slice(0, end) });
    assert.equal(result.curl, null);
    assert.equal(result.native, null);
    assert.ok(!result.files.some(file => file.startsWith('.deckard-bootstrap.')));
  }
});

function tarEntry(name, type = '0', link = '') {
  const header = Buffer.alloc(512);
  const write = (value, offset, length) => header.write(value, offset, length, 'ascii');
  write(name, 0, 100);
  write('0000755\0', 100, 8);
  write('0000000\0', 108, 8);
  write('0000000\0', 116, 8);
  write('00000000000\0', 124, 12);
  write('00000000000\0', 136, 12);
  write('        ', 148, 8);
  write(type, 156, 1);
  write(link, 157, 100);
  write('ustar\0', 257, 6);
  write('00', 263, 2);
  const sum = header.reduce((a, b) => a + b, 0);
  write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return header;
}

test('archive traversal, links, special files and duplicate paths are rejected before extraction', async () => {
  const cases = [
    [tarEntry('../escape')],
    [tarEntry('/absolute')],
    [tarEntry('models/../../escape')],
    [tarEntry('models/link', '2', '../../escape')],
    [tarEntry('models/link', '1', '/escape')],
    [tarEntry('models/pipe', '6')],
    [tarEntry('models/file'), tarEntry('models/file')],
  ];
  for (const entries of cases) {
    const data = gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
    const file = path.join(scratch, `unsafe-${++sequence}.tar.gz`);
    await fs.writeFile(file, data);
    const result = await invoke(undefined, { archive: file, digest: hash(data) });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unsafe archive|not permitted/);
    assert.equal(result.native, null);
  }
});
