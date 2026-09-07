import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import "../core.js";

const source = fs.readFileSync(new URL("../popup.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../popup.html", import.meta.url), "utf8");
async function harness({ enabled = false, granted = true, flagThreshold = globalThis.AIHiderCore.FLAG_THRESHOLD,
  tab = { id: 1, url: "https://example.com", title: "Example" } } = {}) {
  const element = () => ({
    textContent: "", checked: false, disabled: true, events: {}, children: [],
    addEventListener(type, callback) { this.events[type] = callback; },
    appendChild(child) { this.children.push(child); },
    replaceChildren(...children) { this.children = children; },
  });
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, element()]));
  const calls = [];
  let poll;
  const chrome = {
    runtime: {
      id: "test-id",
      sendMessage: async message => {
        calls.push(message);
        if (message.type === "SET_ENABLED") enabled = message.enabled;
        if (message.type === "SET_THRESHOLD") flagThreshold = message.flagThreshold;
        return { ok: true, result: message.type === "STATUS"
          ? { state: enabled ? "done" : "off", detail: enabled ? "Watching." : "Restored." } : { enabled, flagThreshold } };
      },
    },
    permissions: { request: options => { calls.push({ permission: options }); return Promise.resolve(granted); } },
    tabs: { query: async () => [tab] },
  };
  vm.runInNewContext(source, {
    chrome, AIHiderCore: globalThis.AIHiderCore,
    document: { getElementById: id => elements.get(id), createElement: element },
    window: { addEventListener: () => {} }, setInterval: callback => { poll = callback; return 1; },
    clearInterval: () => {},
  });
  const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
  await settle();
  const toggle = value => {
    elements.get("enabled").checked = value;
    elements.get("enabled").events.change();
  };
  return { elements, calls, chrome, toggle, settle, poll: () => poll() };
}

test("popup has one On/Off switch, a threshold slider, and read-only setup", async () => {
  assert.equal([...html.matchAll(/<input\b/g)].length, 2);
  assert.match(html, /type="range" min="70" max="99" step="any"/);
  assert.match(html, /role="switch" aria-label="Enable AI Hider"/);
  assert.doesNotMatch(html, /<select\b|<textarea\b|type="number"|<details\b/);
  const h = await harness();
  assert.equal(h.elements.get("enabled").checked, false);
  assert.equal(h.elements.get("enabled").disabled, false);
  assert.equal(h.elements.get("toggle-label").textContent, "Off");
  assert.equal(h.calls.some(call => call.permission || call.type === "PING"), false);
  assert.match(h.elements.get("install-command").textContent, /\.\/install\.sh --extension-id test-id --replace/);
  assert.equal(h.elements.get("setup").hidden, true);
});

test("the slider preserves the precise default and only saves when committed", async () => {
  const h = await harness();
  assert.equal(Number(h.elements.get("threshold").value), globalThis.AIHiderCore.FLAG_THRESHOLD * 100);
  assert.equal(h.elements.get("threshold-value").textContent, "98.24");
  assert.equal(h.calls.some(call => call.type === "SET_THRESHOLD"), false);
  h.elements.get("threshold").value = "80";
  h.elements.get("threshold").events.input();
  h.poll(); await h.settle();
  assert.equal(h.elements.get("threshold-value").textContent, "80");
  assert.equal(h.calls.some(call => call.type === "SET_THRESHOLD"), false);
  h.elements.get("threshold").events.change(); await h.settle();
  assert.equal(h.calls.find(call => call.type === "SET_THRESHOLD").flagThreshold, 0.8);
  assert.equal(h.calls.some(call => call.permission), false);
  assert.equal(h.elements.get("threshold").disabled, false);
});

test("failed threshold saves display an error and restore the persisted value", async () => {
  const h = await harness({ flagThreshold: 0.9 });
  const original = h.chrome.runtime.sendMessage;
  h.chrome.runtime.sendMessage = message => message.type === "SET_THRESHOLD"
    ? Promise.resolve({ ok: false, error: { message: "Settings write failed." } }) : original(message);
  h.elements.get("threshold").value = "70";
  h.elements.get("threshold").events.change(); await h.settle();
  assert.equal(h.elements.get("threshold").value, "90");
  assert.match(h.elements.get("status").textContent, /Settings write failed/);
  assert.equal(h.elements.get("status").hidden, false);
});

