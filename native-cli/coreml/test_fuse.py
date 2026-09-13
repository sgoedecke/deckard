import unittest

import numpy as np
from coremltools.proto import MIL_pb2

from fuse import append_stage, constant_key, rename_output, elide_cast_roundtrips


def constant(block, name, number, blob=False):
    operation = block.operations.add(type="const")
    value = operation.attributes["val"]
    value.type.tensorType.dataType = MIL_pb2.FLOAT32
    if blob:
        value.blobFileValue.fileName = "@model_path/weights/weight.bin"
        value.blobFileValue.offset = 64
    else:
        value.immediateValue.tensor.floats.values.append(number)
    output = operation.outputs.add(name=name)
    output.type.CopyFrom(value.type)
    return operation


def stage():
    block = MIL_pb2.Block()
    constant(block, "weight", 2)
    operation = block.operations.add(type="add")
    operation.inputs["x"].arguments.add(name="hidden")
    operation.inputs["y"].arguments.add(name="weight")
    operation.outputs.add(name="hidden_out")
    block.outputs.append("hidden_out")
    return block


def no_blob(*args):
    raise AssertionError("Unexpected blob access.")


class FusionTests(unittest.TestCase):
    def test_elides_only_lossless_internal_casts(self):
        def cast(block, source, name, dtype):
            op = block.operations.add(type="cast")
            op.inputs["x"].arguments.add(name=source)
            op.outputs.add(name=name).type.tensorType.dataType = dtype

        for source_type, middle_type, expected in (
                (MIL_pb2.FLOAT16, MIL_pb2.FLOAT32, 1), (MIL_pb2.FLOAT32, MIL_pb2.FLOAT16, 0)):
            block = MIL_pb2.Block()
            op = block.operations.add(type="source")
            op.outputs.add(name="original").type.tensorType.dataType = source_type
            cast(block, "original", "wide", middle_type)
            cast(block, "wide", "back", source_type)
            cast(block, "back", "result", middle_type)
            block.outputs.append("result")
            result = elide_cast_roundtrips(block)
            self.assertEqual(result["bypassed_roundtrips"], expected)
            self.assertEqual(block.operations[-1].outputs[0].name, "result")
            if expected:
                self.assertEqual(len(block.operations), 2)
                self.assertEqual(block.operations[-1].inputs["x"].arguments[0].name, "original")

    def test_fp16_finite_values_survive_widening_exactly(self):
        bits = np.arange(65536, dtype=np.uint16)
        values = bits.view(np.float16)
        finite = np.isfinite(values)
        np.testing.assert_array_equal(values[finite].astype(np.float32).astype(np.float16).view(np.uint16),
                                      bits[finite])

    def test_renames_final_value_and_references_without_colliding(self):
        block = stage()
        rename_output(block, "weight", "shared_weight")
        self.assertEqual(block.operations[0].outputs[0].name, "shared_weight")
        self.assertEqual(block.operations[1].inputs["y"].arguments[0].name, "shared_weight")
        with self.assertRaises(ValueError):
            rename_output(block, "hidden_out", "shared_weight")
        rename_output(block, "hidden_out", "result")
        self.assertEqual(list(block.outputs), ["result"])

    def test_wires_stages_and_shares_only_identical_constants(self):
        destination, constants = MIL_pb2.Block(), {}
        first = append_stage(destination, stage(), 0, {"hidden": "input"}, constants, no_blob, no_blob)
        second = append_stage(destination, stage(), 1, {"hidden": first[0]}, constants, no_blob, no_blob)
        self.assertEqual(second, ["s01_hidden_out"])
        self.assertEqual(len(destination.operations), 3)
        self.assertEqual(destination.operations[-1].inputs["x"].arguments[0].name, first[0])
        self.assertEqual(destination.operations[-1].inputs["y"].arguments[0].name, "s00_weight")

    def test_blob_identity_uses_bytes_not_equal_offsets_in_different_files(self):
        source = MIL_pb2.Block()
        constant(source, "weight", 0, blob=True)
        source.outputs.append("weight")
        destination, constants, written = MIL_pb2.Block(), {}, []

        def write(kind, data):
            written.append(data.copy())
            return len(written) * 64

        for index in range(2):
            append_stage(destination, source, index, {}, constants,
                         lambda *_: np.array([index + 1], dtype=np.float32), write)
        self.assertEqual(len(destination.operations), 2)
        self.assertEqual(len(written), 2)
        self.assertEqual(destination.operations[1].attributes["val"].blobFileValue.offset, 128)

    def test_rejects_unbound_input_and_nested_control_flow(self):
        with self.assertRaises(ValueError):
            append_stage(MIL_pb2.Block(), stage(), 0, {}, {}, no_blob, no_blob)
        source = stage()
        source.operations[-1].blocks.add()
        with self.assertRaises(ValueError):
            append_stage(MIL_pb2.Block(), source, 0, {"hidden": "input"}, {}, no_blob, no_blob)

    def test_preserves_float_bit_patterns(self):
        block = MIL_pb2.Block()
        value = constant(block, "weight", 0, blob=True).attributes["val"]
        self.assertNotEqual(constant_key(value, np.array([0.0], dtype=np.float32)),
                            constant_key(value, np.array([-0.0], dtype=np.float32)))


if __name__ == "__main__":
    unittest.main()
