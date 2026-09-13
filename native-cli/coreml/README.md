# Experimental Gradient on Core ML

This directory retains the standalone research tools and experiment history.
The production implementation now lives in
[`../src/coreml_gradient.mm`](../src/coreml_gradient.mm), not these diagnostic
runners. Historical references below to unchanged MLX production describe the
state during those experiments, before the v0.6.0 migration.

## Production promotion (v0.6.0)

The normalized FP16 export (`cache/coreml/hillclimb/reexport`) is now the
production asset, pinned by [`../model-assets.json`](../model-assets.json).
It uses public Core ML CPU/Neural Engine execution and public default-priority
scheduling, with no MLX/GPU fallback or private ANE hooks. The tokenizer,
windowing, protocol v3, and default 0.97 cutoff are unchanged. Compiled models
are cached locally across native-host lifetimes.

The production native verifier passed all 52 frozen windows: maximum absolute
score error **0.000722**, with no default-cutoff decision changes. Its warm
mean was **188 ms/window**; this was not a simultaneous GPU comparison.
The initial local release candidate, including the model, was **609,737,743
bytes**, below GitHub's 2 GiB per-asset limit. Building and exercising that
archive did not publish it or replace the user's live installation.

## Working resident ANE candidate

The gather-free, FP16 candidate runs the complete 512-token detector as one
resident model. Native background-scheduled bursts measured **297-327 ms per
window**, versus roughly 10-13 seconds for the earlier fused implementation.
The historical native MLX baseline was 175-177 ms; this is not a fresh,
simultaneous GPU comparison. No additional GPU inference or power capture was
performed while debugging this candidate.

The key change is to expand the logarithmic relative-position buckets into
constant positional projection weights during export. Runtime selection then
uses rank-four reshapes and slices rather than CPU gathers. The bucket mapping
and tensor selection are preserved exactly; this is not a replacement of
DeBERTa's relative attention with an approximation. FP16 arithmetic also keeps
the transformer normalization and softmax on ANE. The indexing transformation
and the precision change are separately selectable and tested.

All 52 frozen reference windows passed the fused model's **0.002 absolute
score-error gate**. Maximum error was 0.001710, with no decision changes at the
default 0.97 cutoff. A repeat matching native background thread QoS passed the
same gates and measured a 332 ms median across varied reference inputs.
This establishes parity on those fixtures, not a general accuracy or
calibration evaluation. Runtime stack sampling directly observed
`EvaluateANERequest`, `doEvaluateDirectWithModel` and hardware ANE request calls;
the native run had no plan-build errors. Small CPU tasks remain, including the
embedding lookup, type conversions and classification head.

The package occupies about 933 MiB. The Python validation processes peaked at
285-294 MB and the native timing process at 46 MB; these are **process
footprints, not total model memory**, and exclude allocations attributed to
Core ML/ANE services. The model remained loaded across requests without
exceeding the 6 GiB process cap.

The original export defaults are retained for reproducing earlier experiments.
To build the working candidate explicitly, after setting `PYTHON` and
`MODEL_DIR` as described below:

```sh
$PYTHON native-cli/coreml/export.py \
  --checkpoint "$MODEL_DIR/packed.safetensors" \
  --output cache/coreml/skew-fp16-512 --length 512 \
  --gather skew --precision fp16
$PYTHON native-cli/coreml/fuse.py \
  cache/coreml/skew-fp16-512 cache/coreml/skew-fp16-fused512
$PYTHON native-cli/coreml/validate_fused.py \
  cache/coreml/skew-fp16-fused512 cache/coreml/skew-fp16-validation-native-qos.json \
  --references "$MODEL_DIR/references.json"
```

Use `--process-meter /path/to/process_metrics` during export to enforce the
6 GiB cap independently on every stage worker. The validator loads and inspects
at default scheduling, but applies both process background policy and background
thread QoS during predictions, matching the native worker. An earlier run with
only process background policy measured a 189 ms median; that is **not**
equivalent to the native worker's stricter scheduling.

The successful generated bundles and receipts live under the ignored
`cache/coreml/` directory; runtime traces and native timing receipts are under
`cache/coreml/profile/`. The subsequent power measurement below indicates
substantial rail-energy savings, with an important background-activity caveat.
At this stage, the experiment had not yet been promoted to production.

## Latency hill-climb (2026-09-13)

**The existing `skew-fp16-fused512` model remains the incumbent.** This round
screened 20 layer configurations and measured seven complete-model/runtime
variants. No candidate established a repeatable sustained speedup beyond the
controls. Production remains unchanged.

The experiments include cast-roundtrip elimination, two/four-way FFN
projections, attention-head and query tiling, channel-axis attention, packed
QKV, spatially packed convolutions, channel-first normalization, streamed
four/eight/sixteen-way FFN reductions, full-graph re-export, additional int8
convolution weights, and Core ML specialization hints. Options live in
`export.py`, `fuse.py`, and `compress.py`; defaults retain the original paths.
Layer timings are screening evidence only, not classification speedups.

All seven complete-model/runtime variants passed the 52-window score gate.
Eight-head grouping was substantially slower end-to-end despite a promising
layer screen. Projection splitting and alternate attention layouts did not
produce a clear gain. `FastPrediction` plus infrequent-reshape hints were
slower in the measured comparison. Int8 convolution compression reduced the
package to about 658 MiB but added quantization and approximately 62-68 seconds
of cold model loading, without a convincing sustained speed advantage.

The best-looking candidate was an unquantized full-graph re-export through
Core ML Tools' default optimization pipeline:

```sh
$PYTHON native-cli/coreml/compress.py \
  cache/coreml/skew-fp16-fused512 cache/coreml/hillclimb/reexport --mode reexport
```