test("read-only helper setup appears only when the page reports an error", async () => {
  const h = await harness({ enabled: true });
  const original = h.chrome.runtime.sendMessage;
  h.chrome.runtime.sendMessage = message => message.type === "STATUS"
    ? Promise.resolve({ ok: true, result: { state: "error", detail: "Native host unavailable." } })
    : original(message);
  h.poll(); await h.settle();
  assert.equal(h.elements.get("setup").hidden, false);
  assert.equal(h.elements.get("status").hidden, false);
  assert.equal(h.elements.get("status").textContent, "Native host unavailable.");
  h.chrome.runtime.sendMessage = original;
  h.poll(); await h.settle();
  assert.equal(h.elements.get("setup").hidden, true);
});

test("popup reports marked counts with no hiding or reveal controls", async () => {
  const h = await harness({ enabled: true });
  const original = h.chrome.runtime.sendMessage;
  h.chrome.runtime.sendMessage = message => message.type === "STATUS"
    ? Promise.resolve({ ok: true, result: {
      state: "done", detail: "Watching.", analyzed: 4, marked: 1, partial: 2, skipped: 3,
    } }) : original(message);
  h.poll(); await h.settle();
  assert.equal(h.elements.get("progress").textContent, "0/0 processed · 4 scored · 1 marked · 2 partial · 3 skipped");
  assert.equal(h.elements.get("status").hidden, true);
  assert.doesNotMatch(html, /Show anyway|Collapse|are hidden/);
  assert.doesNotMatch(html, /marks high-scoring prose red|possible AI involvement|not specific AI-authored words|≥0.982423|not guaranteed/);
});

test("On requests both optional grants directly in the gesture, before worker messages", async () => {
  const h = await harness();
  h.calls.length = 0;
  h.toggle(true);
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls)), [{ permission: { origins: ["http://*/*", "https://*/*"] } }]);
  await h.settle();
  assert.equal(h.calls[1].type, "SET_ENABLED");
  assert.equal(h.calls[1].enabled, true);
  assert.equal(h.elements.get("enabled").checked, true);
  assert.equal(h.elements.get("toggle-label").textContent, "On");
});

test("declined access stays Off and preserves a concise error across polling", async () => {
  const h = await harness({ granted: false });
  h.toggle(true);
  await h.settle();
  assert.equal(h.calls.some(call => call.type === "SET_ENABLED"), false);
  assert.equal(h.elements.get("enabled").checked, false);
  assert.match(h.elements.get("status").textContent, /Access declined/);
  h.poll(); await h.settle();
  assert.match(h.elements.get("status").textContent, /Access declined/);
});

test("Off sends a global disable without asking for permission", async () => {
  const h = await harness({ enabled: true });
  h.calls.length = 0;
  h.toggle(false);
  await h.settle();
  assert.equal(h.calls[0].type, "SET_ENABLED");
  assert.equal(h.calls[0].enabled, false);
  assert.equal(h.calls.some(call => call.permission), false);
  assert.equal(h.elements.get("enabled").checked, false);
});

test("late polling cannot overwrite a newer toggle", async () => {
  const h = await harness({ enabled: true });
  const original = h.chrome.runtime.sendMessage;
  let resolve;
  let first = true;
  h.chrome.runtime.sendMessage = message => {
    if (message.type === "STATUS" && first) {
      first = false;
      return new Promise(done => { resolve = done; });
    }
    return original(message);
  };
  h.poll(); await h.settle();
  h.toggle(false); await h.settle();
  resolve({ ok: true, result: { state: "scanning", detail: "Stale status" } });
  await h.settle();
  assert.equal(h.elements.get("enabled").checked, false);
  assert.doesNotMatch(h.elements.get("status").textContent, /Stale/);
});

