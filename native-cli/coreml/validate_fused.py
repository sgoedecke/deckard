"""Validate the single resident graph against frozen MLX cases, without a GPU."""

import argparse
import ctypes
import json
import math
import os
from pathlib import Path
import subprocess
import time

import coremltools as ct
from coremltools.models.compute_plan import MLComputePlan

from gradient import MODEL, REVISION, PACKED_SHA256
from validate import load_cases, placement


def set_background(enabled):
    subprocess.run(["/usr/sbin/taskpolicy", "-b" if enabled else "-B", "-p", str(os.getpid())],
                   check=True, timeout=5)
    set_qos = ctypes.CDLL(None).pthread_set_qos_class_self_np
    set_qos.argtypes = [ctypes.c_uint, ctypes.c_int]
    set_qos.restype = ctypes.c_int
    # Public sys/qos.h constants: BACKGROUND=0x09, DEFAULT=0x15.
    error = set_qos(0x09 if enabled else 0x15, 0)
    if error:
        raise OSError(error, os.strerror(error))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--references", type=Path)
    parser.add_argument("--cases", type=int, default=1000)
    parser.add_argument("--scheduling", choices=["default", "background"], default="background")
    parser.add_argument("--skip-plan", action="store_true",
                        help="Run numerical gates only; runtime ANE evidence must be collected separately.")
    parser.add_argument("--fast-prediction", action="store_true")
    args = parser.parse_args()
    if args.fast_prediction and not args.skip_plan:
        parser.error("Fast-prediction validation requires --skip-plan; collect matching runtime evidence separately.")
    if args.output.exists():
        raise FileExistsError(args.output)
    manifest = json.loads((args.bundle / "manifest.json").read_text())
    required = {"format": "deckard-coreml-fused-v1", "model": MODEL, "revision": REVISION,
                "source_sha256": PACKED_SHA256, "layers": 24}
    if any(manifest.get(key) != value for key, value in required.items()):
        raise ValueError("Invalid fused bundle manifest.")
    if not 1 <= args.cases <= 1000:
        parser.error("Cases must be in 1..1000.")
    cases = load_cases(args.references, manifest["sequence_length"], args.cases)
    if not cases:
        raise ValueError("No reference cases fit this model's sequence length.")
    start = time.perf_counter()
    hints = {"specializationStrategy": ct.SpecializationStrategy.FastPrediction,
             "reshapeFrequency": ct.ReshapeFrequency.Infrequent} if args.fast_prediction else None
    model = ct.models.MLModel(str(args.bundle / "model.mlpackage"), compute_units=ct.ComputeUnit.CPU_AND_NE,
                              optimization_hints=hints)
    receipt = {"load_ms": (time.perf_counter() - start) * 1000, "cases": [], "manifest": manifest,
               "compute_units": "cpu_and_neural_engine", "scheduling": args.scheduling,
               "thread_qos": "background" if args.scheduling == "background" else "unchanged",
               "fast_prediction": args.fast_prediction,
               "score_tolerance": 0.002, "status": "incomplete"}
    if args.scheduling == "background":
        set_background(True)
    for case in cases:
        start = time.perf_counter()
        output = model.predict(case["feed"])["logit"]
        elapsed = (time.perf_counter() - start) * 1000
        if output.shape != (1, 1) or not math.isfinite(float(output.item())):
            raise ValueError("Invalid fused classifier output.")
        logit = float(output.item())
        score = 1 / (1 + math.exp(-logit))
        row = {"name": case["name"], "logit": logit, "score": score,
               "mlx_score": case["mlx_score"], "mlx_score_error": abs(score - case["mlx_score"]),
               "prediction_ms": elapsed, "same_default_decision": (score >= 0.97) == (case["mlx_score"] >= 0.97)}
        receipt["cases"].append(row)
        args.output.write_text(json.dumps(receipt, indent=2, allow_nan=False) + "\n")
        print(json.dumps(row), flush=True)
    if args.scheduling == "background":
        set_background(False)
    receipt["numerical_status"] = "passed" if all(
        row["mlx_score_error"] <= 0.002 and row["same_default_decision"] for row in receipt["cases"]
    ) else "failed"
    receipt["placement_status"] = "skipped" if args.skip_plan else "pending"
    args.output.write_text(json.dumps(receipt, indent=2, allow_nan=False) + "\n")
    if not args.skip_plan:
        plan = MLComputePlan.load_from_path(model.get_compiled_model_path(), compute_units=ct.ComputeUnit.CPU_AND_NE)
        receipt["placement"] = placement(plan)
        receipt["placement_status"] = "collected"
    receipt["status"] = receipt["numerical_status"]
    args.output.write_text(json.dumps(receipt, indent=2, allow_nan=False) + "\n")
    if receipt["status"] != "passed":
        raise SystemExit("Fused model score parity failed.")


if __name__ == "__main__":
    main()