It passed with maximum score error 0.000722 and showed actual ANE hardware
requests in a runtime trace. Initial timing comparisons suggested roughly
2-7% improvement. However, an **identical-model control showed an apparent
11.6% advantage by the median-of-burst-means metric**, exposing timing/order
effects large enough to explain those small gains.

The benchmark was tightened to condition both models, alternate ABBA and BAAB
blocks, support reversed preparation order, check the power source, and report
paired block ratios rather than relying on pooled medians. In the longer
balanced control, the identical models had effectively equal median latency
(342 ms each), with a paired geometric ratio of 0.993. Re-export with reversed
preparation showed a 1.033 paired ratio, but most of that came from its first
block; the remaining three blocks were essentially tied. **That is not enough
to promote a sustained speedup.** The incumbent and all raw comparisons are
preserved rather than selecting the most favorable run.

### Reproducing controlled comparisons

`benchmark.py` runs two native resident CPU/ANE workers serially, never two
inference workloads concurrently. Both use identical process and thread
background scheduling, the same model/input contract and input bytes. It
enforces the 6 GiB per-process cap, records conditioning separately, and rejects
a power-source change during measurement.

```sh
python3 native-cli/coreml/benchmark.py \
  cache/coreml/skew-fp16-fused512 cache/coreml/hillclimb/reexport \
  --input cache/coreml/hillclimb/natural-input.json \
  --output cache/coreml/hillclimb/new-comparison \
  --process-meter /path/to/process_metrics \
  --rounds 4 --burst-ms 5000 --candidate-first
```

Always include an identical-model control and repeat with counterbalanced
preparation order before accepting a small gain. `completed` means a run
finished, not that a candidate is faster. The natural-text input used here
contains 455 active tokens, identically padded to a 512-token tensor for both
models; no text or context was truncated.

Static `MLComputePlan` inspection is deliberately separate from numerical and
latency gates. With int8 weights, all predictions finished, but subsequent
static inspection hit the 180-second deadline. `validate_fused.py --skip-plan`
records numerical status without that diagnostic. Native `--benchmark-worker`
similarly skips static inspection; **neither mode proves ANE execution**.
Collect runtime evidence separately:

```sh
python3 native-cli/coreml/trace.py cache/coreml/hillclimb/reexport \
  --input cache/coreml/hillclimb/natural-input.json \
  --output cache/coreml/hillclimb/new-runtime-trace \
  --process-meter /path/to/process_metrics
```

Instrumented trace timings are not benchmark results. The older
`--power-worker` still requires static plan inspection. Optimization-hint
ablations use `benchmark.py --candidate-fast-prediction` and
`validate_fused.py --fast-prediction --skip-plan`; these do not change QoS.

Artifacts and the incumbent pointer are under `cache/coreml/hillclimb/`.
The frozen corpus is a numerical regression set, not a broad accuracy
evaluation. No GPU inference or new power capture occurred in this round;
the earlier energy results apply to the retained incumbent.

## Faithful four-bit encoding

`q4.py` preserves the existing MLX codes instead of fitting another quantizer.
Each group of 64 weights retains its original four-bit indices and gets a
16-entry FP16 lookup table calculated from the original affine scale and bias,
including the original FP32 arithmetic and FP16 rounding point. Core ML's
`constexpr_lut_to_dense` reconstructs those weights. This avoids treating an
arbitrary affine bias as an integer zero point.

The complete package compresses 147 matrices (434,213,888 weights), including
the token embedding and classifier. Relative-position projections are derived
floating-point tensors and remain uncompressed. The exporter matches checkpoint
matrices to graph constants by shape and exact FP16 bytes, requires complete
coverage, and audits the saved package's reconstructed weight bit patterns,
including after optional graph normalization. It never initializes a GPU model.

The package shrank from **933 MiB to 519 MiB**. This is four-bit index storage,
not a claim of four-bit arithmetic or ANE weight transfers. Its per-group
palette costs 32 bytes in addition to 32 bytes of indices; MLX needs only four
bytes for scale and bias. Therefore this exact representation is less compact
than MLX's affine q4 layout.

Direct graph substitution did not finish full-model loading within 300 seconds.
A convolution-only version also reached its 180-second deadline, so the large
embedding was not the sole issue. A sample of that loader showed it waiting in
the ANE model-loading path, not running classifications. One-layer diagnostics
did run, but were slower in the initial screen.

Running Core ML Tools' whole-graph optimization pipeline after substitution
resolved the full-model loading problem. The normalized package retains all
147 four-bit palettes and bit-exact reconstructed weights. Its first measured
load took **36.7 seconds**, and all 52 frozen cases passed the 0.002 score gate,
with maximum error **0.000914** and no default-cutoff changes. Different compiler
execution can change scores despite unchanged weight values.

Actual runtime sampling observed `doEvaluateDirectWithModel` and H11ANE hardware
requests. This establishes ANE execution, not that weights remained compressed
in ANE memory or DMA transfers.

Four-block comparisons used the same 455-token natural input padded to 512,
background process/thread scheduling, conditioning, and alternating ABBA/BAAB:

| Baseline / candidate | Baseline median | Candidate median | Paired baseline/candidate ratio |
| --- | ---: | ---: | ---: |
| Incumbent / normalized q4 | 355 ms | 335 ms | 1.051 |
| Normalized FP16 / identical normalized FP16 | 294 ms | 306 ms | 0.973 |
| Normalized FP16 / normalized q4, candidate prepared first | 320 ms | 341 ms | 0.949 |

