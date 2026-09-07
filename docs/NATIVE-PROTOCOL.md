# Deckard 0.4.1 native messaging protocol v2 (Gradient)

Implemented by `native-cli/`; release users need no Python runtime.

Host name: `com.sgoedecke.deckard`. Chrome launches `deckard start` for the service
worker's `connectNative` port; this is a stdio host, not an HTTP daemon.
Each message is UTF-8 JSON preceded by a four-byte
unsigned length in native byte order. Stdout contains only these frames; stderr
contains error codes without page text.

The implementation limits each frame to 128 KiB, tighter than Chrome's limits.
It accepts only the documented fields. Malformed frames produce an error and
close the host; well-framed invalid requests produce an error reply.
EOF on stdin releases the process and its model/cache.

## Extension page authorization

Deckard v0.4.1 declares required HTTP/HTTPS host permissions. A missing saved
`enabled` preference defaults On only after Chrome confirms both grants;
explicit Off and malformed saved values remain Off. Runtime settings
normalization itself remains fail-closed. Revocation immediately disables
scanning and persists Off; neither upgrades nor restarts override saved Off.

The content-script/worker scanner contract is version **6**, independently of
native protocol v2. Every content request includes `scanner_version: 6`,
`protocol_version: 2`, and `page_url` captured from the isolated content script's
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
Old content scripts must reload; the native protocol, model identity, 50-word
minimum, and default threshold are unchanged by this scanner contract change.

## Requests

IDs are nonempty strings up to 128 characters.

```json
{"id":"health-1","type":"ping","protocol_version":2}
```

Ping does not load the model. The response reports runtime version, model
revision, whether a model is loaded, scheduling configuration, and input limits.
`ready` confirms the protocol/runtime installation, not a completed inference.
Full asset hashes are checked before the first tokenizer/model load or with
`deckard status`, not on lightweight ping requests.

```json
{"id":"block-1","type":"analyze","protocol_version":2,"text":"A passage of at least 50 words..."}
```

The text is limited to 20,000 Unicode characters. The host counts whitespace-
separated words and tokenizes the original text.
It scores at most four balanced windows of 510 content tokens each. Windows
have Gradient CLS=1 and SEP=2 added separately; no fixed-length padding is used.
Missing or incompatible protocol versions fail closed with
`extension_update_required`.

## Replies

```json
{
  "id": "block-1",
  "ok": true,
  "result": {
    "protocol_version": 2,
    "model": "ShantanuT01/gradient-ai-text-detector",
    "revision": "c2e8b6df87f8a211cbffb713fa9873a0c3a9713f",
    "policy": "gradient-q4-composite-v1-retrospective",
    "flag_threshold": 0.9824231167326641,
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
extension threshold (0.70–0.99, default 0.9824231167326641).
`min_score` is diagnostic, not an all-windows marking requirement.
Text is colored red, never collapsed or hidden.

The identity fields above, including `min_words: 50`, appear in **every successful result**, including
ping and skipped responses. Clients must validate them before consuming scores.
Older helpers without this word-limit identity must be updated with a matching Deckard release;
they are rejected rather than silently skipping 50-74-word passages.
The native `flag_threshold` identity field remains the fixed reference/default,
not the user's setting. The extension validates that identity before applying
its own cutoff; adjusting the slider never changes native requests or weights.
The default threshold is retrospective and experimental, not an independently validated
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
disconnect is observed. Reconnecting creates a new host and cache.
