import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import coremltools as ct
from coremltools.proto import Model_pb2

import compress
from gradient import MODEL, REVISION, PACKED_SHA256, LAYERS


class CompressionTests(unittest.TestCase):
    def test_uses_offline_cpu_ane_model_and_records_additional_quantization(self):
        spec = Model_pb2.Model()
        spec.mlProgram.functions["main"].block_specializations["CoreML8"].operations.add(
            type="constexpr_blockwise_shift_scale")
        with tempfile.TemporaryDirectory() as directory:
            source, destination = Path(directory) / "source", Path(directory) / "compressed"
            source.mkdir()
            (source / "manifest.json").write_text(json.dumps({
                "format": "deckard-coreml-fused-v1", "model": MODEL, "revision": REVISION,
                "source_sha256": PACKED_SHA256, "layers": LAYERS,
            }))
            with patch.object(ct.models, "MLModel") as load, \
                    patch.object(ct.optimize.coreml, "linear_quantize_weights") as quantize, \
                    patch("builtins.print"):
                quantize.return_value.get_spec.return_value = spec
                compress.compress(source, destination)
            self.assertTrue(load.call_args.kwargs["skip_model_load"])
            self.assertEqual(load.call_args.kwargs["compute_units"], ct.ComputeUnit.CPU_AND_NE)
            config = quantize.call_args.args[1]
            self.assertEqual(set(config.op_type_configs), {"conv"})
            self.assertEqual(config.op_type_configs["conv"].block_size, 64)
            receipt = json.loads((destination / "manifest.json").read_text())
            self.assertTrue(receipt["weight_compression"]["requires_numerical_validation"])
            self.assertEqual(receipt["weight_compression"]["dequantize_operations"], 1)


if __name__ == "__main__":
    unittest.main()
