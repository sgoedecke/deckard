"""Run warmed native backends against a separately authorized powermetrics capture."""

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import select
import subprocess
import time
from bounded import footprint


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--process-meter", type=Path, required=True)
    parser.add_argument("--prior-gpu-seconds", type=float, default=0)
    parser.add_argument("--gpu-burst-ms", type=int, default=4000)
    parser.add_argument("--prepare-seconds", type=int, default=600)
    args = parser.parse_args()
    if not math.isfinite(args.prior_gpu_seconds) or not 0 <= args.prior_gpu_seconds <= 18:
        parser.error("Prior GPU allowance must be finite and in 0..18 seconds.")
    if not 100 <= args.gpu_burst_ms <= 15000:
        parser.error("GPU burst length must be in 100..15000 milliseconds.")
    if not 1 <= args.prepare_seconds <= 900:
        parser.error("Preparation deadline must be in 1..900 seconds.")
    with args.checkpoint.open("rb") as stream:
        if hashlib.file_digest(stream, "sha256").hexdigest() != \
                "85a9e02ebdcbbe1dd84cdbf893b708e44ee4691cadc7e1a4780039e22097ac98":
            raise ValueError("Power baseline requires the canonical q4 checkpoint.")
    args.output.mkdir(parents=True, exist_ok=False)
    root = Path(__file__).resolve().parents[2]
    commands = {
        "coreml": [root / "cache/coreml/bin/deckard-coreml", args.bundle, args.input, "--power-worker"],
        "mlx": [root / "cache/coreml/bin/deckard-power-mlx", args.checkpoint, args.input,
                str(args.prior_gpu_seconds)],
    }
    workers, logs, peaks = {}, {}, {}
    last_meter = 0

    def monitor():
        nonlocal last_meter
        if time.monotonic() - last_meter < 1:
            return
        last_meter = time.monotonic()
        for name, process in workers.items():
            if process.poll() is not None:
                raise RuntimeError(f"{name} exited with {process.returncode}; see its stderr log.")
            peaks[name] = max(peaks.get(name, 0), footprint(args.process_meter, process.pid))
            if peaks[name] > 6 * 1024**3:
                raise RuntimeError(f"{name} exceeded the 6 GiB process footprint limit.")

    def response(name, timeout):
        process = workers[name]
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            monitor()
            if select.select([process.stdout], [], [], 0.1)[0]:
                line = process.stdout.readline()
                if not line:
                    raise RuntimeError(f"{name} closed its response stream.")
                return json.loads(line)
        raise TimeoutError(f"{name} exceeded {timeout}s response deadline.")

    def idle(seconds):
        begin, start = time.time(), time.monotonic()
        while time.monotonic() - start < seconds:
            monitor()
            time.sleep(0.1)
        return [begin, time.time()]

    fused = json.loads((args.bundle / "manifest.json").read_text())["format"] == "deckard-coreml-fused-v1"
    receipt = {"scheduling": "background", "input_sha256": hashlib.sha256(args.input.read_bytes()).hexdigest(),
               "ready": {}, "conditions": [], "gpu_inference_limit_seconds": 20,
               "prior_gpu_seconds_reserved": args.prior_gpu_seconds,
               "model_residency": "MLX and fused Core ML model resident; preparation excluded." if fused else
                                  "MLX resident; Core ML precompiled but loaded one layer at a time. "
                                  "Core ML per-layer loading is included; compilation and diagnostics excluded."}
    try:
        # Prepare sequentially, so cold-start work does not contend between backends.
        for name, command in commands.items():
            logs[name] = (args.output / f"{name}.stderr.log").open("x")
            temporary = (args.output / f"{name}-tmp").resolve()
            temporary.mkdir()
            workers[name] = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                            stderr=logs[name], text=True, bufsize=1,
                                            env={**os.environ, "TMPDIR": str(temporary)})
            receipt["ready"][name] = response(name, args.prepare_seconds)
            if receipt["ready"][name].get("ready") is not True:
                raise ValueError(f"{name} failed to report ready.")
            (args.output / "preparation.json").write_text(json.dumps(receipt, indent=2))
        scores = [1 / (1 + math.exp(-row["logit"])) for row in receipt["ready"].values()]
        if abs(scores[0] - scores[1]) > 0.002:
            raise ValueError("Backend scores differ before power measurement.")
        (args.output / "ready.json").write_text(json.dumps(receipt, indent=2))
        print("Both native workers warmed. Waiting for power.plist from the authorized meter.", flush=True)
        power = args.output / "power.plist"
        deadline = time.monotonic() + 600
        while not power.exists() or power.stat().st_size < 4096:
            if time.monotonic() > deadline:
                raise TimeoutError("Power capture was not started within ten minutes.")
            monitor()
            time.sleep(0.1)
        # Reverse order in the second round to expose thermal/order effects.
        for name in ("mlx", "coreml", "coreml", "mlx"):
            before = idle(5)
            workers[name].stdin.write(f"run {args.gpu_burst_ms}\n" if name == "mlx" else "run 10000\n")
            workers[name].stdin.flush()
            result = response(name, 60)
            if result.get("backend") != name or result.get("requests", 0) < 1:
                raise ValueError("Invalid measured inference response.")
            after = idle(5)
            result.update({"idle_before": before, "idle_after": after})
            receipt["conditions"].append(result)
            receipt["peak_process_footprint_bytes"] = peaks.copy()
            (args.output / "workload.json").write_text(json.dumps(receipt, indent=2))
            print(json.dumps(result), flush=True)
    finally:
        for process in workers.values():
            if process.poll() is None:
                try:
                    process.stdin.write("quit\n")
                    process.stdin.flush()
                except BrokenPipeError:
                    process.terminate()
        for process in workers.values():
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        for log in logs.values():
            log.close()
    if len(receipt["conditions"]) != 4 or any(p.returncode != 0 for p in workers.values()):
        raise RuntimeError("Power benchmark did not complete cleanly.")
    print("Measurement workloads finished; no further GPU inference will run.", flush=True)


if __name__ == "__main__":
    main()
