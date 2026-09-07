import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { NativeQueue, validResult } from "../native-queue.js";
import { modelIdentity } from "./model-fixture.js";

const ready = { ...modelIdentity, status: "ready", model_loaded: false,
  runtime: "onnx", scheduling: "background", max_chars: 20000, max_chunks: 4, min_words: 50 };
const complete = { ...modelIdentity, status: "complete", score: 0.95, min_score: 0.9, max_score: 1,
  chunks: [{ index: 0, score: 0.95, tokens: 100, words: 80 }],
  words: 80, total_tokens: 100, analyzed_tokens: 100, truncated: false, cached: false };
function harness(options = {}) {
  const ports = [];
  const timers = new Map();
  const delays = new Map();
  let counter = 0;
  const queue = new NativeQueue(() => {
    const listeners = {};
    const port = {
      messages: [], disconnected: false,
      onMessage: { addListener: fn => { listeners.message = fn; } },
      onDisconnect: { addListener: fn => { listeners.disconnect = fn; } },
      postMessage: message => { port.messages.push(message); },
      disconnect: () => { port.disconnected = true; listeners.disconnect(); },
      reply: response => listeners.message(response),
      drop: () => listeners.disconnect(),
    };
    ports.push(port);
    return port;
  }, { ...options, setTimer: (fn, delay) => { timers.set(++counter, fn); delays.set(counter, delay); return counter; },
    clearTimer: id => { timers.delete(id); delays.delete(id); } });
  function reply(result = complete, ok = true) {
    const port = ports.at(-1);
    port.reply({ id: port.messages.at(-1).id, ok, ...(ok ? { result } : { error: result }) });
  }
  return { queue, ports, timers, delays, reply };
}

test("75-word helpers fail closed instead of silently skipping 50-word passages", () => {
  assert.equal(validResult("ping", ready), true);
  for (const min_words of [undefined, 75]) {
    assert.equal(validResult("ping", { ...ready, min_words }), false);
    assert.equal(validResult("analyze", { ...complete, min_words }), false);
    assert.equal(validResult("analyze", { ...modelIdentity, min_words, status: "skipped", reason: "too_short", words: 50 }), false);
  }
});