The initial apparent gain did **not** establish a q4-specific speedup after
controlling for graph normalization and order. The reversed comparison's large
first-block penalty also makes a firm slowdown claim unwarranted. **The FP16
incumbent remains selected.** The faithful q4 model works and saves package
space, but has no confirmed latency advantage. It also reached roughly 1.8 GiB
peak native-process footprint during these runs, versus about 32-40 MiB for
FP16 workers. These include loading peaks and exclude Core ML/ANE service
allocations; they are not total resident model-memory measurements.

Receipts are in `hillclimb/q4-paired`, `q4-identical-control`,
`q4-normalized-paired`, and `q4-runtime` under `cache/coreml/`. Failed direct
package payloads were removed to reclaim space; their manifests and logs remain.
No GPU inference or new power measurement was performed.

```sh
$PYTHON native-cli/coreml/q4.py \
  cache/coreml/skew-fp16-fused512 cache/coreml/hillclimb/faithful-q4-reexport \
  --checkpoint "$MODEL_DIR/packed.safetensors" --reexport
$PYTHON native-cli/coreml/validate_fused.py \
  cache/coreml/hillclimb/faithful-q4-reexport \
  cache/coreml/hillclimb/faithful-q4-reexport-numerical.json \
  --references "$MODEL_DIR/references.json" --skip-plan
```

Wrap conversion and validation in `bounded.py` for the same 6 GiB process cap
and explicit deadlines as other experiments. `--scope convolutions` leaves the
token embedding dense; explicit diagnostic layer-stack bundles are supported
for isolating compiler behavior. `--reexport` selects no weights for additional
quantization: it normalizes the graph and then repeats the saved-weight audit.

## Runtime profiling

`profile_runtime.py` separates package compilation, model loading, warm host CPU
time, process memory, and sampled call paths. It uses the native CPU/ANE worker,
`getrusage(RUSAGE_SELF)`, the existing process meter, `sample`, and `vmmap`.
Instruments/xctrace was not installed for these initial measurements; they do
**not** expose ANE hardware counters or per-operation accelerator durations.

Completed profiles of normalized FP16 and normalized faithful q4 used the same
455-token input, padded to 512. Receipts and raw captures are in
`cache/coreml/hillclimb/profile-fp16-v2` and `profile-q4-v2`.

| Measurement | Normalized FP16 | Faithful q4 |
| --- | ---: | ---: |
| Package compilation | 124 ms | 141 ms |
| Model loading, wall time | 19.0 s | 41.4 s |
| Model loading, host-process CPU time | 3.11 s | 12.58 s |
| Warm host-process CPU time per classification | 0.96 ms | 7.49 ms |
| Warm wall time per classification in these bursts | 312 ms | 348 ms |
| Main-thread samples in ANE request path | 99.84% | 97.47% |
| Current warm host-process footprint | 26.8 MiB | 1.22 GiB |

These are profiles, not an interleaved speed comparison. Fresh package
compilation does not flush system specialization caches, so load measurements
are not guaranteed cold-cache measurements. Host CPU and footprint counters
exclude Core ML/ANE service processes and do not measure total model memory.

Warm inference is overwhelmingly in the ANE request/driver path, rather than
CPU fallback or weight decoding on the host. The q4 trace additionally samples
host-to-ANE copies (1.55%), CPU tiling (0.45%), and a lookup-based CPU
inner-product routine (0.24%). That extra host work is measurable, but far too
small to account for the overall latency. The larger q4 footprint also persists
after warmup, rather than being solely a loading peak; `vmmap` shows substantial
private heap allocation, some paged/compressed by macOS.

This narrows the bottleneck to the accelerator request path. It does **not**
distinguish ANE computation from DMA, driver waits, or accelerator scheduling,
nor prove that all weights expand to FP16 or stay compressed on ANE. The
expensive startup phase is model loading (which includes accelerator
preparation/specialization), not the package-compilation call.

```sh
bash native-cli/coreml/build.sh
python3 native-cli/coreml/profile_runtime.py \
  cache/coreml/hillclimb/faithful-q4-reexport \
  --input cache/coreml/hillclimb/natural-input.json \
  --output cache/coreml/hillclimb/new-q4-profile \
  --process-meter /path/to/process_metrics
```

Native benchmark workers now report host CPU counters in their warmup/burst
responses and phase timing records on stderr. GPU-worker CPU profiling remains
disabled by default; its inference allowance and accounting are unchanged.
No GPU inference or power capture was used for these profiles.

### Instruments hardware timeline

Xcode 16.4 subsequently supplied the Core ML and Neural Engine instruments.
`profile_instruments.py` records the resident native worker, exports the ANE
activity and driver-event tables, and saves the input fingerprint, host CPU
counters, power source, and raw trace. It uses an allowlisted process environment:
Instruments can otherwise embed inherited credentials in trace metadata.
The default developer-tool selection is not changed.

The following completed warm captures used the same normalized FP16/q4 models,
455-token input padded to 512, and native background process/thread scheduling.
Each row is a separate profiling capture, **not a controlled speed comparison**.

| Capture | Classifications | ANE prediction intervals per classification | Wall time per classification | Inside ANE prediction intervals | Outside those intervals |
| --- | ---: | ---: | ---: | ---: | ---: |
| Normalized FP16, first stable-power capture | 24 | 1 | 335.98 ms | 334.70 ms (99.62%) | 1.28 ms |
| Faithful q4 | 30 | 2 | 271.81 ms | 262.68 ms (96.64%) | 9.12 ms |
| Same normalized FP16, later repeat | 40 | 1 | 200.04 ms | 198.67 ms (99.31%) | 1.38 ms |

The q4 calls alternate a short interval averaging 6.30 ms and a long interval
averaging 256.38 ms. This establishes a different execution segmentation,
**not which layers those segments contain**. Host CPU averages 1.00-1.18 ms
for FP16 and 6.84 ms for q4; it overlaps elapsed time and must not be added to
the hardware interval durations.

