import json
import os
from pathlib import Path
import platform
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import coremltools as ct
import numpy as np
from coremltools.converters.mil import Builder as mb
from coremltools.converters.mil.mil import types

from gradient import MODEL, PACKED_SHA256, REVISION
from validate_fused import set_background


BINARY = Path(__file__).resolve().parents[2] / "cache/coreml/bin/deckard-coreml"


class SchedulingTests(unittest.TestCase):
    def test_sets_both_process_policy_and_thread_qos(self):
        with patch("validate_fused.subprocess.run") as run, patch("validate_fused.ctypes.CDLL") as library:
            setter = library.return_value.pthread_set_qos_class_self_np
            setter.return_value = 0
            for enabled, flag, qos in ((True, "-b", 0x09), (False, "-B", 0x15)):
                set_background(enabled)
                self.assertEqual(run.call_args.args[0][1], flag)
                self.assertTrue(run.call_args.kwargs["check"])
                setter.assert_called_with(qos, 0)

    def test_qos_failure_is_not_silently_accepted(self):
        with patch("validate_fused.subprocess.run"), patch("validate_fused.ctypes.CDLL") as library:
            library.return_value.pthread_set_qos_class_self_np.return_value = 22
            with self.assertRaises(OSError):
                set_background(True)


@unittest.skipUnless(platform.system() == "Darwin" and platform.machine() == "arm64"
                     and BINARY.exists(), "Requires a built Apple Silicon native runner")
class PowerPlanTests(unittest.TestCase):
    def test_ane_observation_is_restricted_to_diagnostics(self):
        for flags, value in ((["--power-worker"], "observe"), (["--benchmark-worker"], "invalid")):
            result = subprocess.run(
                [str(BINARY), "/missing-bundle", "/missing-input", *flags],
                env=dict(os.environ, DECKARD_ANE_TRACE=value), text=True, capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 1)
            self.assertIn("supported only for diagnostic", result.stderr)

    def test_profiler_wait_can_cancel_without_loading_a_model(self):
        for command, code in (("quit\n", 0), ("invalid\n", 1)):
            result = subprocess.run(
                [str(BINARY), "/missing-bundle", "/missing-input", "--benchmark-worker",
                 "--wait-for-profiler"], input=command, text=True, capture_output=True, timeout=10)
            self.assertEqual(result.returncode, code, result.stderr)
            self.assertEqual(json.loads(result.stdout), {"profiler_waiting": True})
            self.assertNotIn("Preparing model", result.stderr)

    def test_refuses_cpu_only_plan_before_power_worker_readiness(self):
        @mb.program(input_specs=[
            mb.TensorSpec(shape=(1, 32), dtype=types.int32),
            mb.TensorSpec(shape=(1, 32), dtype=types.fp32),
        ], opset_version=ct.target.macOS15)
        def constant_model(input_ids, attention_mask):
            return mb.const(val=np.zeros((1, 1), dtype=np.float32), name="logit")

        with tempfile.TemporaryDirectory(prefix="deckard-coreml-plan-test-") as directory:
            bundle = Path(directory)
            model = ct.convert(constant_model, convert_to="mlprogram",
                               minimum_deployment_target=ct.target.macOS15,
                               compute_units=ct.ComputeUnit.CPU_ONLY,
                               compute_precision=ct.precision.FLOAT32, skip_model_load=True)
            model.save(str(bundle / "model.mlpackage"))
            (bundle / "manifest.json").write_text(json.dumps({
                "format": "deckard-coreml-fused-v1", "sequence_length": 32,
                "layers": 24, "model": MODEL, "revision": REVISION,
                "source_sha256": PACKED_SHA256,
            }))
            input_file = bundle / "input.json"
            input_file.write_text(json.dumps({"input_ids": [1, 2], "attention_mask": [1, 1]}))
            result = subprocess.run([str(BINARY), str(bundle), str(input_file), "--power-worker"],
                                    input="quit\n", text=True, capture_output=True, timeout=60)
            self.assertNotEqual(result.returncode, 0, result.stdout)
            self.assertEqual(result.stdout, "", "A CPU-only plan must not emit a ready event")
            self.assertIn("No Neural Engine execution plan was produced", result.stderr)
            for flags in ([], ["--fast-prediction"], ["--wait-for-profiler"]):
                wait_for_profiler = "--wait-for-profiler" in flags
                diagnostic = subprocess.run([str(BINARY), str(bundle), str(input_file),
                                             "--benchmark-worker", *flags],
                                            input=("prepare\n" if wait_for_profiler else "") + "run 100\nquit\n",
                                            text=True, capture_output=True, timeout=60)
                self.assertEqual(diagnostic.returncode, 0, diagnostic.stderr)
                responses = [json.loads(line) for line in diagnostic.stdout.splitlines()]
                if wait_for_profiler:
                    self.assertEqual(responses.pop(0), {"profiler_waiting": True})
                ready, burst = responses
                self.assertTrue(ready["ready"])
                self.assertGreaterEqual(ready["warmup_process_cpu_seconds"], 0)
                self.assertGreaterEqual(burst["process_cpu_seconds"], 0)
                self.assertGreater(burst["requests"], 0)
                self.assertIn("runtime ANE evidence required", diagnostic.stderr)
                phases = [json.loads(line.removeprefix("PROFILE "))
                          for line in diagnostic.stderr.splitlines() if line.startswith("PROFILE ")]
                self.assertEqual(len(phases), 1)
                for name in ("compile_ms", "load_ms", "compile_process_cpu_ms", "load_process_cpu_ms"):
                    self.assertGreaterEqual(phases[0][name], 0)
            environment = dict(os.environ)
            environment.pop("DECKARD_ANE_TRACE", None)
            rejected = subprocess.run(
                [str(BINARY), str(bundle), str(input_file), "--benchmark-worker"],
                env=environment, input="ane-qos default\nquit\n", text=True, capture_output=True, timeout=60)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertIn("Invalid or over-budget", rejected.stderr)
            controlled = subprocess.run(
                [str(BINARY), str(bundle), str(input_file), "--benchmark-worker"],
                env=dict(environment, DECKARD_ANE_TRACE="observe"),
                input="ane-qos default\nane-qos original\npublic-qos default\npublic-qos original\nquit\n",
                text=True, capture_output=True, timeout=60)
            self.assertEqual(controlled.returncode, 0, controlled.stderr)
            replies = [json.loads(line) for line in controlled.stdout.splitlines()]
            self.assertEqual(replies[1:], [
                {"ane_qos": "default"}, {"ane_qos": "original"},
                {"public_qos": "default"}, {"public_qos": "original"},
            ])


if __name__ == "__main__":
    unittest.main()
