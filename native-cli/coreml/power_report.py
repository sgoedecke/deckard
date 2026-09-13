"""Integrate measured CPU/GPU/ANE rails using adjacent idle subtraction."""

import argparse
from datetime import timezone
import json
import math
import plistlib
from pathlib import Path

RAILS = ("cpu", "gpu", "ane")


def samples(path):
    rows = [plistlib.loads(part) for part in path.read_bytes().split(b"\0") if part.strip()]
    if len(rows) < 20:
        raise ValueError("Too few power samples.")
    cumulative, lower, upper = 0.0, float("-inf"), float("inf")
    for row in rows:
        cumulative += row["elapsed_ns"] / 1e9
        # plist dates lose subseconds. Intersect every timestamp's one-second
        # interval against the precise cumulative sample durations.
        stamp = row["timestamp"].replace(tzinfo=timezone.utc).timestamp()
        lower = max(lower, stamp - cumulative)
        upper = min(upper, stamp + 1 - cumulative)
    if lower > upper or upper - lower > 0.2:
        raise ValueError("Cannot align power samples to workload time within 200 ms.")
    start, result = (lower + upper) / 2, []
    for row in rows:
        end = start + row["elapsed_ns"] / 1e9
        power = {rail: row["processor"][f"{rail}_power"] / 1000 for rail in RAILS}
        if any(not math.isfinite(value) or value < 0 for value in power.values()):
            raise ValueError("Invalid power sample.")
        result.append({"begin": start, "end": end, "watts": power, "thermal": row["thermal_pressure"]})
        start = end
    return result, upper - lower


def integrate(rows, interval):
    begin, end = interval
    if begin >= end or begin < rows[0]["begin"] or end > rows[-1]["end"]:
        raise ValueError("Power capture does not fully cover an interval.")
    energy = {rail: 0.0 for rail in RAILS}
    for row in rows:
        overlap = max(0.0, min(end, row["end"]) - max(begin, row["begin"]))
        for rail in RAILS:
            energy[rail] += row["watts"][rail] * overlap
    return energy


def report(workload, rows, uncertainty):
    output = {"measurement": "Estimated CPU+GPU+ANE rail energy, not whole-laptop battery energy",
              "attribution": "Machine-wide rails include unrelated processes; idle subtraction is not process attribution.",
              "time_alignment_interval_seconds": uncertainty, "sample_count": len(rows),
              "thermal_states": sorted({row["thermal"] for row in rows}), "conditions": []}
    if len(workload["conditions"]) != 4:
        raise ValueError("Expected both reversed-order rounds.")
    for condition in workload["conditions"]:
        begin, end = condition["begin"], condition["end"]
        duration = end - begin
        active = integrate(rows, [begin, end])
        idle = []
        for interval in (condition["idle_before"], condition["idle_after"]):
            energy = integrate(rows, interval)
            idle.append({rail: energy[rail] / (interval[1] - interval[0]) for rail in RAILS})
        idle_watts = {rail: (idle[0][rail] + idle[1][rail]) / 2 for rail in RAILS}
        incremental = {rail: active[rail] - idle_watts[rail] * duration for rail in RAILS}
        count = condition["requests"]
        warnings = []
        idle_drift = abs(sum(idle[0].values()) - sum(idle[1].values()))
        incremental_watts = sum(incremental.values()) / duration
        if idle_drift > max(0.2, abs(incremental_watts) * 0.25):
            warnings.append("Adjacent idle power drift is large relative to the estimated workload power.")
        if condition["backend"] == "coreml" and active["gpu"] / duration - idle_watts["gpu"] > 0.1:
            warnings.append("GPU power increased despite the CPU/ANE-only configuration; attribution is confounded.")
        if incremental_watts <= 0:
            warnings.append("Nonpositive total incremental energy; background variation dominates.")
        output["conditions"].append({
            "backend": condition["backend"], "requests": count, "duration_seconds": duration,
            "latency_ms": duration * 1000 / count,
            "active_watts": {rail: active[rail] / duration for rail in RAILS},
            "idle_watts": idle_watts, "idle_before_watts": idle[0], "idle_after_watts": idle[1],
            "incremental_joules_per_request": {rail: incremental[rail] / count for rail in RAILS},
            "total_incremental_joules_per_request": sum(incremental.values()) / count,
            "quality_warnings": warnings,
        })
    output["comparison_quality"] = "confounded" if any(
        row["quality_warnings"] for row in output["conditions"]
    ) else "no_automatic_quality_warning"
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    rows, uncertainty = samples(args.directory / "power.plist")
    value = report(json.loads((args.directory / "workload.json").read_text()), rows, uncertainty)
    with (args.directory / "report.json").open("x") as stream:
        json.dump(value, stream, indent=2, allow_nan=False)
        stream.write("\n")
    print(json.dumps(value, indent=2))