test("default timers retain the browser global receiver through requests and cleanup", async () => {
  const timers = new Map();
  const context = vm.createContext({ timers, DeckardCore: globalThis.DeckardCore });
  const source = fs.readFileSync(new URL("../native-queue.js", import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "").replace(/^export /gm, "");
  vm.runInContext(`
    "use strict";
    let timerId = 0;
    globalThis.setTimeout = function(callback, delay) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      timers.set(++timerId, { callback, delay });
      return timerId;
    };
    globalThis.clearTimeout = function(id) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      timers.delete(id);
    };
    ${source}
    globalThis.NativeQueue = NativeQueue;
  `, context);
  const h = harness();
  const queue = new context.NativeQueue(h.queue.connect);
  const ping = queue.request("ping");
  void ping.catch(() => {});
  assert.equal(h.ports.length, 1);
  assert.equal([...timers.values()][0].delay, 10000);
  h.reply(ready);
  await ping;
  assert.equal([...timers.values()][0].delay, 300000);
  [...timers.values()][0].callback();
  assert.equal(h.ports[0].disconnected, true);
  assert.equal(timers.size, 0);

  const analyze = queue.request("analyze", "test");
  const timedOut = assert.rejects(analyze, { code: "timeout" });
  assert.equal([...timers.values()][0].delay, 60000);
  [...timers.values()][0].callback();
  await timedOut;
  assert.equal(timers.size, 0);
  const retry = queue.request("ping");
  const cancelled = assert.rejects(retry, { code: "cancelled" });
  queue.disconnect();
  await cancelled;
  assert.equal(timers.size, 0);
});

test("one persistent port, one in-flight native request, FIFO", async () => {
  const h = harness();
  const first = h.queue.request("analyze", "first");
  const second = h.queue.request("ping");
  const third = h.queue.request("analyze", "third");
  assert.equal(h.ports.length, 1);
  assert.equal(h.ports[0].messages.length, 1);
  assert.equal(h.ports[0].messages[0].text, "first");
  h.reply();
  assert.deepEqual(await first, complete);
  assert.equal(h.ports[0].messages[1].type, "ping");
  h.reply(ready);
  assert.deepEqual(await second, ready);
  assert.equal(h.ports[0].messages[2].text, "third");
  h.reply();
  await third;
  assert.equal(h.ports.length, 1);
  assert.equal(h.timers.size, 1);
  assert.equal([...h.delays.values()][0], 300000);
});

test("bounded queue rejects overflow without sending it", async () => {
  const h = harness({ maxQueued: 1 });
  const a = h.queue.request("ping");
  const b = h.queue.request("ping");
  await assert.rejects(h.queue.request("ping"), { code: "queue_full" });
  h.reply(ready); await a;
  h.reply(ready); await b;
  assert.equal(h.ports[0].messages.length, 2);
});

test("native errors reject explicitly, next queued request still runs", async () => {
  const h = harness();
  const a = h.queue.request("analyze", "test");
  const rejected = assert.rejects(a, { code: "model_missing", message: "Install model." });
  const b = h.queue.request("ping");
  h.reply({ code: "model_missing", message: "Install model." }, false);
  await rejected;
  h.reply(ready);
  assert.equal((await b).status, "ready");
});

test("cancelled active request holds its slot; queued tab work is removed", async () => {
  const h = harness();
  const a = h.queue.request("analyze", "active", { tabId: 1 });
  const b = h.queue.request("analyze", "queued", { tabId: 1 });
  const c = h.queue.request("ping", undefined, { tabId: 2 });
  const rejected = [assert.rejects(a, { code: "cancelled" }), assert.rejects(b, { code: "cancelled" })];
  h.queue.cancel(owner => owner.tabId === 1);
  await Promise.all(rejected);
  assert.equal(h.ports[0].messages.length, 1);
  h.reply();
  assert.equal(h.ports[0].messages.length, 2);
  assert.equal(h.ports[0].messages[1].type, "ping");
  h.reply(ready);
  await c;
});

test("timeout disconnects and rejects all jobs; no automatic reconnect", async () => {
  const h = harness();
  const a = h.queue.request("analyze", "active");
  const b = h.queue.request("ping");
  const rejected = [assert.rejects(a, { code: "timeout" }), assert.rejects(b, { code: "timeout" })];
  h.timers.values().next().value();
  await Promise.all(rejected);
  assert.equal(h.ports[0].disconnected, true);
  assert.equal(h.ports.length, 1);
  const retry = h.queue.request("ping");
  assert.equal(h.ports.length, 2);
  h.reply(ready);
  await retry;
});

test("disconnect rejects queued jobs; stale old-port messages cannot affect retry", async () => {
  const h = harness();
  const a = h.queue.request("ping");
  const b = h.queue.request("ping");
  const rejected = [assert.rejects(a, { code: "disconnected" }), assert.rejects(b, { code: "disconnected" })];
  h.ports[0].drop();
  await Promise.all(rejected);
  assert.equal(h.ports.length, 1);
  const retry = h.queue.request("ping");
  h.ports[0].reply({ id: "bad", ok: true, result: ready });
  h.reply(ready);
  await retry;
});

test("mismatched IDs and malformed successes fail closed", async () => {
  for (const response of [{ id: "wrong", ok: true, result: ready }, { ok: true, result: { score: 1 } },
    { ok: false, error: "bad" }, { ok: "yes", result: ready }]) {
    const h = harness();
    const request = h.queue.request("ping");
    const rejected = assert.rejects(request, { code: "protocol_error" });
    h.ports[0].reply({ id: h.ports[0].messages[0].id, ...response });
    await rejected;
    assert.equal(h.ports[0].disconnected, true);
  }
});

test("validates request size in Unicode characters, and result ranges", async () => {
  const h = harness();
  await assert.rejects(h.queue.request("analyze", "a".repeat(20001)), { code: "invalid_request" });
  await assert.rejects(h.queue.request("analyze", " "), { code: "invalid_request" });
  await assert.rejects(h.queue.request("unknown"), { code: "invalid_request" });
  const p = h.queue.request("analyze", "😀".repeat(20000));
  h.reply();
  await p;
  assert.equal(validResult("analyze", complete), true);
  assert.equal(validResult("analyze", { ...complete, min_score: 1 }), false);
  assert.equal(validResult("analyze", { ...complete, score: NaN }), false);
  assert.equal(validResult("analyze", { ...modelIdentity, status: "skipped", reason: "too_short", words: 5 }), true);
  assert.equal(validResult("analyze", { ...modelIdentity, status: "skipped", reason: "too_short_after_chunking", words: 80 }), true);
  assert.equal(h.ports[0].messages[0].protocol_version, 2);
  assert.equal(validResult("analyze", { ...complete, protocol_version: 1 }), false);
  assert.equal(validResult("analyze", { ...complete, score: 0.9 - Number.EPSILON, min_score: 0.9 }), true);
});

test("connection and send failures reject without retry loops", async () => {
  const queue = new NativeQueue(() => { throw new Error("Missing host"); });
  await assert.rejects(queue.request("ping"), { code: "connect_failed" });
  const h = harness();
  const a = h.queue.request("ping");
  h.reply(ready); await a;
  h.ports[0].postMessage = () => { throw new Error("Broken pipe"); };
  await assert.rejects(h.queue.request("ping"), { code: "send_failed" });
  assert.equal(h.ports[0].disconnected, true);
});

test("five idle minutes disconnect the helper without reconnecting", async () => {
  const h = harness();
  const request = h.queue.request("ping");
  h.reply(ready); await request;
  assert.equal([...h.delays.values()][0], 300000);
  h.timers.values().next().value();
  assert.equal(h.ports[0].disconnected, true);
  assert.equal(h.queue.port, null);
  assert.equal(h.timers.size, 0);
  assert.equal(h.ports.length, 1);
  const retry = h.queue.request("ping");
  assert.equal(h.ports.length, 2);
  h.reply(ready); await retry;
});

test("new work cancels idle expiry and cancelled active work is not considered idle", async () => {
  const h = harness();
  const ping = h.queue.request("ping");
  h.reply(ready); await ping;
  const oldIdleTimer = h.timers.values().next().value;
  const analyze = h.queue.request("analyze", "test", { tabId: 1 });
  assert.equal([...h.delays.values()][0], 60000);
  oldIdleTimer();
  assert.equal(h.ports[0].disconnected, false);
  const rejected = assert.rejects(analyze, { code: "cancelled" });
  h.queue.cancel(owner => owner.tabId === 1);
  await rejected;
  assert.equal([...h.delays.values()][0], 60000);
  h.reply();
  assert.equal([...h.delays.values()][0], 300000);
});

test("explicit disconnect rejects all work, clears timers, and permits a later manual reconnect", async () => {
  const h = harness();
  const active = h.queue.request("analyze", "active");
  const queued = h.queue.request("ping");
  const rejected = [assert.rejects(active, { code: "cancelled" }), assert.rejects(queued, { code: "cancelled" })];
  h.queue.disconnect();
  await Promise.all(rejected);
  assert.equal(h.ports[0].disconnected, true);
  assert.equal(h.timers.size, 0);
  const retry = h.queue.request("ping");
  assert.equal(h.ports.length, 2);
  h.reply(ready); await retry;
});
