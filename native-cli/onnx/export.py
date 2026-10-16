"""Exports the pinned fp32 Gradient checkpoint to the single-file,
dynamic-sequence model.onnx that deckard's ONNX Runtime backend runs on Linux.

The graph is the Hugging Face DebertaV2ForSequenceClassification with one
label in fp32, the same model Candle runs from model.safetensors. Run it in
the pinned environment of export/requirements.txt (Python 3.14): the result is
then byte-identical to the model.onnx pinned in model-assets-onnx.json, which
deckard checks when it installs or loads the file (see docs/LINUX.md).
"""

import argparse
import json
import os
import tempfile
from pathlib import Path


def verify_checkpoint(checkpoint):
    config = json.loads((checkpoint / "config.json").read_text())
    if not (checkpoint / "model.safetensors").exists():
        raise FileNotFoundError(checkpoint / "model.safetensors")
    if config.get("torch_dtype") != "float32":
        raise SystemExit("The ONNX export requires the pinned fp32 checkpoint.")
    if config.get("model_type") != "deberta-v2" or config.get("hidden_size") != 1024:
        raise SystemExit("Unexpected model configuration.")
    if len(config.get("id2label", {})) != 1:
        raise SystemExit("Unexpected label count for the Gradient ONNX export.")


def fold_relative_position_ifs(model):
    # Every DebertaV2 attention layer exports
    #   if key_len != query_len: relative_pos = build_relative_position(...)
    #   else: relative_pos = <shared relative_pos>
    # as an ONNX If. Self-attention always takes the else branch, but the two
    # branches yield rank 3 vs rank 4 tensors, so the If output has no static
    # rank and the OpenVINO GPU plugin refuses to compile the graph. Replace
    # each If with an Identity of its else-branch input and drop the dead
    # condition chains. Done for the CPU too (same scores), so supporting the
    # GPU later does not change the model.onnx pin.
    from onnx import helper

    graph = model.graph
    nodes = []
    folded = 0
    for node in graph.node:
        if node.op_type != "If":
            nodes.append(node)
            continue
        else_branch = next(a.g for a in node.attribute if a.name == "else_branch")
        if len(else_branch.node) != 1 or else_branch.node[0].op_type != "Identity":
            raise SystemExit(f"Unexpected If node {node.name}: else branch is not an Identity.")
        nodes.append(helper.make_node(
            "Identity", [else_branch.node[0].input[0]], list(node.output), name=node.name))
        folded += 1
    if folded == 0:
        raise SystemExit("Expected relative-position If nodes in the DebertaV2 export.")

    live = {output.name for output in graph.output}
    kept = []
    for node in reversed(nodes):
        if any(name in live for name in node.output):
            kept.append(node)
            live.update(node.input)
    del graph.node[:]
    graph.node.extend(reversed(kept))
    del graph.value_info[:]


# Writes the raw ONNX export (weights as external data) to `exported`. A
# separate function so the PyTorch model (about 2.5 GB) is freed before
# export_model loads the ONNX copy.
def export_torch(checkpoint, exported):
    # Constant folding makes PyTorch compute part of model.onnx, and its CPU
    # kernels round differently per instruction set (AVX2 and AVX-512 exports
    # differed). Use kernels every x86_64 CPU has: portable ATen, reproducible
    # MKL (also thread-count independent), no oneDNN. Set before the import:
    # torch reads them when it loads.
    os.environ["ATEN_CPU_CAPABILITY"] = "default"
    os.environ["MKL_CBWR"] = "COMPATIBLE,STRICT"
    import torch
    from transformers import AutoConfig, AutoModelForSequenceClassification

    torch.backends.mkldnn.enabled = False
    torch.set_num_threads(2)
    config = AutoConfig.from_pretrained(checkpoint)
    model = AutoModelForSequenceClassification.from_pretrained(
        checkpoint, config=config, torch_dtype=torch.float32
    )
    model.eval()
    for parameter in model.parameters():
        parameter.requires_grad_(False)

    clean = [1, 2]
    ids = torch.tensor([clean], dtype=torch.int64)
    mask = torch.ones_like(ids)
    class TraceModel(torch.nn.Module):
        def forward(self, input_ids, attention_mask):
            return model(input_ids, attention_mask=attention_mask).logits

    trace_model = TraceModel().eval()
    with torch.inference_mode():
        traced = torch.jit.trace(trace_model, (ids, mask), check_trace=False)
    torch.onnx.export(
        traced,
        (ids, mask),
        str(exported),
        input_names=["input_ids", "attention_mask"],
        output_names=["logits"],
        dynamic_axes={
            "input_ids": {0: "batch", 1: "sequence"},
            "attention_mask": {0: "batch", 1: "sequence"},
        },
        opset_version=17,
        do_constant_folding=True,
        dynamo=False,
    )


def export_model(checkpoint, output):
    import onnx

    # torch's ONNX serializer writes large weights as external-data files next
    # to its output, so export into a scratch directory, then re-save one
    # self-contained file.
    with tempfile.TemporaryDirectory(dir=output.parent, prefix=".onnx-export-") as spill:
        exported = Path(spill) / "model.onnx"
        export_torch(checkpoint, exported)
        model = onnx.load(exported, load_external_data=True)
    fold_relative_position_ifs(model)
    # Rename into place so an interrupted export never leaves a truncated model.onnx.
    partial = output.with_name(output.name + ".partial")
    onnx.save(model, str(partial), save_as_external_data=False)
    # Shape inference and the checker run on the file, after freeing the
    # in-memory model: in memory each copies the 1.8 GB model (peak 13.3 GB
    # instead of 9.7 GB, on a 16 GB GitHub runner). Same bytes either way.
    del model
    try:
        onnx.shape_inference.infer_shapes_path(str(partial))
        onnx.checker.check_model(str(partial))
    except BaseException:
        # Never leave a 1.8 GB model that failed its checks behind.
        partial.unlink(missing_ok=True)
        raise
    partial.replace(output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=Path("model.onnx"))
    parser.add_argument("--force", action="store_true",
                        help="Overwrite an existing model.onnx whose pin no longer matches.")
    args = parser.parse_args()
    verify_checkpoint(args.checkpoint)
    output = args.output.resolve()
    if output.exists():
        if not args.force:
            raise FileExistsError(output)
        output.unlink()
    if not output.parent.is_dir():
        output.parent.mkdir(parents=True)
    export_model(args.checkpoint, output)
    print(f"Exported {output}")


if __name__ == "__main__":
    main()