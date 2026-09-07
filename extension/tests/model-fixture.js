import "../core.js";
const C = globalThis.AIHiderCore;
export const modelIdentity = Object.freeze({
  protocol_version: C.PROTOCOL_VERSION, model: C.MODEL, revision: C.MODEL_REVISION,
  policy: C.POLICY, flag_threshold: C.FLAG_THRESHOLD, experimental: true, min_words: C.MIN_WORDS,
});
