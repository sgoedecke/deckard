# Deckard 0.6.0 native messaging protocol v3 (Gradient)

Implemented by `native-cli/`; release users need no Python, torch, or Xcode.
This describes the v0.6.0 Core ML release contract.

Host name: `com.sgoedecke.deckard`. Chrome launches `deckard start` for the service
worker's `connectNative` port; this is a stdio host, not an HTTP daemon.
Each message is UTF-8 JSON preceded by a four-byte
unsigned length in native byte order. Stdout contains only these frames; stderr
contains error codes without page text.

The implementation limits incoming frames to 4 MiB; responses remain below Chrome's 1 MiB limit.
It accepts only the documented fields. Malformed frames produce an error and
close the host; well-framed invalid requests produce an error reply.
EOF on stdin releases the process, its resident model, and its in-memory score
cache. The on-disk compiled-model cache persists across host lifetimes.

## Runtime and assets

Production metadata reports `runtime: "native-coreml"` and
`scheduling: "default"`. The extension accepts both default scheduling and
legacy `background` metadata during upgrades; this does not change the new
helper's scheduling policy. Reload the installed extension at
`chrome://extensions` after upgrading so its updated protocol validation is
active. Public Core ML `CPU_AND_NE`
(`MLComputeUnitsCPUAndNeuralEngine`) limits execution to CPU and Neural Engine.
There are no private ANE hooks or silent GPU fallback. Failure to verify,
compile, or load the model is surfaced as an error, never an alternate backend.

The model is a single resident, fixed-512-token FP16 package derived from the
decoded canonical q4 weights. FP16 does not restore original FP32 weights or
mean 4-bit ANE arithmetic. The tokenizer, scoring policy, protocol version and
reference cutoff remain unchanged; policy identity is still
`gradient-q4-two-scale-v1`.

`deckard install --model-dir DIR` and `deckard verify --model DIR` take a
directory containing `model.mlpackage/` and `tokenizer.json`. The package's
`Manifest.json`, `Data/com.apple.CoreML/model.mlmodel`,
`Data/com.apple.CoreML/weights/weight.bin`, and the tokenizer are SHA-256-pinned
by `native-cli/model-assets.json` at build time. A release may include a copy
under `share/licenses/model-assets.json` for installed provenance; runtime verification uses
embedded pins, not mutable pins from that sidecar.

The first actual model use compiles and loads locally. Later starts reuse a
validated compiled artifact in `~/Library/Caches/Deckard/coreml`, keyed by model
artifact, macOS build, and hardware. This is separate from the bounded
in-memory score cache below and contains no page text. Installation and ping
do not require inference. The host keeps one model loaded until it exits.

## Extension page authorization

Deckard declares required HTTP/HTTPS host permissions. A missing saved
`enabled` preference defaults On only after Chrome confirms both grants;
explicit Off and malformed saved values remain Off. Runtime settings
normalization itself remains fail-closed. Revocation immediately disables
scanning and persists Off; neither upgrades nor restarts override saved Off.

The content-script/worker scanner contract is version **7**, independently of
native protocol v3. Every content request includes `scanner_version: 7`,
`protocol_version: 3`, and `page_url` captured from the isolated content script's
live `location.href`. Chrome's `MessageSender.url` can remain the original
document URL after same-document SPA navigation; it is used for the same-origin
check, not as the current page URL.

Before accepting an enabled configuration request, starting a run, or authorizing
run operations/replies, the worker checks the current non-private HTTP(S) tab
and probes its top frame with `scripting.executeScript` in the isolated world.
Chrome's returned frame ID and document ID and the probed URL must match the
sender/run and requested URL; the tab URL is rechecked after the probe. A stale
request cannot replace a newer run. Off, permission revocation, and navigation
invalidate pending authorizations. No additional permissions are required.
Old helpers, extensions and content scripts must be updated/reloaded together.
The 50-word minimum and two-scale policy are unchanged; the policy defaults
to 0.97. The Core ML package retains the canonical q4-derived model lineage,
with FP16 computation. Existing explicitly saved thresholds remain unchanged.

## Requests

IDs are nonempty strings up to 128 characters.

```json
{"id":"health-1","type":"ping","protocol_version":3}
```

Ping does not load the model. The response reports runtime version, model
revision, whether a model is loaded, scheduling configuration, and input limits.
`ready` confirms the protocol/runtime installation, not a completed inference.
The tokenizer hash is checked before tokenization; all model asset hashes are
checked before the first model/cache load or with `deckard status`, not on
lightweight ping or tokenizer-only planning requests.

```json
{"id":"block-1","type":"analyze","protocol_version":3,"text":"A passage of at least 50 words..."}
```

The text is limited to 20,000 Unicode characters. The host counts whitespace-
separated words and tokenizes the original text.
It scores at most four balanced windows of 510 content tokens each. Windows
have Gradient CLS=1 and SEP=2 added separately. The Core ML runtime right-pads
shorter windows to 512 positions with an attention mask; padding does not
change reported token counts or the 510-content-token window policy.
Missing or incompatible protocol versions fail closed with
`extension_update_required`.

### Larger-context planning

```json
{"id":"plan-1","type":"plan","protocol_version":3,"texts":["Ordered eligible prose for one source..."]}
```

