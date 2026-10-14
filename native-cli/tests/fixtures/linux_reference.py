# Generates linux-reference.json: reference logits for `deckard verify` on
# Linux, computed with PyTorch from the pinned fp32 Hugging Face checkpoint
# (model-assets-linux.json). Native Linux backends must reproduce them within
# verify's 0.002 score tolerance. Only needed again when the pin changes:
#
#   python3 linux_reference.py --checkpoint DIR [--output FILE]
#
# DIR holds the pinned config.json and model.safetensors; the script refuses
# any other checkpoint. Needs torch and transformers; their versions are
# recorded in the output.

import argparse
import hashlib
import json
import math
from pathlib import Path

MANIFEST = Path(__file__).resolve().parents[2] / "model-assets-linux.json"
LENGTHS = (32, 128, 512)
STEPS = (11, 97)


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def require_pinned(checkpoint, manifest):
    for name in ("config.json", "model.safetensors"):
        if sha256(checkpoint / name) != manifest["files"][name]:
            raise SystemExit(f"{checkpoint / name} does not match its pin in {MANIFEST.name}")


def feed(length, step, padded):
    # Wrapped CLS..SEP inputs, unpadded, as the Linux host sends them. The
    # padded variant masks one interior token instead of appending padding
    # after SEP, which the Linux backends reject.
    interior = [3 + index * step for index in range(length - 2)]
    if padded:
        interior[(length - 2) // 2] = 0
    ids = [1] + interior + [2]
    return ids, [int(value != 0) for value in ids]


def generate(checkpoint):
    import torch
    import transformers
    from transformers import AutoModelForSequenceClassification

    torch.set_num_threads(2)
    model = AutoModelForSequenceClassification.from_pretrained(checkpoint, dtype=torch.float32)
    model.eval()
    cases = []
    with torch.inference_mode():
        for length in LENGTHS:
            for step in STEPS:
                for padded in (False, True):
                    ids, mask = feed(length, step, padded)
                    logit = float(model(input_ids=torch.tensor([ids]), attention_mask=torch.tensor([mask])).logits[0, 0])
                    name = f"length{length}-values{step}-batch1" + ("-padded" if padded else "")
                    print(f"  {name}: logit={logit:.6f}")
                    cases.append({"name": name, "logit": logit, "score": 1 / (1 + math.exp(-logit)),
                                  "feed": {"input_ids": [ids], "attention_mask": [mask]}})
    return {"torch": torch.__version__, "transformers": transformers.__version__}, cases


def write(output, source, cases):
    # One case per line keeps the file small and its diffs readable.
    lines = ",\n".join("    " + json.dumps(case) for case in cases)
    output.write_text('{\n  "source": ' + json.dumps(source) + ',\n  "cases": [\n' + lines + "\n  ]\n}\n")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=Path(__file__).with_name("linux-reference.json"))
    args = parser.parse_args()
    manifest = json.loads(MANIFEST.read_text())
    require_pinned(args.checkpoint, manifest)
    print(f"Generating reference logits from {args.checkpoint}")
    versions, cases = generate(args.checkpoint)
    source = {"model": manifest["model"], "revision": manifest["revision"],
              "source_weights_sha256": manifest["source_weights_sha256"], **versions}
    write(args.output, source, cases)
    print(f"Wrote {args.output}")


if __name__ == "__main__":
    main()
