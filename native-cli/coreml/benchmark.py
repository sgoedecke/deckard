"""Interleave resident CPU/ANE models under identical native background scheduling."""

import argparse
from contextlib import ExitStack
import hashlib
import json
import math
from pathlib import Path
import select
import statistics
import subprocess
import time

from bounded import footprint


def sigmoid(value):
    return 1 / (1 + math.exp(-value)) if value >= 0 else math.exp(value) / (1 + math.exp(value))


def abba_ratios(bursts):
    if not bursts or len(bursts) % 4:
        raise ValueError("Expected complete ABBA blocks.")
    result = []
    for start in range(0, len(bursts), 4):
        block = bursts[start:start + 4]
        order = [row["variant"] for row in block]
        if order not in (["baseline", "candidate", "candidate", "baseline"],
                          ["candidate", "baseline", "baseline", "candidate"]):
            raise ValueError("Invalid ABBA ordering.")
        baseline = statistics.mean(row["latency_ms"] for row in block if row["variant"] == "baseline")
        candidate = statistics.mean(row["latency_ms"] for row in block if row["variant"] == "candidate")
        result.append(baseline / candidate)
    return result


def power_source():
    result = subprocess.run(["/usr/bin/pmset", "-g", "batt"], check=True,
                            capture_output=True, text=True, timeout=5)
    lines = result.stdout.splitlines()
    if not lines:
        raise ValueError("Power-source query returned no data.")
    return lines[0]


