# Deckard on Linux

Deckard runs on Linux x86_64 with the same Chrome extension, native-messaging
protocol, policy and model identity as on macOS. Only the inference runtime
differs:

| | macOS (Apple Silicon) | Linux (x86_64) |
|---|---|---|
| Runtime | Core ML (`coreml_gradient.mm`) | Candle (`native-cli/candle`, Rust) |
| Model | pinned fp16 Core ML export, shipped in the release bundle | pinned fp32 Hugging Face checkpoint, downloaded at install |
| Model files | `model-assets.json` | `model-assets-linux.json` |
| Install prefix | `~/Deckard` | `~/.local/share/deckard` |
| Model cache | `~/Library/Caches/Deckard/coreml` | `~/.cache/deckard` |
| Chrome host registration | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts` | `~/.config/google-chrome/NativeMessagingHosts` |

Like the Core ML backend, Candle never lets masked positions contribute, and
position ids do not depend on the sequence length. Linux scores the fp32
checkpoint itself rather than the fp16 export.

There is no Linux release bundle yet, so Deckard is built from source.

## Build

System packages (names vary by distribution): a C++20 compiler, CMake 3.24+,
`pkg-config`, `curl`, `unzip`, and the OpenSSL and libcurl development headers
(for example `g++ cmake pkg-config curl unzip libssl-dev libcurl4-openssl-dev`
on Debian/Ubuntu).

```sh
scripts/build-native.sh
```

`native-cli/bootstrap.sh` hands Linux off to `native-cli/bootstrap-linux.sh`,
which fills `cache/native-build` with the pinned dependencies: nlohmann/json,
license notices, Rust 1.90.0 (installed through a checksummed `rustup-init`,
exactly like on macOS) and an offline crate registry for the tokenizer and
Candle crates. A pre-filled `NATIVE_CACHE` elsewhere is used read-only, and its
Rust toolchain must really be 1.90.0. `native-cli/linux.cmake` then builds the
Candle staticlib with that toolchain and links it into `deckard`.

## Install

From the repository root:

```sh
native-cli/build/dist/bin/deckard install --extension-dir extension
```

A source build has no packaged extension next to the binary, so
`--extension-dir` points install at the repository's `extension/` folder; it
is copied to `~/.local/share/deckard/extension`. Install also adds deckard to
`PATH` in your shell profile (`--shell bash|zsh`, default: your login shell);
`--shell none` skips that, for example when the profile is a symlink managed
elsewhere.

Without `--model-dir`, install downloads the three pinned files
(`config.json`, `model.safetensors`, `tokenizer.json`, about 1.7 GB) from
Hugging Face into the model cache, resuming partial downloads and verifying
every SHA-256 pin. `--model-dir DIR` installs from a local copy instead (other
files in `DIR` are ignored); `--no-download` fails instead of downloading
missing files. Then load `~/.local/share/deckard/extension` unpacked in Chrome
as described in the README.

## Performance

Measured on an Intel Core i5-8500T with Intel UHD Graphics 630:

| | Candle |
|---|---|
| Model load, once per host start | 4.6 s, of which about 4 s is the SHA-256 check of the weights |
| One window of 32 / 128 / 512 tokens | 0.65 / 1.44 / 8.2 s |
| A real page ([Prussian Union on EndlessWiki](https://www.endlesswiki.com/wiki/prussian_union)), warm host | 11.2 s |
| CPU cores used while scoring | about 1 of 6 |
| Memory of the Chrome-launched host | 1.8 GB resident; up to 3.3 GB while `deckard verify` loads and checks the model |

Window timings are the median of `deckard verify` runs after a warm-up; the
page timing is the CPU activity of the host Chrome launched while the
extension scored the page.

Candle runs almost entirely on one core, so scoring a page leaves the rest of
the machine responsive but takes several seconds. Chrome starts the host on
demand and the extension closes it after five idle minutes, so the first page
after a pause also waits for the model load. The Linux host uses more memory
than the macOS one because it runs the fp32 checkpoint rather than the fp16
Core ML export.

### Why Candle, and what a faster runtime costs

ONNX Runtime scores the same checkpoint (exported to `model.onnx`) about five
times faster on this CPU, because it spreads the work over several cores. It
costs more almost everywhere else (disk, dependencies, start-up, memory,
binary size), so Candle is the default and a faster runtime is left for later,
as an opt-in. Measured on the same machine:

| | Candle | ONNX Runtime (CPU) |
|---|---|---|
| One window of 512 tokens | 8.2 s | 1.65 s |
| CPU cores used while scoring | about 1 | about 3 |
| Model load, once per host start | 4.6 s | 7.7 s |
| Peak memory (`deckard verify`) | 3.3 GB | 3.6 GB |
| `deckard` binary | 35 MB | about 66 MB (embeds the 31 MB ONNX Runtime library) |
| Disk beyond the three Hugging Face files | none | `model.onnx`, 1.8 GB, in the model cache and again in the installation |
| Getting the model | download the pinned files | additionally export `model.onnx` with PyTorch (nobody publishes it): podman, docker or Python 3.14, about 1.3 GB of downloads and a few minutes |
| Build dependencies | Rust toolchain and crates | additionally ONNX Runtime headers and library (about 90 MB of downloads) |
| Runtime dependencies | libc, libcrypto, libcurl | additionally zlib; the ONNX Runtime library is written to the model cache and loaded at run time |

## Test

```sh
npm test
DECKARD_MODEL_DIR=~/.cache/deckard npm run test:native
```

The native suites run against the Linux binary. Tests that only apply to
macOS, such as those for the Core ML runtime or for upgrading from earlier
macOS releases, are skipped on Linux.

The Candle crate has its own unit tests (`cargo test` in `native-cli/candle`);
set `DECKARD_CANDLE_CONFIG` and `DECKARD_CANDLE_WEIGHTS` to also run one real
inference.

`linux-cli.test.mjs` covers the Linux side of `deckard install` and the host:
the default paths, the model cache (reuse without network, resumed and
corrupt files, `--no-download`) and a host started under `nice`. Downloads go
to a dead proxy there, so these tests never use the network.
