import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { NativeQueue, NativeError } from "../native-queue.js";
import { modelIdentity } from "./model-fixture.js";

const coreSource = fs.readFileSync(new URL("../core.js", import.meta.url), "utf8");
const workerSource = fs.readFileSync(new URL("../service-worker.js", import.meta.url), "utf8")
  .replace(/^import .*;\n/gm, "");
const origins = ["http://*/*", "https://*/*"];
function event() {
  const listeners = [];
  return { addListener: fn => listeners.push(fn), fire: (...args) => listeners.forEach(fn => fn(...args)), listeners };
}
async function harness(initial = {}, options = {}) {
  const events = { message: event(), removed: event(), updated: event(), permissions: event() };
  const stored = { deckardSettings: initial, ...(options.flagThreshold !== undefined ? { deckardFlagThreshold: options.flagThreshold } : {}) };
  const granted = new Set(options.grants || (initial.enabled ? origins : []));
  const tabs = new Map((options.tabs || [{ id: 1, url: "https://example.com/article", incognito: false }])
    .map(tab => [tab.id, tab]));
  const documents = new Map([...tabs.values()].map(tab => [tab.id,
    { documentId: `document-${tab.id}`, frameId: 0, url: tab.url }]));
  const scripts = new Map();
  const messages = [];
  const ports = [];
  const injections = [];
  const probes = [];
  const badges = new Map();
  const actionCalls = [];
  const action = Object.fromEntries(["setBadgeText", "setBadgeBackgroundColor", "setTitle"].map(method =>
    [method, async fields => {
      actionCalls.push({ method, ...fields });
      badges.set(fields.tabId, { ...badges.get(fields.tabId), ...fields });
    }]));
  const chrome = {
    action,
    runtime: {
      id: "test-id", getURL: path => `chrome-extension://test-id/${path}`,
      onMessage: events.message, onInstalled: event(), onStartup: event(),
      connectNative: name => {
        assert.equal(name, "com.sgoedecke.deckard");
        const onMessage = event(), onDisconnect = event();
        const port = { onMessage, onDisconnect, sent: [], postMessage: message => port.sent.push(message),
          disconnect: () => { port.disconnected = true; onDisconnect.fire(); } };
        ports.push(port);
        return port;
      },
    },
    storage: { local: {
      get: async () => options.initialRead || stored,
      set: async value => Object.assign(stored, value),
    } },
    permissions: {
      contains: async ({ origins }) => origins.every(origin => granted.has(origin)),
      remove: async ({ origins }) => { origins.forEach(origin => granted.delete(origin)); return true; },
      onRemoved: events.permissions,
    },
    scripting: {
      getRegisteredContentScripts: async () => [...scripts.values()],
      unregisterContentScripts: async ({ ids }) => ids.forEach(id => scripts.delete(id)),
      registerContentScripts: async entries => entries.forEach(script => scripts.set(script.id, script)),
      executeScript: async entry => {
        if (entry.files) { injections.push(entry); return []; }
        probes.push(entry);
        assert.equal(entry.world, "ISOLATED");
        assert.deepEqual(Array.from(entry.target.frameIds), [0]);
        const document = documents.get(entry.target.tabId);
        return document ? [{ documentId: document.documentId, frameId: document.frameId,
          result: vm.runInNewContext(`(${entry.func.toString()})()`, { location: { href: document.url } }) }] : [];
      },
    },
    tabs: {
      query: async () => [...tabs.values()],
      get: async id => tabs.get(id),
      sendMessage: async (id, message, target) => {
        messages.push({ id, message, target });
        return options.reply ? options.reply(id, message, target) : { state: "starting" };
      },
      onRemoved: events.removed, onUpdated: events.updated,
    },
  };
  const context = vm.createContext({ chrome, console, URL, crypto: globalThis.crypto, NativeError,
    NativeQueue: class extends NativeQueue {
      constructor(connect) { super(connect, { setTimer: () => 1, clearTimer: () => {} }); }
    } });
  vm.runInContext(coreSource, context);
  vm.runInContext(workerSource, context);
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
  await settle();
  const popup = { id: "test-id", url: "chrome-extension://test-id/popup.html" };
  const content = { id: "test-id", tab: tabs.get(1), frameId: 0, documentId: "document-1", documentLifecycle: "active",
    url: "https://example.com/article" };
  let progressSequence = 0;
  const send = (message, sender = popup) => new Promise(resolve =>
    events.message.listeners[0]({ protocol_version: 2, scanner_version: 6, page_url: sender.url, ...message,
      ...(message.type === "PAGE_PROGRESS" ? { status: { sequence: ++progressSequence, ...message.status } } : {}),
    }, sender, resolve));
  return { chrome, events, stored, granted, tabs, documents, scripts, messages, ports, injections, probes,
    send, popup, content, settle, badges, actionCalls };
}

test("manifest declares required host access but denied access keeps startup Off without contacting helper", async () => {
  const manifest = JSON.parse(fs.readFileSync(new URL("../manifest.json", import.meta.url)));
  assert.deepEqual(manifest.host_permissions, origins);
  assert.equal(manifest.optional_host_permissions, undefined);
  assert.deepEqual(manifest.permissions, ["scripting", "storage", "nativeMessaging"]);
  assert.equal(manifest.incognito, "not_allowed");
  const h = await harness();
  assert.equal(h.ports.length, 0);
  assert.equal(h.scripts.size, 0);
  const response = await h.send({ type: "GET_SETTINGS" });
  assert.equal(response.result.enabled, false);
  assert.equal(h.injections.length, 0);
});

