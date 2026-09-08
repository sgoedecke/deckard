# Deckard model attribution

Deckard uses **Gradient — AI-Generated Text Detector**, published by
**ShantanuT01 (Shantanu Thorat)**:

- Model: [`ShantanuT01/gradient-ai-text-detector`](https://huggingface.co/ShantanuT01/gradient-ai-text-detector).
- Exact source revision: `c2e8b6df87f8a211cbffb713fa9873a0c3a9713f`.
- [Model card at that revision](https://huggingface.co/ShantanuT01/gradient-ai-text-detector/blob/c2e8b6df87f8a211cbffb713fa9873a0c3a9713f/README.md).
- Upstream identifies English binary text classification, a single sigmoid
  classification head, the MIT license, and a DeBERTa-v3-large base.

## Base model

**Microsoft DeBERTa-v3-large**, by Microsoft:

- [Base model card](https://huggingface.co/microsoft/deberta-v3-large/blob/64a8c8eab3e352a784c658aef62be1662607476f/README.md),
  pinned for provenance at `64a8c8eab3e352a784c658aef62be1662607476f`.
- [Official implementation](https://github.com/microsoft/DeBERTa/tree/4d7fe0bd4fb3c7d4f4005a7cafabde9800372098),
  linked by that card.
- Its model card explicitly declares MIT. See [license notices](licenses/README.md)
  for the actual Microsoft MIT text and the provenance of Gradient's declaration.
  Gradient does not state a training-time base revision.

## Deckard's adaptation and interpretation

Deckard converts the pinned weights for a local MLX runtime, with 4-bit
quantization and a bounded, windowed scoring policy
`gradient-q4-two-scale-v1`. The [native protocol](NATIVE-PROTOCOL.md)
specifies the exact model identity, 50-word minimum, coverage and score checks.
It scores up to four windows per supplied passage and uses the maximum scored
window, not an average or a judgment of every word. A complementary partition
of larger contexts uses the same eligible prose, tokenizer and weights.

The upstream card calls its sigmoid output P(AI) and describes a 0.5 decision
threshold. **Deckard does not claim calibrated authorship probabilities or
adopt that threshold.** Deckard's default is `0.97` (97 on the
slider); users may select 0.70–0.99. This is an experimental, user-selected
cutoff, not a guarantee of any false-positive rate on real browsing.
Upstream benchmark claims do not establish the accuracy of Deckard's
quantized, windowed, browser-extracted scores.

Minimum-length grouping may combine adjacent text by different authors.
Partial/skipped text is not marked, and unmarked text is not proof of human
authorship. Domain, language, length and text editing can affect results.
As the upstream card warns, do not use this detector as the sole basis for
academic penalties, employment actions or other high-stakes decisions.
The model authors and Microsoft do not endorse Deckard.

## Upstream citations

Gradient's pinned card supplies:

```bibtex
@article{thorat2026panclef,
  title={Team DACTYL at PAN 2026: Bayesian Data Mixing and Empirical X-risk Minimization for AI-text Detection},
  author={Thorat, Shantanu},
  journal={Working Notes of CLEF},
  year={2026}
}
```

The base-model card supplies:

```bibtex
@misc{he2021debertav3,
  title={DeBERTaV3: Improving DeBERTa using ELECTRA-Style Pre-Training with Gradient-Disentangled Embedding Sharing},
  author={Pengcheng He and Jianfeng Gao and Weizhu Chen},
  year={2021},
  eprint={2111.09543},
  archivePrefix={arXiv},
  primaryClass={cs.CL}
}

@inproceedings{he2021deberta,
  title={DEBERTA: DECODING-ENHANCED BERT WITH DISENTANGLED ATTENTION},
  author={Pengcheng He and Xiaodong Liu and Jianfeng Gao and Weizhu Chen},
  booktitle={International Conference on Learning Representations},
  year={2021},
  url={https://openreview.net/forum?id=XPZIaotutsD}
}
```
