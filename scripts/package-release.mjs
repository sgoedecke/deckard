import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = '0.4.1';
const archiveName = `deckard-v${version}-macos-arm64.tar.gz`;
const options = { '--native-dist': path.join(root, 'native-cli/build/dist'), '--output-dir': path.join(root, `dist/v${version}`) };
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  if (!['--model-dir', '--native-dist', '--output-dir'].includes(key) || !process.argv[i + 1] || process.argv[i + 1].startsWith('--')) {
    throw new Error('Usage: scripts/package-release.sh --model-dir DIR [--native-dist DIR] [--output-dir DIR]');
  }
  options[key] = path.resolve(process.argv[i + 1]);
}
if (!options['--model-dir']) throw new Error('--model-dir is required; the canonical model is read-only.');
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Packaging requires Apple Silicon macOS.');
const run = (command, args) => execFileSync(command, args, { stdio: 'inherit', env: { ...process.env, COPYFILE_DISABLE: '1', LC_ALL: 'C' } });
async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function tree(directory, prefix = '') {
  const entries = [];
  for (const name of (await fs.readdir(directory)).sort()) {
    const relative = prefix ? `${prefix}/${name}` : name;
    if (!/^[A-Za-z0-9_./-]+$/.test(relative)) throw new Error(`Unsafe package filename: ${relative}`);
    const source = path.join(directory, name);
    const stat = await fs.lstat(source);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error(`Links and special files cannot be packaged: ${source}`);
    entries.push(relative + (stat.isDirectory() ? '/' : ''));
    if (stat.isDirectory()) entries.push(...await tree(source, relative));
  }
  return entries;
}
const modelHashes = {
  'packed.safetensors': '85a9e02ebdcbbe1dd84cdbf893b708e44ee4691cadc7e1a4780039e22097ac98',
  'tokenizer.json': '4b4f60231058db4b5794e7b124bb7945bc8ade6719282de4d2e0372ee527b929',
};
for (const [name, expected] of Object.entries(modelHashes)) {
  const source = path.join(options['--model-dir'], name);
  if (!(await fs.lstat(source)).isFile() || await sha256(source) !== expected) throw new Error(`Canonical model checksum mismatch: ${name}`);
}
const native = options['--native-dist'];
await tree(native);
for (const required of ['bin/deckard', 'lib/libmlx.dylib', 'lib/mlx.metallib', 'share/licenses/MLX-LICENSE', 'share/licenses/NLOHMANN-LICENSE', 'share/licenses/Cargo.lock', 'share/licenses/rust-stdlib/COPYRIGHT-library.html']) {
  if (!(await fs.stat(path.join(native, required))).isFile()) throw new Error(`Missing native distribution file: ${required}`);
}
const nativeVersion = execFileSync(path.join(native, 'bin/deckard'), ['--version'], { encoding: 'utf8' }).trim();
if (nativeVersion !== version) throw new Error(`Native version ${nativeVersion} does not match ${version}.`);
const out = options['--output-dir'];
for (const input of [native, options['--model-dir'], path.join(root, 'extension'), path.join(root, 'docs')]) {
  if (input === out || input.startsWith(out + path.sep) || out.startsWith(input + path.sep)) throw new Error('Output must not overlap package inputs.');
}
await fs.mkdir(out, { recursive: true });
const staging = path.join(out, `.staging-${process.pid}`);
await fs.mkdir(staging);
try {
  const bundle = path.join(staging, 'bundle');
  await fs.mkdir(path.join(bundle, 'bin'), { recursive: true });
  await fs.copyFile(path.join(native, 'bin/deckard'), path.join(bundle, 'bin/deckard'));
  for (const name of ['lib', 'share']) await fs.cp(path.join(native, name), path.join(bundle, name), { recursive: true });
  await fs.cp(path.join(root, 'extension'), path.join(bundle, 'extension'), {
    recursive: true,
    filter: source => !['tests', '.DS_Store'].includes(path.basename(source)),
  });
  const manifest = JSON.parse(await fs.readFile(path.join(bundle, 'extension/manifest.json'), 'utf8'));
  if (manifest.name !== 'Deckard' || manifest.version !== version) throw new Error('Extension branding/version does not match release.');
  await fs.mkdir(path.join(bundle, 'models'));
  for (const name of Object.keys(modelHashes)) await fs.copyFile(path.join(options['--model-dir'], name), path.join(bundle, 'models', name));
  await fs.copyFile(path.join(root, 'LICENSE'), path.join(bundle, 'share/licenses/DECKARD-LICENSE'));
  await fs.cp(path.join(root, 'docs/licenses'), path.join(bundle, 'share/licenses/models'), { recursive: true });
  await fs.copyFile(path.join(root, 'docs/MODEL-ATTRIBUTION.md'), path.join(bundle, 'share/licenses/MODEL-ATTRIBUTION.md'));
  let entries = await tree(bundle);
  for (const entry of entries.filter(name => name.endsWith('.dylib'))) {
    run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', path.join(bundle, entry)]);
    run('/usr/bin/codesign', ['--verify', '--strict', path.join(bundle, entry)]);
  }
  run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', path.join(bundle, 'bin/deckard')]);
  run('/usr/bin/codesign', ['--verify', '--strict', path.join(bundle, 'bin/deckard')]);
  run('/usr/bin/lipo', [path.join(bundle, 'bin/deckard'), '-verify_arch', 'arm64']);
  entries = await tree(bundle);
  const epoch = new Date('2026-01-01T00:00:00Z');
  for (const entry of [...entries].reverse()) {
    const file = path.join(bundle, entry);
    await fs.chmod(file, entry.endsWith('/') || entry === 'bin/deckard' ? 0o755 : 0o644);
    await fs.utimes(file, epoch, epoch);
  }
  const fileList = path.join(staging, 'entries');
  await fs.writeFile(fileList, entries.join('\n') + '\n');
  const tarFile = path.join(staging, archiveName.slice(0, -3));
  run('/usr/bin/tar', ['--format', 'ustar', '--no-recursion', '--uid', '0', '--gid', '0', '--uname', 'root', '--gname', 'wheel',
    '--no-xattrs', '--no-acls', '--no-fflags', '-cf', tarFile, '-C', bundle, '-T', fileList]);
  run('/usr/bin/gzip', ['-n', '-9', tarFile]);
  const archive = path.join(staging, archiveName);
  const digest = await sha256(archive);
  const template = await fs.readFile(path.join(root, 'install.sh'), 'utf8');
  if (template.split('@ARCHIVE_SHA256@').length !== 2) throw new Error('Installer template must contain exactly one digest placeholder.');
  const installer = template.replace('@ARCHIVE_SHA256@', digest);
  await fs.writeFile(path.join(staging, 'install.sh'), installer, { mode: 0o755 });
  const installerDigest = await sha256(path.join(staging, 'install.sh'));
  await fs.writeFile(path.join(staging, 'SHA256SUMS'), `${digest}  ${archiveName}\n${installerDigest}  install.sh\n`);
  for (const name of [archiveName, 'install.sh', 'SHA256SUMS']) await fs.rename(path.join(staging, name), path.join(out, name));
  console.log(`Packaged ${path.join(out, archiveName)}\nSHA-256: ${digest}\nAd-hoc signatures verified. Not notarized. No release was published.`);
} finally {
  await fs.rm(staging, { recursive: true, force: true });
}
