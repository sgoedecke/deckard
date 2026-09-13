"""Compare offline graph re-export with additional int8 convolution-weight compression."""

import argparse
import json
from pathlib import Path

import coremltools as ct

from gradient import MODEL, REVISION, PACKED_SHA256, LAYERS


def compress(source, destination, mode="int8"):
    manifest = json.loads((source / "manifest.json").read_text())
    required = {"format": "deckard-coreml-fused-v1", "model": MODEL, "revision": REVISION,
                "source_sha256": PACKED_SHA256, "layers": LAYERS}
    if any(manifest.get(key) != value for key, value in required.items()):
        raise ValueError("Expected a complete fused Gradient bundle.")
    if destination.exists():
        raise FileExistsError(destination)
    model = ct.models.MLModel(str(source / "model.mlpackage"), skip_model_load=True,
                              compute_units=ct.ComputeUnit.CPU_AND_NE)
    if mode == "reexport":
        if manifest.get("weight_compression"):
            raise ValueError("The graph-only control requires an uncompressed source.")
        compressed = ct.optimize.coreml.decompress_weights(model)
    elif mode == "int8":
        config = ct.optimize.coreml.OptimizationConfig(op_type_configs={
            "conv": ct.optimize.coreml.OpLinearQuantizerConfig(
                mode="linear", dtype="int8", granularity="per_block", block_size=64),
        })
        compressed = ct.optimize.coreml.linear_quantize_weights(model, config)
    else:
        raise ValueError("Unknown offline optimization mode.")
    spec = compressed.get_spec()
    count = sum(op.type == "constexpr_blockwise_shift_scale"
                for function in spec.mlProgram.functions.values()
                for block in function.block_specializations.values() for op in block.operations)
    if mode == "int8" and not count:
        raise ValueError("The optimizer did not compress any weights.")
    destination.mkdir(parents=True)
    compressed.save(str(destination / "model.mlpackage"))
    manifest.update({"postprocessed_from": source.name, "graph_reexport": "coremltools-default-pipeline"})
    if mode == "int8":
        manifest["weight_compression"] = {
            "dtype": "int8", "mode": "linear", "granularity": "per_block", "block_size": 64,
            "operation_types": ["conv"], "dequantize_operations": count,
            "requires_numerical_validation": True,
        }
    (destination / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--mode", choices=["int8", "reexport"], default="int8")
    args = parser.parse_args()
    compress(args.source, args.destination, args.mode)