test("fresh installs default On only with both host grants and persist the preference", async () => {
  for (const initialRead of [{}, { deckardSettings: {} }]) {
    const h = await harness({}, { initialRead, grants: origins });
    assert.equal((await h.send({ type: "GET_SETTINGS" })).result.enabled, true);
    assert.equal((await h.send({ type: "GET_CONFIG" }, h.content)).result.enabled, true);
    assert.equal(h.stored.deckardSettings.enabled, true);
    assert.equal(h.scripts.size, 1);
    assert.equal(h.injections.length, 1);
    assert.equal(h.ports.length, 0, "startup alone does not contact the native helper");
  }
  for (const grants of [[], [origins[0]], [origins[1]]]) {
    const h = await harness({}, { grants });
    assert.equal((await h.send({ type: "GET_SETTINGS" })).result.enabled, false);
    assert.equal(h.stored.deckardSettings.enabled, false);
    assert.equal(h.injections.length, 0);
    assert.equal(h.ports.length, 0);
  }
});

test("saved Off and invalid enabled values never become On during upgrade or restart", async () => {
  for (const enabled of [false, null, "true", 1]) {
    const h = await harness({ enabled }, { grants: origins });
    assert.equal((await h.send({ type: "GET_SETTINGS" })).result.enabled, false);
    assert.equal(h.stored.deckardSettings.enabled, false);
    assert.equal(h.injections.length, 0);
    assert.equal(h.ports.length, 0);
  }
});

test("Deckard uses its own storage keys and leaves unrelated legacy settings untouched", async () => {
  const legacy = { settings: { enabled: true }, flagThreshold: 0.7 };
  const h = await harness({}, { initialRead: legacy, grants: origins });
  Object.assign(h.stored, legacy);
  assert.equal((await h.send({ type: "GET_SETTINGS" })).result.enabled, true);
  assert.equal((await h.send({ type: "GET_SETTINGS" })).result.flagThreshold, 0.9824231167326641);
  await h.send({ type: "SET_ENABLED", enabled: true });
  await h.send({ type: "SET_THRESHOLD", flagThreshold: 0.85 });
  assert.equal(h.stored.deckardSettings.enabled, true);
  assert.equal(h.stored.deckardFlagThreshold, 0.85);
  assert.deepEqual(h.stored.settings, legacy.settings);
  assert.equal(h.stored.flagThreshold, legacy.flagThreshold);
  assert.ok([...h.scripts.keys()].every(id => id.startsWith("deckard-")));
});

test("threshold preferences persist independently of On/Off and notify active documents without inference", async () => {
  const h = await harness({ enabled: true }, { flagThreshold: 0.85 });
  assert.equal((await h.send({ type: "GET_SETTINGS" })).result.flagThreshold, 0.85);
  assert.equal((await h.send({ type: "GET_CONFIG" }, h.content)).result.flagThreshold, 0.85);
  await h.send({ type: "BEGIN_SCAN", runId: "run" }, h.content);
  const result = await h.send({ type: "SET_THRESHOLD", flagThreshold: 0.7 });
  assert.equal(result.result.flagThreshold, 0.7);
  assert.equal(h.stored.deckardFlagThreshold, 0.7);
  assert.ok(h.messages.some(entry => entry.message.type === "SETTINGS_CHANGED" && entry.target.documentId === "document-1"));
  await h.send({ type: "SET_ENABLED", enabled: false });
  assert.equal(h.stored.deckardFlagThreshold, 0.7);
  assert.equal((await h.send({ type: "GET_SETTINGS" })).result.flagThreshold, 0.7);
  assert.equal(h.ports.length, 0);
});

test("invalid or failed threshold writes never change the active preference", async () => {
  const h = await harness({}, { flagThreshold: 0.85 });
  for (const value of [0.69, 1, "0.8", null, NaN]) {
    assert.equal((await h.send({ type: "SET_THRESHOLD", flagThreshold: value })).error.code, "invalid_request");
  }
  assert.equal((await h.send({ type: "SET_THRESHOLD", flagThreshold: 0.8 }, h.content)).ok, false);
  h.chrome.storage.local.set = async () => { throw new Error("Write failed"); };
  assert.equal((await h.send({ type: "SET_THRESHOLD", flagThreshold: 0.8 })).ok, false);
  assert.equal((await h.send({ type: "GET_SETTINGS" })).result.flagThreshold, 0.85);
  assert.equal(h.stored.deckardFlagThreshold, 0.85);
});

test("a frozen tab cannot block threshold saving or switching Off", async () => {
  const h = await harness({ enabled: true });
  await h.send({ type: "BEGIN_SCAN", runId: "run" }, h.content);
  const original = h.chrome.tabs.sendMessage;
  h.chrome.tabs.sendMessage = (id, message, target) => message.type === "SETTINGS_CHANGED"
    ? new Promise(() => {}) : original(id, message, target);
  assert.equal((await h.send({ type: "SET_THRESHOLD", flagThreshold: 0.9 })).ok, true);
  assert.equal((await h.send({ type: "SET_ENABLED", enabled: false })).result.enabled, false);
  assert.equal(h.stored.deckardFlagThreshold, 0.9);
});

test("out-of-order progress authorization cannot restore an old scanning badge", async () => {
  const h = await harness({ enabled: true });
  await h.send({ type: "BEGIN_SCAN", runId: "run" }, h.content);
  const contains = h.chrome.permissions.contains;
  let release;
  h.chrome.permissions.contains = () => new Promise(resolve => { release = resolve; });
  const old = h.send({ type: "PAGE_PROGRESS", runId: "run", status: progress({ state: "scanning", sequence: 1 }) }, h.content);
  await h.settle();
  h.chrome.permissions.contains = contains;
  await h.send({ type: "PAGE_PROGRESS", runId: "run", status: progress({ sequence: 2 }) }, h.content);
  release(true);
  assert.equal((await old).result.updated, false);
  await h.settle();
  assert.equal(h.badges.get(1).text, "0");
  assert.equal((await h.send({ type: "PAGE_PROGRESS", runId: "run", status: progress({ sequence: 0 }) }, h.content)).error.code, "invalid_request");
});