test("current-page word progress and finding buttons navigate without adding settings", async () => {
  const h = await harness({ enabled: true, tab: { id: 1, url: "https://example.com", title: "<img src=x>" } });
  const original = h.chrome.runtime.sendMessage;
  const findingId = "11111111-1111-4111-8111-111111111111";
  let focused = true;
  h.chrome.runtime.sendMessage = async message => {
    if (message.type === "STATUS") return { ok: true, result: {
      state: "done", detail: "", analyzed: 4, marked: 1, partial: 0, skipped: 0,
      scannedWords: 25000, totalWords: 30000, budgetExhausted: true,
      findings: [{ id: findingId, label: "Passage 1", words: 125 }],
    } };
    if (message.type === "FOCUS_FINDING") {
      h.calls.push(message);
      return { ok: true, result: { focused } };
    }
    return original(message);
  };
  h.poll(); await h.settle();
  assert.equal(h.elements.get("page-title").textContent, "<img src=x>");
  assert.equal(h.elements.get("progress").textContent, "25,000/30,000 processed · 4 scored · 1 marked · 0 partial · 0 skipped");
  assert.equal(h.elements.get("status").hidden, true);
  assert.doesNotMatch(h.elements.get("progress").textContent, /page cap|eligible|incomplete/);
  assert.equal(h.elements.get("results").hidden, false);
  const button = h.elements.get("findings").children[0].children[0];
  assert.equal(button.textContent, "Passage 1 · 125 words");
  button.events.click(); await h.settle();
  assert.equal(h.calls.at(-1).type, "FOCUS_FINDING");
  assert.equal(h.calls.at(-1).findingId, findingId);
  assert.equal(h.calls.at(-1).tabId, 1);
  assert.match(h.elements.get("navigation-status").textContent, /Jumped to Passage 1/);
  focused = false;
  button.events.click(); await h.settle();
  assert.match(h.elements.get("navigation-status").textContent, /no longer available/);
  h.chrome.runtime.sendMessage = original;
  h.toggle(false); await h.settle();
  assert.equal(h.elements.get("results").hidden, true);
  assert.equal(h.elements.get("findings").children.length, 0);
});

test("private and excluded pages never expose a title or send their tab ID", async () => {
  for (const tab of [
    { id: 1, url: "https://example.com", title: "Private title", incognito: true },
    { id: 1, url: "chrome://settings", title: "Secret title" },
  ]) {
    const h = await harness({ tab });
    assert.equal(h.elements.get("page-title").textContent, "Page unavailable or private");
    assert.equal(h.calls.find(call => call.type === "STATUS").tabId, undefined);
  }
});

test("zero analyzed pages show only compact counters", async () => {
  const h = await harness({ enabled: true });
  const original = h.chrome.runtime.sendMessage;
  h.chrome.runtime.sendMessage = message => message.type === "STATUS"
    ? Promise.resolve({ ok: true, result: { state: "done", analyzed: 0, marked: 0, findings: [] } })
    : original(message);
  h.poll(); await h.settle();
  assert.equal(h.elements.get("status").hidden, true);
  assert.equal(h.elements.get("progress").textContent, "0/0 processed · 0 scored · 0 marked · 0 partial · 0 skipped");
});

test("a late finding-navigation response cannot restore results after Off", async () => {
  const h = await harness({ enabled: true });
  const original = h.chrome.runtime.sendMessage;
  let release;
  let on = true;
  h.chrome.runtime.sendMessage = message => {
    if (message.type === "SET_ENABLED") on = message.enabled;
    if (message.type === "STATUS" && on) return Promise.resolve({ ok: true, result: {
      state: "done", analyzed: 1, marked: 1,
      findings: [{ id: "11111111-1111-4111-8111-111111111111", label: "Passage 1", words: 100 }],
    } });
    if (message.type === "FOCUS_FINDING") return new Promise(done => { release = done; });
    return original(message);
  };
  h.poll(); await h.settle();
  h.elements.get("findings").children[0].children[0].events.click();
  h.toggle(false); await h.settle();
  release({ ok: true, result: { focused: true } });
  await h.settle();
  assert.equal(h.elements.get("results").hidden, true);
  assert.equal(h.elements.get("navigation-status").textContent, "");
});