class Worker:
    backend = "coreml"

    def __init__(self, binary, bundle, feed, log, meter, fast_prediction=False, env=None,
                 wait_for_profiler=False):
        if fast_prediction and wait_for_profiler:
            raise ValueError("Profiler attachment and fast-prediction flags cannot be combined.")
        command = [str(binary), str(bundle), str(feed), "--benchmark-worker"]
        if fast_prediction:
            command.append("--fast-prediction")
        if wait_for_profiler:
            command.append("--wait-for-profiler")
        self.process = subprocess.Popen(command,
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=log, text=True, bufsize=1, env=env)
        self.meter, self.peak, self.last_meter = meter, 0, 0

    def response(self, timeout):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise RuntimeError(f"Core ML worker {self.process.pid} exited: {self.process.returncode}")
            if time.monotonic() - self.last_meter >= 1:
                self.peak = max(self.peak, footprint(self.meter, self.process.pid))
                self.last_meter = time.monotonic()
                if self.peak > 6 * 1024**3:
                    raise RuntimeError("Core ML worker exceeded the 6 GiB process limit.")
            if select.select([self.process.stdout], [], [], 0.1)[0]:
                line = self.process.stdout.readline()
                if not line:
                    raise RuntimeError("Core ML worker closed its response stream.")
                return json.loads(line)
        raise TimeoutError("Core ML worker exceeded its response deadline.")

    def run(self, milliseconds):
        self.process.stdin.write(f"run {milliseconds}\n")
        self.process.stdin.flush()
        result = self.response(60)
        if (result.get("backend") != self.backend or result.get("requests", 0) < 1
                or not all(math.isfinite(result[key]) for key in ("begin", "end", "logit"))
                or result["end"] <= result["begin"]):
            raise ValueError("Invalid benchmark response.")
        result["latency_ms"] = (result["end"] - result["begin"]) * 1000 / result["requests"]
        return result

    def close(self):
        if self.process.poll() is None:
            self.process.stdin.write("quit\n")
            self.process.stdin.flush()
            try:
                self.process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
                raise TimeoutError("Core ML worker did not shut down.")
        if self.process.returncode != 0:
            raise RuntimeError(f"Core ML worker exited with {self.process.returncode}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("baseline", type=Path)
    parser.add_argument("candidate", type=Path)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--process-meter", required=True, type=Path)
    parser.add_argument("--rounds", type=int, default=2)
    parser.add_argument("--burst-ms", type=int, default=2000)
    parser.add_argument("--candidate-fast-prediction", action="store_true")
    parser.add_argument("--candidate-first", action="store_true", help="Reverse model preparation order.")
    parser.add_argument("--conditioning-ms", type=int, default=2000)
    args = parser.parse_args()
    if (not 1 <= args.rounds <= 10 or not 100 <= args.burst_ms <= 15000
            or not 100 <= args.conditioning_ms <= 15000):
        parser.error("Rounds must be 1..10 and bursts 100..15000 ms.")
    args.output.mkdir(parents=True, exist_ok=False)
    binary = Path(__file__).resolve().parents[2] / "cache/coreml/bin/deckard-coreml"
    receipt = {"scheduling": "native process and thread background", "compute_units": "cpu_and_neural_engine",
               "static_plan_inspection": False, "runtime_ane_evidence_required": True,
               "candidate_fast_prediction": args.candidate_fast_prediction,
               "candidate_prepared_first": args.candidate_first, "ordering": "alternating ABBA/BAAB",
               "input_sha256": hashlib.sha256(args.input.read_bytes()).hexdigest(),
               "ready": {}, "manifests": {}, "worker_pids": {}, "conditioning": [],
               "bursts": [], "status": "incomplete"}
    workers = {}
    bundles = {"baseline": args.baseline, "candidate": args.candidate}
    for name, bundle in bundles.items():
        receipt["manifests"][name] = json.loads((bundle / "manifest.json").read_text())
        if receipt["manifests"][name].get("format") != "deckard-coreml-fused-v1":
            raise ValueError("Resident benchmarks require fused bundles.")
    if any(receipt["manifests"]["candidate"].get(key) != receipt["manifests"]["baseline"].get(key)
           for key in ("sequence_length", "layers", "model", "revision", "source_sha256")):
        raise ValueError("Baseline and candidate must have the same model and input contract.")
    with ExitStack() as stack:
        preparation_order = ("candidate", "baseline") if args.candidate_first else ("baseline", "candidate")
        for name in preparation_order:
            log = stack.enter_context((args.output / f"{name}.stderr.log").open("x"))
            worker = Worker(binary, bundles[name], args.input, log, args.process_meter,
                            fast_prediction=name == "candidate" and args.candidate_fast_prediction)
            stack.callback(worker.close)
            workers[name] = worker
            receipt["worker_pids"][name] = worker.process.pid
            ready = worker.response(180)
            if ready.get("ready") is not True or not math.isfinite(ready["logit"]):
                raise ValueError("Core ML worker did not report a valid warmup.")
            receipt["ready"][name] = ready
        if abs(sigmoid(receipt["ready"]["baseline"]["logit"]) -
               sigmoid(receipt["ready"]["candidate"]["logit"])) > 0.002:
            raise ValueError("Candidate exceeds the score tolerance on the benchmark input.")
        receipt["power_source_begin"] = power_source()
        for name in ("baseline", "candidate", "candidate", "baseline"):
            result = workers[name].run(args.conditioning_ms)
            result["variant"] = name
            receipt["conditioning"].append(result)
        (args.output / "ready.json").write_text(json.dumps(receipt, indent=2) + "\n")
        print("Both Core ML models resident; starting interleaved bursts.", flush=True)
        for iteration in range(args.rounds):
            order = (("baseline", "candidate", "candidate", "baseline") if iteration % 2 == 0 else
                     ("candidate", "baseline", "baseline", "candidate"))
            for name in order:
                time.sleep(0.5)
                result = workers[name].run(args.burst_ms)
                result["variant"] = name
                receipt["bursts"].append(result)
                (args.output / "result.json").write_text(json.dumps(receipt, indent=2) + "\n")
                print(json.dumps(result), flush=True)
        receipt["median_burst_latency_ms"] = {
            name: statistics.median(row["latency_ms"] for row in receipt["bursts"] if row["variant"] == name)
            for name in workers
        }
        receipt["baseline_over_candidate"] = (
            receipt["median_burst_latency_ms"]["baseline"] / receipt["median_burst_latency_ms"]["candidate"])
        receipt["abba_baseline_over_candidate"] = abba_ratios(receipt["bursts"])
        receipt["paired_ratio_geomean"] = math.exp(statistics.mean(
            math.log(ratio) for ratio in receipt["abba_baseline_over_candidate"]))
        receipt["peak_process_bytes"] = {name: worker.peak for name, worker in workers.items()}
        receipt["power_source_end"] = power_source()
    receipt["status"] = ("completed" if receipt["power_source_begin"] == receipt["power_source_end"]
                         else "environment_changed")
    (args.output / "result.json").write_text(json.dumps(receipt, indent=2) + "\n")
    if receipt["status"] != "completed":
        raise SystemExit("Power source changed during measurement; benchmark is not comparable.")
    print(json.dumps({key: receipt[key] for key in (
        "median_burst_latency_ms", "baseline_over_candidate", "abba_baseline_over_candidate",
        "paired_ratio_geomean")}))


if __name__ == "__main__":
    main()