test("validates extension identity, popup URL, frame, scheme, and private mode", async () => {
  const h = await harness();
  for (const sender of [
    { ...h.popup, id: "other" }, { ...h.popup, url: "chrome-extension://test-id/other.html" },
    { ...h.content, frameId: 1 }, { ...h.content, url: "chrome://settings" },
    { ...h.content, documentId: undefined }, { ...h.content, documentLifecycle: "prerender" },
    { ...h.content, tab: { ...h.content.tab, incognito: true } },
  ]) {
    assert.equal((await h.send({ type: "PING" }, sender)).error.code, "invalid_sender");
  }
  assert.equal((await h.send({ type: "PING" }, h.content)).error.code, "invalid_request");
  assert.equal((await h.send({ type: "BOGUS" })).ok, false);
  assert.equal(h.ports.length, 0);
});

test("analysis requires a current document-bound scan, navigation cancels native jobs", async () => {
  const h = await harness({ enabled: true });
  const analyze = { type: "ANALYZE", runId: "run-1", text: "private page text" };
  assert.equal((await h.send(analyze, h.content)).error.code, "cancelled");
  assert.equal((await h.send({ type: "BEGIN_SCAN", runId: "run-1" }, h.content)).ok, true);
  assert.equal((await h.send(analyze, { ...h.content, documentId: "old-document" })).error.code, "cancelled");
  const active = h.send(analyze, h.content);
  const queued = h.send(analyze, h.content);
  await h.settle();
  assert.equal(h.ports[0].sent.length, 1);
  h.events.updated.fire(1, { status: "loading" });
  assert.ok(h.messages.some(entry => entry.message.type === "NAVIGATED"
    && entry.message.cancelledRunId === "run-1"));
  assert.equal((await active).error.code, "cancelled");
  assert.equal((await queued).error.code, "cancelled");
  assert.equal((await h.send(analyze, h.content)).error.code, "cancelled");
  assert.equal(JSON.stringify(h.stored).includes("private page text"), false);
});

test("SPA URL notifications cancel the old run and wake the existing content script", async () => {
  const h = await harness({ enabled: true });
  await h.send({ type: "BEGIN_SCAN", runId: "old-run" }, h.content);
  const destination = "https://example.com/next";
  h.tabs.get(1).url = destination;
  h.documents.get(1).url = destination;
  h.events.updated.fire(1, { url: destination }, h.tabs.get(1));
  await h.settle();
  const notice = h.messages.find(entry => entry.message.type === "NAVIGATED");
  assert.equal(notice.message.url, destination);
  assert.equal(notice.message.cancelledRunId, "old-run");
  assert.equal((await h.send({ type: "GET_CONFIG", page_url: destination }, h.content)).ok, true);
  assert.equal((await h.send({ type: "BEGIN_SCAN", runId: "new-run", page_url: destination }, h.content)).ok, true);
  assert.equal((await h.send({ type: "PAGE_PROGRESS", runId: "new-run", page_url: destination,
    status: progress() }, h.content)).ok, true);
  assert.equal((await h.send({ type: "STATUS", tabId: 1 })).ok, true);
});

test("late tab URL notifications preserve an already authorized destination run", async () => {
  const h = await harness({ enabled: true });
  const destination = "https://example.com/next";
  h.tabs.get(1).url = destination;
  h.documents.get(1).url = destination;
  await h.send({ type: "BEGIN_SCAN", runId: "destination-run", page_url: destination }, h.content);
  h.events.updated.fire(1, { status: "loading", url: destination }, h.tabs.get(1));
  await h.settle();
  assert.equal((await h.send({ type: "PAGE_PROGRESS", runId: "destination-run", page_url: destination,
    status: progress() }, h.content)).ok, true);
  assert.equal(h.messages.some(entry => entry.message.type === "NAVIGATED"), false);
});

test("the original Chrome sender URL authorizes live SPA analysis, progress, focus and cancellation", async () => {
  const h = await harness({ enabled: true }, { flagThreshold: 0.85 });
  const originalURL = h.content.url;
  for (const page_url of ["https://example.com/page-1?words=50", "https://example.com/page-1?words=50#/next"]) {
    h.tabs.get(1).url = page_url;
    h.documents.get(1).url = page_url;
    assert.equal(h.content.url, originalURL, "Chrome keeps the original MessageSender.url");
    const config = await h.send({ type: "GET_CONFIG", page_url }, h.content);
    assert.equal(config.result.flagThreshold, 0.85);
    assert.equal((await h.send({ type: "BEGIN_SCAN", runId: "spa", page_url }, h.content)).ok, true);
    const pending = h.send({ type: "ANALYZE", runId: "spa", page_url, text: "word ".repeat(50) }, h.content);
    await h.settle();
    const port = h.ports.at(-1);
    assert.equal(port.sent.at(-1).page_url, undefined, "URLs never enter the native protocol");
    port.onMessage.fire({ id: port.sent.at(-1).id, ok: true, result: {
      ...modelIdentity, status: "complete", score: 0.99, min_score: 0.99, max_score: 0.99,
      chunks: [{ index: 0, score: 0.99, tokens: 50, words: 50 }], words: 50,
      total_tokens: 50, analyzed_tokens: 50, truncated: false, cached: false,
    } });
    assert.equal((await pending).ok, true);
    assert.equal((await h.send({ type: "PAGE_PROGRESS", runId: "spa", page_url,
      status: progress({ marked: 1, findings: [{ id: findingId, words: 50 }] }) }, h.content)).ok, true);
    h.chrome.tabs.sendMessage = async () => ({ focused: true });
    assert.equal((await h.send({ type: "FOCUS_FINDING", tabId: 1, findingId })).result.focused, true);
    assert.equal((await h.send({ type: "CANCEL_SCAN", runId: "spa", page_url }, h.content)).result.cancelled, true);
    assert.equal((await h.send({ type: "ANALYZE", runId: "spa", page_url, text: "old" }, h.content)).ok, false);
  }
});

