"""Run a validation process with a deadline and the existing native memory meter."""

import argparse
import json
import subprocess
import sys
import time


def footprint(meter, pid):
    result = subprocess.run([str(meter), str(pid)], capture_output=True, text=True, check=True, timeout=3)
    value = json.loads(result.stdout)
    return max(value["physical_footprint_bytes"], value["peak_physical_footprint_bytes"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--meter", required=True)
    parser.add_argument("--seconds", type=int, default=300)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command or args.seconds <= 0:
        parser.error("A command and positive deadline are required.")
    process = subprocess.Popen(command)
    started, peak = time.monotonic(), 0
    try:
        while process.poll() is None:
            if time.monotonic() - started > args.seconds:
                raise TimeoutError("Validation exceeded its deadline.")
            try:
                peak = max(peak, footprint(args.meter, process.pid))
            except subprocess.CalledProcessError:
                if process.poll() is None:
                    raise
            if peak > 6 * 1024**3:
                raise RuntimeError("Validation exceeded the 6 GiB process footprint limit.")
            time.sleep(0.25)
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        print(json.dumps({"peak_process_bytes": peak, "elapsed_seconds": time.monotonic() - started,
                          "exit_code": process.returncode}), file=sys.stderr)
    raise SystemExit(process.returncode)


if __name__ == "__main__":
    main()
