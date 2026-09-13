"""Profile startup and warm CPU/ANE execution without requiring Instruments."""

import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import subprocess
import time

from benchmark import Worker, power_source


def main_thread_samples(text):
    header = re.search(
        r"^    (\d+) Thread_\d+[^\n]*(?:\bMain Thread\b|com\.apple\.main-thread)[^\n]*\n",
        text, re.MULTILINE)
    if header is None:
        headers = list(re.finditer(r"^    (\d+) Thread_\d+[^\n]*\n", text, re.MULTILINE))
        for index, candidate in enumerate(headers):
            end = headers[index + 1].start() if index + 1 < len(headers) else len(text)
            # Synchronous Core ML work can relabel the main thread with its
            # current dispatch queue. Its executable's main frame is unambiguous.
            if re.search(r"^[ +!:|]+\d+ main\s+\(in deckard-coreml\)",
                         text[candidate.end():end], re.MULTILINE):
                header = candidate
                break
    if header is None:
        raise ValueError("Sample has no recognized main-thread call tree.")
    tail = text[header.end():]
    boundary = re.search(r"^    \d+ Thread_|^Total number in stack|^Binary Images:", tail, re.MULTILINE)
    if boundary is None:
        raise ValueError("Sample has no recognized call-tree boundary.")
    nodes = []
    for line in tail[:boundary.start()].splitlines():
        match = re.match(r"^([ +!:|]+)(\d+) (.+)$", line)
        if match:
            nodes.append((len(match[1]), int(match[2]), match[3]))
    markers = {
        "ane_request_path": ("doEvaluateDirectWithModel:", "EvaluateANERequest("),
        "host_to_ane_copy": ("blob_container::__copy_from_host(",),
        "cpu_tile": ("tile_kernel_cpu::__launch(",),
        "cpu_inner_product": ("inner_product_kernel_cpu::__launch",),
        "model_loading": ("+[MLModel modelWithContentsOfURL:",),
    }
    counts = {}
    for name, alternatives in markers.items():
        count, ancestor_depth = 0, None
        for depth, samples, symbol in nodes:
            if ancestor_depth is not None and depth <= ancestor_depth:
                ancestor_depth = None
            if ancestor_depth is None and any(marker in symbol for marker in alternatives):
                count += samples
                ancestor_depth = depth
        counts[name] = count
    total = int(header[1])
    if total <= 0 or any(value > total for value in counts.values()):
        raise ValueError("Invalid or overlapping sample counts.")
    return {"main_thread_samples": total, "counts": counts,
            "fractions": {name: count / total for name, count in counts.items()},
            "interpretation": "Sampled wall-time call paths, not CPU utilization or hardware busy time; "
                              "categories can overlap and omit other work."}


def cpu_summary(burst):
    cpu = burst["process_cpu_seconds"]
    wall = burst["end"] - burst["begin"]
    requests = burst["requests"]
    if not all(math.isfinite(value) for value in (cpu, wall, requests)) or cpu < 0 or wall <= 0 or requests < 1:
        raise ValueError("Invalid process CPU or wall-time counters.")
    return {"process_cpu_ms_per_request": cpu * 1000 / requests,
            "wall_ms_per_request": wall * 1000 / requests,
            "process_cpu_seconds_per_wall_second": cpu / wall}


def memory(meter, pid):
    result = subprocess.run([str(meter), str(pid)], text=True, capture_output=True,
                            check=True, timeout=3)
    return json.loads(result.stdout)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--process-meter", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    binary = Path(__file__).resolve().parents[2] / "cache/coreml/bin/deckard-coreml"
    receipt = {"status": "incomplete", "bundle": str(args.bundle),
               "input_sha256": hashlib.sha256(args.input.read_bytes()).hexdigest(),
               "compute_units": "cpu_and_neural_engine",
               "scheduling": "native process and thread background during inference",
               "power_source_begin": power_source(),
               "limitations": ["Host CPU/memory counters exclude Core ML/ANE service processes.",
                               "ANE request-path samples cannot distinguish compute, DMA, and scheduling.",
                               "Startup samples may include warmup or idle time if loading finishes early.",
                               "Profiling runs are not controlled latency comparisons.",
                               "Fresh package compilation does not flush system specialization caches."]}
    with (args.output / "worker.log").open("x") as log, (args.output / "sampler.log").open("x") as sample_log:
        start = time.monotonic()
        worker = Worker(binary, args.bundle, args.input, log, args.process_meter)
        sampler = None

        def sample(name, seconds):
            return subprocess.Popen(
                ["/usr/bin/sample", str(worker.process.pid), str(seconds), "1",
                 "-file", str(args.output / f"{name}.txt")],
                stdout=sample_log, stderr=subprocess.STDOUT)

        try:
            receipt["pid"] = worker.process.pid
            sampler = sample("startup-stacks", 5)
            receipt["ready"] = worker.response(180)
            if receipt["ready"].get("ready") is not True:
                raise ValueError("Profiler worker did not become ready.")
            receipt["launch_to_ready_ms"] = (time.monotonic() - start) * 1000
            receipt["ready_memory"] = memory(args.process_meter, worker.process.pid)
            if sampler.wait(timeout=10) != 0:
                raise RuntimeError("Startup sampling failed; see sampler.log.")
            receipt["conditioning"] = worker.run(2000)
            receipt["uninstrumented_burst"] = worker.run(10000)
            receipt["cpu_summary"] = cpu_summary(receipt["uninstrumented_burst"])
            sampler = sample("warm-stacks", 3)
            receipt["sampled_burst"] = worker.run(5000)
            if sampler.wait(timeout=10) != 0:
                raise RuntimeError("Warm sampling failed; see sampler.log.")
            receipt["warm_memory"] = memory(args.process_meter, worker.process.pid)
            with (args.output / "vmmap.txt").open("x") as output:
                mapped = subprocess.run(["/usr/bin/vmmap", "-summary", str(worker.process.pid)],
                                        stdout=output, stderr=subprocess.STDOUT, timeout=20)
            receipt["vmmap_exit_code"] = mapped.returncode
            if mapped.returncode:
                receipt["vmmap_warning"] = "Memory-map inspection failed; see vmmap.txt."
            for phase in ("startup", "warm"):
                receipt[f"{phase}_samples"] = main_thread_samples(
                    (args.output / f"{phase}-stacks.txt").read_text())
            receipt["preparation_phases"] = [
                json.loads(line.removeprefix("PROFILE "))
                for line in (args.output / "worker.log").read_text().splitlines()
                if line.startswith("PROFILE ")]
            if not receipt["preparation_phases"]:
                raise ValueError("Runner lacks phase counters; rebuild it with coreml/build.sh.")
            receipt["power_source_end"] = power_source()
            receipt["status"] = ("completed" if receipt["power_source_begin"] == receipt["power_source_end"]
                                 else "environment_changed")
        finally:
            if sampler is not None and sampler.poll() is None:
                sampler.kill()
                sampler.wait()
            worker.close()
            (args.output / "profile.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({key: receipt[key] for key in (
        "status", "preparation_phases", "cpu_summary", "warm_memory", "warm_samples")}, indent=2))


if __name__ == "__main__":
    main()