test("missing, malformed, cross-origin and old-page URLs cannot replace or use a live run", async () => {
  const h = await harness({ enabled: true });
  const page_url = "https://example.com/next";
  h.tabs.get(1).url = page_url;
  h.documents.get(1).url = page_url;
  await h.send({ type: "BEGIN_SCAN", runId: "current", page_url }, h.content);
  for (const url of [undefined, null, {}, "", "chrome://settings", "https://other.example/next", h.content.url]) {
    for (const type of ["GET_CONFIG", "BEGIN_SCAN", "ANALYZE", "PAGE_PROGRESS", "CANCEL_SCAN"]) {
      const response = await h.send({ type, runId: "current", page_url: url,
        text: "private", status: progress() }, h.content);
      assert.equal(response.ok, false, `${type}: ${String(url)}`);
    }
  }
  assert.equal((await h.send({ type: "PAGE_PROGRESS", runId: "current", page_url,
    status: progress() }, h.content)).ok, true, "invalid BEGIN and CANCEL leave the live run intact");
  assert.equal(h.ports.length, 0);
});

test("same-URL replacement documents reject old senders even before tab navigation events arrive", async () => {
  const h = await harness({ enabled: true });
  await h.send({ type: "BEGIN_SCAN", runId: "old" }, h.content);
  h.documents.get(1).documentId = "document-new";
  for (const type of ["GET_CONFIG", "BEGIN_SCAN", "ANALYZE", "PAGE_PROGRESS", "CANCEL_SCAN"]) {
    assert.equal((await h.send({ type, runId: "old", text: "private", status: progress() },
      h.content)).error.code, "cancelled", type);
  }
  assert.equal((await h.send({ type: "STATUS", tabId: 1 })).ok, false);
  const current = { ...h.content, documentId: "document-new" };
  assert.equal((await h.send({ type: "GET_CONFIG" }, current)).ok, true);
  assert.equal((await h.send({ type: "BEGIN_SCAN", runId: "new" }, current)).ok, true);
  assert.equal((await h.send({ type: "BEGIN_SCAN", runId: "late-old" }, h.content)).ok, false);
  assert.equal((await h.send({ type: "PAGE_PROGRESS", runId: "new", status: progress() }, current)).ok, true);
  assert.equal(h.ports.length, 0);
});

test("a claimed live cross-origin URL cannot reuse the original document sender", async () => {
  const h = await harness({ enabled: true });
  const page_url = "https://other.example/article";
  h.tabs.get(1).url = page_url;
  h.documents.set(1, { documentId: "document-new", frameId: 0, url: page_url });
  assert.equal((await h.send({ type: "BEGIN_SCAN", runId: "spoof", page_url }, h.content)).error.code, "cancelled");
  const current = { ...h.content, url: page_url, documentId: "document-new" };
  assert.equal((await h.send({ type: "BEGIN_SCAN", runId: "new", page_url }, current)).ok, true);
});

test("authoritative probes reject wrong frames, documents, URLs, empty results and injection errors", async () => {
  for (const kind of ["frame", "document", "url", "empty", "error", "private"]) {
    const h = await harness({ enabled: true });
    if (kind === "frame") h.documents.get(1).frameId = 1;
    if (kind === "document") h.documents.get(1).documentId = "cached-document";
    if (kind === "url") h.documents.get(1).url = "https://example.com/not-the-tab";
    if (kind === "empty") h.documents.delete(1);
    if (kind === "private") h.tabs.get(1).incognito = true;
    if (kind === "error") h.chrome.scripting.executeScript = async () => { throw new Error("Cannot access frame"); };
    assert.equal((await h.send({ type: "BEGIN_SCAN", runId: "bad" }, h.content)).ok, false, kind);
    assert.equal(h.ports.length, 0);
  }
});

test("Off, permission revocation and navigation win pending document probes", async () => {
  for (const type of ["GET_CONFIG", "BEGIN_SCAN", "ANALYZE", "PAGE_PROGRESS", "CANCEL_SCAN"]) {
    for (const kind of ["off", "permission", "navigation"]) {
      const h = await harness({ enabled: true });
      await h.send({ type: "BEGIN_SCAN", runId: "run" }, h.content);
      const execute = h.chrome.scripting.executeScript;
      let release;
      h.chrome.scripting.executeScript = async entry => {
        const result = await execute(entry);
        return new Promise(resolve => { release = () => resolve(result); });
      };
      const pending = h.send({ type, runId: "run", text: "private", status: progress() }, h.content);
      await h.settle();
      if (kind === "off") await h.send({ type: "SET_ENABLED", enabled: false });
      if (kind === "permission") { h.granted.clear(); h.events.permissions.fire({ origins }); }
      if (kind === "navigation") h.events.updated.fire(1, { status: "loading" });
      release();
      assert.equal((await pending).error.code, "cancelled", `${type}: ${kind}`);
      assert.equal(h.ports.length, 0);
    }
  }
});

test("a delayed BEGIN probe cannot cancel a newer authorized run", async () => {
  const h = await harness({ enabled: true });
  const execute = h.chrome.scripting.executeScript;
  let release;
  h.chrome.scripting.executeScript = async entry => {
    const result = await execute(entry);
    return new Promise(resolve => { release = () => resolve(result); });
  };
  const old = h.send({ type: "BEGIN_SCAN", runId: "old" }, h.content);
  await h.settle();
  h.chrome.scripting.executeScript = execute;
  assert.equal((await h.send({ type: "BEGIN_SCAN", runId: "new" }, h.content)).ok, true);
  release();
  assert.equal((await old).error.code, "cancelled");
  assert.equal((await h.send({ type: "PAGE_PROGRESS", runId: "new", status: progress() }, h.content)).ok, true);
});

