"""Collect a runtime stack trace; instrumented timings are not benchmark results."""

import argparse
import json
from pathlib import Path
import subprocess

from benchmark import Worker


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--process-meter", type=Path, required=True)
    parser.add_argument("--fast-prediction", action="store_true")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    binary = Path(__file__).resolve().parents[2] / "cache/coreml/bin/deckard-coreml"
    with (args.output / "worker.log").open("x") as log, (args.output / "sampler.log").open("x") as sample_log:
        worker = Worker(binary, args.bundle, args.input, log, args.process_meter, args.fast_prediction)
        sampler = None
        try:
            ready = worker.response(180)
            if ready.get("ready") is not True:
                raise ValueError("Trace worker did not report ready.")
            sampler = subprocess.Popen(
                ["/usr/bin/sample", str(worker.process.pid), "2", "1", "-file", str(args.output / "stacks.txt")],
                stdout=sample_log, stderr=subprocess.STDOUT)
            result = worker.run(5000)
            if sampler.wait(timeout=10) != 0:
                raise RuntimeError("Stack sampling failed; see sampler.log.")
            receipt = {"pid": worker.process.pid, "ready": ready, "sampled_run": result,
                       "timing_is_instrumented": True, "fast_prediction": args.fast_prediction}
            (args.output / "trace.json").write_text(json.dumps(receipt, indent=2) + "\n")
        finally:
            if sampler is not None and sampler.poll() is None:
                sampler.kill()
                sampler.wait()
            worker.close()


if __name__ == "__main__":
    main()
