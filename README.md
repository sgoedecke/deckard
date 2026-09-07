# Deckard

Experimental, local AI-text detection for Chrome. Deckard colors high-scoring
passages red; it never hides or rewrites them. The crossed-eye toolbar button
opens an On/Off switch, threshold slider, and links to flagged passages.

**Website access in v0.4.1:** Deckard declares required access to HTTP and HTTPS
websites, which Chrome grants or prompts for when the extension is installed.
Fresh installs start **On** only when that access is available; an explicitly
saved **Off** stays Off across upgrades and restarts. Browser restrictions or
revoked access stop scanning. While On, eligible pages are analyzed automatically
and locally; use the toolbar switch to turn Off and remove marks.

## Getting started

Install [Deckard v0.4.1](https://github.com/sgoedecke/deckard/releases/tag/v0.4.1)
from your terminal:

```sh
curl --proto '=https' --tlsv1.2 -fsSL https://github.com/sgoedecke/deckard/releases/download/v0.4.1/install.sh | bash
```

The command downloads and executes a shell script. Review the published script
and release checksums before running it. Installation downloads the native
runtime and model assets, verifies their pinned hashes, and registers Chrome's
native helper. Release users do not need Python, a compiler, or Node.js.

Chrome still requires this **manual** step:

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Choose **Load unpacked** and select
   `~/Library/Application Support/Deckard/extension` (use Command-Shift-G in
   the folder picker). Keep this stable installed folder in place.
3. Pin Deckard if desired and open a normal HTTP(S) page. New installs start
   **On** with website access. If you previously saved **Off**, turn Deckard
   **On** and approve website access if Chrome requests it.

Requirements: **Apple Silicon (arm64), macOS 15 or later, and Google Chrome
121 or later**. Intel Macs, other operating systems and other browsers are
not supported. Model inference uses local memory and CPU/GPU resources;
initial downloads are large and require an internet connection.
The release download is approximately 259 MiB and includes the quantized model.

The native release is **ad-hoc signed, not Developer ID signed or notarized**.
macOS or managed-device policy may block it. After verifying the release and
its checksum, use macOS's per-application approval in **System Settings >
Privacy & Security** if offered. Do not disable Gatekeeper or remove quarantine
from unrelated files. Some managed devices will require administrator approval.

## Use and limitations

- The default threshold displays **98.24**, adjustable from **70–99**. These
  are model-score cutoffs, **not probabilities of AI authorship**. Neither the
  default nor any other cutoff guarantees a false-positive rate.
- At least **50 words** are required. Adjacent short passages may be grouped,
  including comments by **different authors**. A red group is not evidence
  about every sentence, word, or author within it.
- Deckard scans up to **25,000 words per page**, including later mutations.
  Navigating to a new SPA page gives a fresh budget; ordinary in-page anchors
  do not. Partial, skipped, unsupported and unscanned text is not judged human.
- English prose only; restricted Chrome pages, private windows, frames,
  hidden/editable content and some complex page layouts are not scanned.
- False positives and false negatives are expected. Do not use the score as
  proof of misconduct or as the sole basis for academic, employment or other
  consequential decisions. Turning Off removes Deckard's marks.

See [model attribution and limitations](docs/MODEL-ATTRIBUTION.md).

## Privacy

Analysis runs locally. Page text is sent only through Chrome native messaging
to the local `com.sgoedecke.deckard` helper, not to a remote inference service.
There is no HTTP daemon: Chrome launches `deckard start` as a framed stdio host
on demand. The extension keeps page text/results in memory while scanning and
stores only Deckard's On/Off and threshold preferences in Chrome local storage.
The helper keeps a bounded in-memory hash/result cache, not a disk text log.
Deckard adds no analytics. Release installation contacts GitHub; obtaining
upstream model assets for development also contacts Hugging Face.
Ordinary browser and website traffic is unaffected.

## Installation layout and advanced options

Everything Deckard owns lives under `~/Library/Application Support/Deckard`,
apart from its Chrome native-host registration and marked shell PATH block.
The installed CLI is `current/bin/deckard` below that prefix; new shells can use
`deckard` when PATH setup is enabled. Reopen your terminal after installation.

The generated release bootstrap accepts `--yes`, `--no-open`, `--shell zsh|bash|none`,
`--home DIR`, `--manifest-dir DIR`, and `--extension-id ID`. With a reviewed
local copy downloaded from the published release:

```sh
bash install.sh --yes --no-open --shell zsh
```

The repository's root `install.sh` is a fail-closed template, not an installer
for a source checkout. Release packaging generates the installable script.
Chrome is never opened automatically; `--no-open` makes that intent explicit.

Use `--shell none` to leave shell files alone and invoke the full CLI path.
PATH setup manages only `~/.zshrc` or `~/.bash_profile`, using the login
`$SHELL` rather than the shell executing the downloaded script. Symlinked
profiles and custom `ZDOTDIR` are not managed; use `--shell none` for those.
Native `deckard install` also accepts `--model-dir DIR` and `--extension-dir DIR`
for prepared assets, plus `--shell zsh|bash|none`. `--home DIR` selects the
Deckard install prefix, not a replacement login home. See `deckard --help`
for native options, and `deckard status` to verify an installation.

The public manifest key pins extension ID
`bkihjdkalohbkgnjjoobababhipefjdg`. It is a public identity key, not a secret or
proof of publisher authenticity. No signing private key is shipped.

## Uninstall

Run `deckard uninstall` (or
`"$HOME/Library/Application Support/Deckard/current/bin/deckard" uninstall`
if PATH was not configured). It removes Deckard's managed installation files,
owned PATH block and native-host registration. Then manually choose **Remove**
for Deckard at `chrome://extensions`; the CLI cannot remove a Chrome extension.

## Development

Use a current Node.js with the built-in test runner:

```sh
npm test
```

Extension tests need no npm dependencies. Native tests/builds require the native
toolchain and fixtures; release users do not. On a supported Mac, with a
prepared dependency cache and canonical quantized model directory:

```sh
NATIVE_CACHE=/path/to/native-build scripts/build-native.sh
DECKARD_MODEL_DIR=/path/to/canonical/mlx-q4 npm run test:native
scripts/package-release.sh --model-dir /path/to/canonical/mlx-q4
```

The build reads the external dependency cache without modifying it. Packaging
also accepts `--native-dist native-cli/build/dist` and
`--output-dir dist/v0.4.1`. These are maintainer steps, not evidence that a
release has been published. Release archives bundle prepared model assets;
source installs must pass `--model-dir` explicitly. The installer does not
download or convert upstream FP32 weights automatically.
Without `DECKARD_MODEL_DIR`, native model-installation tests are explicitly
skipped; protocol and ownership-refusal tests still run against the built CLI.
The separately invoked `native-cli/tests/model-smoke.mjs` uses original synthetic
text, serial inference, a 6 GiB physical-footprint watchdog and a 90-second
deadline. Pass an installed CLI path and a new receipt path; the developer build
provides its process meter, or set `DECKARD_PROCESS_METRICS` explicitly.
Load `extension/` unpacked for extension development;
its manifest key gives the same ID, so do not load both copies in one profile.

See [native protocol](docs/NATIVE-PROTOCOL.md) for framing and model identity.
Research datasets, experiment outputs and model weights are not committed.

## License

Deckard is [MIT licensed](LICENSE). Gradient and its Microsoft DeBERTa-v3-large
base are MIT-licensed upstream; see [verified notices](docs/licenses/README.md)
for exact sources and the distinction between model-card declarations and
upstream license files. Release artifacts must also carry runtime dependency
licenses.