test("the tab URL is checked again after a document probe completes", async () => {
  const h = await harness({ enabled: true });
  const execute = h.chrome.scripting.executeScript;
  h.chrome.scripting.executeScript = async entry => {
    const result = await execute(entry);
    h.tabs.get(1).url = "https://example.com/next";
    return result;
  };
  assert.equal((await h.send({ type: "BEGIN_SCAN", runId: "old" }, h.content)).error.code, "cancelled");
  assert.equal(h.ports.length, 0);
});

test("native replies recheck live URL and document without relying on navigation notifications", async () => {
  for (const kind of ["url", "document"]) {
    const h = await harness({ enabled: true });
    await h.send({ type: "BEGIN_SCAN", runId: "run" }, h.content);
    const pending = h.send({ type: "ANALYZE", runId: "run", text: "short" }, h.content);
    await h.settle();
    if (kind === "url") {
      h.tabs.get(1).url = "https://example.com/next";
      h.documents.get(1).url = h.tabs.get(1).url;
    } else h.documents.get(1).documentId = "new-document";
    const port = h.ports[0];
    port.onMessage.fire({ id: port.sent[0].id, ok: true,
      result: { ...modelIdentity, status: "skipped", reason: "too_short", words: 1 } });
    assert.equal((await pending).error.code, "cancelled", kind);
  }
});

test("stale content scripts cannot consume Deckard results with an incompatible policy", async () => {
  const h = await harness({ enabled: true });
  const response = await h.send({ type: "BEGIN_SCAN", runId: "old", protocol_version: 1 }, h.content);
  assert.equal(response.error.code, "extension_update_required");
  assert.equal(h.ports.length, 0);
});

test("old or missing scanner versions fail closed for every content request", async () => {
  const h = await harness({ enabled: true });
  await h.send({ type: "BEGIN_SCAN", runId: "current" }, h.content);
  for (const scanner_version of [undefined, 2, "3", 4, 5]) {
    for (const type of ["GET_CONFIG", "BEGIN_SCAN", "ANALYZE", "PAGE_PROGRESS", "CANCEL_SCAN"]) {
      const response = await h.send({ type, runId: "current", scanner_version, text: "private text",
        status: { state: "done" } }, h.content);
      assert.equal(response.error.code, "extension_update_required");
    }
  }
  assert.equal((await h.send({ type: "GET_CONFIG" }, h.content)).ok, true);
  assert.equal(h.ports.length, 0);
});

test("Off and tab removal cancel queued work without another native send", async () => {
  for (const stopKind of ["off", "removed"]) {
    const h = await harness({ enabled: true });
    await h.send({ type: "BEGIN_SCAN", runId: "scan" }, h.content);
    const active = h.send({ type: "ANALYZE", runId: "scan", text: "a" }, h.content);
    const queued = h.send({ type: "ANALYZE", runId: "scan", text: "b" }, h.content);
    await h.settle();
    if (stopKind === "off") await h.send({ type: "SET_ENABLED", enabled: false });
    else h.events.removed.fire(1);
    assert.equal((await active).error.code, "cancelled");
    assert.equal((await queued).error.code, "cancelled");
    assert.equal(h.ports[0].sent.length, 1);
  }
});

test("global On requires both host grants, registers broad scripts and scans existing tabs", async () => {
  const h = await harness();
  assert.equal((await h.send({ type: "SET_ENABLED", enabled: true })).error.code, "permission_required");
  h.granted.add(origins[0]);
  assert.equal((await h.send({ type: "SET_ENABLED", enabled: true })).ok, false);
  h.granted.add(origins[1]);
  assert.equal((await h.send({ type: "SET_ENABLED", enabled: true })).result.enabled, true);
  assert.equal(h.scripts.size, 1);
  assert.deepEqual(Array.from([...h.scripts.values()][0].matches), origins);
  assert.equal(h.injections.length, 1);
  assert.equal((await h.send({ type: "GET_CONFIG" }, h.content)).result.enabled, true);
  assert.equal((await h.send({ type: "GET_CONFIG" },
    { ...h.content, url: "https://other.example:8443/article" })).error.code, "cancelled");
  assert.deepEqual(JSON.parse(JSON.stringify(h.stored)), { deckardSettings: { enabled: true } });
  await h.send({ type: "SET_ENABLED", enabled: false });
  assert.equal(h.scripts.size, 0);
  assert.equal(h.granted.size, 2, "Off retains grants so On does not reprompt");
  assert.equal((await h.send({ type: "BEGIN_SCAN", runId: "auto" }, h.content)).ok, false);
});

test("permission revocation restores automatic tabs even after Chrome hides tab URLs", async () => {
  const h = await harness({ enabled: true });
  await h.send({ type: "BEGIN_SCAN", runId: "auto" }, h.content);
  h.granted.clear();
  h.tabs.set(1, { id: 1, incognito: false });
  h.events.permissions.fire({ origins: ["https://example.com/*"] });
  await h.settle();
  assert.equal(h.scripts.size, 0);
  assert.equal(h.messages.at(-1).message.type, "STOP");
  assert.equal(h.stored.deckardSettings.enabled, false);
  assert.equal((await h.send({ type: "ANALYZE", runId: "auto", text: "x" }, h.content)).error.code, "cancelled");
});

