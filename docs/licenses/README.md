# Model license provenance

Verified against public upstream sources on 2026-09-07. These notices apply to
the model and base used by Deckard, not to unrelated models or datasets.
Include this directory and `docs/MODEL-ATTRIBUTION.md` in model distributions.
Runtime libraries have additional licenses collected by the native build.

## Gradient

- Model: **ShantanuT01/gradient-ai-text-detector**, attributed upstream to
  **Shantanu Thorat**.
- Pinned revision: `c2e8b6df87f8a211cbffb713fa9873a0c3a9713f`.
- [Pinned model card](https://huggingface.co/ShantanuT01/gradient-ai-text-detector/blob/c2e8b6df87f8a211cbffb713fa9873a0c3a9713f/README.md)
  declares `license: [mit]`, “License: MIT License”, and base model
  `microsoft/deberta-v3-large`.
- The [pinned repository inventory](https://huggingface.co/api/models/ShantanuT01/gradient-ai-text-detector/revision/c2e8b6df87f8a211cbffb713fa9873a0c3a9713f)
  contains **no standalone LICENSE file or copyright notice**. We do not
  misrepresent a generated copyright line as upstream text.
- [`GRADIENT-MIT.txt`](GRADIENT-MIT.txt) preserves the verified attribution and
  declaration, followed by the standard MIT permission/warranty terms from
  [SPDX license-list-data v3.27.0](https://github.com/spdx/license-list-data/blob/v3.27.0/text/MIT.txt).
  This is a downstream notice, **not a verbatim upstream LICENSE file**.

## Microsoft DeBERTa-v3-large

- [Pinned base-model card](https://huggingface.co/microsoft/deberta-v3-large/blob/64a8c8eab3e352a784c658aef62be1662607476f/README.md)
  at revision `64a8c8eab3e352a784c658aef62be1662607476f` explicitly declares
  `license: mit` and links Microsoft's official DeBERTa repository.
- That model snapshot contains no standalone LICENSE. The linked official
  project's [LICENSE](https://github.com/microsoft/DeBERTa/blob/4d7fe0bd4fb3c7d4f4005a7cafabde9800372098/LICENSE)
  at revision `4d7fe0bd4fb3c7d4f4005a7cafabde9800372098` is **MIT**, with
  `Copyright (c) Microsoft Corporation.`
- [`DEBERTA-MIT.txt`](DEBERTA-MIT.txt) reproduces that official license text.
  The model card is the evidence for the **model's** MIT designation; the
  linked repository supplies Microsoft's complete notice. We do not infer
  licensing from a similarly named library, or assume Apache-2.0.

The base revision above pins the licensing evidence we inspected. Gradient's
card names the base model but does not identify its exact training-time base
commit; this notice does not claim otherwise.
