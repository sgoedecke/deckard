"""Join split ML Programs without retracing or holding all weights in RAM."""

import argparse
import copy
import gc
import hashlib
import json
from pathlib import Path
import tempfile

import coremltools as ct
from coremltools.libmilstoragepython import _BlobStorageReader, _BlobStorageWriter
from coremltools.proto import MIL_pb2

from gradient import MODEL, REVISION, PACKED_SHA256, LAYERS, stage_names


STORAGE_TYPES = {
    MIL_pb2.FLOAT16: "fp16", MIL_pb2.FLOAT32: "float",
    MIL_pb2.INT32: "int32", MIL_pb2.UINT16: "uint16",
}


def constant_key(value, data=None):
    digest = hashlib.sha256()
    digest.update(value.type.SerializeToString(deterministic=True))
    digest.update(value.SerializeToString(deterministic=True) if data is None else memoryview(data))
    return digest.digest()


def append_stage(destination, source, index, bindings, constants, read_blob, write_blob):
    names = dict(bindings)
    for original in source.operations:
        if original.blocks:
            raise ValueError("Fusion supports these straight-line Gradient programs, not nested blocks.")
        operation = copy.deepcopy(original)
        data, storage_type, key = None, None, None
        if operation.type == "const":
            if len(operation.outputs) != 1 or "val" not in operation.attributes:
                raise ValueError("Unexpected constant schema.")
            value = operation.attributes["val"]
            if value.HasField("blobFileValue"):
                storage_type = STORAGE_TYPES.get(value.type.tensorType.dataType)
                if storage_type is None:
                    raise ValueError("Unsupported stored tensor dtype.")
                data = read_blob(storage_type, value.blobFileValue)
            key = constant_key(value, data)
            if key in constants:
                names[operation.outputs[0].name] = constants[key]
                continue
        for argument_list in operation.inputs.values():
            for argument in argument_list.arguments:
                if argument.HasField("name"):
                    if argument.name not in names:
                        raise ValueError(f"Unbound input {argument.name} in stage {index}.")
                    argument.name = names[argument.name]
                elif argument.value.HasField("blobFileValue"):
                    raise ValueError("Unexpected inline blob argument.")
        for output in operation.outputs:
            old = output.name
            names[old] = "logit" if index == 25 and old == "logit" else f"s{index:02d}_{old}"
            output.name = names[old]
        if "name" in operation.attributes:
            attribute = operation.attributes["name"].immediateValue.tensor.strings
            if len(attribute.values) == 1:
                attribute.values[0] = f"s{index:02d}_{attribute.values[0]}"
        if key is not None:
            constants[key] = operation.outputs[0].name
            if data is not None:
                value = operation.attributes["val"]
                value.blobFileValue.fileName = "@model_path/weights/weight.bin"
                value.blobFileValue.offset = write_blob(storage_type, data)
        destination.operations.append(operation)
    return [names[name] for name in source.outputs]


def rename_output(block, old, new):
    if old == new:
        return
    if any(output.name == new for operation in block.operations for output in operation.outputs):
        raise ValueError(f"Output name {new} is already defined.")
    for operation in block.operations:
        for arguments in operation.inputs.values():
            for argument in arguments.arguments:
                if argument.HasField("name") and argument.name == old:
                    argument.name = new
        for output in operation.outputs:
            if output.name == old:
                output.name = new
    for index, output in enumerate(block.outputs):
        if output == old:
            block.outputs[index] = new


def elide_cast_roundtrips(block):
    """Bypass FP16 -> FP32 -> FP16 only; preserve narrowing and public outputs."""
    producers, aliases, kept = {}, {}, []
    bypassed = 0
    for original in block.operations:
        if original.blocks:
            raise ValueError("Cast cleanup requires a straight-line program.")
        operation = copy.deepcopy(original)
        for arguments in operation.inputs.values():
            for argument in arguments.arguments:
                if argument.HasField("name"):
                    argument.name = aliases.get(argument.name, argument.name)
        source = None
        if operation.type == "cast" and len(operation.outputs) == 1:
            arguments = operation.inputs["x"].arguments
            if len(arguments) == 1 and arguments[0].HasField("name"):
                first = producers.get(arguments[0].name)
                if first is not None and first.type == "cast" and len(first.outputs) == 1:
                    inner = first.inputs["x"].arguments
                    if len(inner) == 1 and inner[0].HasField("name"):
                        producer = producers.get(inner[0].name)
                        if producer is not None:
                            source = next((out for out in producer.outputs if out.name == inner[0].name), None)
                if (source is not None and source.type.tensorType.dataType == MIL_pb2.FLOAT16
                        and first.outputs[0].type.tensorType.dataType == MIL_pb2.FLOAT32
                        and source.type == operation.outputs[0].type
                        and operation.outputs[0].name not in block.outputs):
                    aliases[operation.outputs[0].name] = source.name
                    bypassed += 1
                    continue
        kept.append(operation)
        for output in operation.outputs:
            producers[output.name] = operation
    live, retained = set(block.outputs), []
    for operation in reversed(kept):
        if operation.type in ("cast", "const") and not any(out.name in live for out in operation.outputs):
            continue
        retained.append(operation)
        live.update(argument.name for arguments in operation.inputs.values() for argument in arguments.arguments
                    if argument.HasField("name"))
    removed = len(block.operations) - len(retained)
    del block.operations[:]
    block.operations.extend(reversed(retained))
    return {"bypassed_roundtrips": bypassed, "removed_operations": removed}


