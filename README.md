# Deckard

Named after the original AI hunter in _Blade Runner_, Deckard is a Chrome extension that detects AI-generated text on pages you visit.

![Deckard's toolbar icon and open popup above passages marked red on EndlessWiki](docs/images/deckard-endlesswiki.jpg)

## Getting started

Install [Deckard v0.6.0](https://github.com/sgoedecke/deckard/releases/tag/v0.6.0)
from your terminal:

```sh
curl --proto '=https' --tlsv1.2 -fsSL https://github.com/sgoedecke/deckard/releases/download/v0.6.0/install.sh | bash
```

v0.6.0 uses Core ML on CPU/Apple Neural Engine instead of the previous
MLX/Metal backend.

In Chrome:

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Choose **Load unpacked** and select
   `~/Library/Application Support/Deckard/extension` 
3. Pin Deckard so you can see it in your extension hotbar

After an upgrade, use **Reload** on Deckard at `chrome://extensions` to
activate the updated extension alongside the new native helper.

Right now this only works on Apple Silicon macs. If you want to use it on a PC or some other device, PRs are welcome.

## How it works

Deckard runs the [Gradient](docs/MODEL-ATTRIBUTION.md) model on your laptop. When you visit a page, the extension will chunk it and run it through the local model.

The v0.6.0 release bundle includes the converted FP16 model (roughly 933 MiB
before archive compression) and tokenizer as GitHub release assets, not a
separate Hugging Face download. Production inference uses public Core ML
`CPU_AND_NE` compute units and default scheduling: no GPU fallback or private
ANE hooks. One compiled model remains resident for the native host's lifetime;
memory usage depends on Core ML and the workload.

First model use compiles locally and can take longer. Later starts reuse a
validated compiled-model cache in `~/Library/Caches/Deckard/coreml`, keyed by
the pinned artifact, macOS build, and hardware. End users need macOS 15 or
newer on Apple Silicon, but no Python, torch, or Xcode.

## Limitations

This is obviously much less reliable than [Pangram](https://www.pangram.com/?gad_source=1&gad_campaignid=24124423800&gbraid=0AAAABBiSmkhWjllltD0VxcnFAPyHROHK-&gclid=CjwKCAjwwfnUBhAtEiwAfQpAYiH9vGllYuOm7zvv0ANSJh_lMKJl3tdb5CN3ai-vzZomTYIY3MTkCBoC52YQAvD_BwE) (which at the time of writing is the only good AI detector), but (a) it runs entirely locally, and (b) you can use it as much as you want for free.

I've set the default detection threshold to 97%, but that's configurable via the extension slider. Please don't use this as proof of AI usage; if you want to do that, paste it in to Pangram.

Deckard keeps local chunks and also scans larger contexts of up to 510 tokens. Either pass can flag text. Chunks need at least 50 words, so short AI-generated content is harder to detect (since it'll be chunked with other text on the page).

## Uninstall

Run `deckard uninstall` (or
`"$HOME/Library/Application Support/Deckard/current/bin/deckard" uninstall`
if PATH was not configured). It removes Deckard's managed installation files,
owned PATH block and native-host registration. Then manually choose **Remove**
for Deckard at `chrome://extensions`; the CLI cannot remove a Chrome extension.

## Development

This (aside from the README above this point) is entirely vibe-coded, so contribute by hand at your own risk.

Use a current Node.js with the built-in test runner:

```sh
npm test
```

Extension tests need no npm dependencies. Native tests/builds require the native
toolchain and fixtures; release users do not. On a supported Mac, with a
prepared Rust/JSON dependency cache and the pinned Core ML asset directory:

```sh
NATIVE_CACHE=/path/to/native-build scripts/build-native.sh
DECKARD_MODEL_DIR=/path/to/coreml-assets npm run test:native
scripts/package-release.sh --model-dir /path/to/coreml-assets
```

The build reads the external dependency cache without modifying it. Packaging
also accepts `--native-dist native-cli/build/dist` and
`--output-dir dist/v0.6.0`. `BUILD_DIR` overrides the build directory. The build
refuses stale MLX distribution artifacts without deleting existing output;
choose a fresh `BUILD_DIR` when migrating an old MLX build. Source
builders need CMake and Apple's command-line developer tools; the bootstrap
prepares pinned Rust/tokenizers and nlohmann JSON dependencies without an MLX
SDK. An external `NATIVE_CACHE` must already contain those dependencies.
`DECKARD_BOOTSTRAP_MLX=1 native-cli/bootstrap.sh` retains optional SDK acquisition
for historical MLX research, not the production build.

`--model-dir` is the directory **containing** `model.mlpackage/` and
`tokenizer.json`, not the package itself. Packaging verifies every nested file
against [`native-cli/model-assets.json`](native-cli/model-assets.json). It bundles
the native executable, extension, model, tokenizer and license notices, with
the pin manifest under `share/licenses/` as installed provenance; runtime trust is anchored in
the pins embedded in the native binary, not an editable sidecar. No
`packed.safetensors`, MLX libraries, Metal resource or MLX license is shipped.
Every final release archive must be strictly under GitHub's 2 GiB asset limit;
packaging reports its exact byte count and fails before publishing local outputs
if that limit is exceeded.

These are maintainer steps, not evidence that a release has been published.
Packaging writes the archive, checksum-pinned `install.sh`, and `SHA256SUMS`
locally; it never uploads a release. Source installs must pass `--model-dir`
explicitly, for example:

```sh
native-cli/build/dist/bin/deckard install --model-dir /path/to/coreml-assets \
  --extension-dir "$PWD/extension" --shell zsh
native-cli/build/dist/bin/deckard verify --model /path/to/coreml-assets \
  --fixtures /path/to/fixtures.json --output /path/to/new-receipt.json
```

The source installer template fails closed until packaging pins its archive
checksum. Neither the installer nor the production CLI converts or downloads
upstream FP32 weights. Maintainer conversion lives in the Python pipeline under
`native-cli/coreml/`; Python is not part of the distribution.
Without `DECKARD_MODEL_DIR`, native model-installation tests are explicitly
skipped; protocol and ownership-refusal tests still run against the built CLI.
The separately invoked `native-cli/tests/model-smoke.mjs` uses original synthetic
text, serial inference, a 6 GiB physical-footprint watchdog and a 90-second
deadline. Pass an installed CLI path and a new receipt path; the developer build
provides its process meter, or set `DECKARD_PROCESS_METRICS` explicitly.
Load `extension/` unpacked for extension development;
its manifest key gives ID `bkihjdkalohbkgnjjoobababhipefjdg`, so do not load both copies in one profile.

See [native protocol](docs/NATIVE-PROTOCOL.md) for framing and model identity.
Research datasets, experiment outputs and model weights are not committed.

The [Core ML / Neural Engine research history](native-cli/coreml/README.md)
retains the earlier split-model experiment, CPU/ANE-only native runners, and
later resident-model measurements. Those historical MLX comparisons and
background/private-scheduling experiments are not the production configuration.
The v0.6.0 backend is a resident FP16 model derived from decoded q4 weights:
it neither restores the original FP32 weights nor uses 4-bit ANE arithmetic.
Protocol v3 and policy `gradient-q4-two-scale-v1` remain unchanged.

## License

Deckard is [MIT licensed](LICENSE). Gradient and its Microsoft DeBERTa-v3-large
base are MIT-licensed upstream.