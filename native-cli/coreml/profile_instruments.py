"""Record a bounded, resident CPU/ANE workload with Instruments."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import select
import signal
import subprocess
import time

from benchmark import Worker, power_source
from profile_runtime import cpu_summary
from report_instruments import table_rows


TABLE_QUERIES = {
    "ane": '@schema="ane-hw-intervals-internal"',
    "coreml": '@schema="coreml-os-signpost"',
    "hardware-events": (
        '@schema="kdebug" and contains(@codes,"0x06,0x1b") '
        'and not(contains(@codes,"0x85")) and not(contains(@codes,"0x2b,0x23"))'),
}


def trace_environment(developer_dir, source=None):
    source = os.environ if source is None else source
    # Instruments saves the target environment, so never inherit credentials.
    environment = {key: source[key] for key in
                   ("HOME", "TMPDIR", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE")
                   if key in source}
    return dict(environment, PATH="/usr/bin:/bin:/usr/sbin:/sbin",
                DEVELOPER_DIR=str(developer_dir))


def wait_for_recording(process, timeout=60):
    deadline = time.monotonic() + timeout
    output = bytearray()
    while time.monotonic() < deadline:
        if select.select([process.stdout], [], [], 0.1)[0]:
            chunk = os.read(process.stdout.fileno(), 4096)
            if not chunk:
                raise RuntimeError(f"Instruments exited before recording: {output.decode()}")
            output.extend(chunk)
            if b"Ctrl-C to stop the recording" in output:
                return bytes(output)
        if process.poll() is not None:
            raise RuntimeError(f"Instruments exited before recording: {output.decode()}")
    raise TimeoutError(f"Instruments did not start recording: {output.decode()}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--process-meter", type=Path, required=True)
    parser.add_argument("--developer-dir", type=Path, required=True)
    parser.add_argument("--instrument", action="append", default=[])
    parser.add_argument("--include-startup", action="store_true",
                        help="Attach before model loading to capture Core ML initialization.")
    args = parser.parse_args()
    xctrace = args.developer_dir / "usr/bin/xctrace"
    if not xctrace.is_file():
        parser.error("The developer directory must contain usr/bin/xctrace.")
    args.output.mkdir(parents=True, exist_ok=False)
    binary = Path(__file__).resolve().parents[2] / "cache/coreml/bin/deckard-coreml"
    env = trace_environment(args.developer_dir)
    trace = args.output / "warm.trace"
    receipt = {
        "status": "incomplete", "bundle": str(args.bundle),
        "input_sha256": hashlib.sha256(args.input.read_bytes()).hexdigest(),
        "compute_units": "cpu_and_neural_engine",
        "scheduling": "native process and thread background during inference",
        "power_source_begin": power_source(),
        "template": "Core ML", "additional_instruments": args.instrument,
        "include_startup": args.include_startup,
        "limitations": [
            "Profiling runs are not controlled latency comparisons.",
            "Host process CPU and footprint exclude ANE/Core ML service allocations.",
            "Startup is included only when include_startup is true.",
        ],
    }
    with (args.output / "worker.log").open("x") as log:
        worker = Worker(binary, args.bundle, args.input, log, args.process_meter, env=env,
                        wait_for_profiler=args.include_startup)
        tracer = None
        trace_output = b""
        try:
            receipt["pid"] = worker.process.pid
            if args.include_startup:
                if worker.response(10) != {"profiler_waiting": True}:
                    raise ValueError("Worker did not wait for profiler attachment.")
            else:
                receipt["ready"] = worker.response(180)
                if receipt["ready"].get("ready") is not True:
                    raise ValueError("Profiler worker did not become ready.")
                receipt["conditioning"] = worker.run(2000)
                receipt["uninstrumented_burst"] = worker.run(4000)
            command = [
                str(xctrace), "record", "--template", "Core ML",
                "--time-limit", "180s" if args.include_startup else "20s",
                "--output", str(trace),
                "--attach", str(worker.process.pid),
            ]
            for instrument in args.instrument:
                command.extend(["--instrument", instrument])
            tracer = subprocess.Popen(command, stdout=subprocess.PIPE,
                                      stderr=subprocess.STDOUT, env=env)
            trace_output = wait_for_recording(tracer)
            if args.include_startup:
                worker.process.stdin.write("prepare\n")
                worker.process.stdin.flush()
                receipt["ready"] = worker.response(180)
                if receipt["ready"].get("ready") is not True:
                    raise ValueError("Profiler worker did not become ready.")
                receipt["conditioning"] = worker.run(2000)
            receipt["instrumented_burst"] = worker.run(8000)
            if tracer.poll() is not None:
                raise RuntimeError("Instruments stopped before the workload finished.")
            if args.include_startup:
                tracer.send_signal(signal.SIGINT)
            remaining, _ = tracer.communicate(timeout=60)
            trace_output += remaining
            if tracer.returncode:
                raise RuntimeError(f"Instruments recording failed: {trace_output.decode()}")
            subprocess.run(
                [str(xctrace), "export", "--input", str(trace), "--toc",
                 "--output", str(args.output / "toc.xml")],
                env=env, check=True, timeout=60)
            for name, query in TABLE_QUERIES.items():
                subprocess.run(
                    [str(xctrace), "export", "--input", str(trace),
                     "--xpath", f'/trace-toc/run[@number="1"]/data/table[{query}]',
                     "--output", str(args.output / f"{name}.xml")],
                    env=env, check=True, timeout=60)
            receipt["coreml_event_count"] = len(table_rows(args.output / "coreml.xml"))
            if receipt["coreml_event_count"] == 0:
                receipt["warnings"] = [
                    "Core ML signposts are absent; the trace cannot identify individual model operations."
                ]
            receipt["cpu_summary"] = {
                phase: cpu_summary(receipt[f"{phase}_burst"])
                for phase in ("uninstrumented", "instrumented") if f"{phase}_burst" in receipt
            }
            receipt["peak_host_process_bytes"] = worker.peak
            receipt["power_source_end"] = power_source()
            receipt["status"] = (
                "completed" if receipt["power_source_begin"] == receipt["power_source_end"]
                else "environment_changed")
        finally:
            try:
                if tracer is not None and tracer.poll() is None:
                    tracer.terminate()
                    try:
                        remaining, _ = tracer.communicate(timeout=15)
                    except subprocess.TimeoutExpired:
                        tracer.kill()
                        remaining, _ = tracer.communicate()
                    trace_output += remaining
                worker.close()
            finally:
                (args.output / "xctrace.log").write_bytes(trace_output)
                (args.output / "profile.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    main()