def fuse(source, destination, layer_count=None, layer_start=0, share_constants=True, elide_casts=False):
    manifest = json.loads((source / "manifest.json").read_text())
    required = {"format": "deckard-coreml-split-v1", "model": MODEL, "revision": REVISION,
                "source_sha256": PACKED_SHA256, "layers": LAYERS}
    if any(manifest.get(key) != value for key, value in required.items()):
        raise ValueError("Source must be the pinned, completed split Gradient bundle.")
    if layer_count is None:
        if layer_start:
            raise ValueError("A layer start requires a diagnostic layer count.")
        stages = stage_names()
    else:
        if layer_count < 1 or layer_start < 0 or layer_start + layer_count > LAYERS:
            raise ValueError("Diagnostic layers must be a nonempty range within 0..23.")
        stages = [f"layer-{index:02d}" for index in range(layer_start, layer_start + layer_count)]
    if destination.exists():
        raise FileExistsError(destination)
    destination.mkdir(parents=True)
    with tempfile.TemporaryDirectory(dir=destination, prefix="weights-") as temporary:
        weights = Path(temporary)
        writer = _BlobStorageWriter(str(weights / "weight.bin"))
        constants, previous, fused = {}, None, None
        original_operations, unique_constants = 0, 0
        for index, stage in enumerate(stages):
            package = source / f"{stage}.mlpackage"
            spec = ct.utils.load_spec(str(package))
            if set(spec.mlProgram.functions) != {"main"}:
                raise ValueError("Unexpected functions in source stage.")
            function = spec.mlProgram.functions["main"]
            if set(function.block_specializations) != {"CoreML8"}:
                raise ValueError("Expected the validated macOS 15 graph specialization.")
            block = function.block_specializations["CoreML8"]
            if index == 0:
                fused = copy.deepcopy(spec)
                target = fused.mlProgram.functions["main"].block_specializations["CoreML8"]
                del target.operations[:]
            original_operations += len(block.operations)
            expected_inputs = {"input_ids", "attention_mask"} if stage == "embedding" else (
                {"hidden"} if stage == "head" else {"hidden", "attention_mask"})
            bindings = {name: name for name in expected_inputs} if index == 0 else {
                "hidden": previous, "attention_mask": "attention_mask"}
            if {item.name for item in function.inputs} != expected_inputs:
                raise ValueError(f"Unexpected input interface for {stage}.")
            length = manifest["sequence_length"]
            for feature in spec.description.input:
                shape = [1, length] if feature.name != "hidden" else [1, length, 1024]
                if list(feature.type.multiArrayType.shape) != shape:
                    raise ValueError(f"Inconsistent sequence length in {stage}.")
            reader = _BlobStorageReader(str(package / "Data/com.apple.CoreML/weights/weight.bin"))

            def read_blob(kind, blob):
                if blob.fileName != "@model_path/weights/weight.bin":
                    raise ValueError("Unexpected external blob path.")
                return getattr(reader, f"read_{kind}_data")(blob.offset)

            stage_constants = constants if share_constants else {}
            prior_constants = len(stage_constants)
            outputs = append_stage(target, block, index, bindings, stage_constants, read_blob,
                                   lambda kind, data: getattr(writer, f"write_{kind}_data")(data))
            unique_constants += len(stage_constants) - prior_constants
            if len(outputs) != 1:
                raise ValueError("Expected exactly one output per Gradient stage.")
            previous = outputs[0]
        output_name = "logit" if layer_count is None else "hidden_out"
        rename_output(target, previous, output_name)
        del fused.description.output[:]
        fused.description.output.extend(spec.description.output)
        fused.description.output[0].name = output_name
        del target.outputs[:]
        target.outputs.append(output_name)
        cast_cleanup = elide_cast_roundtrips(target) if elide_casts else None
        del writer
        gc.collect()
        fused.description.metadata.shortDescription = (
            "Single-graph Gradient q4 CPU/ANE experiment" if layer_count is None else
            "Diagnostic Gradient layer stack; not a complete detector")
        model = ct.models.MLModel(fused, weights_dir=str(weights), skip_model_load=True,
                                  compute_units=ct.ComputeUnit.CPU_AND_NE)
        model.save(str(destination / "model.mlpackage"))
    manifest.update({"format": "deckard-coreml-fused-v1" if layer_count is None else
                     "deckard-coreml-layer-stack-v1", "source_bundle": source.name,
                     "original_operations": original_operations, "fused_operations": len(target.operations),
                     "unique_constants": unique_constants, "share_constants": share_constants})
    if cast_cleanup is not None:
        manifest["cast_cleanup"] = cast_cleanup
    if layer_count is not None:
        manifest.update({"layers": layer_count, "layer_start": layer_start, "diagnostic": True})
    (destination / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--layer-count", type=int, help="Export only a diagnostic hidden-to-hidden layer stack")
    parser.add_argument("--layer-start", type=int, default=0)
    parser.add_argument("--no-share-constants", action="store_true",
                        help="Keep constant definitions separate across stages to isolate fusion issues")
    parser.add_argument("--elide-casts", action="store_true",
                        help="Bypass lossless internal FP16-to-FP32-to-FP16 roundtrips")
    args = parser.parse_args()
    fuse(args.source, args.destination, args.layer_count, args.layer_start,
         not args.no_share_constants, args.elide_casts)