`report_instruments.py` matches each prediction interval to enclosing
target-process markers (class `0x2b`, subclass `0x24`, codes `0x32`/`0x33`).
It rejects missing/ambiguous pairs, foreign request markers, unmatched
prediction intervals, and changed power sources. The mean gap from the
leading marker to the ANE interval is only 0.17-0.20 ms for FP16 and 0.22 ms
for q4. The trailing gap is 0.08 ms and 0.64 ms respectively. These are
observed marker boundaries, **not documented queue-time counters**.
Overlapping activity labelled `Neural Engine Load: prepare and cache` is
reported separately, not double-counted as prediction time or attributed to
the worker without evidence.

This is stronger evidence against host submission/return overhead explaining
the latency. Even the large variation between the two unchanged FP16 runs
occurs inside the ANE prediction interval, not in the host gaps. It does not
establish a quantization speedup, a clock-frequency explanation, or a new
production latency. Both completed captures started and ended on AC power;
Low Power Mode was disabled for both AC and battery in a subsequent read-only
settings query. Those checks do not control every changing device condition.

Apple describes the Neural Engine instrument as showing when the hardware is
[actively running the model](https://developer.apple.com/videos/play/wwdc2022/10027/?time=784),
in contrast with asynchronous Core ML requests. Nevertheless, its activity
intervals expose **no compute-cycle, DMA-byte, or bandwidth counters here**.
They cannot distinguish arithmetic from transfers, memory stalls, or
firmware scheduling within execution. Public `MLComputePlan` operation costs
are estimates, not measured per-operation hardware timestamps.

Detailed Core ML signpost tables remained empty. Attaching before model
loading (`--include-startup`) did not fix that. A separate small Gradient
layer launched directly under Instruments also exited successfully with ANE
events but zero Core ML events. An administrator-authorized, read-only
logging query reported `DEBUG PERSIST_INFO` for `com.apple.coreml`; no logging
settings were changed. No documented Core ML-specific signpost-enabling
environment variable was established, so speculative switches were not used.
Adding `Thread State Trace` failed to finish recording shutdown within the
deadline; that capture is incomplete and is not used for conclusions.

```sh
bash native-cli/coreml/build.sh
python3 native-cli/coreml/profile_instruments.py \
  cache/coreml/hillclimb/reexport \
  --input cache/coreml/hillclimb/natural-input.json \
  --output cache/coreml/hillclimb/new-instruments-profile \
  --process-meter /path/to/process_metrics \
  --developer-dir /Applications/Xcode-16.4.app/Contents/Developer
python3 native-cli/coreml/report_instruments.py \
  cache/coreml/hillclimb/new-instruments-profile
```

Evidence is retained under `cache/coreml/hillclimb/instruments-fp16-v2`,
`instruments-q4`, and `instruments-fp16-v4`, including `analysis.json`,
exported XML, worker logs, and raw traces. Initialization diagnostics are in
`instruments-fp16-startup` and `instruments-launch-layer`. An initial
battery-to-AC transition capture was excluded and its unsanitized trace
discarded. All these workloads were CPU/ANE-only; production remains MLX.

### Lower-level investigation: ANE request QoS explains much of the slowdown

The lack of detailed Instruments events was not the end of the investigation.
Runtime inspection of this Mac's AppleNeuralEngine framework found private
request/QoS interfaces and 24 named performance counters. The names include
FP16/INT8 cycles, compute cycles, kernel/input/output stalls, throttling, and
DMA bytes. These are **interface names, not collected counter values**.
Ordinary Core ML requests had a zero profiling mask and no statistics object.
Setting the exported performance-statistics request option to mask 1 succeeded
on a small Gradient layer but still returned no statistics object.

More importantly, the actual native requests carried QoS **9 (background)**.
The local `_ANEQoSMapper` maps background to program priority/queue index **6**;
utility (17) and default (21) map to **5**. `ane_trace.hpp` enables
process-local, ABI-checked observation of Core ML's direct ANE evaluation
method, without replacing the model, tensors, or Core ML prediction path.
Diagnostic commands can then change only the ANE request QoS.

`profile_qos.py` runs four alternating ABBA/BAAB blocks on **one resident
model**, with conditioning, bounded workers, power-source checks, and optional
identical-condition controls. For request-only comparisons, CPU process and
thread scheduling remain backgrounded throughout. Runtime observations
confirmed incoming QoS 9 and effective QoS 9/21 as requested.

| Experiment | Background median burst latency | Default median burst latency | Paired block speedup |
| --- | ---: | ---: | ---: |
| FP16, request-only change | 338 ms | 180 ms | 1.86x |
| FP16, reversed first condition, longer bursts | 338 ms | 180 ms | 1.87x |
| Faithful q4, reversed first condition | 348 ms | 191 ms | 1.74x |
| FP16, public process/thread scheduling change | 287 ms | 180 ms | 1.60x |

Speedups are geometric means of paired block ratios, not ratios of the two
table medians. The identical-condition control kept QoS 9 for both labels:
337 versus 343 ms, paired ratio **0.968**, rather than a near-twofold change.
The reversed FP16 comparison's four block ratios were 1.82, 1.90, 1.87, and
1.88. All measured burst logits were unchanged within each model:
`-9.03125` for FP16 and `-9.0390625` for q4.

The public-API comparison clears the worker's Darwin background process policy
and sets its thread to default QoS, then restores both for the background
condition. In that comparison the observer does **not** override requests:
Core ML itself emits QoS 9/21 following the public scheduling changes. Thus
the performance effect does not require shipping a private request override.
The observer remains a private-API diagnostic and is not a production feature.

This causally identifies background ANE request QoS as a major contributor to
the earlier latency gap. It does not identify whether the hardware implements
that policy with clock changes, duty cycling, firmware scheduling, or a
combination. It also does **not** establish the faster mode's energy efficiency:
the earlier low-power measurements used background scheduling and must not be
carried over to default QoS. No global policy, entitlement, production default,
or model-incumbent selection was changed.

```sh
bash native-cli/coreml/build.sh
python3 native-cli/coreml/profile_qos.py \
  cache/coreml/hillclimb/reexport \
  --input cache/coreml/hillclimb/natural-input.json \
  --output cache/coreml/hillclimb/new-qos-comparison \
  --process-meter /path/to/process_metrics \
  --candidate-first --burst-ms 2000
```

Use `--control` to keep both labels at background QoS, or
`--scope process-thread` to exercise public scheduling APIs rather than changing
the request argument. `DECKARD_ANE_TRACE=observe` and the experimental `timing`
mode are accepted only by diagnostic workers/layer profiles. Without that
explicit opt-in, no methods are interposed and QoS-control commands are refused.
The shared GPU worker retains its original defaults and inference budget.

Receipts and per-request observations are in `cache/coreml/hillclimb/ane-qos-*`
(`paired`, `control`, `reversed`, `q4`, and `public`). The locally inspected
interfaces, counter names, and QoS mapping are in `ane-runtime-api.json`.
`ane_inspect.mm` can regenerate that inspection using Foundation and the
Objective-C runtime; it does not run a model.

Useful source leads were the
[`_ANERequest` runtime interface](https://github.com/MTACS/iOS-17-Runtime-Headers/blob/d1d960dfaa4107765dd7fcf891e4967c0930d5fd/PrivateFrameworks/AppleNeuralEngine.framework/_ANERequest.h),
[`_ANEPerformanceStats` interface](https://github.com/MTACS/iOS-17-Runtime-Headers/blob/d1d960dfaa4107765dd7fcf891e4967c0930d5fd/PrivateFrameworks/AppleNeuralEngine.framework/_ANEPerformanceStats.h),
and [ANE performance-statistics experiments](https://github.com/maderix/ANE/blob/d91c9845c0784dec7753048954fc6d0e8411fe29/training/test_perf_stats.m).
These are reverse-engineering references, not supported Apple API guarantees;
the experiments checked the actual macOS method ABIs before invoking them.

### Power remeasurement: background/default ANE and production GPU

A later battery-powered comparison measured both ANE priorities and a fresh
native production MLX q4 baseline on the same 455 active tokens padded to 512.
Models were resident; model loading and tokenization are excluded. Only the
ANE request priority changed between the ANE conditions; their CPU process
and thread stayed backgrounded. The GPU worker used production background
process/thread scheduling.

The final, user-requested short captures collected 600 samples each at a nominal
100 ms interval. Meter overhead made the actual durations **66.9 seconds for
ANE and 67.4 seconds for GPU**, rather than precisely 60 seconds. ANE modes
had two roughly two-second bursts each in reversed order, with two-second idle
windows and their first 0.5 seconds excluded for settling. GPU had four
budget-limited bursts of roughly one second, with five-second idle windows
and the same 0.5-second exclusion. Power source remained battery and thermal
pressure remained nominal.

| Backend | Priority | Active CPU+GPU+ANE rail power | Mean classification latency |
| --- | --- | ---: | ---: |
| ANE, FP16 | Background | 0.90 W | 324 ms |
| ANE, FP16 | Default | 2.60 W | 181 ms |
| ANE, faithful q4 | Background | 1.16 W | 326 ms |
| ANE, faithful q4 | Default | 2.59 W | 193 ms |
| Production MLX q4, GPU | Background | 13.63 W | 175 ms |

These are **approximate machine-wide active rail estimates**, not whole-laptop
draw or process-attributed power. The repeated ANE capture still had idle CPU
drift: FP16 background even produced a negative incremental-energy estimate
in one burst. The report preserves and flags that result rather than hiding
it. Consequently, idle-subtracted ANE energy and precise battery-life ratios
are not accepted results. The final GPU capture had no automatic quality
warnings; the q4/default ANE group also had none. The approximate active-power
comparison suggests that default ANE approaches GPU latency while drawing
about one-fifth as much CPU+GPU+ANE rail power; background ANE trades latency
for still lower active power.

The earlier longer passes (`qos-ane-1` and `qos-gpu-1`) also had substantial idle
drift and are retained as confounded evidence, not selectively pooled into
the final table. Final reports, raw captures, and per-burst observations are in
`cache/coreml/power/qos-ane-2` and `qos-gpu-2`. Input fingerprints match, and the
warmup score spread between all three models was below the existing 0.002 gate.

The user explicitly authorized **20 additional seconds of local GPU inference**
for this fresh baseline. The first pass consumed 10.098 seconds of that
allocation; the repeat carried a 10.1-second reserve and finished at
**15.948 seconds cumulatively**, including construction and warmup. With the
earlier 18-second conservative reserve, combined accounted usage is
33.948 seconds. Future work must retain **18 seconds from the first allocation
and at least 16 seconds from the second**, not restart either at zero. No
further GPU inference was run for reporting.

`power_qos.py ane` prepares both resident ANE workers and waits for an
administrator-authorized capture; `power_qos.py gpu` requires explicit
prior-allocation reservations and uses the native 19-second safety cap.
`capture-rails.sh DIRECTORY SAMPLE_COUNT` authorizes only the meter, waits for
`ready.json`, and records CPU/GPU/ANE rails plus thermal pressure. Sample count
is not a strict wall-clock timeout. Generate each report with
`python3 native-cli/coreml/power_qos.py report DIRECTORY`.
The original GPU/ANE power controller and its budget defaults are unchanged.

## Approach

- Dequantize Deckard's SHA-256-pinned affine q4/group64 checkpoint on CPU.
  No MLX, Metal, CUDA, MPS, or remote service is required by these scripts.
- Split inference into an embedding model, 24 transformer-layer models, and a
  classification head. Export each in a separate process, with two CPU threads
  and a five-minute per-stage timeout, rather than converting the whole 435M
  parameter graph in memory at once.
- Use fixed sequence lengths, constant relative-position indices, and
  channels-first 1x1 convolutions for dense projections. Preserve DeBERTa's
  content-to-position and position-to-content attention.
- The original default keeps normalization and softmax in FP32, uses a finite
  mask floor, and scales
  positional keys before multiplying to avoid FP16 intermediate overflow.
  Other operations use FP16. These rounding points differ from MLX, so frozen
  MLX score comparisons are required; matching the model name is not enough.
- Allow **CPU and Neural Engine only**. Unsupported operations can still run on
  CPU. The compute-plan report records compiler device preferences, **not proof
  that every operation actually ran on ANE**.

The default packages contain dequantized FP16 weights, not the compact MLX q4 layout.
The optional faithful four-bit experiment above uses groupwise palettes instead.
Expect substantially more disk space than the production checkpoint. Loading
and releasing stages bounds model residency but introduces overhead. This is a
feasibility experiment, not an optimized browser runtime.

## Prepare and export

Requires Apple Silicon, macOS 15+, Python 3.13 with the packages in `requirements.txt`,
and Xcode command-line tools for the native runner. Use an isolated environment:

```sh
python3.13 -m venv cache/coreml/venv
cache/coreml/venv/bin/pip install -r native-cli/coreml/requirements.txt
PYTHON=cache/coreml/venv/bin/python
MODEL_DIR=/path/to/canonical/mlx-q4

$PYTHON -m unittest discover -s native-cli/coreml -p 'test_*.py'
$PYTHON native-cli/coreml/export.py \
  --checkpoint "$MODEL_DIR/packed.safetensors" \
  --output cache/coreml/gradient128 --length 128
```

Core ML Tools 9 warns that PyTorch 2.8 is newer than its most recently tested
version (2.7). The pinned environment reflects the version used for this
experiment; the numerical gates below must still pass on the target Mac.

The exporter refuses to overwrite an existing bundle. An interrupted export
has no final manifest and is not runnable as a complete bundle. For a
single-stage diagnostic, use a separate directory and `--stage layer-00`.
Supported fixed lengths are 32, 64, 128, 256 and 512. A 128-token bundle cannot
score longer inputs; use a 512-token bundle to cover the production window size.

## Score and inspect placement

The default references are bundled synthetic fixtures with frozen MLX logits.
For broader coverage, optionally supply an existing frozen MLX reference file,
with entries containing `name`, `logit`, `score`, and `feed`
(`input_ids`/`attention_mask` as batch-one arrays). The validator does **not**
run MLX to regenerate it:

```sh
$PYTHON native-cli/coreml/validate.py \
  --checkpoint "$MODEL_DIR/packed.safetensors" \
  --bundle cache/coreml/gradient128 --length 128 \
  --output cache/coreml/validation128.json
```

Use `--references "$MODEL_DIR/references.json" --cases 64` to include additional
frozen natural-text cases, if available.

It compares the entire Core ML pipeline with both the CPU rewrite and frozen
MLX outputs. Inputs are padded with masked zero tokens, never truncated.
The default acceptance gate is absolute score error at most 0.02 against both
references, finite outputs, and no changed decision at the default 0.97 cutoff.
Score-gate failures write a diagnostic receipt and exit nonzero. These small fixture
checks are not an accuracy, calibration, or false-positive-rate evaluation.

For one layer, add `--stage layer-00`. Such results are explicitly diagnostic
and cannot establish end-to-end parity. Per-stage timings include the first
prediction separately in the case list; model load/compile time is also
reported. Do not confuse the sum of warmed stage prediction times with
end-to-end request latency.

The standalone native runner accepts pre-tokenized input, not raw text:

```sh
bash native-cli/coreml/build.sh
cache/coreml/bin/deckard-coreml cache/coreml/gradient128 input.json
node --test native-cli/coreml/runner.test.mjs
```

`input.json` has the shape `{"input_ids":[1,14,2],"attention_mask":[1,1,1]}`.
The result contains a finite logit, sigmoid score, timing and placement
diagnostics. It deliberately has no GPU option. The native runner is not
installed or bundled in production releases.

## Recorded feasibility results

On an Apple M4 with 24 GiB RAM and macOS 15.6.1 (2026-09-12), the 128-token
bundle passed 14 frozen fixtures: eight synthetic cases, including padding,
and six natural-text cases. Maximum absolute score difference was 0.000874
against MLX q4 and 0.000585 against the CPU rewrite, with no changed decisions
at the default cutoff.

The full 512-token bundle passed all 52 reference windows (12 synthetic and
40 natural-text windows), including short inputs padded to 512. Maximum
absolute score difference was 0.000956 against MLX q4 and 0.000979 against the
CPU rewrite; again, no default-cutoff decisions changed. The independent
attention/layout tests and the native runner's input/manifest tests also pass.

For each of the 24 transformer layers, the compiler preferred ANE for 30
operations and CPU for 22 at length 128; at length 512, it preferred ANE for 36
and CPU for 14. The convolutions and most matrix multiplications were assigned
to ANE; gathers, normalization, softmax and some other operations remained on
CPU. Embedding and head stages were CPU-preferred. Constants have no reported
preferred device and are excluded from these counts.

The 128-token packages occupied approximately 914 MiB. The validator peaked
at approximately 1.78 GiB physical footprint. Summed per-stage prediction
times were approximately 0.73-0.83 seconds per fixture, excluding about
25.8 seconds of total stage load/compile time. These are diagnostic timings,
not a warmed end-to-end browser benchmark or a comparison with a fresh GPU run.
Machine-readable receipts are generated under the ignored `cache/coreml/`
directory; model packages and natural-text fixtures are not committed.

The 512-token packages occupied approximately 1.4 GiB. Its background-scheduled
Python validation summed to 7.9-9.1 seconds of stage prediction time per window,
excluding 37.8 seconds of total stage load/compile time. Native 128-token
diagnostics without the background wrapper summed to 0.17-0.18 seconds of
prediction time, but roughly 20 seconds end-to-end because compilation,
loading and compute-plan inspection dominate. These differently scheduled,
interleaved diagnostic runs must not be used to infer a backend speedup or
energy saving.

After the Python validators exited, isolated native runs under
`/usr/sbin/taskpolicy -b` also passed: a full 512-token input and a short,
partially masked input padded to 128. The 512-token native run spent 7.98 seconds
in predictions and 77.1 seconds end-to-end, including 50.6 seconds of
compute-plan inspection and 15.8 seconds loading models. Its peak process
physical footprint was about 312 MiB (not whole-system/Core ML service memory).
The padded 128-token run spent 0.88 seconds in predictions and 48.0 seconds
end-to-end. These startup/inspection costs are another reason not to use the
diagnostic runner directly as a browser backend.

## Power claims

### Resident gather-free model (2026-09-13)

An authorized three-minute capture compared the validated `skew`/FP16 resident
model with native MLX q4 on the same 512-token synthetic input. Both workers
used process and thread background scheduling. The Mac was fully charged and
on AC power. The capture contained 1,800 samples at 100 ms intervals, remained
at nominal thermal pressure, and aligned to workload timestamps within 0.084 ms.
Compilation, loading, plan inspection and warmup preceded the measurement.

The first round had no automatic quality warnings:

| Backend | Windows | Time per window | Active CPU+GPU+ANE rails | Idle-subtracted rail energy per window |
| --- | --- | --- | --- | --- |
| Native MLX q4 | 11 | 188 ms | 13.71 W | 2.423 J |
| Resident Core ML CPU/ANE | 32 | 315 ms | 1.30 W | 0.184 J |

For that round, the ANE implementation used about **10.5x less active rail
power and 13.1x less incremental rail energy per window**, at 1.68x the latency.
The ANE rail itself averaged 0.515 W during the Core ML burst, versus almost
zero during the GPU burst. These are warmed, sustained-burst measurements,
not cold-start costs or whole-laptop battery-energy measurements.

The reversed-order round measured 273 ms and 0.190 J/window for Core ML, and
178 ms and 2.511 J/window for MLX. **Do not treat the second Core ML energy
estimate as an independent confirmation:** adjacent idle rail power rose from
0.679 W to 3.301 W, and GPU idle subtraction produced a negative component.
Process samples also showed increased background browser CPU activity, but
cannot assign the rail-power change to a particular process. The raw report
correctly marks the overall comparison `confounded`; only the first Core ML
condition is unflagged. The energy advantage is promising, but the precise
ratio is provisional and does not imply a 13x battery-life improvement.

Receipts, the selected candidate manifest, and the raw capture are preserved
under `cache/coreml/power/skew-comparison-1/`. The controller completed all four
conditions and shut both workers down. Conservative cumulative GPU accounting
reached **17.810 seconds of the authorized 20 seconds**, including the
13-second reserve for earlier work. Any later attempt must carry at least an
18-second reserve forward, rather than restarting the allowance.

### Earlier performance debugging: resident model and CPU fallback

The later resident-model experiment does **not** establish that ANE hardware
is intrinsically slow. `fuse.py` joins the converted stages and deduplicates
constant storage without loading the original full PyTorch graph. This
produced one 901 MiB package in about 17 seconds with a 505 MB conversion peak.
The loaded model fits within the 6 GiB process safety limit; that limit is
not an ANE hardware capacity limit.

However, that original mixed-precision fused model was not an accepted
replacement. Its partial validation completed only 12 synthetic cases before
the deadline, with maximum
absolute score error 0.003919 against the stricter fused-model gate of 0.002.
There were no cutoff changes in those cases, but full numerical parity has
not been established.

More importantly, a resident native run logged `Error plan build: -1` after
repeated ANE device-selection attempts. Prediction stack samples showed CPU
convolution, GELU and generic gather kernels rather than ANE execution stacks:
about 57% of prediction-thread samples were in CPU gather and 17% in CPU
activation/GELU. This is evidence of a failed accelerated plan and CPU
fallback, not a valid measurement of a fully ANE-executed fused model.
The preceding Espresso exception detail was redacted by macOS; the exact
reason for the plan failure remains unresolved. Successful prediction with
`CPU_AND_NE` alone must not be treated as successful ANE placement.

Independent profiling of one real 512-token transformer layer isolated another
bottleneck: approximately 80% of the original hybrid prediction-thread samples
were in `Espresso::gather_nd_kernel_cpu`. Row-wise indexing copies all heads
together rather than selecting individual elements from a four-dimensional
tensor. Its tensor selection is mathematically equivalent.

| Layer-0 configuration | Median background prediction |
| --- | --- |
| CPU only, original indexing | 116 ms |
| CPU/ANE, original indexing | 297 ms |
| CPU/ANE, row-wise indexing, mixed precision | 83 ms |
| CPU/ANE, row-wise indexing, all FP16 diagnostic | 48 ms |

At default scheduling, the original CPU-only and hybrid layer took about
26 ms and 64 ms respectively. Background scheduling magnifies the CPU
bottleneck. These are warmed single-layer diagnostics with deterministic
synthetic hidden states, not full-model latency or energy results. The row-wise
variant has not passed full-model numerical validation. The subsequent
gather-free (`skew`) FP16 candidate described above has. FP16 changes arithmetic,
unlike the indexing-only rewrites.

```sh
cache/coreml/bin/deckard-coreml \
  cache/coreml/gradient512/layer-00.mlpackage 512 \
  --profile-layer cpu-ane background 5
```

Use `cpu` or `default` to isolate device and scheduling effects. Export an
alternative layer with `--stage layer-00 --gather rowwise`, optionally adding
`--precision fp16` for the separate precision ablation.

Power workers inspect compute plans before readiness and refuse plans with no
ANE-preferred operations. This necessary check does not prove actual runtime
device use: the failing 24-layer mixed-precision stack still reported 888
ANE-preferred operations. Runtime tracing, not these counts, establishes the
successful candidate's ANE use. Compilation, inspection and initial loading
occur before background-scheduled warmup and measured inference. The later
resident-model power comparison is recorded above.

For graph-size diagnostics, `fuse.py --layer-count N` produces a hidden-to-hidden
stack accepted by `--profile-layer`, not a runnable classifier bundle.
`--layer-start` selects its first layer and `--no-share-constants` disables
cross-stage constant sharing for an independent ablation. Original mixed
stacks of 1, 2, 8, 12 and 16 layers completed; the 24-layer stack showed the
slow fallback path. These observations do not establish a specific hardware
capacity or segment-count limit. The underlying old-plan exception remains
redacted, but removing runtime gathers and FP32 transformer boundaries avoids
the failure in the complete candidate. Local diagnostics are preserved under
`cache/coreml/profile/`.

### Earlier streaming comparison

Enabling `CPU_AND_NE` is not evidence of lower battery consumption. A subsequent
administrator-authorized `powermetrics` capture collected 1,800 samples at
100 ms intervals, with nominal thermal pressure throughout. It compared the
same 512-token input in two reversed-order rounds, with five-second idle
windows before and after each condition and production-equivalent background
scheduling.

| Backend | Time per window | Active CPU+GPU+ANE rail power | Idle-subtracted rail energy per window |
| --- | --- | --- | --- |
| Native MLX q4 | 175-177 ms | 13.8-13.9 W | 2.15-2.33 J |
| Core ML CPU/ANE, streaming layers | 25.2-25.6 s | 2.0-2.5 W | 25.2-31.3 J, **confounded** |

There were six MLX requests in each one-second burst and one Core ML request
in each longer burst. These are a small feasibility sample, not a statistical
battery-life benchmark. Actual ANE rail activity was visible during Core ML
requests (approximately 0.19-0.22 J above adjacent idle per window).

**Do not interpret the Core ML energy column as process-attributed energy or
an established efficiency ratio.** GPU rail activity increased even during the
CPU/ANE-only condition, and idle CPU power drifted substantially. The second
Core ML condition had a negative idle-subtracted CPU component, another sign
of background variation. The reporter flags these conditions as confounded
and preserves negative components instead of hiding them. Whole-system rail
measurements cannot identify whether unrelated graphics activity, framework
loading, or another process caused a rise.

The first attempt to hold every Core ML stage resident exceeded the 6 GiB
process safety limit and was stopped. Consequently, the measured Core ML
path precompiles once but loads and releases each layer per request. Its
per-layer loading costs are included; compilation and compute-plan inspection
are excluded. MLX remains resident. This measures the current memory-bounded
rewrite, **not an optimized or purely ANE-resident model**. No battery advantage
has been established, and production continues to use MLX.

### Reproducing the measurement

Only run the local GPU baseline with explicit user approval: a remote GPU
cannot measure this Mac's energy consumption. The completed experiment stayed
within its authorized 20-second GPU allowance, including preparation. Both
workers enforce time bounds; the controller enforces a 6 GiB per-process
footprint limit.

```sh
NATIVE_CACHE=/path/to/native-build bash native-cli/coreml/build-power.sh
python3 native-cli/coreml/power_compare.py \
  --checkpoint "$MODEL_DIR/packed.safetensors" \
  --bundle cache/coreml/gradient512 --input input512.json \
  --output cache/coreml/power/new-comparison \
  --process-meter native-cli/build/bin/deckard-process-metrics
```

The controller writes `ready.json` after preparing both workers, then waits
for a power capture. In a separate interactive terminal, authorize only the
meter; **do not run the model/controller as root**:

```sh
sudo /usr/bin/powermetrics \
  --samplers cpu_power,gpu_power,ane_power,thermal \
  --sample-rate 100 --sample-count 1800 --buffer-size 0 --format plist \
  > cache/coreml/power/new-comparison/power.plist
```

Keep the Mac otherwise idle. Once both commands finish:

```sh
python3 native-cli/coreml/power_report.py cache/coreml/power/new-comparison
python3 -m unittest discover -s native-cli/coreml -p 'test_power.py'
```

`workload.json`, `power.plist`, and `report.json` preserve the timing, raw rail
samples, and interpretation. The successful measured run is in the ignored
`cache/coreml/power/comparison-3/` directory. Its GPU allowance conservatively
reserved nine seconds for an earlier preparation attempt; the final cumulative
allowance consumed was 11.61 seconds. The capture's timestamp-alignment interval
was under one millisecond. `--prior-gpu-seconds` carries an earlier attempt's
upper bound forward, and `--gpu-burst-ms` can shorten bursts without relaxing
the total allowance.
