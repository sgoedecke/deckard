"""Correlate exported ANE intervals with the profiled worker's request markers."""

import argparse
from collections import Counter
import json
from pathlib import Path
import statistics
import xml.etree.ElementTree as ET


def table_rows(path):
    root = ET.parse(path).getroot()
    identifiers = {element.get("id"): element for element in root.iter()
                   if element.get("id") is not None}
    nodes = root.findall("node")
    if len(nodes) != 1:
        raise ValueError("Export exactly one Instruments table per XML file.")
    columns = [col.findtext("mnemonic") for col in nodes[0].find("schema").findall("col")]
    rows = []
    for row in nodes[0].findall("row"):
        if len(row) != len(columns):
            raise ValueError("Trace row does not match its schema.")
        rows.append({name: identifiers[cell.get("ref")] if "ref" in cell.attrib else cell
                     for name, cell in zip(columns, row)})
    return rows


def request_spans(rows, pid):
    pending, spans, foreign = {}, [], 0
    for row in rows:
        if (row["class"].text, row["subclass"].text) != ("43", "36"):
            continue
        code = row["code"].text
        if code not in ("50", "51"):
            continue
        thread = row["thread"].get("fmt", "")
        if not thread.endswith(f", pid: {pid})"):
            foreign += code == "50"
            continue
        key = (thread, row["arg2"].text)
        timestamp = int(row["time"].text)
        if code == "50":
            if key in pending:
                raise ValueError("Overlapping request markers with the same identity.")
            pending[key] = timestamp
        else:
            if key not in pending:
                raise ValueError("Request end without a matching start.")
            start = pending.pop(key)
            if timestamp <= start:
                raise ValueError("Non-positive request duration.")
            spans.append((start, timestamp))
    if pending or not spans:
        raise ValueError("Incomplete or missing target-process request markers.")
    return sorted(spans), foreign


def correlate(intervals, spans):
    matched = []
    for start, end in spans:
        contained = [(a, b) for a, b in intervals if start <= a and b <= end]
        if len(contained) != 1:
            raise ValueError("Each target request must enclose exactly one ANE interval.")
        a, b = contained[0]
        matched.append({"start_ns": a, "end_ns": b, "duration_ns": b - a,
                        "marker_lead_ns": a - start, "marker_tail_ns": end - b})
    if len({(row["start_ns"], row["end_ns"]) for row in matched}) != len(matched):
        raise ValueError("An ANE interval matched multiple requests.")
    if any(left["end_ns"] > right["start_ns"] for left, right in zip(matched, matched[1:])):
        raise ValueError("Target ANE intervals overlap.")
    return matched


def prediction_intervals(rows):
    intervals, other_activity = [], Counter()
    for row in rows:
        label = row["event-label"].get("fmt")
        if label != "Neural Engine Prediction":
            other_activity[label or "unlabelled"] += 1
            continue
        start, duration = int(row["start"].text), int(row["duration"].text)
        if duration <= 0:
            raise ValueError("Non-positive ANE interval.")
        intervals.append((start, start + duration))
    return intervals, dict(other_activity)


def report(directory):
    profile = json.loads((directory / "profile.json").read_text())
    if profile["status"] != "completed" or profile.get("include_startup", False):
        raise ValueError("Timing summaries require a completed warm-only capture with stable power source.")
    spans, foreign = request_spans(table_rows(directory / "hardware-events.xml"), profile["pid"])
    if foreign:
        raise ValueError("Other processes submitted ANE requests; attribution needs further inspection.")
    intervals, other_activity = prediction_intervals(table_rows(directory / "ane.xml"))
    matched = correlate(intervals, spans)
    if len(matched) != len(intervals):
        raise ValueError("Unattributed ANE intervals remain in the warm capture.")
    burst = profile["instrumented_burst"]
    count = burst["requests"]
    if len(matched) % count:
        raise ValueError("ANE request count does not divide evenly into classifications.")
    per_classification = len(matched) // count
    total_ns = sum(row["duration_ns"] for row in matched)
    wall = burst["end"] - burst["begin"]
    if total_ns > wall * 1e9:
        raise ValueError("Hardware intervals exceed the recorded workload duration.")
    result = {
        "status": "completed", "source": str(directory), "classifications": count,
        "other_ane_activity_events_not_attributed": other_activity,
        "ane_intervals": len(matched), "ane_intervals_per_classification": per_classification,
        "wall_ms_per_classification": wall * 1000 / count,
        "ane_interval_ms_per_classification": total_ns / 1e6 / count,
        "outside_ane_interval_ms_per_classification": (wall * 1e9 - total_ns) / 1e6 / count,
        "ane_interval_fraction_of_burst": total_ns / (wall * 1e9),
        "host_cpu_ms_per_classification": burst["process_cpu_seconds"] * 1000 / count,
        "mean_marker_lead_ms_per_ane_request": statistics.mean(
            row["marker_lead_ns"] for row in matched) / 1e6,
        "mean_marker_tail_ms_per_ane_request": statistics.mean(
            row["marker_tail_ns"] for row in matched) / 1e6,
        "mean_ms_by_interval_position": [
            statistics.mean(row["duration_ns"] for row in matched[position::per_classification]) / 1e6
            for position in range(per_classification)
        ],
        "interpretation": [
            "ANE activity intervals are not compute-cycle, DMA-byte, or bandwidth counters.",
            "Target attribution uses enclosing class 0x2b/subclass 0x24 code 0x32/0x33 markers.",
            "Marker lead/tail are observed boundaries, not documented queue-time counters.",
            "Interval positions describe repeated request order, not identified model layers.",
            "Host CPU overlaps wall time and must not be added to interval duration.",
            "Separate profiling captures are not controlled backend speed comparisons.",
        ],
        "intervals": matched,
    }
    (directory / "analysis.json").write_text(json.dumps(result, indent=2) + "\n")
    return {key: value for key, value in result.items() if key != "intervals"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directories", nargs="+", type=Path)
    args = parser.parse_args()
    for directory in args.directories:
        print(json.dumps(report(directory), indent=2))


if __name__ == "__main__":
    main()
