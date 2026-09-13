from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import benchmark


class BenchmarkTests(unittest.TestCase):
    def test_interleaves_variants_and_closes_both_workers(self):
        instances = []

        class FakeWorker:
            def __init__(self, binary, bundle, feed, log, meter, fast_prediction=False):
                self.name, self.closed, self.peak = bundle.name, False, 42
                self.process = SimpleNamespace(pid=42)
                self.fast_prediction = fast_prediction
                instances.append(self)

            def response(self, timeout):
                return {"ready": True, "logit": 2}

            def run(self, milliseconds):
                return {"latency_ms": 200 if self.name == "baseline" else 100}

            def close(self):
                self.closed = True

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name in ("baseline", "candidate"):
                (root / name).mkdir()
                (root / name / "manifest.json").write_text(json.dumps({
                    "name": name, "format": "deckard-coreml-fused-v1", "sequence_length": 512}))
            (root / "input.json").write_text("{}")
            argv = ["benchmark.py", str(root / "baseline"), str(root / "candidate"),
                    "--input", str(root / "input.json"), "--output", str(root / "result"),
                    "--process-meter", "unused", "--candidate-fast-prediction"]
            with patch("sys.argv", argv), patch.object(benchmark, "Worker", FakeWorker), \
                    patch.object(benchmark.time, "sleep"), patch.object(benchmark, "power_source", return_value="test"), \
                    redirect_stdout(io.StringIO()):
                benchmark.main()
            result = json.loads((root / "result/result.json").read_text())
            self.assertEqual(result["status"], "completed")
            self.assertEqual([row["variant"] for row in result["bursts"]],
                             ["baseline", "candidate", "candidate", "baseline",
                              "candidate", "baseline", "baseline", "candidate"])
            self.assertEqual(result["baseline_over_candidate"], 2)
            self.assertEqual(result["abba_baseline_over_candidate"], [2, 2])
            self.assertEqual(result["paired_ratio_geomean"], 2)
            self.assertEqual(len(result["conditioning"]), 4)
            self.assertTrue(all(worker.closed for worker in instances))
            self.assertFalse(instances[0].fast_prediction)
            self.assertTrue(instances[1].fast_prediction)

    def test_sigmoid_handles_large_finite_logits(self):
        self.assertEqual(benchmark.sigmoid(1000), 1)
        self.assertEqual(benchmark.sigmoid(-1000), 0)

    def test_abba_pairing_cancels_linear_timing_drift(self):
        bursts = [{"variant": name, "latency_ms": latency} for name, latency in
                  zip(("baseline", "candidate", "candidate", "baseline"), (100, 110, 120, 130))]
        self.assertEqual(benchmark.abba_ratios(bursts), [1])
        for row in bursts:
            row["variant"] = "candidate" if row["variant"] == "baseline" else "baseline"
        self.assertEqual(benchmark.abba_ratios(bursts), [1])
        with self.assertRaises(ValueError):
            benchmark.abba_ratios(bursts[:3])


if __name__ == "__main__":
    unittest.main()
