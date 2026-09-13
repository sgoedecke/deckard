"""Export fixed-shape Core ML stages in separate bounded-memory CPU processes."""

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

from gradient import (
    MODEL, REVISION, PACKED_SHA256, LAYERS, Weights, inputs, make_stage,
    stage_names, verify_checkpoint,
)


def export_stage(checkpoint, output, name, length, precision="mixed", gather_mode="elementwise",
                 ffn_splits=1, split_axis="input", head_chunk=16, attention_layout="matrix",
                 query_chunk=None, pack_qkv=False, spatial_width=None, channel_norm=False):
    import coremltools as ct
    import numpy as np
    import torch

    torch.set_num_threads(2)
    model = make_stage(Weights(checkpoint), name, length, gather_mode, ffn_splits, split_axis,
                       head_chunk, attention_layout, query_chunk, pack_qkv, spatial_width, channel_norm)
    feed = inputs(name, length)
    with torch.inference_mode():
        traced = torch.jit.trace(model, tuple(feed.values()), check_trace=False)
    output_name = "hidden" if name == "embedding" else "logit" if name == "head" else "hidden_out"
    preserve_fp32 = {"mixed": {"layer_norm", "softmax"}, "fp16-softmax": {"layer_norm"},
                     "fp16-norm": {"softmax"}, "fp16": set()}[precision]
    converted = ct.convert(
        traced, convert_to="mlprogram", minimum_deployment_target=ct.target.macOS15,
        inputs=[ct.TensorType(name=key, shape=value.shape,
                              dtype=np.int32 if key == "input_ids" else np.float32)
                for key, value in feed.items()],
        outputs=[ct.TensorType(name=output_name, dtype=np.float32)],
        compute_precision=ct.transform.FP16ComputePrecision(
            op_selector=lambda op: op.op_type not in preserve_fp32),
        compute_units=ct.ComputeUnit.CPU_AND_NE,
        skip_model_load=True,
    )
    converted.author = "Deckard experimental Core ML conversion"
    converted.short_description = f"Pinned Gradient q4 dequantized; {name}; CPU/ANE experiment"
    converted.save(str(output / f"{name}.mlpackage"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--length", type=int, choices=[32, 64, 128, 256, 512], default=128)
    parser.add_argument("--stage", choices=stage_names(), help="Export just one stage for diagnostics.")
    parser.add_argument("--precision", choices=["mixed", "fp16-softmax", "fp16-norm", "fp16"], default="mixed",
                        help="Experimental arithmetic mode; every full bundle requires numerical validation.")
    parser.add_argument("--gather", choices=["elementwise", "rowwise", "skew"], default="elementwise")
    parser.add_argument("--process-meter", type=Path, help="Enforce the 6 GiB process cap on each export worker.")
    parser.add_argument("--ffn-splits", type=int, choices=[1, 2, 4, 8, 16], default=1)
    parser.add_argument("--split-axis", choices=["input", "output"], default="input")
    parser.add_argument("--head-chunk", type=int, choices=[1, 2, 4, 8, 16], default=16)
    parser.add_argument("--attention-layout", choices=["matrix", "channels"], default="matrix")
    parser.add_argument("--query-chunk", type=int, choices=[32, 64, 128, 256, 512])
    parser.add_argument("--pack-qkv", action="store_true")
    parser.add_argument("--spatial-width", type=int, choices=[16, 32, 64, 128, 256, 512])
    parser.add_argument("--channel-norm", action="store_true")
    args = parser.parse_args()
    if args.stage and args.process_meter:
        parser.error("Use bounded.py around a single --stage; --process-meter wraps full-bundle workers.")
    if args.channel_norm and args.precision != "fp16":
        parser.error("The channel-normalization ablation currently requires --precision fp16.")
    if args.spatial_width is not None and args.length % args.spatial_width:
        parser.error("Convolution spatial width must divide the sequence length.")
    if args.query_chunk is not None and (not args.stage or args.stage.startswith("layer-")):
        if (args.length % args.query_chunk or
                (args.query_chunk != args.length and
                 (args.gather != "skew" or args.attention_layout != "matrix" or args.head_chunk != 16))):
            parser.error("Query chunks must divide the length and use skew/matrix attention with all 16 heads.")
    verify_checkpoint(args.checkpoint)
    if args.gather != "elementwise" and args.stage and not args.stage.startswith("layer-"):
        parser.error("A gather layout applies only to transformer layers.")
    if args.stage:
        destination = args.output / f"{args.stage}.mlpackage"
        if destination.exists():
            raise FileExistsError(destination)
        args.output.mkdir(parents=True, exist_ok=True)
        export_stage(args.checkpoint, args.output, args.stage, args.length, args.precision, args.gather,
                     args.ffn_splits, args.split_axis, args.head_chunk, args.attention_layout,
                     args.query_chunk, args.pack_qkv, args.spatial_width, args.channel_norm)
        return
    args.output.mkdir(parents=True, exist_ok=False)
    env = dict(os.environ, OMP_NUM_THREADS="2", OPENBLAS_NUM_THREADS="2", VECLIB_MAXIMUM_THREADS="2")
    for name in stage_names():
        command = [sys.executable, __file__, "--checkpoint", str(args.checkpoint),
                   "--output", str(args.output), "--length", str(args.length), "--stage", name,
                   "--precision", args.precision,
                   "--gather", args.gather if name.startswith("layer-") else "elementwise",
                   "--ffn-splits", str(args.ffn_splits), "--split-axis", args.split_axis,
                   "--head-chunk", str(args.head_chunk), "--attention-layout", args.attention_layout]
        if args.query_chunk is not None:
            command.extend(["--query-chunk", str(args.query_chunk)])
        if args.pack_qkv:
            command.append("--pack-qkv")
        if args.spatial_width is not None:
            command.extend(["--spatial-width", str(args.spatial_width)])
        if args.channel_norm:
            command.append("--channel-norm")
        if args.process_meter:
            command = [sys.executable, str(Path(__file__).with_name("bounded.py")),
                       "--meter", str(args.process_meter), "--seconds", "300", "--", *command]
        subprocess.run(
            command, env=env, check=True, timeout=315 if args.process_meter else 300,
        )
    precision = {
        "mixed": "dequantized-q4-fp16-with-fp32-norm-softmax",
        "fp16-softmax": "dequantized-q4-fp16-with-fp32-norm",
        "fp16-norm": "dequantized-q4-fp16-with-fp32-softmax",
        "fp16": "dequantized-q4-fp16",
    }
    manifest = {
        "format": "deckard-coreml-split-v1", "model": MODEL, "revision": REVISION,
        "source_sha256": PACKED_SHA256, "sequence_length": args.length, "layers": LAYERS,
        "precision": precision[args.precision],
        "precision_mode": args.precision,
        "gather": args.gather,
        "ffn_splits": args.ffn_splits, "split_axis": args.split_axis, "head_chunk": args.head_chunk,
        "ffn_reduction": "streamed" if args.ffn_splits > 1 and args.split_axis == "input" else "none",
        "attention_layout": args.attention_layout,
        "query_chunk": args.query_chunk,
        "pack_qkv": args.pack_qkv,
        "spatial_width": args.spatial_width,
        "channel_norm": args.channel_norm,
        "experimental": True,
    }
    with (args.output / "manifest.json").open("x") as stream:
        json.dump(manifest, stream, indent=2)
        stream.write("\n")


if __name__ == "__main__":
    main()
