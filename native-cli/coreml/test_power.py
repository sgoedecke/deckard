from datetime import datetime, timezone
import plistlib
from pathlib import Path
import tempfile
import unittest

from power_report import integrate, report, samples


class PowerTests(unittest.TestCase):
    def rows(self):
        return [{"begin": i, "end": i + 1,
                 "watts": {"cpu": 3 if 3 <= i < 5 else 1, "gpu": 0, "ane": 0},
                 "thermal": "Nominal"} for i in range(10)]

    def test_fractional_sample_overlap(self):
        energy = integrate(self.rows(), [2.5, 3.5])
        self.assertEqual(energy, {"cpu": 2, "gpu": 0, "ane": 0})

    def test_requires_complete_capture(self):
        for interval in [[-1, 1], [9, 11], [3, 3], [5, 3]]:
            with self.subTest(interval=interval), self.assertRaises(ValueError):
                integrate(self.rows(), interval)

    def test_idle_subtraction_and_joules_per_request(self):
        condition = {"begin": 3, "end": 5, "requests": 2,
                     "idle_before": [1, 2], "idle_after": [6, 7]}
        workload = {"conditions": [{**condition, "backend": backend}
                    for backend in ("mlx", "coreml", "coreml", "mlx")]}
        value = report(workload, self.rows(), 0.1)
        for row in value["conditions"]:
            self.assertEqual(row["total_incremental_joules_per_request"], 2)
            self.assertEqual(row["active_watts"]["cpu"], 3)
            self.assertEqual(row["idle_watts"]["cpu"], 1)
            self.assertEqual(row["latency_ms"], 1000)

    def test_reconstructs_subsecond_timeline_and_milliwatts(self):
        start = 1700000000.0
        records = []
        for index in range(30):
            end = start + (index + 1) / 10
            records.append({
                "elapsed_ns": 100000000,
                "timestamp": datetime.fromtimestamp(int(end), timezone.utc).replace(tzinfo=None),
                "processor": {"cpu_power": 2000.0, "gpu_power": 1000.0, "ane_power": 100.0},
                "thermal_pressure": "Nominal",
            })
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "power.plist"
            path.write_bytes(b"\0".join(plistlib.dumps(row) for row in records))
            rows, uncertainty = samples(path)
            self.assertLessEqual(uncertainty, 0.101)
            self.assertAlmostEqual(rows[0]["begin"], start + 0.05, places=5)
            self.assertEqual(rows[0]["watts"], {"cpu": 2, "gpu": 1, "ane": 0.1})

    def test_flags_gpu_activity_in_coreml_interval(self):
        rows = self.rows()
        for row in rows[3:5]:
            row["watts"]["gpu"] = 1
        condition = {"backend": "coreml", "begin": 3, "end": 5, "requests": 1,
                     "idle_before": [1, 2], "idle_after": [6, 7]}
        result = report({"conditions": [condition] * 4}, rows, 0.1)
        self.assertEqual(result["comparison_quality"], "confounded")
        self.assertTrue(any("GPU power increased" in warning
                            for warning in result["conditions"][0]["quality_warnings"]))


if __name__ == "__main__":
    unittest.main()