test("manual/configuration/helper control messages no longer exist", async () => {
  const h = await harness();
  for (const type of ["PING", "SCAN", "STOP", "DISCONNECT", "SAVE_SETTINGS", "SET_SITE"]) {
    assert.equal((await h.send({ type })).error.code, "invalid_request");
  }
  assert.equal((await h.send({ type: "SET_ENABLED", enabled: "yes" })).error.code, "invalid_request");
  assert.equal(h.ports.length, 0);
});

test("global Off cancels all tabs and restores content without exposing page text", async () => {
  const h = await harness({ enabled: true });
  h.tabs.set(2, { id: 2, url: "https://other.example/article", incognito: false });
  h.documents.set(2, { documentId: "document-2", frameId: 0, url: h.tabs.get(2).url });
  const other = { ...h.content, tab: h.tabs.get(2), url: h.tabs.get(2).url, documentId: "document-2" };
  await h.send({ type: "BEGIN_SCAN", runId: "one" }, h.content);
  await h.send({ type: "BEGIN_SCAN", runId: "two" }, other);
  const a = h.send({ type: "ANALYZE", runId: "one", text: "private one" }, h.content);
  const b = h.send({ type: "ANALYZE", runId: "two", text: "private two" }, other);
  await h.settle();
  assert.equal((await h.send({ type: "SET_ENABLED", enabled: false }, h.content)).error.code, "invalid_request");
  const response = await h.send({ type: "SET_ENABLED", enabled: false });
  assert.equal(response.ok, true);
  assert.equal((await a).error.code, "cancelled");
  assert.equal((await b).error.code, "cancelled");
  assert.equal(h.ports[0].disconnected, true);
  assert.deepEqual([...new Set(h.messages.filter(entry => entry.message.type === "STOP").map(entry => entry.id))], [1, 2]);
  assert.equal(JSON.stringify(h.messages).includes("private one"), false);
});

test("startup restores enabled scanning on existing safe tabs and complete navigations", async () => {
  const h = await harness({ enabled: true }, { tabs: [
    { id: 1, url: "https://example.com/article" }, { id: 2, url: "http://other.example/" },
    { id: 3, url: "chrome://settings" }, { id: 4, url: "https://private.example", incognito: true },
  ] });
  assert.deepEqual(h.injections.map(entry => entry.target.tabId), [1, 2]);
  assert.ok(h.injections.every(entry => JSON.stringify(entry.target.frameIds) === "[0]"));
  const next = { id: 5, url: "https://new.example" };
  h.tabs.set(5, next);
  h.events.updated.fire(5, { status: "complete" }, next);
  await h.settle();
  assert.equal(h.injections.at(-1).target.tabId, 5);
  await h.send({ type: "SET_ENABLED", enabled: false });
  const before = h.injections.length;
  h.events.updated.fire(5, { status: "complete" }, next);
  await h.settle();
  assert.equal(h.injections.length, before);
});

test("legacy settings and missing startup permission migrate to Off", async () => {
  for (const [initial, options] of [
    [{ hideEnabled: true, autoSites: ["https://example.com"], threshold: 0.4 }, {}],
    [{ enabled: true }, { grants: [] }],
  ]) {
    const h = await harness(initial, options);
    assert.equal((await h.send({ type: "GET_SETTINGS" })).result.enabled, false);
    assert.equal(h.scripts.size, 0);
    assert.equal(h.injections.length, 0);
    assert.deepEqual(JSON.parse(JSON.stringify(h.stored.deckardSettings)), { enabled: false });
  }
});

test("Off wins pending enable and BEGIN_SCAN permission races", async () => {
  for (const type of ["SET_ENABLED", "BEGIN_SCAN"]) {
    const h = await harness({ enabled: true });
    let resolve;
    h.chrome.permissions.contains = () => new Promise(done => { resolve = done; });
    const pending = h.send(type === "SET_ENABLED" ? { type, enabled: true } : { type, runId: "late" },
      type === "SET_ENABLED" ? h.popup : h.content);
    await h.settle();
    await h.send({ type: "SET_ENABLED", enabled: false });
    resolve(true);
    await pending;
    assert.equal(h.stored.deckardSettings.enabled, false);
    assert.equal(h.scripts.size, 0);
    assert.equal((await h.send({ type: "ANALYZE", runId: "late", text: "x" }, h.content)).ok, false);
    assert.equal(h.ports.length, 0);
  }
});

test("Off wins delayed startup storage read without injecting or loading native code", async () => {
  let resolve;
  const h = await harness({ enabled: true }, { initialRead: new Promise(done => { resolve = done; }) });
  await h.send({ type: "SET_ENABLED", enabled: false });
  resolve({ deckardSettings: { enabled: true } });
  await h.settle();
  assert.equal((await h.send({ type: "GET_SETTINGS" })).result.enabled, false);
  assert.equal(h.injections.length, 0);
  assert.equal(h.ports.length, 0);
});

test("Off wins pending first-install default-On initialization", async () => {
  let resolve;
  const h = await harness({}, { grants: origins, initialRead: new Promise(done => { resolve = done; }) });
  await h.send({ type: "SET_ENABLED", enabled: false });
  resolve({});
  await h.settle();
  assert.equal((await h.send({ type: "GET_SETTINGS" })).result.enabled, false);
  assert.equal(h.stored.deckardSettings.enabled, false);
  assert.equal(h.injections.length, 0);
  assert.equal(h.ports.length, 0);
});
test("Off during injection never sends START after the injection resolves", async () => {
  const h = await harness();
  origins.forEach(origin => h.granted.add(origin));
  let resolve;
  h.chrome.scripting.executeScript = () => new Promise(done => { resolve = done; });
  const enabling = h.send({ type: "SET_ENABLED", enabled: true });
  await h.settle();
  const disabling = h.send({ type: "SET_ENABLED", enabled: false });
  await h.settle();
  resolve([]);
  await Promise.all([enabling, disabling]);
  assert.equal(h.messages.some(entry => entry.message.type === "START"), false);
  assert.equal(h.scripts.size, 0);
});

