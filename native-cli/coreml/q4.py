"""Losslessly encode the pinned MLX q4 values as Core ML group64 four-bit palettes."""

import argparse
from collections import Counter
import copy
import gc
import hashlib
import json
from pathlib import Path
import tempfile

import coremltools as ct
from coremltools.libmilstoragepython import _BlobStorageReader, _BlobStorageWriter
from coremltools.proto import MIL_pb2
import numpy as np
from safetensors import safe_open

from fuse import STORAGE_TYPES
from gradient import MODEL, REVISION, PACKED_SHA256, LAYERS, unpack, verify_checkpoint


def fingerprint(values):
    return hashlib.sha256(memoryview(np.ascontiguousarray(values))).hexdigest()


def encode(weight, scales, biases):
    expected = unpack(weight, scales, biases).astype(np.float16)
    indices = ((weight[..., None] >> (np.arange(8, dtype=np.uint32) * 4)) & 15)
    indices = indices.astype(np.uint8).reshape(expected.shape)
    # Preserve the original affine grid's FP32 arithmetic and FP16 rounding,
    # including half-way cases that a newly fitted integer zero point can change.
    lut = (np.arange(16, dtype=np.float32) * scales.astype(np.float32)[..., None]
           + biases.astype(np.float32)[..., None]).astype(np.float16)
    if not np.isfinite(lut).all():
        raise ValueError("Nonfinite q4 palette.")
    reconstructed = decode(indices, lut)
    if not np.array_equal(reconstructed.view(np.uint16), expected.view(np.uint16)):
        raise ValueError("Four-bit palette changed the decoded checkpoint.")
    return indices, lut


