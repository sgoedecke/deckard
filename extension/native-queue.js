export class NativeError extends Error {
  constructor(code, message) { super(message); this.name = "NativeError"; this.code = code; }
}

function validScore(value) { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1; }
function nonnegative(value) { return Number.isInteger(value) && value >= 0; }
export function validResult(type, result) {
  if (!nativeCore.validModelIdentity(result)) return false;
  if (type === "ping") return result.status === "ready" && typeof result.model_loaded === "boolean"
    && ["model", "revision", "runtime"].every(key => typeof result[key] === "string")
    && result.scheduling === "background" && result.max_chars === 20000
    && result.max_chunks === 4 && result.min_words === nativeCore.MIN_WORDS;
  if (result.status === "skipped") return ["too_short", "too_short_after_chunking"].includes(result.reason)
    && nonnegative(result.words);
  return ["complete", "partial"].includes(result.status)
    && ["score", "min_score", "max_score"].every(key => validScore(result[key]))
    && result.min_score <= result.score + 1e-12 && result.score <= result.max_score + 1e-12
    && Array.isArray(result.chunks) && result.chunks.length > 0 && result.chunks.length <= 4
    && result.chunks.every(chunk => chunk && nonnegative(chunk.index) && validScore(chunk.score)
      && nonnegative(chunk.tokens) && nonnegative(chunk.words))
    && ["words", "total_tokens", "analyzed_tokens"].every(key => nonnegative(result[key]))
    && typeof result.truncated === "boolean" && typeof result.cached === "boolean";
}

export class NativeQueue {
  constructor(connect, { maxQueued = 24, timeout = 60000, pingTimeout = 10000, idleTimeout = 300000,
    setTimer = (callback, delay) => globalThis.setTimeout(callback, delay),
    clearTimer = id => globalThis.clearTimeout(id) } = {}) {
    Object.assign(this, { connect, maxQueued, timeout, pingTimeout, idleTimeout, setTimer, clearTimer });
    this.port = null;
    this.idleTimer = null;
    this.active = null;
    this.queue = [];
    this.sequence = 0;
    this.session = Math.random().toString(36).slice(2);
  }
  request(type, text, owner = {}) {
    if (!["ping", "analyze"].includes(type) || (type === "analyze"
      && (typeof text !== "string" || [...text].length > 20000 || !text.trim()))) {
      return Promise.reject(new NativeError("invalid_request", "Invalid native request."));
    }
    if (this.active && this.queue.length >= this.maxQueued) {
      return Promise.reject(new NativeError("queue_full", "Local analysis queue is full. Try again later."));
    }
    return new Promise((resolve, reject) => {
      const job = { id: `${this.session}-${++this.sequence}`, type, owner, resolve, reject, cancelled: false };
      if (type === "analyze") job.text = text;
      this.queue.push(job);
      this.pump();
    });
  }
  cancel(predicate, message = "Analysis cancelled.") {
    const error = new NativeError("cancelled", message);
    this.queue = this.queue.filter(job => {
      if (!predicate(job.owner)) return true;
      job.reject(error);
      return false;
    });
    if (this.active && predicate(this.active.owner) && !this.active.cancelled) {
      this.active.cancelled = true;
      this.active.reject(error);
      // The helper cannot interrupt inference. Keep this slot until its response arrives.
      delete this.active.text;
    }
  }
  failAll(error, disconnect = false) {
    this.clearTimer(this.idleTimer);
    this.idleTimer = null;
    const port = this.port;
    this.port = null;
    if (this.active) {
      this.clearTimer(this.active.timer);
      this.active.reject(error);
      this.active = null;
    }
    for (const job of this.queue.splice(0)) job.reject(error);
    if (disconnect && port) {
      try { port.disconnect(); } catch { /* Already disconnected. */ }
    }
  }
  disconnect() {
    this.failAll(new NativeError("cancelled", "Helper disconnected."), true);
  }
  pump() {
    if (this.active) return;
    this.clearTimer(this.idleTimer);
    this.idleTimer = null;
    if (!this.queue.length) {
      if (this.port) {
        const port = this.port;
        this.idleTimer = this.setTimer(() => {
          if (this.port === port && !this.active && !this.queue.length) this.disconnect();
        }, this.idleTimeout);
      }
      return;
    }
    if (!this.port) {
      try {
        const port = this.connect();
        this.port = port;
        port.onMessage.addListener(message => { if (this.port === port) this.receive(message); });
        port.onDisconnect.addListener(() => {
          if (this.port !== port) return;
          const message = port.error?.message || globalThis.chrome?.runtime?.lastError?.message
            || "Native helper disconnected. Check installation, then turn Off and On to retry.";
          this.failAll(new NativeError("disconnected", message));
        });
      } catch (error) {
        this.failAll(new NativeError("connect_failed", error.message || "Could not connect to native helper."));
        return;
      }
    }
    const job = this.queue.shift();
    this.active = job;
    job.timer = this.setTimer(() => {
      this.failAll(new NativeError("timeout", "Local helper timed out. Pending work was cancelled; turn Off and On to retry."), true);
    }, job.type === "ping" ? this.pingTimeout : this.timeout);
    const message = { id: job.id, type: job.type, protocol_version: nativeCore.PROTOCOL_VERSION };
    if (job.type === "analyze") message.text = job.text;
    delete job.text;
    try { this.port.postMessage(message); } catch (error) {
      this.failAll(new NativeError("send_failed", error.message || "Native send failed."), true);
    }
  }
  receive(message) {
    const job = this.active;
    if (!job || !message || message.id !== job.id || typeof message.ok !== "boolean") {
      this.failAll(new NativeError("protocol_error", "Unexpected native response."), true);
      return;
    }
    if ((message.ok && !validResult(job.type, message.result))
      || (!message.ok && (!message.error || typeof message.error.code !== "string"
        || typeof message.error.message !== "string"))) {
      this.failAll(new NativeError("protocol_error",
        "Malformed or incompatible native response. Update Deckard, then reload the extension and page."), true);
      return;
    }
    this.clearTimer(job.timer);
    this.active = null;
    if (message.ok) job.resolve(message.result);
    else job.reject(new NativeError(message.error.code, message.error.message));
    this.pump();
  }
}
import "./core.js";

const nativeCore = globalThis.DeckardCore;