test("a delayed tab injection cannot block other tabs or switching Off", async () => {
  const h = await harness();
  h.tabs.set(2, { id: 2, url: "https://other.example/" });
  origins.forEach(origin => h.granted.add(origin));
  let resolve;
  h.chrome.scripting.executeScript = ({ target }) => target.tabId === 1
    ? new Promise(done => { resolve = done; }) : Promise.resolve([]);
  await h.send({ type: "SET_ENABLED", enabled: true });
  await h.settle();
  assert.equal(h.messages.some(entry => entry.id === 2 && entry.message.type === "START"), true);
  await h.send({ type: "SET_ENABLED", enabled: false });
  assert.equal(h.stored.deckardSettings.enabled, false);
  assert.equal(h.scripts.size, 0);
  resolve([]);
  await h.settle();
  assert.equal(h.messages.some(entry => entry.id === 1 && entry.message.type === "START"), false);
});

test("navigation during pending BEGIN_SCAN authorization rejects the stale document", async () => {
  const h = await harness({ enabled: true });
  let resolve;
  h.chrome.permissions.contains = () => new Promise(done => { resolve = done; });
  const pending = h.send({ type: "BEGIN_SCAN", runId: "old" }, h.content);
  await h.settle();
  h.events.updated.fire(1, { status: "loading" });
  resolve(true);
  assert.equal((await pending).error.code, "cancelled");
  assert.equal((await h.send({ type: "ANALYZE", runId: "old", text: "x" }, h.content)).ok, false);
  assert.equal(h.ports.length, 0);
});

const findingId = "11111111-1111-4111-8111-111111111111";
const progress = overrides => ({
  state: "done", analyzed: 2, partial: 0, skipped: 0, marked: 0, limited: false,
  budgetExhausted: false, detail: "Finished.", scannedWords: 150, totalWords: 150,
  usedWords: 150, findings: [], ...overrides,
});

test("authenticated progress drives tab badges without a popup and is never persisted", async () => {
  const h = await harness({ enabled: true });
  await h.send({ type: "BEGIN_SCAN", runId: "run" }, h.content);
  await h.settle();
  assert.equal(h.badges.get(1).text, "...");
  for (const [status, text, color] of [
    [progress({ state: "scanning", marked: 1 }), "...", "#216bce"],
    [progress({ marked: 2 }), "2", "#b42318"],
    [progress(), "0", "#287a46"],
    [progress({ limited: true }), "0", "#287a46"],
    [progress({ partial: 1 }), "0", "#287a46"],
    [progress({ skipped: 1 }), "0", "#287a46"],
    [progress({ budgetExhausted: true }), "0", "#287a46"],
    [progress({ state: "skipped", analyzed: 0 }), "0", "#287a46"],
    [progress({ state: "error" }), "!", "#b45309"],
  ]) {
    assert.equal((await h.send({ type: "PAGE_PROGRESS", runId: "run", status }, h.content)).ok, true);
    await h.settle();
    assert.equal(h.badges.get(1).text, text);
    assert.equal(h.badges.get(1).color, color);
    if (status.limited || status.partial || status.skipped || status.budgetExhausted || status.state === "skipped") {
      assert.match(h.badges.get(1).title, /incomplete|insufficient/i);
      assert.match(h.badges.get(1).title, /Not proof of human authorship/);
    }
  }
  assert.deepEqual(JSON.parse(JSON.stringify(h.stored)), { deckardSettings: { enabled: true } });
  await h.send({ type: "SET_ENABLED", enabled: false });
  await h.settle();
  assert.equal(h.badges.get(1).text, "");
});

test("progress rejects mismatched run, document, URL, navigation and revoked permissions", async () => {
  const h = await harness({ enabled: true });
  await h.send({ type: "BEGIN_SCAN", runId: "run" }, h.content);
  const message = { type: "PAGE_PROGRESS", runId: "run", status: progress({ marked: 1 }) };
  for (const [input, sender] of [
    [{ ...message, runId: "old" }, h.content],
    [message, { ...h.content, documentId: "old" }],
    [message, { ...h.content, url: "https://other.example/" }],
  ]) assert.equal((await h.send(input, sender)).error.code, "cancelled");
  h.granted.clear();
  assert.equal((await h.send(message, h.content)).error.code, "cancelled");
  origins.forEach(origin => h.granted.add(origin));
  h.tabs.set(1, { ...h.tabs.get(1), url: "https://new.example/" });
  assert.equal((await h.send(message, h.content)).error.code, "cancelled");
  h.events.updated.fire(1, { status: "loading" });
  await h.settle();
  assert.equal(h.badges.get(1).text, "");
  assert.equal((await h.send(message, h.content)).error.code, "cancelled");
});

test("progress and in-flight badge writes cannot leave stale badges after Off or removal", async () => {
  for (const kind of ["off", "navigation", "removed"]) {
    const h = await harness({ enabled: true });
    await h.send({ type: "BEGIN_SCAN", runId: "run" }, h.content);
    await h.settle();
    let release;
    const original = h.chrome.action.setBadgeText;
    h.chrome.action.setBadgeText = fields => fields.text === "2"
      ? new Promise(done => { release = async () => { await original(fields); done(); }; }) : original(fields);
    await h.send({ type: "PAGE_PROGRESS", runId: "run", status: progress({ marked: 2 }) }, h.content);
    await h.settle();
    if (kind === "off") await h.send({ type: "SET_ENABLED", enabled: false });
    else if (kind === "navigation") h.events.updated.fire(1, { status: "loading" });
    else h.events.removed.fire(1);
    await release();
    await h.settle();
    assert.equal(h.badges.get(1).text, "");
    assert.doesNotMatch(h.badges.get(1).title, /2 flagged/);
  }
  const h = await harness({ enabled: true });
  await h.send({ type: "BEGIN_SCAN", runId: "run" }, h.content);
  let release;
  h.chrome.permissions.contains = () => new Promise(done => { release = done; });
  const pending = h.send({ type: "PAGE_PROGRESS", runId: "run", status: progress({ marked: 1 }) }, h.content);
  await h.settle();
  await h.send({ type: "SET_ENABLED", enabled: false });
  release(true);
  assert.equal((await pending).error.code, "cancelled");
  await h.settle();
  assert.equal(h.badges.get(1).text, "");
});

