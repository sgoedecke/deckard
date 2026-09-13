import unittest
from pathlib import Path
import subprocess
import sys

from power_qos import condition_order, summarize


class PowerQoSTests(unittest.TestCase):
    def test_cli_builds_all_subcommands_without_starting_workers(self):
        script = Path(__file__).with_name("power_qos.py")
        for command in ([], ["ane"], ["gpu"], ["report"]):
            result = subprocess.run([sys.executable, str(script), *command, "--help"],
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_models_have_reversed_priority_order(self):
        order = condition_order()
        self.assertEqual(len(order), 8)
        self.assertEqual([mode for model, mode in order if model == "fp16"],
                         ["background", "default", "default", "background"])
        self.assertEqual([mode for model, mode in order if model == "q4"],
                         ["default", "background", "background", "default"])

    def test_aggregates_energy_by_duration_and_request_count(self):
        def row(duration, count):
            return {"model": "fp16", "priority": "default", "duration_seconds": duration,
                    "requests": count, "active_watts": {"cpu": 1, "gpu": 0, "ane": 2},
                    "total_incremental_joules_per_request": 0.5, "quality_warnings": []}
        result = summarize([row(2, 10), row(4, 20)])
        self.assertEqual(result["latency_ms"], 200)
        self.assertEqual(result["active_rail_watts"], 3)
        self.assertEqual(result["incremental_rail_watts"], 2.5)
        self.assertEqual(result["incremental_joules_per_classification"], 0.5)
        self.assertEqual(result["quality_warnings"], [])
        with self.assertRaises(ValueError):
            summarize([])

    def test_keeps_confounding_warnings_and_negative_energy(self):
        rows = [{"model": "fp16", "priority": "background", "duration_seconds": 2,
                 "requests": 10, "active_watts": {"cpu": 1, "gpu": 0, "ane": 1},
                 "total_incremental_joules_per_request": -0.1,
                 "quality_warnings": ["Background variation dominates."]}]
        result = summarize(rows)
        self.assertLess(result["incremental_rail_watts"], 0)
        self.assertIn("Background variation dominates.", result["quality_warnings"])


if __name__ == "__main__":
    unittest.main()
