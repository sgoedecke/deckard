import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const reference = fileURLToPath(new URL("../../cache/gradient-accelerator/exports/mlx-q4/packed.safetensors", import.meta.url));
const generated = fileURLToPath(new URL("../../cache/native-build/clean-install/current/models/packed.safetensors", import.meta.url));
const available = fs.existsSync(reference) && fs.existsSync(generated);
function tensors(file) {
  const bytes = fs.readFileSync(file);
  assert.ok(bytes.length >= 245189442, "Published output must contain the full checkpoint, not the reserved empty file.");
  const length = Number(bytes.readBigUInt64LE());
  assert.ok(length > 0 && length < bytes.length - 8);
  const header = JSON.parse(bytes.subarray(8, length + 8));
  delete header.__metadata__;
  return { bytes, header, start: length + 8 };
}
test("native FP32 conversion publishes all 690 byte-identical packed tensors", { skip: !available }, () => {
  const a = tensors(reference), b = tensors(generated);
  assert.equal(Object.keys(a.header).length, 690);
  assert.equal(Object.keys(b.header).length, 690);
  for (const [name, value] of Object.entries(a.header)) {
    assert.deepEqual(value.shape, b.header[name].shape, name);
    assert.equal(value.dtype, b.header[name].dtype, name);
    const [begin, end] = b.header[name].data_offsets;
    assert.ok(a.bytes.subarray(a.start + value.data_offsets[0], a.start + value.data_offsets[1])
      .equals(b.bytes.subarray(b.start + begin, b.start + end)), name);
  }
});