def decode(indices, lut):
    rows, columns = indices.shape[:2]
    groups = indices.reshape(rows, columns // 64, 64)
    return np.take_along_axis(lut.reshape(rows, columns // 64, 16), groups, axis=-1).reshape(
        indices.shape)


def blob_constant(name, shape, dtype, offset):
    operation = MIL_pb2.Operation(type="const")
    operation.attributes["name"].type.tensorType.dataType = MIL_pb2.STRING
    operation.attributes["name"].immediateValue.tensor.strings.values.append(name)
    value = operation.attributes["val"]
    value.type.tensorType.dataType = dtype
    value.type.tensorType.rank = len(shape)
    for dimension in shape:
        value.type.tensorType.dimensions.add().constant.size = dimension
    value.blobFileValue.fileName = "@model_path/weights/weight.bin"
    value.blobFileValue.offset = offset
    operation.outputs.add(name=name).type.CopyFrom(value.type)
    return operation


def replace_weight(original, shape, indices_offset, lut_offset):
    name = original.outputs[0].name
    indices = blob_constant(name + "_q4_indices", shape, MIL_pb2.UINT4, indices_offset)
    lut_shape = (shape[0], shape[1] // 64, *shape[2:], 16, 1)
    lut = blob_constant(name + "_q4_lut", lut_shape, MIL_pb2.FLOAT16, lut_offset)
    operation = copy.deepcopy(original)
    operation.type = "constexpr_lut_to_dense"
    del operation.attributes["val"]
    operation.inputs["indices"].arguments.add(name=indices.outputs[0].name)
    operation.inputs["lut"].arguments.add(name=lut.outputs[0].name)
    return indices, lut, operation


def audit_saved(package, records):
    spec = ct.utils.load_spec(str(package))
    block = spec.mlProgram.functions["main"].block_specializations["CoreML8"]
    constants = {op.outputs[0].name: op.attributes["val"]
                 for op in block.operations if op.type == "const"}
    reader = _BlobStorageReader(str(package / "Data/com.apple.CoreML/weights/weight.bin"))

    def tensor(operation, name, dtype, kind):
        arguments = operation.inputs[name].arguments
        if len(arguments) != 1:
            raise ValueError("Unexpected palette input arity.")
        argument = arguments[0]
        value = constants[argument.name] if argument.HasField("name") else argument.value
        if (value.type.tensorType.dataType != dtype or not value.HasField("blobFileValue")
                or value.blobFileValue.fileName != "@model_path/weights/weight.bin"):
            raise ValueError("Unexpected serialized palette input.")
        data = getattr(reader, f"read_{kind}_data")(value.blobFileValue.offset)
        if dtype == MIL_pb2.FLOAT16:
            data = data.view(np.float16)
        return data.reshape(tuple(d.constant.size for d in value.type.tensorType.dimensions))

    actual = Counter()
    for op in block.operations:
        if op.type == "constexpr_lut_to_dense":
            indices = tensor(op, "indices", MIL_pb2.UINT4, "uint4")
            lut = tensor(op, "lut", MIL_pb2.FLOAT16, "fp16")
            expected_shape = (indices.shape[0], indices.shape[1] // 64, *indices.shape[2:], 16, 1)
            if lut.shape != expected_shape:
                raise ValueError("Serialized palette grouping changed.")
            actual[fingerprint(decode(indices, lut))] += 1
        elif op.type.startswith("constexpr_"):
            raise ValueError("Unexpected additional weight compression.")
    if actual != Counter(record["dense_sha256"] for record in records):
        raise ValueError("Saved package no longer reproduces all original weight bit patterns.")


def compress(source, destination, checkpoint, scope="all", reexport=False):
    manifest = json.loads((source / "manifest.json").read_text())
    required = {"model": MODEL, "revision": REVISION,
                "source_sha256": PACKED_SHA256, "precision_mode": "fp16"}
    if any(manifest.get(key) != value for key, value in required.items()):
        raise ValueError("Expected an uncompressed FP16 Gradient bundle.")
    diagnostic = manifest.get("format") == "deckard-coreml-layer-stack-v1"
    if diagnostic:
        start, count = manifest.get("layer_start", -1), manifest.get("layers", 0)
        if not manifest.get("diagnostic") or not 0 <= start < start + count <= LAYERS:
            raise ValueError("Invalid diagnostic layer range.")
    elif manifest.get("format") != "deckard-coreml-fused-v1" or manifest.get("layers") != LAYERS:
        raise ValueError("Expected a complete classifier or explicit diagnostic layer stack.")
    if scope not in ("all", "convolutions"):
        raise ValueError("Unknown compression scope.")
    if manifest.get("weight_compression"):
        raise ValueError("Cannot faithfully repack already compressed weights.")
    if destination.exists():
        raise FileExistsError(destination)
    verify_checkpoint(checkpoint)
    spec = ct.utils.load_spec(str(source / "model.mlpackage"))
    if (set(spec.mlProgram.functions) != {"main"}
            or set(spec.mlProgram.functions["main"].block_specializations) != {"CoreML8"}):
        raise ValueError("Expected the macOS 15 straight-line Gradient graph.")
    block = spec.mlProgram.functions["main"].block_specializations["CoreML8"]
    if any(op.blocks or op.type.startswith("constexpr_") for op in block.operations):
        raise ValueError("Expected an uncompressed straight-line graph.")
    names = {output.name for op in block.operations for output in op.outputs}
    if any(name + suffix in names for name in names for suffix in ("_q4_indices", "_q4_lut")):
        raise ValueError("Compressed weight names would collide with existing values.")

    with safe_open(str(checkpoint), framework="numpy") as packed:
        matrix_names = {key[:-7] for key in packed.keys() if key.endswith(".scales")}
        expected_names = matrix_names - {"relative_embeddings"}
        if scope == "convolutions":
            expected_names.discard("embeddings.word")
        if diagnostic:
            expected_names = {name for name in expected_names
                              if name.startswith(tuple(f"layers.{i}." for i in range(start, start + count)))}
        index = {}
        for name in sorted(expected_names):
            dense = unpack(packed.get_tensor(name + ".weight"), packed.get_tensor(name + ".scales"),
                           packed.get_tensor(name + ".biases")).astype(np.float16)
            key = (dense.shape, fingerprint(dense))
            index.setdefault(key, []).append(name)
        del dense
        print(json.dumps({"indexed_matrices": len(expected_names)}), flush=True)
        destination.mkdir(parents=True)
        records, matched, elements = [], set(), 0
        with tempfile.TemporaryDirectory(dir=destination, prefix="weights-") as temporary:
            weights = Path(temporary)
            writer = _BlobStorageWriter(str(weights / "weight.bin"))
            reader = _BlobStorageReader(str(
                source / "model.mlpackage/Data/com.apple.CoreML/weights/weight.bin"))
            operations = []
            for original in block.operations:
                operation = copy.deepcopy(original)
                if operation.type != "const":
                    if any(arg.value.HasField("blobFileValue") for args in operation.inputs.values()
                           for arg in args.arguments if arg.HasField("value")):
                        raise ValueError("Unexpected inline blob argument.")
                    operations.append(operation)
                    continue
                value = operation.attributes["val"]
                if not value.HasField("blobFileValue"):
                    operations.append(operation)
                    continue
                kind = STORAGE_TYPES.get(value.type.tensorType.dataType)
                if kind is None or value.blobFileValue.fileName != "@model_path/weights/weight.bin":
                    raise ValueError("Unexpected source blob dtype or path.")
                data = getattr(reader, f"read_{kind}_data")(value.blobFileValue.offset)
                shape = tuple(d.constant.size for d in value.type.tensorType.dimensions)
                candidates = []
                if kind == "fp16" and len(shape) >= 2 and all(d == 1 for d in shape[2:]):
                    candidates = index.get((shape[:2], fingerprint(data)), [])
                if candidates:
                    name = candidates[0]
                    indices, lut = encode(packed.get_tensor(name + ".weight"),
                                          packed.get_tensor(name + ".scales"),
                                          packed.get_tensor(name + ".biases"))
                    indices_offset = writer.write_uint4_data(indices.flatten())
                    lut_offset = writer.write_fp16_data(lut.view(np.uint16).flatten())
                    operations.extend(replace_weight(operation, shape, indices_offset, lut_offset))
                    records.append({"checkpoint_names": candidates, "output": operation.outputs[0].name,
                                    "shape": shape, "dense_sha256": fingerprint(data),
                                    "indices_offset": indices_offset, "lut_offset": lut_offset})
                    matched.update(candidates)
                    elements += indices.size
                    del indices, lut
                else:
                    value.blobFileValue.offset = getattr(writer, f"write_{kind}_data")(data)
                    operations.append(operation)
                del data
            # The relative embedding is folded into positional products before export;
            # it is deliberately not requantized. All other q4 matrices must be found.
            if not matched or matched != expected_names:
                raise ValueError(f"Incomplete q4 mapping: missing={sorted(expected_names - matched)}, "
                                 f"unexpected={sorted(matched - expected_names)}")
            del writer
            gc.collect()
            stored = _BlobStorageReader(str(weights / "weight.bin"))
            for record in records:
                shape = record["shape"]
                indices = stored.read_uint4_data(record["indices_offset"]).reshape(shape)
                lut = stored.read_fp16_data(record["lut_offset"]).view(np.float16)
                reconstructed = decode(indices, lut)
                if fingerprint(reconstructed) != record["dense_sha256"]:
                    raise ValueError(f"Serialized q4 weights changed {record['output']}.")
                del indices, lut, reconstructed
            del stored
            del block.operations[:]
            block.operations.extend(operations)
            model = ct.models.MLModel(spec, weights_dir=str(weights), skip_model_load=True,
                                      compute_units=ct.ComputeUnit.CPU_AND_NE)
            if reexport:
                # An empty selection disables new quantization but still runs the
                # public optimizer's graph import/export pipeline.
                config = ct.optimize.coreml.OptimizationConfig(global_config=None)
                model = ct.optimize.coreml.linear_quantize_weights(model, config)
            model.save(str(destination / "model.mlpackage"))
        audit_saved(destination / "model.mlpackage", records)
        manifest.update({
            "postprocessed_from": source.name,
            "weight_compression": {
                "method": "faithful-mlx-q4-group64-lut", "index_dtype": "uint4", "group_size": 64,
                "scope": scope,
                "lut_dtype": "fp16", "palette_entries_per_group": 16,
                "additional_quantization": False, "serialized_weights_bit_exact": True,
                "compressed_operations": len(records), "compressed_elements": elements,
                "uncompressed_derived_weights": "relative-position projections",
                "bytes_per_group": 64, "mlx_bytes_per_group": 36,
                "requires_numerical_validation": True,
                "runtime_compressed_execution": "unverified",
            },
        })
        if reexport:
            manifest["graph_reexport"] = "coremltools-default-pipeline"
        (destination / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        mapping = [{key: value for key, value in record.items() if not key.endswith("_offset")}
                   for record in records]
        (destination / "weight-mapping.json").write_text(json.dumps(mapping, indent=2) + "\n")
        print(json.dumps(manifest["weight_compression"], indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--scope", choices=["all", "convolutions"], default="all")
    parser.add_argument("--reexport", action="store_true",
                        help="Normalize the whole graph without selecting weights for new quantization.")
    args = parser.parse_args()
    compress(args.source, args.destination, args.checkpoint, args.scope, args.reexport)
