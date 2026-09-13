"""Compare CPU/ANE Core ML stages with the CPU rewrite and frozen MLX scores."""

import argparse
from collections import Counter
import gc
import hashlib
import json
import math
from pathlib import Path
import time

import numpy as np
import torch

from gradient import (
    MODEL, REVISION, PACKED_SHA256, LAYERS, Weights, make_stage, stage_names,
    validate_input, verify_checkpoint,
)
from fixtures import references


def placement(plan):
    counts = Counter()
    operations = []

    def visit(block):
        for operation in block.operations:
            usage = plan.get_compute_device_usage_for_mlprogram_operation(operation)
            device = type(usage.preferred_compute_device).__name__ if usage else "unknown"
            counts[device] += 1
            operations.append({"operation": operation.operator_name, "preferred_device": device})
            for nested in operation.blocks:
                visit(nested)

    if plan.model_structure.program:
        for function in plan.model_structure.program.functions.values():
            visit(function.block)
    return {"preferred_device_counts": dict(counts), "operations": operations,
            "interpretation": "Compiler placement preference, not a measured hardware execution trace."}


def load_cases(path, length, limit):
    data = json.loads(path.read_text()) if path else references()
    cases = []
    for row in data["cases"]:
        feed = row["feed"]
        ids, mask = feed["input_ids"][0], feed["attention_mask"][0]
        if len(ids) <= length:
            cases.append({"name": row["name"], "mlx_score": row["score"], "mlx_logit": row["logit"],
                          "feed": validate_input({"input_ids": ids, "attention_mask": mask}, length)})
        if len(cases) == limit:
            break
    if not cases:
        raise ValueError("No reference cases fit the selected sequence length.")
    return cases


def main():
    import coremltools as ct
    from coremltools.models.compute_plan import MLComputePlan

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--references", type=Path, help="Defaults to bundled synthetic frozen MLX fixtures.")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--length", type=int, choices=[32, 64, 128, 256, 512], default=128)
    parser.add_argument("--cases", type=int, default=16)
    parser.add_argument("--stage", choices=stage_names(), help="Diagnose just one stage.")
    parser.add_argument("--score-tolerance", type=float, default=0.02)
    args = parser.parse_args()
    if args.cases < 1 or not 0 < args.score_tolerance < 1:
        parser.error("Cases must be positive and score tolerance must be in (0,1).")
    if args.output.exists():
        raise FileExistsError(args.output)
    verify_checkpoint(args.checkpoint)
    if not args.stage:
        manifest = json.loads((args.bundle / "manifest.json").read_text())
        required = {"format": "deckard-coreml-split-v1", "model": MODEL, "revision": REVISION,
                    "source_sha256": PACKED_SHA256, "layers": LAYERS, "sequence_length": args.length}
        if any(manifest.get(key) != value for key, value in required.items()):
            raise ValueError("Bundle manifest does not match the checkpoint and requested shape.")
    torch.set_num_threads(2)
    cases = load_cases(args.references, args.length, args.cases)
    weights = Weights(args.checkpoint)
    stages = stage_names() if args.stage is None else [args.stage]
    if args.stage and args.stage != "embedding":
        with torch.inference_mode():
            embedding = make_stage(weights, "embedding", args.length)
            for case in cases:
                case["hidden"] = embedding(*(torch.from_numpy(x) for x in case["feed"].values())).numpy()
                case["reference_hidden"] = case["hidden"].copy()
        del embedding
        gc.collect()
    if args.references:
        with args.references.open("rb") as source:
            reference_sha = hashlib.file_digest(source, "sha256").hexdigest()
    else:
        reference_sha = hashlib.sha256(json.dumps(references(), sort_keys=True).encode()).hexdigest()
    receipt = {"compute_units": "cpu_and_neural_engine", "sequence_length": args.length,
               "model": MODEL, "revision": REVISION, "source_sha256": PACKED_SHA256,
               "references_sha256": reference_sha,
               "references_kind": "external" if args.references else "bundled_synthetic",
               "score_tolerance": args.score_tolerance, "stages": [], "cases": [],
               "status": "diagnostic_only" if args.stage else "failed"}
    for name in stages:
        started = time.perf_counter()
        model = ct.models.MLModel(str(args.bundle / f"{name}.mlpackage"),
                                 compute_units=ct.ComputeUnit.CPU_AND_NE)
        load_ms = (time.perf_counter() - started) * 1000
        plan = MLComputePlan.load_from_path(model.get_compiled_model_path(),
                                          compute_units=ct.ComputeUnit.CPU_AND_NE)
        report = {"stage": name, "load_ms": load_ms, "placement": placement(plan), "cases": []}
        del plan
        reference = make_stage(weights, name, args.length)
        for case in cases:
            if name == "embedding":
                feed = case["feed"]
                reference_feed = feed
            else:
                feed = {"hidden": case["hidden"]}
                reference_feed = {"hidden": case["reference_hidden"]}
                if name != "head":
                    feed["attention_mask"] = case["feed"]["attention_mask"]
                    reference_feed["attention_mask"] = feed["attention_mask"]
            started = time.perf_counter()
            result = model.predict(feed)
            elapsed = (time.perf_counter() - started) * 1000
            key = "hidden" if name == "embedding" else "logit" if name == "head" else "hidden_out"
            actual = result[key]
            with torch.inference_mode():
                expected = reference(*(torch.from_numpy(x) for x in reference_feed.values())).numpy()
            if actual.shape != expected.shape or not np.isfinite(actual).all() or not np.isfinite(expected).all():
                raise ValueError(f"{name}: invalid/non-finite model output.")
            report["cases"].append({"name": case["name"], "prediction_ms": elapsed,
                                    "max_absolute_error": float(np.max(np.abs(actual - expected)))})
            if name != "head":
                case["hidden"] = actual
                case["reference_hidden"] = expected
            else:
                logit, reference_logit = float(actual.item()), float(expected.item())
                score = 1 / (1 + math.exp(-logit))
                reference_score = 1 / (1 + math.exp(-reference_logit))
                receipt["cases"].append({
                    "name": case["name"], "logit": logit, "score": score,
                    "cpu_logit": reference_logit, "cpu_score": reference_score,
                    "mlx_logit": case["mlx_logit"], "mlx_score": case["mlx_score"],
                    "cpu_score_error": abs(score - reference_score),
                    "mlx_score_error": abs(score - case["mlx_score"]),
                    "same_default_decision": (score >= 0.97) == (case["mlx_score"] >= 0.97),
                })
        receipt["stages"].append(report)
        print(json.dumps({"stage": name, "load_ms": load_ms,
                          "preferred_devices": report["placement"]["preferred_device_counts"],
                          "max_error": max(x["max_absolute_error"] for x in report["cases"])}), flush=True)
        del model, reference
        gc.collect()
    if not args.stage:
        receipt["status"] = "passed" if all(
            case["cpu_score_error"] <= args.score_tolerance
            and case["mlx_score_error"] <= args.score_tolerance
            and case["same_default_decision"] for case in receipt["cases"]
        ) else "failed"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x") as stream:
        json.dump(receipt, stream, indent=2, allow_nan=False)
        stream.write("\n")
    if receipt["status"] == "failed":
        raise SystemExit("Score parity failed; do not enable this backend for browsing.")


if __name__ == "__main__":
    main()
