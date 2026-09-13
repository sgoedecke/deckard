import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import export
from gradient import stage_names


class ExportTests(unittest.TestCase):
    def test_full_export_propagates_gather_layout_only_to_transformers(self):
        for gather, precision in (("elementwise", "mixed"), ("rowwise", "mixed"), ("skew", "fp16")):
            with self.subTest(gather=gather, precision=precision), tempfile.TemporaryDirectory() as temporary:
                output = Path(temporary) / "bundle"
                arguments = ["export.py", "--checkpoint", "unused", "--output", str(output),
                             "--length", "512", "--gather", gather, "--precision", precision,
                             "--process-meter", "meter", "--ffn-splits", "2",
                             "--split-axis", "output", "--head-chunk", "4", "--attention-layout", "channels",
                             "--pack-qkv"]
                with patch("sys.argv", arguments), patch.object(export, "verify_checkpoint"), \
                        patch.object(export.subprocess, "run") as run:
                    export.main()
                self.assertEqual(run.call_count, 26)
                for call, name in zip(run.call_args_list, stage_names()):
                    command = call.args[0]
                    self.assertEqual(command[command.index("--stage") + 1], name)
                    self.assertEqual(command[command.index("--gather") + 1],
                                     gather if name.startswith("layer-") else "elementwise")
                    self.assertEqual(command[command.index("--precision") + 1], precision)
                    self.assertEqual(command[command.index("--meter") + 1], "meter")
                    self.assertEqual(command[command.index("--ffn-splits") + 1], "2")
                    self.assertEqual(command[command.index("--split-axis") + 1], "output")
                    self.assertEqual(command[command.index("--head-chunk") + 1], "4")
                    self.assertEqual(command[command.index("--attention-layout") + 1], "channels")
                    self.assertIn("--pack-qkv", command)
                manifest = json.loads((output / "manifest.json").read_text())
                self.assertEqual(manifest["gather"], gather)
                self.assertEqual(manifest["precision_mode"], precision)
                self.assertEqual((manifest["ffn_splits"], manifest["split_axis"], manifest["head_chunk"]),
                                 (2, "output", 4))
                self.assertEqual(manifest["attention_layout"], "channels")
                self.assertTrue(manifest["pack_qkv"])
                self.assertTrue(manifest["experimental"])


if __name__ == "__main__":
    unittest.main()