test("popup statuses and passage focus use bounded metadata and the authenticated document", async () => {
  const h = await harness({ enabled: true });
  await h.send({ type: "BEGIN_SCAN", runId: "run" }, h.content);
  const status = progress({ marked: 1, analyzed: 1e9, detail: "x".repeat(1000), scannedWords: 1e9,
    totalWords: 1e12, arbitrary: "private", findings: [
      { id: findingId, label: "<script>private</script>", words: 1e9, text: "private" },
      { id: findingId, label: "duplicate" }, { id: "bad", label: "invalid" },
    ] });
  h.chrome.tabs.sendMessage = async (id, message, target) => {
    h.messages.push({ id, message, target });
    return message.type === "PAGE_STATUS" ? status : { focused: true, extra: "private" };
  };
  const response = await h.send({ type: "STATUS", tabId: 1 });
  assert.equal(response.ok, true);
  assert.equal(response.result.detail.length, 300);
  assert.equal(response.result.scannedWords, 25000);
  assert.equal(response.result.analyzed, 25000);
  assert.equal(response.result.totalWords, 25000);
  assert.equal(response.result.findings.length, 1);
  assert.equal(response.result.findings[0].label, "Passage 1");
  assert.equal(response.result.findings[0].words, 25000);
  assert.equal(JSON.stringify(response).includes("private"), false);
  assert.equal((await h.send({ type: "FOCUS_FINDING", tabId: 1, findingId })).result.focused, true);
  assert.deepEqual(JSON.parse(JSON.stringify(h.messages.at(-1))), {
    id: 1, message: { type: "FOCUS_FINDING", findingId, runId: "run" }, target: { documentId: "document-1" },
  });
  assert.equal((await h.send({ type: "FOCUS_FINDING", tabId: 1, findingId: "bad" })).ok, false);
  const beforeMissing = h.messages.length;
  assert.equal((await h.send({ type: "FOCUS_FINDING", tabId: 1,
    findingId: "22222222-2222-4222-8222-222222222222" })).result.focused, false);
  assert.equal(h.messages.length, beforeMissing);
  assert.equal((await h.send({ type: "FOCUS_FINDING", tabId: 1, findingId }, h.content)).ok, false);
  h.tabs.set(1, { ...h.tabs.get(1), incognito: true });
  assert.equal((await h.send({ type: "FOCUS_FINDING", tabId: 1, findingId })).ok, false);
  h.tabs.set(1, { ...h.tabs.get(1), incognito: false });
  h.events.updated.fire(1, { status: "loading" });
  assert.equal((await h.send({ type: "FOCUS_FINDING", tabId: 1, findingId })).ok, false);
});

test("stale status and focus responses cannot survive navigation or Off", async () => {
  for (const type of ["STATUS", "FOCUS_FINDING"]) {
    const h = await harness({ enabled: true });
    await h.send({ type: "BEGIN_SCAN", runId: "run" }, h.content);
    await h.send({ type: "PAGE_PROGRESS", runId: "run",
      status: progress({ marked: 1, findings: [{ id: findingId, words: 75 }] }) }, h.content);
    let release;
    h.chrome.tabs.sendMessage = async (id, message) => message.type === "STOP" ? null
      : new Promise(done => { release = done; });
    const pending = h.send({ type, tabId: 1, findingId });
    await h.settle();
    await h.send({ type: "SET_ENABLED", enabled: false });
    release(type === "STATUS" ? progress({ marked: 3 }) : { focused: true });
    assert.equal((await pending).error.code, "cancelled");
    await h.settle();
    assert.equal(h.badges.get(1).text, "");
  }
});

test("worker reactivation recovers progress only after a new authenticated BEGIN_SCAN", async () => {
  const h = await harness({ enabled: true });
  assert.equal(h.messages.some(entry => entry.message.type === "START"), true);
  assert.equal((await h.send({ type: "PAGE_PROGRESS", runId: "old", status: progress() }, h.content)).ok, false);
  h.chrome.tabs.sendMessage = async (id, message) => {
    if (message.type === "START") {
      await h.send({ type: "BEGIN_SCAN", runId: "new-session" }, h.content);
      return {};
    }
    return progress({ marked: 1 });
  };
  assert.equal((await h.send({ type: "STATUS", tabId: 1 })).result.marked, 1);
  await h.settle();
  assert.equal(h.badges.get(1).text, "1");
  assert.equal(h.ports.length, 0);
});

test("a delayed PAGE_STATUS cannot replace newer authenticated progress", async () => {
  const h = await harness({ enabled: true });
  await h.send({ type: "BEGIN_SCAN", runId: "run" }, h.content);
  let release;
  h.chrome.tabs.sendMessage = () => new Promise(done => { release = done; });
  const pending = h.send({ type: "STATUS", tabId: 1 });
  await h.settle();
  await h.send({ type: "PAGE_PROGRESS", runId: "run", status: progress({ marked: 2 }) }, h.content);
  release(progress({ state: "scanning" }));
  assert.equal((await pending).result.marked, 2);
  await h.settle();
  assert.equal(h.badges.get(1).text, "2");
});
