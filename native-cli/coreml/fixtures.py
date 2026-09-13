"""Synthetic fixtures with frozen canonical MLX q4 logits (no GPU execution).

These values come from the existing Gradient q4 conversion reference, whose
checkpoint identity is enforced by gradient.verify_checkpoint.
"""

import math


LOGITS = {
    32: (-3.390625, -5.3671875, 2.677734375, -1.826171875),
    128: (5.6953125, 1.330078125, 7.0234375, 6.41015625),
    512: (7.1875, 6.97265625, 7.1796875, 7.26953125),
}


def references():
    cases = []
    for length, logits in LOGITS.items():
        for step_index, step in enumerate((11, 97)):
            for padded in (False, True):
                used = length // 2 + 1 if padded else length
                ids = [3 + index * step for index in range(used)]
                ids[0], ids[-1] = 1, 2
                ids += [0] * (length - used)
                mask = [1] * used + [0] * (length - used)
                logit = logits[step_index * 2 + int(padded)]
                cases.append({
                    "name": f"length{length}-values{step}-batch1" + ("-padded" if padded else ""),
                    "logit": logit, "score": 1 / (1 + math.exp(-logit)),
                    "feed": {"input_ids": [ids], "attention_mask": [mask]},
                })
    return {"cases": cases}
