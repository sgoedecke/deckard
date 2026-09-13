"""Measure ANE QoS or a separately authorized MLX baseline against powermetrics."""

import argparse
from contextlib import ExitStack
import hashlib
import json
import math
from pathlib import Path
import statistics
import subprocess
import time

from benchmark import Worker, power_source
from bounded import footprint
from power_report import RAILS, report as rail_report, samples
from profile_instruments import trace_environment
from profile_qos import set_qos


class GPUWorker(Worker):
    backend = "mlx"

    def __init__(self, binary, checkpoint, feed, log, meter, prior, env):
        self.process = subprocess.Popen(
            [str(binary), str(checkpoint), str(feed), str(prior)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log,
            text=True, bufsize=1, env=env)
        self.meter, self.peak, self.last_meter = meter, 0, 0


def condition_order():
    first = [("fp16", "background"), ("fp16", "default"),
             ("q4", "default"), ("q4", "background")]
    return first + list(reversed(first))


def measure(args):
    args.output.mkdir(parents=True, exist_ok=False)
    root = Path(__file__).resolve().parents[2]
    env = trace_environment("/Library/Developer/CommandLineTools")
    gpu = args.operation == "gpu"
    receipt = {
        "status": "incomplete", "compute_units": "gpu" if gpu else "cpu_and_neural_engine",
        "scope": "production background MLX" if gpu else "ANE request priority only; host remains background",
        "input_sha256": hashlib.sha256(args.input.read_bytes()).hexdigest(),
        "power_source_begin": power_source(), "ready": {}, "conditions": [],
        "model_preparation_excluded_from_measurement": True,
        "idle_seconds": args.idle_seconds,
        "idle_settling_seconds_excluded": args.settle_seconds,
    }
    if gpu:
        with args.checkpoint.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        if digest != "85a9e02ebdcbbe1dd84cdbf893b708e44ee4691cadc7e1a4780039e22097ac98":
            raise ValueError("The GPU baseline requires the canonical Gradient q4 checkpoint.")
        receipt["gpu_budget"] = {
            "additional_authorized_seconds": 20,
            "previous_allocation_reserved_seconds": args.previous_allocation_seconds,
            "used_from_additional_allocation_before_this_run": args.prior_new_gpu_seconds,
            "native_worker_cap_seconds": 19,
            "constructor_and_warmup_count_toward_budget": True,
        }
    workers = {}

    def monitor():
        for worker in workers.values():
            if worker.process.poll() is not None:
                raise RuntimeError(f"Power worker exited with {worker.process.returncode}.")
            if time.monotonic() - worker.last_meter >= 1:
                worker.peak = max(worker.peak, footprint(worker.meter, worker.process.pid))
                worker.last_meter = time.monotonic()
                if worker.peak > 6 * 1024**3:
                    raise RuntimeError("Power worker exceeded the 6 GiB process limit.")

    def idle(seconds):
        begin, start = time.time(), time.monotonic()
        while time.monotonic() - start < seconds:
            monitor()
            time.sleep(0.1)
        return [begin, time.time()]

    try:
        with ExitStack() as stack:
            variants = {"mlx": args.checkpoint} if gpu else {"fp16": args.fp16, "q4": args.q4}
            if not gpu:
                env["DECKARD_ANE_TRACE"] = "observe"
            for name, bundle in variants.items():
                log = stack.enter_context((args.output / f"{name}.log").open("x"))
                worker = (GPUWorker(root / "cache/coreml/bin/deckard-power-mlx", bundle,
                                    args.input, log, args.process_meter, args.prior_new_gpu_seconds, env)
                          if gpu else Worker(root / "cache/coreml/bin/deckard-coreml", bundle,
                                             args.input, log, args.process_meter, env=env))
                workers[name] = worker
                stack.callback(worker.close)
                ready = worker.response(180)
                if ready.get("ready") is not True or not math.isfinite(ready["logit"]):
                    raise ValueError("Worker failed to report a finite warmup.")
                receipt["ready"][name] = ready
                print(f"{name} resident and warmed.", flush=True)
            if gpu:
                used = receipt["ready"]["mlx"]["preparation_seconds"]
                # Reserve conditioning plus an overrun margin for every burst.
                burst_ms = min(args.burst_ms, math.floor(((18 - used - 1.5) / 4 - 0.5) * 1000))
                if burst_ms < 500:
                    raise RuntimeError("Too little authorized GPU budget remains for four useful bursts.")
                receipt["conditioning"] = workers["mlx"].run(1000)
                order = [("mlx", "background")] * 4
            else:
                burst_ms = args.burst_ms
                receipt["conditioning"] = []
                for name, mode in condition_order()[:4]:
                    set_qos(workers[name], "original" if mode == "background" else "default")
                    receipt["conditioning"].append(workers[name].run(1000))
                order = condition_order()
            receipt["burst_ms"] = burst_ms
            (args.output / "ready.json").write_text(json.dumps(receipt, indent=2) + "\n")
            print("READY: waiting for the authorized power.plist capture.", flush=True)
            power = args.output / "power.plist"
            deadline = time.monotonic() + 600
            while not power.exists() or power.stat().st_size < 4096:
                if time.monotonic() > deadline:
                    raise TimeoutError("Power capture was not started within ten minutes.")
                monitor()
                time.sleep(0.1)
            for name, mode in order:
                worker = workers[name]
                if not gpu:
                    set_qos(worker, "original" if mode == "background" else "default")
                before = idle(args.idle_seconds)
                before[0] += args.settle_seconds
                burst = worker.run(burst_ms)
                after = idle(args.idle_seconds)
                after[0] += args.settle_seconds
                burst.update({"model": name, "priority": mode,
                              "idle_before": before, "idle_after": after})
                receipt["conditions"].append(burst)
                (args.output / "workload.json").write_text(json.dumps(receipt, indent=2) + "\n")
                print(f"{name}/{mode}: {burst['requests']} classifications, "
                      f"{burst['latency_ms']:.1f} ms each.", flush=True)
            receipt["power_source_end"] = power_source()
            receipt["peak_process_bytes"] = {name: worker.peak for name, worker in workers.items()}
            if gpu:
                used = receipt["conditions"][-1]["inference_seconds_used"]
                receipt["gpu_budget"]["additional_allocation_used_seconds"] = used
                receipt["gpu_budget"]["combined_conservative_used_seconds"] = (
                    args.previous_allocation_seconds + used)
                if used > 19:
                    raise RuntimeError("GPU worker exceeded its internal budget.")
            else:
                receipt["runtime_qos"] = {}
                for name in workers:
                    calls = [json.loads(line.removeprefix("ANE_TRACE "))
                             for line in (args.output / f"{name}.log").read_text().splitlines()
                             if line.startswith("ANE_TRACE ")]
                    if (not calls or {call["qos"] for call in calls} != {9}
                            or {call["effective_qos"] for call in calls} != {9, 21}
                            or not all(call["success"] for call in calls)):
                        raise ValueError("Runtime evidence did not confirm ANE priority selection.")
                    receipt["runtime_qos"][name] = {"original": 9, "effective": [9, 21]}
            receipt["status"] = ("completed" if receipt["power_source_begin"] == receipt["power_source_end"]
                                 else "environment_changed")
    finally:
        if gpu and "additional_allocation_used_seconds" not in receipt["gpu_budget"]:
            receipt["gpu_budget"]["additional_allocation_used_seconds_upper_bound"] = 19
            receipt["gpu_budget"]["failure_accounting"] = (
                "Conservatively reserve the native cap after an incomplete run; do not restart at zero.")
        (args.output / "workload.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(f"Workloads finished: {receipt['status']}.", flush=True)


def summarize(conditions):
    if not conditions or any(row["duration_seconds"] <= 0 or row["requests"] <= 0 for row in conditions):
        raise ValueError("Expected positive measured durations and classification counts.")
    duration = sum(row["duration_seconds"] for row in conditions)
    requests = sum(row["requests"] for row in conditions)
    active_joules = sum(sum(row["active_watts"].values()) * row["duration_seconds"] for row in conditions)
    incremental_joules = sum(row["total_incremental_joules_per_request"] * row["requests"]
                             for row in conditions)
    warnings = sorted({warning for row in conditions for warning in row["quality_warnings"]})
    energies = [row["total_incremental_joules_per_request"] for row in conditions]
    if max(energies) - min(energies) > max(0.02, abs(statistics.mean(energies)) * 0.25):
        warnings.append("Repeated energy estimates vary substantially between runs.")
    return {
        "model": conditions[0]["model"], "priority": conditions[0]["priority"],
        "requests": requests, "bursts": len(conditions),
        "latency_ms": duration * 1000 / requests,
        "active_rail_watts": active_joules / duration,
        "incremental_rail_watts": incremental_joules / duration,
        "incremental_joules_per_classification": incremental_joules / requests,
        "active_watts_by_rail": {
            rail: sum(row["active_watts"][rail] * row["duration_seconds"] for row in conditions) / duration
            for rail in RAILS
        },
        "quality_warnings": warnings,
    }


def make_report(directory):
    workload = json.loads((directory / "workload.json").read_text())
    if workload["status"] != "completed":
        raise ValueError("Cannot compare an incomplete or power-source-changing workload.")
    rows, uncertainty = samples(directory / "power.plist")
    conditions = []
    for model in sorted({row["model"] for row in workload["conditions"]}):
        selected = [row for row in workload["conditions"] if row["model"] == model]
        calculated = rail_report({"conditions": selected}, rows, uncertainty)
        for source, result in zip(selected, calculated["conditions"]):
            result.update({"model": model, "priority": source["priority"]})
            conditions.append(result)
    groups = sorted({(row["model"], row["priority"]) for row in conditions})
    report = {
        "measurement": "Machine-wide CPU+GPU+ANE rails, not total laptop power or process-attributed power.",
        "input_sha256": workload["input_sha256"], "scope": workload["scope"],
        "power_source": workload["power_source_begin"],
        "alignment_interval_seconds": uncertainty,
        "thermal_states": sorted({row["thermal"] for row in rows}),
        "conditions": conditions,
        "summary": [summarize([row for row in conditions
                               if (row["model"], row["priority"]) == key]) for key in groups],
    }
    if report["thermal_states"] != ["Nominal"]:
        for row in report["summary"]:
            row["quality_warnings"].append("Thermal pressure was not consistently nominal.")
    report["quality"] = ("confounded" if any(row["quality_warnings"] for row in report["summary"])
                         else "no_automatic_quality_warning")
    (directory / "report.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
    print(json.dumps({key: report[key] for key in ("quality", "summary")}, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="operation", required=True)
    for name in ("ane", "gpu"):
        sub = subparsers.add_parser(name)
        sub.add_argument("--input", type=Path, required=True)
        sub.add_argument("--output", type=Path, required=True)
        sub.add_argument("--process-meter", type=Path, required=True)
        sub.add_argument("--burst-ms", type=int, default=6000 if name == "ane" else 2000)
        sub.add_argument("--idle-seconds", type=float, default=5)
        sub.add_argument("--settle-seconds", type=float, default=0)
        if name == "ane":
            sub.add_argument("--fp16", type=Path, required=True)
            sub.add_argument("--q4", type=Path, required=True)
        else:
            sub.add_argument("--checkpoint", type=Path, required=True)
            sub.add_argument("--prior-new-gpu-seconds", type=float, required=True)
            sub.add_argument("--previous-allocation-seconds", type=float, required=True)
    subparsers.add_parser("report").add_argument("directory", type=Path)
    args = parser.parse_args()
    if args.operation == "report":
        make_report(args.directory)
    else:
        if (not 500 <= args.burst_ms <= (10000 if args.operation == "ane" else 2000)
                or not math.isfinite(args.idle_seconds) or not 2 <= args.idle_seconds <= 10
                or not math.isfinite(args.settle_seconds)
                or not 0 <= args.settle_seconds <= args.idle_seconds - 1):
            parser.error("Use bounded bursts, 2..10 second idle periods, and at least one retained idle second.")
        if args.operation == "gpu" and (
                not math.isfinite(args.prior_new_gpu_seconds) or not 0 <= args.prior_new_gpu_seconds <= 18
                or not math.isfinite(args.previous_allocation_seconds) or args.previous_allocation_seconds < 0):
            parser.error("GPU reservations must be finite, with new-budget usage in 0..18 seconds.")
        measure(args)


if __name__ == "__main__":
    main()