One bounded request plans all current source groups with the same native tokenizer,
without loading the model. `texts` has 1–500 nonempty strings, at most 500,000
Unicode characters and 25,000 words in total. Local passage strings are joined
verbatim with two newlines. Explicit `article`, `role=article`, comment microdata,
`data-comment-id`, and `.comment` ancestors delimit sources; unmarked authors
and semantic topic changes cannot reliably be detected.

The planner greedily binary-searches word boundaries for slices near 510 content
tokens. Slices are verbatim, nonoverlapping and cover the complete supplied text.
If the final slice cannot be scored completely, the last two are rebalanced at
the earliest word boundary minimizing token-count imbalance, provided both fit
510 tokens and meet the native decoded-word minimum. Oversized words remain
verbatim and may abstain. No whole-document four-window cap is imposed.

The identity-bearing reply has `status: "planned"` and `groups`, one array per
input, of `{start_word, end_word, tokens, complete}`. Word ordinals are zero-based,
end-exclusive; clients validate ordered, gap-free coverage before mapping to DOM
ranges. No UTF-8 byte offsets are treated as JavaScript UTF-16 offsets.
Planning stops explicitly at 20,000 tokenizer operations or the 60-second deadline.

Local extraction has a cumulative 25,000-word budget per page route. Context
planning and context inference each have a separate cumulative 25,000-word
ceiling across revisions; failed/stale work also spends its budget. Mutations can
replan the current partition only while that ceiling permits. Unchanged plans,
On/Off and threshold changes reuse page-local results; exact request strings
already scored by either pass reuse their result. Only current-revision context
windows are retained. Ordinary anchors do not reset budgets; new SPA routes do.
Progress counts unique local coverage separately from local/context requests.
Overlapping flags form one finding; its displayed word count is the largest
contributing region, not a sum that double-counts words. Context findings apply
to a region, not independently to each paragraph.

## Replies

```json
{
  "id": "block-1",
  "ok": true,
  "result": {
    "protocol_version": 3,
    "model": "ShantanuT01/gradient-ai-text-detector",
    "revision": "c2e8b6df87f8a211cbffb713fa9873a0c3a9713f",
    "policy": "gradient-q4-two-scale-v1",
    "flag_threshold": 0.97,
    "experimental": true,
    "min_words": 50,
    "status": "complete",
    "score": 0.99,
    "min_score": 0.91,
    "max_score": 0.99,
    "chunks": [
      {"index": 0, "score": 0.91, "tokens": 300, "words": 180},
      {"index": 1, "score": 0.99, "tokens": 300, "words": 170}
    ],
    "words": 350,
    "total_tokens": 600,
    "analyzed_tokens": 600,
    "truncated": false,
    "cached": false,
    "duration_ms": 1900
  }
}
```

These numbers illustrate the schema, not a real detection result.
`score` equals `max_score`: the maximum sigmoid logit over scored windows.
It is not a calibrated AI-authorship probability. `complete` describes coverage
of the supplied block, not of the entire webpage. Marking requires complete
coverage, every chunk at least 50 words, and `max_score` at least the user's
extension threshold (0.70–0.99, default 0.97).
`min_score` is diagnostic, not an all-windows marking requirement.
Text is colored red, never collapsed or hidden.

The identity fields above, including `min_words: 50`, appear in **every successful result**, including
ping and skipped responses. Clients must validate them before consuming scores.
Older helpers without this word-limit identity must be updated with a matching Deckard release;
they are rejected rather than silently skipping 50-74-word passages.
The native `flag_threshold` identity field remains the fixed reference/default,
not the user's setting. The extension validates that identity before applying
its own cutoff; adjusting the slider never changes native requests or weights.
The 97% default is a user-selected experimental cutoff, not a calibrated
guarantee of at most 1% browsing false positives.

`partial` means the token limit was exceeded or one or more windows were shorter
than 50 decoded words; `reason` is `chunk_limit` or `short_chunk`. The response
contains only actually scored windows. **Never mark partial coverage.**

`skipped` contains `reason` (`too_short` or `too_short_after_chunking`), `words`,
and `cached: false`, but no score. **Never interpret skipped as human or AI.**

Repeated identical text may hit a 64-entry in-memory hash/result cache.
No input text is stored in that cache or written to disk. The extension stores
On/Off and the global threshold preference locally. Threshold changes reapply
valid page-local cached results without another native inference.

```json
{
  "id": "block-1",
  "ok": false,
  "error": {"code": "missing_assets", "message": "Model assets are missing. Run deckard install."}
}
```

The extension must display errors and leave content visible. Protocol errors
without a valid request ID use `id: null`. Unexpected native failures exit the
process; the extension must surface the disconnect, reject pending work, and
avoid automatic retry loops.

## Cancellation and lifetime

There are no unsolicited events or protocol-level cancellation messages.
The extension owns a serialized queue and sends at most one analysis at a time.
It can drop queued requests and ignore stale results after navigation or text
changes. Disconnecting the native port terminates the connection; Chrome owns
the child process lifetime. An in-flight operation may briefly finish before the
disconnect is observed. Reconnecting creates a new host and in-memory score
cache, reusing the validated disk compilation cache when compatible.
