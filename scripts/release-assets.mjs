import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export const archiveSizeLimit = 2 * 1024 ** 3;
export const modelFiles = [
  'model.mlpackage/Manifest.json',
  'model.mlpackage/Data/com.apple.CoreML/model.mlmodel',
  'model.mlpackage/Data/com.apple.CoreML/weights/weight.bin',
  'tokenizer.json',
];

export function validatePins(pins) {
  if (pins?.format !== 1 || pins.runtime !== 'native-coreml' ||
      pins.precision !== 'fp16' || pins.sequence_length !== 512 ||
      pins.model_package !== 'model.mlpackage' ||
      !pins.files || typeof pins.files !== 'object' || Array.isArray(pins.files) ||
      JSON.stringify(Object.keys(pins.files).sort()) !== JSON.stringify([...modelFiles].sort()) ||
      Object.values(pins.files).some(hash => typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))) {
    throw new Error('Invalid Core ML model asset pins.');
  }
  return pins.files;
}

export async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function regularAsset(directory, name) {
  if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(name) ||
      name.split('/').some(part => part === '.' || part === '..')) {
    throw new Error(`Unsafe model asset path: ${name}`);
  }
  const parts = name.split('/');
  let current = directory;
  for (let i = 0; i <= parts.length; ++i) {
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || (i < parts.length ? !stat.isDirectory() : !stat.isFile())) {
      throw new Error(`Model asset links and special files are not permitted: ${name}`);
    }
    if (i < parts.length) current = path.join(current, parts[i]);
  }
  return current;
}

export async function verifyAssets(directory, hashes) {
  for (const [name, expected] of Object.entries(hashes)) {
    const source = await regularAsset(directory, name);
    if (await sha256(source) !== expected) throw new Error(`Canonical model checksum mismatch: ${name}`);
  }
}

export async function copyAssets(source, destination, hashes) {
  await verifyAssets(source, hashes);
  await fs.mkdir(destination, { recursive: true });
  for (const name of Object.keys(hashes)) {
    const file = await regularAsset(source, name);
    const target = path.join(destination, name);
    let directory = destination;
    for (const part of ['', ...name.split('/').slice(0, -1)]) {
      if (part) {
        directory = path.join(directory, part);
        await fs.mkdir(directory).catch(error => { if (error.code !== 'EEXIST') throw error; });
      }
      const stat = await fs.lstat(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`Unsafe model asset destination: ${directory}`);
      }
    }
    await fs.copyFile(file, target, constants.COPYFILE_EXCL);
  }
  // Verify what will actually ship, including changes to a source during copying.
  await verifyAssets(destination, hashes);
}

export function checkArchiveSize(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes >= archiveSizeLimit) {
    throw new Error(`Release archive is ${bytes} bytes; GitHub assets must be under ${archiveSizeLimit} bytes (2 GiB).`);
  }
  return bytes;
}
