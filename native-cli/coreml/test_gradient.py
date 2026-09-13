import math
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import torch
from torch.nn import functional as F

import gradient
from fixtures import references
from validate import load_cases


class PackedTests(unittest.TestCase):
    def test_nibble_order_groups_and_fp16_rounding(self):
        packed = np.full((2, 16), 0x76543210, dtype=np.uint32)
        scales = np.array([[0.3, 1.5], [2, 4]], dtype=np.float16)
        biases = np.array([[-0.25, 10], [3, -7]], dtype=np.float16)
        actual = gradient.unpack(packed, scales, biases)
        expected = np.tile(np.arange(8), (2, 16)).astype(np.float32)
        for row in range(2):
            for group in range(2):
                expected[row, group * 64:(group + 1) * 64] *= scales[row, group]
                expected[row, group * 64:(group + 1) * 64] += biases[row, group]
        np.testing.assert_array_equal(actual, expected.astype(np.float16).astype(np.float32))

    def test_rejects_invalid_packing(self):
        with self.assertRaises(ValueError):
            gradient.unpack(np.zeros((1, 8), dtype=np.int32),
                            np.zeros((1, 1), dtype=np.float16), np.zeros((1, 1), dtype=np.float16))
        with self.assertRaises(ValueError):
            gradient.unpack(np.zeros((1, 7), dtype=np.uint32),
                            np.zeros((1, 1), dtype=np.float16), np.zeros((1, 1), dtype=np.float16))

    def test_requires_exact_checkpoint(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "weights"
            path.write_bytes(b"wrong model")
            with self.assertRaises(ValueError):
                gradient.verify_checkpoint(path)


class InputTests(unittest.TestCase):
    def test_padding_is_masked(self):
        feed = gradient.validate_input({"input_ids": [1, 7, 2], "attention_mask": [1, 1, 1]}, 4)
        np.testing.assert_array_equal(feed["input_ids"], [[1, 7, 2, 0]])
        np.testing.assert_array_equal(feed["attention_mask"], [[1, 1, 1, 0]])

    def test_invalid_inputs(self):
        for ids, mask in [([], []), ([1], []), ([128100], [1]), ([-1], [1]),
                          ([True], [1]), ([1.5], [1]), ([1], [2]), ([1], [True]),
                          ([1, 2, 3], [1, 1, 1])]:
            with self.subTest(ids=ids, mask=mask), self.assertRaises(ValueError):
                gradient.validate_input({"input_ids": ids, "attention_mask": mask}, 2)

    def test_bucket_boundaries(self):
        c2p, p2c = gradient.position_indices(512)
        self.assertEqual(tuple(c2p.shape), (1, 16, 512, 512))
        for distance in [0, 1, 127, 128, 129, 255, 256, 510, 511]:
            bucket = distance if distance <= 128 else math.ceil(
                math.log(distance / 128) / math.log(511 / 128) * 127) + 128
            self.assertEqual(c2p[0, 0, distance, 0], min(bucket + 256, 511))
            self.assertEqual(p2c[0, 0, distance, 0], max(256 - bucket, 0))

    def test_frozen_synthetic_fixture_structure(self):
        cases = references()["cases"]
        self.assertEqual(len(cases), 12)
        for case in cases:
            ids, mask = case["feed"]["input_ids"][0], case["feed"]["attention_mask"][0]
            self.assertEqual(len(ids), len(mask))
            self.assertEqual(ids[0], 1)
            self.assertEqual(ids[sum(mask) - 1], 2)
            self.assertTrue(all(token == 0 for token in ids[sum(mask):]))
            self.assertAlmostEqual(case["score"], 1 / (1 + math.exp(-case["logit"])))

    def test_reference_selection_does_not_truncate_inputs(self):
        cases = load_cases(None, 64, 100)
        self.assertEqual(len(cases), 4)
        self.assertTrue(all(case["feed"]["input_ids"].shape == (1, 64) for case in cases))
        self.assertTrue(all("length32-" in case["name"] for case in cases))
        self.assertEqual(len(load_cases(None, 512, 3)), 3)


class TinyWeights:
    def __init__(self, hidden):
        self.hidden = hidden

    def matrix(self, name):
        return torch.randn(512, self.hidden) * 0.1

    def norm(self, name):
        return gradient.StableNorm(torch.randn(self.hidden) * 0.1 + 1,
                                   torch.randn(self.hidden) * 0.1)

    def linear(self, name):
        inputs = self.hidden * 4 if name.endswith(".output") else self.hidden
        outputs = self.hidden * 4 if name.endswith(".intermediate") else self.hidden
        return gradient.Projection(torch.randn(outputs, inputs) * 0.1, torch.randn(outputs) * 0.1)


class RewriteTests(unittest.TestCase):
    def setUp(self):
        torch.set_num_threads(2)
        torch.manual_seed(42)

    def test_conv_projection_matches_linear(self):
        weight, bias, x = torch.randn(24, 16), torch.randn(24), torch.randn(1, 7, 16)
        actual = gradient.Projection(weight, bias)(x)
        torch.testing.assert_close(actual, F.linear(x, weight, bias))

    def test_split_projections_preserve_affine_transform(self):
        weight, bias, x = torch.randn(24, 16), torch.randn(24), torch.randn(1, 7, 16)
        for axis in ("input", "output"):
            for splits in (2, 4, 8, 16):
                projection = gradient.Projection(weight, bias)
                projection.splits, projection.split_axis = splits, axis
                torch.testing.assert_close(projection(x), F.linear(x, weight, bias))

    def test_head_chunks_preserve_masked_attention(self):
        with patch.multiple(gradient, HIDDEN=16, HEADS=2, HEAD_DIM=8):
            for gather in ("elementwise", "rowwise", "skew"):
                for layout in ("matrix", "channels"):
                    torch.manual_seed(42)
                    baseline = gradient.Layer(TinyWeights(16), 0, 8, gather)
                    torch.manual_seed(42)
                    chunked = gradient.Layer(TinyWeights(16), 0, 8, gather, head_chunk=1,
                                             attention_layout=layout)
                    hidden = torch.randn(1, 8, 16)
                    mask = torch.tensor([[1., 1., 1., 1., 0., 0., 0., 0.]])
                    torch.testing.assert_close(chunked(hidden, mask), baseline(hidden, mask))

    def test_query_chunks_preserve_positions_across_bucket_boundaries(self):
        with patch.multiple(gradient, HIDDEN=16, HEADS=2, HEAD_DIM=8):
            for length, chunk in ((8, 2), (256, 64), (512, 128)):
                torch.manual_seed(42)
                baseline = gradient.Layer(TinyWeights(16), 0, length, "skew")
                torch.manual_seed(42)
                chunked = gradient.Layer(TinyWeights(16), 0, length, "skew", query_chunk=chunk)
                hidden = torch.randn(1, length, 16)
                mask = torch.ones(1, length)
                mask[:, length // 2:] = 0
                torch.testing.assert_close(chunked(hidden, mask), baseline(hidden, mask))

    def test_packed_qkv_preserves_both_runtime_and_positional_projections(self):
        with patch.multiple(gradient, HIDDEN=16, HEADS=2, HEAD_DIM=8):
            torch.manual_seed(42)
            baseline = gradient.Layer(TinyWeights(16), 0, 16, "skew")
            torch.manual_seed(42)
            packed = gradient.Layer(TinyWeights(16), 0, 16, "skew", pack_qkv=True)
            torch.testing.assert_close(packed.pos_key, baseline.pos_key, rtol=0, atol=0)
            torch.testing.assert_close(packed.pos_query, baseline.pos_query, rtol=0, atol=0)
            hidden, mask = torch.randn(1, 16, 16), torch.ones(1, 16)
            torch.testing.assert_close(packed(hidden, mask), baseline(hidden, mask))

    def test_spatial_packing_preserves_pointwise_projections(self):
        weight, bias, x = torch.randn(24, 16), torch.randn(24), torch.randn(1, 16, 16)
        for width in (1, 4, 8, 16):
            projection = gradient.Projection(weight, bias)
            projection.spatial_width = width
            torch.testing.assert_close(projection(x), F.linear(x, weight, bias))

    def test_channel_normalization_matches_layer_norm(self):
        with patch.multiple(gradient, HIDDEN=16):
            norm = gradient.StableNorm(torch.randn(16), torch.randn(16))
            norm.channels_first = True
            values = torch.randn(1, 32, 16) * 5 + 10
            torch.testing.assert_close(norm(values),
                                       F.layer_norm(values, (16,), norm.weight, norm.bias, gradient.EPSILON))

    def test_rowwise_position_selection_is_exact(self):
        with patch.multiple(gradient, HIDDEN=16, HEADS=2, HEAD_DIM=8):
            torch.manual_seed(42)
            original = gradient.Layer(TinyWeights(16), 0, 4)
            torch.manual_seed(42)
            rowwise = gradient.Layer(TinyWeights(16), 0, 4, "rowwise")
            table = torch.randn(1, 2, 4, 512)
            for first, second in [(original.c2p, rowwise.c2p), (original.p2c, rowwise.p2c)]:
                torch.testing.assert_close(original.select_positions(table, first),
                                           rowwise.select_positions(table, second), rtol=0, atol=0)
            hidden = torch.randn(1, 4, 16)
            for mask in [torch.ones(1, 4), torch.tensor([[1., 1., 0., 0.]])]:
                torch.testing.assert_close(original(hidden, mask), rowwise(hidden, mask))

    def test_skew_selection_preserves_logarithmic_buckets_exactly(self):
        with patch.multiple(gradient, HIDDEN=16, HEADS=2, HEAD_DIM=8):
            for length in (1, 4, 32, 128, 256, 512):
                with self.subTest(length=length):
                    torch.manual_seed(42)
                    original = gradient.Layer(TinyWeights(16), 0, length)
                    torch.manual_seed(42)
                    skew = gradient.Layer(TinyWeights(16), 0, length, "skew")
                    table = torch.randn(1, 2, length, 512)
                    for first, second in ((original.c2p, skew.c2p), (original.p2c, skew.p2c)):
                        expanded = F.pad(table.index_select(-1, second), (0, 1))
                        torch.testing.assert_close(original.select_positions(table, first),
                                                   skew.select_positions(expanded, second), rtol=0, atol=0)
                    hidden = torch.randn(1, length, 16)
                    mask = torch.ones(1, length)
                    mask[:, length // 2:] = 0
                    torch.testing.assert_close(original(hidden, mask), skew(hidden, mask))

    def test_disentangled_attention_matches_direct_pairwise_formula(self):
        hidden, heads, dim, length = 16, 2, 8, 4
        with patch.multiple(gradient, HIDDEN=hidden, HEADS=heads, HEAD_DIM=dim):
            layer = gradient.Layer(TinyWeights(hidden), 0, length)
            x = torch.randn(1, length, hidden)

            def linear(module, value):
                return F.linear(value, module.weight[:, :, 0, 0], module.bias)

            q, k, v = [linear(module, x).reshape(length, heads, dim).transpose(0, 1)
                       for module in (layer.query, layer.key, layer.value)]
            for mask in [torch.tensor([[1., 1., 1., 1.]]),
                         torch.tensor([[1., 1., 0., 0.]]), torch.zeros(1, length)]:
                scores = torch.empty(heads, length, length)
                for h in range(heads):
                    for i in range(length):
                        for j in range(length):
                            position = 256 + i - j
                            scores[h, i, j] = (
                                q[h, i] @ k[h, j]
                                + q[h, i] @ layer.pos_key[0, h, position]
                                + k[h, j] @ layer.pos_query[0, h, position]
                            ) / math.sqrt(dim * 3) if mask[0, i] * mask[0, j] else -65504
                attended = (scores.softmax(-1) @ v).transpose(0, 1).reshape(1, length, hidden)
                expected = layer.attention_norm(x + linear(layer.attention_output, attended))
                expected = layer.output_norm(expected + linear(
                    layer.output, F.gelu(linear(layer.intermediate, expected))))
                actual = layer(x, mask)
                torch.testing.assert_close(actual, expected, atol=1e-6, rtol=1e-5)
                self.assertTrue(torch.isfinite(actual).all())


if __name__ == "__main__":
    unittest.main()
