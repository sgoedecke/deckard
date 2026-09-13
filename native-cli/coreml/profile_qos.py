"""Change only ANE request QoS, interleaved on one resident Gradient model."""

import argparse
import hashlib
import json
import math
from pathlib import Path
import statistics

from benchmark import Worker, abba_ratios, power_source
from profile_instruments import trace_environment


def set_qos(worker, name, scope="request"):
    if name not in ("original", "default"):
        raise ValueError("Expected original or default ANE request QoS.")
    if scope not in ("request", "process-thread"):
        raise ValueError("Expected request or process-thread QoS scope.")
    prefix = "ane-qos" if scope == "request" else "public-qos"
    worker.process.stdin.write(f"{prefix} {name}\n")
    worker.process.stdin.flush()
    if worker.response(5) != {prefix.replace("-", "_"): name}:
        raise ValueError("Worker did not acknowledge the ANE QoS change.")


def block_order(iteration, candidate_first):
    return (("candidate", "baseline", "baseline", "candidate")
            if bool(iteration % 2) != candidate_first else
            ("baseline", "candidate", "candidate", "baseline"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--process-meter", type=Path, required=True)
    parser.add_argument("--control", action="store_true",
                        help="Keep original ANE QoS for both labels as an identical-condition control.")
    parser.add_argument("--candidate-first", action="store_true")
    parser.add_argument("--burst-ms", type=int, default=1000)
    parser.add_argument("--scope", choices=("request", "process-thread"), default="request",
                        help="Override the ANE request alone, or use public process/thread scheduling APIs.")
    args = parser.parse_args()
    if not 100 <= args.burst_ms <= 5000:
        parser.error("Burst duration must be 100..5000 ms.")
    args.output.mkdir(parents=True, exist_ok=False)
    binary = Path(__file__).resolve().parents[2] / "cache/coreml/bin/deckard-coreml"
    env = trace_environment("/Library/Developer/CommandLineTools")
    env["DECKARD_ANE_TRACE"] = "observe"
    receipt = {
        "status": "incomplete", "bundle": str(args.bundle),
        "input_sha256": hashlib.sha256(args.input.read_bytes()).hexdigest(),
        "compute_units": "cpu_and_neural_engine", "identical_condition_control": args.control,
        "candidate_first": args.candidate_first, "burst_ms": args.burst_ms,
        "scope": args.scope,
        "host_scheduling": ("background process and thread throughout" if args.scope == "request"
                            else "alternating background/default process and thread policy"),
        "intervention": ("only direct ANE evaluation request QoS; no model reload" if args.scope == "request"
                         else "public process/thread scheduling APIs only; no request override or model reload"),
        "power_source_begin": power_source(), "conditioning": [], "bursts": [],
    }
    with (args.output / "worker.log").open("x") as log:
        worker = Worker(binary, args.bundle, args.input, log, args.process_meter, env=env)
        try:
            receipt["ready"] = worker.response(180)
            if receipt["ready"].get("ready") is not True:
                raise ValueError("ANE worker did not become ready.")
            conditioning_order = (("default", "original", "original", "default")
                                  if args.candidate_first else
                                  ("original", "default", "default", "original"))
            for name in conditioning_order:
                set_qos(worker, "original" if args.control else name, args.scope)
                receipt["conditioning"].append(worker.run(1000))
            for iteration in range(4):
                for variant in block_order(iteration, args.candidate_first):
                    name = "original" if variant == "baseline" or args.control else "default"
                    set_qos(worker, name, args.scope)
                    burst = worker.run(args.burst_ms)
                    burst["variant"] = variant
                    burst["ane_qos"] = name
                    receipt["bursts"].append(burst)
            calls = [
                json.loads(line.removeprefix("ANE_TRACE "))
                for line in (args.output / "worker.log").read_text().splitlines()
                if line.startswith("ANE_TRACE ")
            ]
            expected = {9} if args.control else {9, 21}
            original_expected = {9} if args.scope == "request" else expected
            if (not calls or {call["effective_qos"] for call in calls} != expected
                    or {call["qos"] for call in calls} != original_expected
                    or not all(call["success"] for call in calls)):
                raise ValueError("Runtime calls do not confirm the requested ANE QoS intervention.")
            if args.scope == "process-thread" and any(call["qos"] != call["effective_qos"] for call in calls):
                raise ValueError("Public scheduling test unexpectedly overrode an ANE request.")
            receipt["observed_original_ane_qos"] = sorted(original_expected)
            receipt["observed_effective_ane_qos"] = sorted(expected)
            receipt["ane_model_instances"] = len({call["model_instance"] for call in calls})
            receipt["logit_values"] = sorted({row["logit"] for row in receipt["bursts"]})
            receipt["paired_ratios"] = abba_ratios(receipt["bursts"])
            receipt["paired_ratio_geomean"] = math.exp(statistics.mean(
                math.log(ratio) for ratio in receipt["paired_ratios"]))
            receipt["median_burst_ms"] = {
                variant: statistics.median(row["latency_ms"] for row in receipt["bursts"]
                                           if row["variant"] == variant)
                for variant in ("baseline", "candidate")
            }
            receipt["peak_host_process_bytes"] = worker.peak
            receipt["power_source_end"] = power_source()
            receipt["status"] = ("completed" if receipt["power_source_begin"] == receipt["power_source_end"]
                                 else "environment_changed")
        finally:
            try:
                worker.close()
            finally:
                (args.output / "result.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({key: receipt[key] for key in (
        "status", "median_burst_ms", "paired_ratios", "paired_ratio_geomean")}, indent=2))


if __name__ == "__main__":
    main()
