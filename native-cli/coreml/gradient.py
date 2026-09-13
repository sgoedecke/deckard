"""CPU-only, split Gradient rewrite for experimental Core ML export.

Start from Deckard's pinned q4 checkpoint, not a different detector. Dequantize
on CPU; neither importing nor running this module initializes MLX/Metal.
"""

import hashlib
import math
from pathlib import Path

import numpy as np
import torch
from safetensors import safe_open
from torch import nn
from torch.nn import functional as F


MODEL = "ShantanuT01/gradient-ai-text-detector"
REVISION = "c2e8b6df87f8a211cbffb713fa9873a0c3a9713f"
PACKED_SHA256 = "85a9e02ebdcbbe1dd84cdbf893b708e44ee4691cadc7e1a4780039e22097ac98"
HIDDEN, HEADS, HEAD_DIM, LAYERS, VOCAB = 1024, 16, 64, 24, 128100
EPSILON = 1e-7


def verify_checkpoint(path):
    with Path(path).open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    if digest != PACKED_SHA256:
        raise ValueError("Expected Deckard's pinned Gradient q4 checkpoint.")


def unpack(weight, scales, biases):
    """MLX affine q4/group64 layout, with the dequantized FP16 rounding point."""
    if weight.dtype != np.uint32 or scales.dtype != np.float16 or biases.dtype != np.float16:
        raise ValueError("Invalid packed tensor dtypes.")
    rows, packed_columns = weight.shape
    columns = packed_columns * 8
    if columns % 64 or scales.shape != (rows, columns // 64) or biases.shape != scales.shape:
        raise ValueError("Invalid packed tensor shapes.")
    values = ((weight[..., None] >> (np.arange(8, dtype=np.uint32) * 4)) & 15)
    values = values.reshape(rows, columns // 64, 64).astype(np.float32)
    values = values * scales.astype(np.float32)[..., None] + biases.astype(np.float32)[..., None]
    return values.reshape(rows, columns).astype(np.float16).astype(np.float32)


class Weights:
    def __init__(self, path):
        self.path = str(path)

    def get(self, name):
        with safe_open(self.path, framework="numpy") as source:
            return torch.from_numpy(source.get_tensor(name).astype(np.float32))

    def matrix(self, name):
        with safe_open(self.path, framework="numpy") as source:
            return torch.from_numpy(unpack(
                source.get_tensor(name + ".weight"),
                source.get_tensor(name + ".scales"),
                source.get_tensor(name + ".biases"),
            ))

    def norm(self, name):
        return StableNorm(self.get(name + ".weight"), self.get(name + ".bias"))

    def linear(self, name):
        return Projection(self.matrix(name), self.get(name + ".bias"))


class StableNorm(nn.Module):
    def __init__(self, weight, bias):
        super().__init__()
        self.register_buffer("weight", weight)
        self.register_buffer("bias", bias)
        self.channels_first = False

    def forward(self, x):
        # Mixed-precision exports preserve this in FP32; other arithmetic modes
        # must pass the independent end-to-end numerical gate.
        if self.channels_first:
            values = x.transpose(1, 2).unsqueeze(2)
            centered = values - values.mean(dim=1, keepdim=True)
            variance = (centered * centered).mean(dim=1, keepdim=True)
            normalized = centered * torch.rsqrt(variance + EPSILON)
            output = normalized * self.weight[None, :, None, None] + self.bias[None, :, None, None]
            return output.squeeze(2).transpose(1, 2)
        return F.layer_norm(x, (HIDDEN,), self.weight, self.bias, EPSILON)


class Projection(nn.Module):
    def __init__(self, weight, bias):
        super().__init__()
        self.register_buffer("weight", weight[:, :, None, None])
        self.register_buffer("bias", bias)
        self.splits, self.split_axis = 1, "input"
        self.spatial_width = None

    def forward(self, x):
        # ANE's preferred linear layout is channels-first with 1x1 convolutions.
        x = x.transpose(1, 2)
        x = (x.reshape(1, self.weight.shape[1], -1, self.spatial_width)
             if self.spatial_width is not None else x.unsqueeze(2))
        if self.splits == 1:
            output = F.conv2d(x, self.weight, self.bias)
        elif self.split_axis == "input":
            parts = iter(zip(x.chunk(self.splits, dim=1), self.weight.chunk(self.splits, dim=1)))
            first, weight = next(parts)
            output = F.conv2d(first, weight)
            for part, weight in parts:
                output = output + F.conv2d(part, weight)
            output = output + self.bias[None, :, None, None]
        else:
            output = torch.cat([F.conv2d(x, weight, bias) for weight, bias in
                                zip(self.weight.chunk(self.splits, dim=0),
                                    self.bias.chunk(self.splits, dim=0))], dim=1)
        output = output.flatten(2) if self.spatial_width is not None else output.squeeze(2)
        return output.transpose(1, 2)


def position_indices(length):
    relative = np.arange(length)[:, None] - np.arange(length)[None, :]
    distance = np.maximum(np.abs(relative), 128)
    bucket = np.ceil(np.log(distance / 128) / math.log(511 / 128) * 127).astype(np.int64) + 128
    relative = np.where(np.abs(relative) <= 128, relative, np.sign(relative) * bucket)
    c2p = np.clip(relative + 256, 0, 511)
    p2c = np.clip(-relative + 256, 0, 511)
    return (torch.from_numpy(np.broadcast_to(index, (1, HEADS, length, length)).copy())
            for index in (c2p, p2c))


def split_heads(x):
    return x.reshape(1, -1, HEADS, HEAD_DIM).permute(0, 2, 1, 3)


def skew_positions(table, heads, rows, columns):
    values = table.reshape(1, heads, rows + columns, rows)[:, :, :-1, :]
    return values.reshape(1, heads, rows, rows + columns - 1)[:, :, :, rows - 1:]


class Embedding(nn.Module):
    def __init__(self, weights):
        super().__init__()
        self.register_buffer("word", weights.matrix("embeddings.word"))
        self.norm = weights.norm("embeddings.norm")

    def forward(self, input_ids, attention_mask):
        return self.norm(F.embedding(input_ids.long(), self.word)) * attention_mask.unsqueeze(-1)


class Layer(nn.Module):
    def __init__(self, weights, index, length, gather_mode="elementwise",
                 ffn_splits=1, split_axis="input", head_chunk=None, attention_layout="matrix",
                 query_chunk=None, pack_qkv=False, spatial_width=None, channel_norm=False):
        super().__init__()
        self.head_chunk = HEADS if head_chunk is None else head_chunk
        if (ffn_splits not in (1, 2, 4, 8, 16) or split_axis not in ("input", "output")
                or self.head_chunk < 1 or HEADS % self.head_chunk
                or attention_layout not in ("matrix", "channels")):
            raise ValueError("Invalid projection split or attention-head chunk.")
        self.attention_layout = attention_layout
        self.query_chunk = length if query_chunk is None else query_chunk
        if spatial_width is not None and (spatial_width < 1 or length % spatial_width):
            raise ValueError("Convolution spatial width must divide the sequence length.")
        if (self.query_chunk < 1 or length % self.query_chunk
                or (self.query_chunk != length and
                    (gather_mode != "skew" or attention_layout != "matrix" or self.head_chunk != HEADS))):
            raise ValueError("Query chunks must divide the length and use unchunked-head skew/matrix attention.")
        prefix = f"layers.{index}."
        self.query = weights.linear(prefix + "attention.query")
        self.key = weights.linear(prefix + "attention.key")
        self.value = weights.linear(prefix + "attention.value")
        self.attention_output = weights.linear(prefix + "attention_output")
        self.attention_norm = weights.norm(prefix + "attention_norm")
        self.intermediate = weights.linear(prefix + "intermediate")
        self.output = weights.linear(prefix + "output")
        self.output_norm = weights.norm(prefix + "output_norm")
        self.attention_norm.channels_first = self.output_norm.channels_first = channel_norm
        for projection in (self.intermediate, self.output):
            projection.splits, projection.split_axis = ffn_splits, split_axis
        with torch.no_grad():
            relative = weights.norm("relative_norm")(weights.matrix("relative_embeddings")).unsqueeze(0)
            self.register_buffer("pos_query", split_heads(self.query(relative)))
            self.register_buffer("pos_key", split_heads(self.key(relative)))
        c2p, p2c = position_indices(length)
        self.length = length
        self.gather_mode = gather_mode
        if gather_mode == "rowwise":
            offsets = torch.arange(length)[:, None] * 512
            c2p, p2c = ((indices[0, 0] + offsets).reshape(-1) for indices in (c2p, p2c))
        elif gather_mode == "skew":
            # Expand the logarithmic buckets in constant positional weights,
            # so runtime selection becomes a diagonal reshape/slice, not gather.
            c2p, p2c = (torch.cat((indices[0, 0, :, 0].flip(0), indices[0, 0, 0, 1:]))
                        for indices in (c2p, p2c))
            self.pos_key = F.pad(self.pos_key.index_select(2, c2p), (0, 0, 0, 1))
            self.pos_query = F.pad(self.pos_query.index_select(2, p2c), (0, 0, 0, 1))
        elif gather_mode != "elementwise":
            raise ValueError("Unknown relative-position gather layout.")
        self.register_buffer("c2p", c2p)
        self.register_buffer("p2c", p2c)
        self.qkv = (Projection(torch.cat([module.weight[:, :, 0, 0]
                                         for module in (self.query, self.key, self.value)], dim=0),
                               torch.cat([module.bias for module in (self.query, self.key, self.value)]))
                    if pack_qkv else None)
        for projection in (self.query, self.key, self.value, self.attention_output,
                           self.intermediate, self.output, self.qkv):
            if projection is not None:
                projection.spatial_width = spatial_width

    def select_positions(self, table, indices, heads=None):
        heads = HEADS if heads is None else heads
        if self.gather_mode == "skew":
            # Keep the reshape axes small instead of flattening the whole table.
            return skew_positions(table, heads, self.length, self.length)
        if self.gather_mode == "rowwise":
            # Copy a row containing all heads per index, rather than invoking
            # Core ML's generic per-element 4D gather for every head separately.
            rows = table.permute(0, 2, 3, 1).reshape(-1, heads)
            return torch.index_select(rows, 0, indices).reshape(
                1, self.length, self.length, heads).permute(0, 3, 1, 2)
        return torch.gather(table, -1, indices)

    def attend(self, query, key, value, pair_mask, start, end):
        heads = end - start
        c2p_indices = self.c2p[:, start:end] if self.gather_mode == "elementwise" else self.c2p
        p2c_indices = self.p2c[:, start:end] if self.gather_mode == "elementwise" else self.p2c
        scale = math.sqrt(HEAD_DIM * 3)
        if self.attention_layout == "channels":
            # Keep keys on the channel axis, including the softmax reduction.
            q = query.permute(0, 3, 1, 2)
            k = key.permute(0, 2, 1, 3)
            content = torch.einsum("bdhq,bkhd->bkhq", q, k / scale)
            c2p_table = torch.einsum("bdhq,bkhd->bkhq", q,
                                    self.pos_key[:, start:end].permute(0, 2, 1, 3) / scale)
            p2c_table = torch.einsum("bdhk,bqhd->bqhk", key.permute(0, 3, 1, 2),
                                    self.pos_query[:, start:end].permute(0, 2, 1, 3) / scale)
            c2p = self.select_positions(c2p_table.permute(0, 2, 3, 1), c2p_indices, heads)
            p2c = self.select_positions(p2c_table.permute(0, 2, 3, 1), p2c_indices, heads)
            scores = content + c2p.permute(0, 3, 1, 2) + p2c.permute(0, 2, 1, 3)
            scores = torch.where(pair_mask.permute(0, 3, 1, 2) > 0, scores, -65504.0)
            probabilities = torch.softmax(scores, dim=1)
            return torch.einsum("bkhq,bdhk->bdhq", probabilities,
                                value.permute(0, 3, 1, 2)).permute(0, 2, 3, 1)
        content = query @ (key.transpose(-1, -2) / scale)
        # Scale before multiplication to avoid FP16 overflow in intermediates.
        c2p = self.select_positions(query @ (self.pos_key[:, start:end].transpose(-1, -2) / scale),
                                   c2p_indices, heads)
        p2c = self.select_positions(key @ (self.pos_query[:, start:end].transpose(-1, -2) / scale),
                                   p2c_indices, heads).transpose(-1, -2)
        scores = content + c2p + p2c
        scores = torch.where(pair_mask > 0, scores, -65504.0)
        probabilities = torch.softmax(scores, dim=-1)
        return probabilities @ value

    def attend_query_chunks(self, query, key, value, pair_mask):
        scale = math.sqrt(HEAD_DIM * 3)
        scaled_key = key.transpose(-1, -2) / scale
        p2c = self.select_positions(key @ (self.pos_query.transpose(-1, -2) / scale),
                                    self.p2c).transpose(-1, -2)
        chunks = []
        for start in range(0, self.length, self.query_chunk):
            stop = start + self.query_chunk
            q = query[:, :, start:stop]
            positions = self.pos_key[:, :, self.length - stop:2 * self.length - start]
            c2p = skew_positions(q @ (positions.transpose(-1, -2) / scale),
                                  HEADS, self.query_chunk, self.length)
            scores = q @ scaled_key + c2p + p2c[:, :, start:stop]
            scores = torch.where(pair_mask[:, :, start:stop] > 0, scores, -65504.0)
            chunks.append(torch.softmax(scores, dim=-1) @ value)
        return torch.cat(chunks, dim=2)

    def forward(self, hidden, attention_mask):
        if self.qkv is None:
            query, key, value = (split_heads(projection(hidden))
                                 for projection in (self.query, self.key, self.value))
        else:
            query, key, value = (split_heads(part) for part in self.qkv(hidden).chunk(3, dim=-1))
        pair_mask = attention_mask[:, None, :, None] * attention_mask[:, None, None, :]
        if self.query_chunk != self.length:
            attended = self.attend_query_chunks(query, key, value, pair_mask)
        else:
            chunks = [self.attend(query[:, start:start + self.head_chunk],
                                  key[:, start:start + self.head_chunk],
                                  value[:, start:start + self.head_chunk], pair_mask,
                                  start, start + self.head_chunk)
                      for start in range(0, HEADS, self.head_chunk)]
            attended = (chunks[0] if len(chunks) == 1 else torch.cat(chunks, dim=1))
        attended = attended.permute(0, 2, 1, 3).reshape(1, -1, HIDDEN)
        x = self.attention_norm(hidden + self.attention_output(attended))
        return self.output_norm(x + self.output(F.gelu(self.intermediate(x), approximate="none")))


class Head(nn.Module):
    def __init__(self, weights):
        super().__init__()
        self.pooler = weights.linear("pooler")
        self.classifier = weights.linear("classifier")

    def forward(self, hidden):
        return self.classifier(F.gelu(self.pooler(hidden[:, :1, :]), approximate="none")).reshape(1, 1)


def stage_names():
    return ["embedding", *(f"layer-{i:02d}" for i in range(LAYERS)), "head"]


def make_stage(weights, name, length, gather_mode="elementwise",
               ffn_splits=1, split_axis="input", head_chunk=None, attention_layout="matrix",
               query_chunk=None, pack_qkv=False, spatial_width=None, channel_norm=False):
    if name == "embedding":
        return Embedding(weights).eval()
    if name == "head":
        return Head(weights).eval()
    if name in stage_names()[1:-1]:
        return Layer(weights, int(name[-2:]), length, gather_mode, ffn_splits, split_axis,
                     head_chunk, attention_layout, query_chunk, pack_qkv, spatial_width, channel_norm).eval()
    raise ValueError(f"Unknown stage: {name}")


def inputs(name, length):
    mask = torch.ones((1, length), dtype=torch.float32)
    if name == "embedding":
        return {"input_ids": torch.zeros((1, length), dtype=torch.int32), "attention_mask": mask}
    hidden = torch.zeros((1, length, HIDDEN), dtype=torch.float32)
    return {"hidden": hidden} if name == "head" else {"hidden": hidden, "attention_mask": mask}


def validate_input(value, length):
    ids, mask = value["input_ids"], value["attention_mask"]
    if (not isinstance(ids, list) or not isinstance(mask, list) or not 1 <= len(ids) <= length
            or len(ids) != len(mask) or not 1 <= length <= 512):
        raise ValueError("Matching token/mask lengths in 1..sequence_length required.")
    if any(type(x) is not int or not 0 <= x < VOCAB for x in ids):
        raise ValueError("Token IDs must be integers in the vocabulary.")
    if any(type(x) is not int or x not in (0, 1) for x in mask):
        raise ValueError("Masks must contain integer zero or one.")
    padding = length - len(ids)
    return {"input_ids": np.array([ids + [0] * padding], dtype=np.int32),
            "attention_mask": np.array([mask + [0] * padding], dtype=np.float32)}
