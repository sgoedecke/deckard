import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from coremltools.converters.mil.mil.ops.defs.iOS18.compression import constexpr_lut_to_dense
from coremltools.libmilstoragepython import _BlobStorageReader, _BlobStorageWriter
from coremltools.proto import MIL_pb2, Model_pb2
import numpy as np

from gradient import unpack
from q4 import audit_saved, blob_constant, decode, encode, fingerprint, replace_weight


class FaithfulQ4Tests(unittest.TestCase):
    def tensors(self):
        weight = np.tile(np.array([0x76543210, 0xFEDCBA98], dtype=np.uint32), (3, 8))
        scales = np.array([[0.00071, 0.0413], [0.0127, 0], [0.125, 0.0327]], dtype=np.float16)
        biases = np.array([[-0.007, -0.228], [0.031, -0.013], [-0.5, 0.0031]], dtype=np.float16)
        return weight, scales, biases

    def test_nibble_order_and_original_affine_rounding(self):
        inputs = self.tensors()
        indices, lut = encode(*inputs)
        np.testing.assert_array_equal(indices[0, :16], np.arange(16))
        np.testing.assert_array_equal(decode(indices, lut).view(np.uint16),
                                      unpack(*inputs).astype(np.float16).view(np.uint16))
        self.assertEqual(lut.shape, (3, 2, 16))
        self.assertEqual(indices.dtype, np.uint8)
        self.assertEqual(lut.dtype, np.float16)

    def test_coreml_lut_axes_for_embedding_and_optimized_convolutions(self):
        inputs = self.tensors()
        indices, lut = encode(*inputs)
        expected = unpack(*inputs).astype(np.float16)
        for shape in ((3, 128), (3, 128, 1), (3, 128, 1, 1)):
            palette = lut.reshape((3, 2, *shape[2:], 16, 1))
            actual = constexpr_lut_to_dense.decompress(indices.reshape(shape), palette, None)
            np.testing.assert_array_equal(actual.reshape(expected.shape).view(np.uint16),
                                          expected.view(np.uint16))

    def test_real_uint4_blob_storage_preserves_codes_and_fp16_bits(self):
        indices, lut = encode(*self.tensors())
        with tempfile.TemporaryDirectory() as temporary:
            path = str(Path(temporary) / "weight.bin")
            writer = _BlobStorageWriter(path)
            offset = writer.write_uint4_data(indices.flatten())
            palette_offset = writer.write_fp16_data(lut.view(np.uint16).flatten())
            del writer
            reader = _BlobStorageReader(path)
            np.testing.assert_array_equal(reader.read_uint4_data(offset), indices.flatten())
            np.testing.assert_array_equal(reader.read_fp16_data(palette_offset), lut.view(np.uint16).flatten())
            # Three rows x 128 values require 192 payload bytes, not 384 uint8 bytes.
            self.assertLess(palette_offset - offset, indices.size)

    def test_replacement_retains_consumers_output_type_and_group_axes(self):
        original = blob_constant("weight", (3, 128, 1), MIL_pb2.FLOAT16, 64)
        indices, lut, operation = replace_weight(original, (3, 128, 1), 128, 256)
        self.assertEqual(operation.outputs, original.outputs)
        self.assertEqual(operation.type, "constexpr_lut_to_dense")
        self.assertNotIn("val", operation.attributes)
        self.assertEqual(operation.inputs["indices"].arguments[0].name, indices.outputs[0].name)
        self.assertEqual(operation.inputs["lut"].arguments[0].name, lut.outputs[0].name)
        self.assertEqual(indices.attributes["val"].type.tensorType.dataType, MIL_pb2.UINT4)
        self.assertEqual([d.constant.size for d in lut.outputs[0].type.tensorType.dimensions],
                         [3, 2, 1, 16, 1])
        self.assertEqual(original.type, "const")

    def test_invalid_checkpoint_layout_is_rejected(self):
        weight, scales, biases = self.tensors()
        with self.assertRaises(ValueError):
            encode(weight.astype(np.uint16), scales, biases)
        with self.assertRaises(ValueError):
            encode(weight, scales[:, :1], biases)

    def test_saved_audit_supports_named_and_inlined_inputs_and_rejects_changed_weights(self):
        indices, lut = encode(*self.tensors())
        records = [{"dense_sha256": fingerprint(decode(indices, lut))}]
        with tempfile.TemporaryDirectory() as temporary:
            package = Path(temporary)
            weights = package / "Data/com.apple.CoreML/weights"
            weights.mkdir(parents=True)
            writer = _BlobStorageWriter(str(weights / "weight.bin"))
            indices_offset = writer.write_uint4_data(indices.flatten())
            lut_offset = writer.write_fp16_data(lut.view(np.uint16).flatten())
            del writer
            original = blob_constant("weight", (3, 128, 1), MIL_pb2.FLOAT16, 0)
            nodes = replace_weight(original, (3, 128, 1), indices_offset, lut_offset)
            spec = Model_pb2.Model()
            block = spec.mlProgram.functions["main"].block_specializations["CoreML8"]
            block.operations.extend(nodes)
            with patch("q4.ct.utils.load_spec", return_value=spec):
                audit_saved(package, records)
                with self.assertRaisesRegex(ValueError, "weight bit patterns"):
                    audit_saved(package, [{"dense_sha256": "0" * 64}])
                for name, constant in zip(("indices", "lut"), nodes[:2]):
                    arguments = block.operations[-1].inputs[name].arguments
                    del arguments[:]
                    arguments.add().value.CopyFrom(constant.attributes["val"])
                del block.operations[:2]
                audit_saved(package, records)
                block.operations[0].inputs["indices"].arguments[0].value.type.tensorType.dataType = MIL_pb2.UINT8
                with self.assertRaisesRegex(ValueError, "palette input"):
                    audit_saved(package, records)


if __name__ == "__main__":
    unittest.main()
