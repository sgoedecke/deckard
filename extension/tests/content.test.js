import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import "../core.js";
import { modelIdentity } from "./model-fixture.js";

const source = fs.readFileSync(new URL("../content.js", import.meta.url), "utf8");
const result = { ...modelIdentity, status: "complete", score: 0.99, min_score: 0.96, max_score: 0.99,
  chunks: [{ index: 0, score: 0.97, tokens: 100, words: 80 }], words: 80,
  total_tokens: 100, analyzed_tokens: 100, truncated: false, cached: false };
class Node {
  constructor(tag = "div") {
    this.tag = tag;
    this.nodeType = 1;
    this.children = [];
    this.parentElement = null;
    this.isConnected = false;
    this.dataset = {};
    this.attrs = {};
    this.events = {};
    this.classes = new Set();
    this.style = { setProperty(name, value) { this[name] = value; } };
    this.classList = {
      add: name => this.classes.add(name),
      contains: name => this.classes.has(name),
      toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name),
      remove: name => this.classes.delete(name),
    };
  }
  append(...nodes) {
    for (const node of nodes) {
      this.children.push(node); node.parentElement = this; node.connect(this.isConnected);
    }
  }
  connect(value) { this.isConnected = value; this.children.forEach(child => child.connect(value)); }
  contains(other) {
    for (let node = other; node; node = node.parentElement) if (node === this) return true;
    return false;
  }
  before(node) {
    const parent = this.parentElement;
    parent.children.splice(parent.children.indexOf(this), 0, node);
    node.parentElement = parent; node.connect(parent.isConnected);
  }
  remove() {
    if (this.parentElement) {
      const parent = this.parentElement;
      parent.children.splice(parent.children.indexOf(this), 1);
      this.parentElement = null;
    }
    this.connect(false);
  }
  attachShadow() { this.shadow = new Node("shadow"); return this.shadow; }
  addEventListener(type, callback) { this.events[type] = callback; }
  scrollIntoView(options) { this.scrolled = options; }
  setAttribute(key, value) { this.attrs[key] = value; }
  getAttribute(key) { return key === "class" ? [...this.classes].join(" ") : this.attrs[key] ?? null; }
  hasAttribute(key) { return key === "data-deckard-owned" ? Boolean(this.dataset.deckardOwned) : key in this.attrs; }
  closest(selector) {
    if (selector === "[data-deckard-owned]") {
      for (let node = this; node; node = node.parentElement) if (node.hasAttribute("data-deckard-owned")) return node;
    }
    return null;
  }
}
async function harness({ auto = false, count = 1, getConfig, budget = 25000, dual = false, planHandler } = {}) {
  const root = new Node("html");
  root.lang = "en"; root.isConnected = true;
  const blocks = Array.from({ length: count }, () => {
    const node = new Node("article");
    node.text = "word ".repeat(80).trim();
    node.append(new Node("original-child"));
    root.append(node);
    return node;
  });
  const document = { documentElement: root, createElement: tag => new Node(tag) };
  const listeners = [];
  const requests = [];
  const analyses = [];
  let textReads = 0;
  const timers = new Map();
  let timerCount = 0;
  let observer;
  const settings = { enabled: auto };
  const chrome = { runtime: { id: "test-id",
    onMessage: { addListener: listener => listeners.push(listener) },
    sendMessage: message => {
      requests.push(message);
      if (message.type === "ANALYZE") return new Promise(resolve => analyses.push({ message, resolve }));
      if (message.type === "PLAN_CONTEXT") return planHandler ? planHandler(message) : Promise.resolve({
        ok: true, result: { ...modelIdentity, status: "planned", groups: message.texts.map(text => [{
          start_word: 0, end_word: globalThis.DeckardCore.wordCount(text), tokens: 100, complete: true,
        }]) },
      });
      if (message.type === "GET_CONFIG" && getConfig) return getConfig();
      return Promise.resolve({ ok: true, result: message.type === "GET_CONFIG"
        ? { ...settings } : {} });
    },
  } };
  const windowEvents = new Map();
  const navigationEvents = new Map();
  const window = { addEventListener: (type, callback) => windowEvents.set(type, callback),
    navigation: { addEventListener: (type, callback) => navigationEvents.set(type, callback) },
    getComputedStyle: () => ({
    display: "block", visibility: "visible", opacity: "1",
  }) };
  window.top = window;
  let id = 0;
  const context = vm.createContext({
    document, window, chrome, location: { href: "https://example.com/article" },
    crypto: { randomUUID: () => `id-${++id}` },
    DeckardCore: { ...globalThis.DeckardCore, MAX_PAGE_WORDS: budget,
      contextSources: dual ? globalThis.DeckardCore.contextSources
        : blocks => blocks.map(block => ({ blocks: [block], text: block.text })),
      selectBlocks: () => ({ blocks: blocks.filter(node => node.isConnected).map((node, index) => ({
        key: `block-${index}`, node, text: node.text, words: globalThis.DeckardCore.wordCount(node.text),
        parts: [{ node, text: node.text, whole: true, ranges: [] }],
      })), totalWords: blocks.filter(node => node.isConnected).reduce((n, node) => n + globalThis.DeckardCore.wordCount(node.text), 0),
        skipped: 0, limited: false }),
      groupCurrent: block => { textReads++; return block.parts.every(part => part.node.isConnected && part.node.text === part.text); },
      readText: node => { textReads++; return node.isConnected ? node.text : ""; },
    },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; observer = this; this.active = false; }
      observe() { this.active = true; }
      disconnect() { this.active = false; }
    },
    setTimeout: callback => { timers.set(++timerCount, callback); return timerCount; },
    clearTimeout: key => timers.delete(key),
  });
  const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
  const send = message => new Promise(resolve => listeners[0](message, { id: "test-id" }, resolve));
  const start = async () => {
    settings.enabled = true;
    await send({ type: "START" }); await settle();
  };
  const finish = async (index = analyses.length - 1, value = result) => {
    analyses[index].resolve({ ok: true, result: value }); await settle();
  };
  const flushTimers = async () => {
    await settle();
    for (const [key, callback] of [...timers]) { timers.delete(key); callback(); }
    await settle();
  };
  const mutate = async node => {
    if (observer.active) observer.callback([{ type: "characterData", target: { nodeType: 3, parentElement: node } }]);
    await flushTimers();
  };
  vm.runInContext(source, context);
  await settle();
  return { root, blocks, context, listeners, requests, analyses, settings, observer,
    start, finish, mutate, send, settle, flushTimers, timers, windowEvents, navigationEvents,
    get textReads() { return textReads; } };
}

test("content script is idempotent and marks prose red without hiding or replacing nodes", async () => {
  const h = await harness();
  vm.runInContext(source, h.context);
  assert.equal(h.listeners.length, 1);
  const originalChild = h.blocks[0].children[0];
  await h.start();
  await h.finish();
  assert.equal(h.blocks[0].classes.size, 1);
  assert.equal(h.blocks[0].children[0], originalChild);
  const status = await h.send({ type: "PAGE_STATUS" });
  assert.equal(status.marked, 1);
  assert.equal(status.state, "done");
  assert.equal(h.root.children.filter(node => node.shadow).length, 0, "no banners, controls, or global panel");
  const sheet = h.root.children.find(node => node.tag === "style");
  const flagClass = [...h.blocks[0].classes][0];
  assert.match(flagClass, /^deckard-marked-/);
  assert.ok(sheet.textContent.startsWith(`.${flagClass},.${flagClass} :is(`));
  assert.match(sheet.textContent, /:is\([^)]*\bspan,a,em,strong\b/);
  assert.match(sheet.textContent, /\{color:#d00!important;-webkit-text-fill-color:#d00!important\}/);
  assert.doesNotMatch(sheet.textContent, /display|visibility|opacity/);
  assert.deepEqual(h.root.children, [h.blocks[0], sheet]);
  assert.equal(h.blocks[0].attrs.hidden, undefined);
  assert.equal(h.blocks[0].attrs["aria-hidden"], undefined);
});

test("97% context flags subthreshold locals; cached slider and Off/On reuse both passes and merge overlap", async () => {
  const h = await harness({ dual: true, count: 2, budget: 160 });
  const low = { ...result, score: 0.5, max_score: 0.5, min_score: 0.5 };
  await h.start();
  await h.finish(0, low);
  await h.finish(1, low);
  assert.equal(h.analyses.length, 3);
  assert.equal(h.analyses[2].message.text, h.blocks.map(block => block.text).join("\n\n"));
  await h.finish(2, { ...result, max_score: 0.976535, score: 0.976535 });
  let status = await h.send({ type: "PAGE_STATUS" });
  assert.equal(status.marked, 1);
  assert.equal(status.analyzed, 2);
  assert.equal(status.contextAnalyzed, 1);
  assert.equal(status.scannedWords, 160);
  assert.equal(status.contextWords, 160);
  assert.equal(status.findings[0].context, true);
  assert.ok(h.blocks.every(block => block.classes.size === 1));
  h.settings.flagThreshold = 0.98;
  await h.send({ type: "SETTINGS_CHANGED" });
  assert.equal((await h.send({ type: "PAGE_STATUS" })).marked, 0);
  h.settings.flagThreshold = 0.97;
  await h.send({ type: "SETTINGS_CHANGED" });
  assert.equal((await h.send({ type: "PAGE_STATUS" })).marked, 1);
  await h.send({ type: "STOP" });
  assert.ok(h.blocks.every(block => block.classes.size === 0));
  await h.start();
  assert.equal(h.analyses.length, 3);
  assert.equal(h.requests.filter(message => message.type === "PLAN_CONTEXT").length, 1);
  assert.equal((await h.send({ type: "PAGE_STATUS" })).marked, 1);
  h.settings.flagThreshold = 0.7;
  await h.send({ type: "SETTINGS_CHANGED" });
  assert.equal(h.analyses.length, 3);
});

test("overlapping local and context owners produce one finding and restore styles independently", async () => {
  const h = await harness({ dual: true, count: 2 });
  h.blocks[0].style.color = "blue";
  await h.start();
  await h.finish(0, result);
  await h.finish(1, result);
  await h.finish(2, { ...result, score: 0.975, max_score: 0.975 });
  assert.equal((await h.send({ type: "PAGE_STATUS" })).marked, 1);
  h.settings.flagThreshold = 0.98;
  await h.send({ type: "SETTINGS_CHANGED" });
  assert.equal((await h.send({ type: "PAGE_STATUS" })).marked, 2);
  assert.ok(h.blocks.every(block => block.classes.size === 1));
  await h.send({ type: "STOP" });
  assert.ok(h.blocks.every(block => block.classes.size === 0));
  assert.equal(h.blocks[0].style.color, "blue");
});

test("malformed plans fail visibly without context inference or cancelling a newer run", async () => {
  const h = await harness({ dual: true, count: 1,
    planHandler: () => Promise.resolve({ ok: true, result: { ...modelIdentity, status: "planned", groups: [[]] } }) });
  await h.start();
  await h.finish();
  assert.equal(h.analyses.length, 1);
  assert.equal((await h.send({ type: "PAGE_STATUS" })).state, "error");
  assert.equal(h.observer.active, false);
});

test("stale native planning cannot strand the new run's context partition", async () => {
  const plans = [];
  const h = await harness({ dual: true, count: 1,
    planHandler: message => new Promise(resolve => plans.push({ message, resolve })) });
  await h.start();
  await h.finish();
  assert.equal(plans.length, 1);
  await h.send({ type: "STOP" });
  await h.start();
  const answer = { ok: true, result: { ...modelIdentity, status: "planned",
    groups: [[{ start_word: 0, end_word: 80, tokens: 100, complete: true }]] } };
  plans[0].resolve(answer);
  await h.settle();
  assert.equal(plans.length, 2);
  plans[1].resolve(answer);
  await h.settle();
  assert.equal((await h.send({ type: "PAGE_STATUS" })).contextAnalyzed, 1);
  assert.equal(h.analyses.length, 1, "identical local/context text reuses its result");
});

test("mutation replanning spends a separate bounded partition budget; Off/On cannot replenish it", async () => {
  const h = await harness({ dual: true, count: 2, budget: 320 });
  const low = { ...result, score: 0.5, max_score: 0.5, min_score: 0.5 };
  await h.start();
  await h.finish(0, low);
  await h.finish(1, low);
  await h.finish(2, result);
  h.blocks[0].text = "changed ".repeat(80).trim();
  await h.mutate(h.blocks[0]);
  await h.finish(3, low);
  await h.finish(4, result);
  assert.equal(h.requests.filter(message => message.type === "PLAN_CONTEXT").length, 2);
  h.blocks[0].text = "again ".repeat(80).trim();
  await h.mutate(h.blocks[0]);
  await h.finish(5, low);
  let status = await h.send({ type: "PAGE_STATUS" });
  assert.equal(status.usedWords, 320);
  assert.equal(status.contextWords, 320);
  assert.equal(status.marked, 0, "old contexts cannot accumulate after replanning is capped");
  assert.equal(status.limited, true);
  await h.send({ type: "STOP" });
  await h.start();
  status = await h.send({ type: "PAGE_STATUS" });
  assert.equal(status.limited, true);
  assert.equal(h.analyses.length, 6);
  assert.equal(h.requests.filter(message => message.type === "PLAN_CONTEXT").length, 2);
});

test("duplicate starts retain the mark without adding controls or rescanning", async () => {
  const h = await harness();
  await h.start(); await h.finish();
  const flagClass = [...h.blocks[0].classes][0];
  await h.start();
  assert.equal(h.analyses.length, 1);
  assert.deepEqual([...h.blocks[0].classes], [flagClass]);
  assert.equal(h.blocks[0].isConnected, true);
  assert.equal(h.root.children.length, 2);
});

test("a complete 50-word passage is scored and marked without changing the cutoff", async () => {
  const h = await harness({ budget: 50 });
  h.blocks[0].text = "word ".repeat(50).trim();
  await h.start();
  assert.equal(h.analyses.length, 1);
  await h.finish(0, { ...result, words: 50, chunks: [{ index: 0, score: 0.99, tokens: 50, words: 50 }] });
  const status = await h.send({ type: "PAGE_STATUS" });
  assert.equal(status.analyzed, 1);
  assert.equal(status.marked, 1);
  assert.equal(status.usedWords, 50);
  assert.equal(globalThis.DeckardCore.FLAG_THRESHOLD, 0.97);
});

test("low, partial, or short-chunk results leave no page annotations", async () => {
  for (const value of [
    { ...result, score: 0.45, min_score: 0.4, max_score: 0.5 },
    { ...result, status: "partial" }, { ...result, truncated: true },
    { ...result, chunks: [{ ...result.chunks[0], words: 25 }] },
  ]) {
    const h = await harness();
    await h.start();
    await h.finish(0, value);
    assert.equal(h.blocks[0].classes.size, 0);
    assert.equal((await h.send({ type: "PAGE_STATUS" })).analyzed, 1);
    assert.equal(h.root.children.filter(node => node.shadow).length, 0);
    assert.deepEqual(h.root.children, h.blocks, "no stylesheet or annotation for ineligible results");
    assert.equal((await h.send({ type: "PAGE_STATUS" })).marked, 0);
  }
});

test("a mixed complete block is marked red when one chunk exceeds the Gradient threshold", async () => {
  const h = await harness();
  await h.start();
  await h.finish(0, { ...result, min_score: 0.04, max_score: 0.99, score: 0.13,
    chunks: [{ index: 0, score: 0.99, tokens: 100, words: 80 },
      { index: 1, score: 0.04, tokens: 1000, words: 800 }],
    words: 880, total_tokens: 1100, analyzed_tokens: 1100 });
  assert.equal(h.blocks[0].classes.size, 1);
  assert.equal((await h.send({ type: "PAGE_STATUS" })).marked, 1);
  assert.equal(h.blocks[0].isConnected, true);
  assert.equal(h.root.children.filter(node => node.shadow).length, 0);
});

test("changed or detached text rejects late analysis, and mutations remove stale marks", async () => {
  for (const detached of [false, true]) {
    const h = await harness();
    await h.start();
    if (detached) h.blocks[0].remove();
    else h.blocks[0].text += " changed";
    await h.finish();
    assert.equal(h.blocks[0].classes.size, 0);
    assert.equal((await h.send({ type: "PAGE_STATUS" })).analyzed, 0);
  }
  const h = await harness();
  await h.start(); await h.finish();
  h.blocks[0].text += " changed";
  await h.mutate(h.blocks[0]);
  assert.equal(h.blocks[0].classes.size, 0);
  assert.equal(h.analyses.length, 2);
});

test("Stop cancels the run, restores nodes, and ignores outstanding results", async () => {
  const h = await harness({ count: 2 });
  await h.start(); await h.finish(0);
  assert.equal(h.analyses.length, 2);
  assert.equal(h.blocks[0].classes.size, 1);
  await h.send({ type: "STOP" });
  assert.equal(h.blocks[0].classes.size, 0);
  assert.equal(h.requests.at(-1).type, "CANCEL_SCAN");
  await h.finish(1);
  assert.equal(h.blocks[1].classes.size, 0);
  assert.equal((await h.send({ type: "PAGE_STATUS" })).state, "stopped");
});

test("mutations stay capped but a new SPA page replenishes the word budget", async () => {
  const h = await harness({ auto: true, budget: 250 });
  for (let i = 0; i < 3; i++) {
    assert.equal(h.analyses.length, i + 1);
    await h.finish(i);
    h.blocks[0].text += " changed";
    await h.mutate(h.blocks[0]);
  }
  assert.equal(h.analyses.length, 3);
  assert.equal((await h.send({ type: "PAGE_STATUS" })).usedWords, 243);
  h.context.location.href = "https://example.com/another";
  await h.send({ type: "NAVIGATED" }); await h.flushTimers();
  assert.equal(h.analyses.length, 4);
  await h.finish();
  assert.equal((await h.send({ type: "PAGE_STATUS" })).usedWords, 83);
  assert.equal((await h.send({ type: "PAGE_STATUS" })).limited, false);
  await h.send({ type: "STOP" });
  await h.start();
  assert.equal(h.analyses.length, 4);
});

test("permission revocation removes marks and own mutations never trigger rescans", async () => {
  const h = await harness({ auto: true });
  await h.finish();
  const sheet = h.root.children.find(node => node.tag === "style");
  h.observer.callback([{ type: "childList", target: h.root, addedNodes: [sheet], removedNodes: [] }]);
  h.observer.callback([{ type: "attributes", target: h.blocks[0], attributeName: "class", oldValue: "" }]);
  await h.settle();
  assert.equal(h.analyses.length, 1);
  await h.send({ type: "STOP" });
  assert.equal(h.blocks[0].classes.size, 0);
  assert.equal(h.observer.active, false);
  assert.equal((await h.send({ type: "PAGE_STATUS" })).state, "stopped");
});

test("automatic injection plus global activation cannot start duplicate scans", async () => {
  const h = await harness({ auto: true });
  assert.equal(h.analyses.length, 1);
  await h.start();
  assert.equal(h.requests.filter(message => message.type === "BEGIN_SCAN").length, 1);
  await h.finish();
});

test("own mutations do not re-extract scored text", async () => {
  const h = await harness();
  await h.start(); await h.finish();
  const sheet = h.root.children.find(node => node.tag === "style");
  const reads = h.textReads;
  await h.mutate(sheet);
  assert.equal(h.textReads, reads);
  assert.equal(h.blocks[0].classes.size, 1);
  h.blocks[0].text += " changed";
  await h.mutate(h.blocks[0]);
  assert.equal(h.analyses.length, 2, "changed text is scheduled again without re-reading a known-dirty mark");
  assert.equal(h.blocks[0].classes.size, 0);
});

test("page removal of the owned stylesheet clears marks and their count", async () => {
  const h = await harness();
  await h.start(); await h.finish();
  const sheet = h.root.children.find(node => node.tag === "style");
  sheet.remove();
  h.observer.callback([{ type: "childList", target: h.root, addedNodes: [], removedNodes: [sheet] }]);
  assert.equal(h.blocks[0].classes.size, 0);
  assert.equal(h.blocks[0].isConnected, true);
  assert.equal((await h.send({ type: "PAGE_STATUS" })).marked, 0);
});

test("Off removes only the marking class and preserves original and updated inline colors", async () => {
  const h = await harness();
  const block = h.blocks[0];
  const link = new Node("a");
  link.style.color = "blue";
  block.append(link);
  block.classList.add("page-theme");
  block.style.color = "green";
  block.style.display = "grid";
  const childNodes = [...block.children];
  await h.start(); await h.finish();
  assert.equal(block.classes.size, 2);
  assert.equal(block.style.color, "green", "marking must not edit the inline color");
  assert.equal(link.style.color, "blue", "descendant colors must not be overwritten");
  assert.deepEqual(block.children, childNodes);
  block.style.color = "purple";
  link.style.color = "orange";
  await h.send({ type: "STOP" });
  assert.deepEqual([...block.classes], ["page-theme"]);
  assert.equal(block.style.color, "purple", "Off preserves colors authored while marked");
  assert.equal(block.style.display, "grid");
  assert.equal(link.style.color, "orange");
  assert.deepEqual(block.children, childNodes);
  assert.deepEqual(h.root.children, h.blocks, "Off removes the only extension stylesheet");
  assert.equal((await h.send({ type: "PAGE_STATUS" })).marked, 0);
});

test("Stop prevents pending SPA configuration from restarting automatic scanning", async () => {
  const h = await harness({ auto: true });
  await h.finish();
  const original = h.context.chrome.runtime.sendMessage;
  let reply;
  h.context.chrome.runtime.sendMessage = message => message.type === "GET_CONFIG"
    ? new Promise(resolve => { reply = resolve; }) : original(message);
  h.context.location.href = "https://example.com/next";
  await h.send({ type: "NAVIGATED" });
  await h.send({ type: "STOP" });
  reply({ ok: true, result: { enabled: true } });
  await h.settle();
  assert.equal(h.analyses.length, 1);
  assert.equal((await h.send({ type: "PAGE_STATUS" })).state, "stopped");
});

test("Off prevents delayed initial configuration from starting any work", async () => {
  let reply;
  const h = await harness({ getConfig: () => new Promise(resolve => { reply = resolve; }) });
  await h.send({ type: "STOP" });
  reply({ ok: true, result: { enabled: true } });
  await h.settle();
  assert.equal(h.analyses.length, 0);
  assert.equal(h.observer.active, false);
  assert.equal(h.root.children.filter(node => node.dataset.deckardOwned).length, 0);
});

test("Off prevents a late BEGIN_SCAN response from scheduling inference", async () => {
  const h = await harness();
  let reply;
  const original = h.context.chrome.runtime.sendMessage;
  h.context.chrome.runtime.sendMessage = message => message.type === "BEGIN_SCAN"
    ? new Promise(resolve => { reply = resolve; }) : original(message);
  const starting = h.start();
  await h.settle();
  await h.send({ type: "STOP" });
  reply({ ok: true, result: { started: true } });
  await starting;
  assert.equal(h.analyses.length, 0);
  assert.equal(h.observer.active, false);
});

test("SPA URL changes automatically restart with a fresh page budget", async () => {
  const h = await harness({ auto: true });
  await h.finish();
  h.context.location.href = "https://example.com/new-route";
  h.blocks[0].text += " new route";
  await h.mutate(h.blocks[0]);
  assert.equal(h.blocks[0].classes.size, 0);
  assert.equal(h.analyses.length, 2);
  assert.notEqual(h.analyses[0].message.runId, h.analyses[1].message.runId);
  await h.finish(1);
  assert.equal(h.blocks[0].classes.size, 1);
  assert.equal((await h.send({ type: "PAGE_STATUS" })).usedWords, 82);
});

test("every scanner request carries the live URL, including SPA and hash changes", async () => {
  const h = await harness({ auto: true });
  await h.finish();
  assert.ok(h.requests.every(message => message.page_url === "https://example.com/article"));
  for (const url of ["https://example.com/next?words=50", "https://example.com/next?words=50#/route"]) {
    const before = h.requests.length;
    h.context.location.href = url;
    h.navigationEvents.get("currententrychange")();
    await h.flushTimers();
    await h.finish();
    const requests = h.requests.slice(before);
    for (const type of ["CANCEL_SCAN", "GET_CONFIG", "BEGIN_SCAN", "ANALYZE", "PAGE_PROGRESS"]) {
      assert.ok(requests.some(message => message.type === type), type);
    }
    assert.ok(requests.every(message => message.page_url === url
      && message.scanner_version === 7 && message.protocol_version === 3));
  }
});

test("history changes restart exhausted pages without requiring DOM mutations", async () => {
  const h = await harness({ auto: true, budget: 80 });
  await h.finish();
  h.context.location.href = "https://example.com/new-route";
  h.navigationEvents.get("currententrychange")();
  await h.settle();
  assert.equal(h.blocks[0].classes.size, 0);
  assert.equal(h.analyses.length, 1, "let the route render before extracting");
  await h.flushTimers();
  assert.equal(h.analyses.length, 2);
  await h.finish();
  assert.equal((await h.send({ type: "PAGE_STATUS" })).usedWords, 80);
});

test("back/forward and hash-router navigation get fresh budgets, ordinary anchors do not", async () => {
  const h = await harness({ auto: true, budget: 80 });
  await h.finish();
  h.context.location.href = "https://example.com/article#comment-1";
  h.windowEvents.get("hashchange")();
  await h.flushTimers();
  assert.equal(h.analyses.length, 1);
  assert.equal((await h.send({ type: "PAGE_STATUS" })).usedWords, 80);
  for (const [url, event] of [
    ["https://example.com/article#/next", "hashchange"],
    ["https://example.com/article", "popstate"],
  ]) {
    const count = h.analyses.length;
    h.context.location.href = url;
    h.windowEvents.get(event)();
    await h.flushTimers();
    assert.equal(h.analyses.length, count + 1);
    await h.finish();
    assert.equal((await h.send({ type: "PAGE_STATUS" })).usedWords, 80);
  }
});

test("late navigation notices cannot cancel a destination run or replenish its budget", async () => {
  const h = await harness({ auto: true });
  await h.finish();
  const oldRun = h.analyses[0].message.runId;
  h.context.location.href = "https://example.com/next";
  h.navigationEvents.get("currententrychange")();
  await h.flushTimers();
  const begins = h.requests.filter(message => message.type === "BEGIN_SCAN").length;
  await h.send({ type: "NAVIGATED", url: h.context.location.href, cancelledRunId: oldRun });
  await h.send({ type: "NAVIGATED", url: "https://example.com/article", restart: true });
  await h.flushTimers();
  assert.equal(h.requests.filter(message => message.type === "BEGIN_SCAN").length, begins);
  await h.finish();
  assert.equal((await h.send({ type: "PAGE_STATUS" })).usedWords, 80);
});

test("a loading-only cancellation reauthorizes the current page without another budget", async () => {
  const h = await harness({ auto: true, budget: 80 });
  await h.finish();
  await h.send({ type: "NAVIGATED", cancelledRunId: h.analyses[0].message.runId });
  await h.flushTimers();
  assert.equal(h.requests.filter(message => message.type === "BEGIN_SCAN").length, 2);
  assert.equal(h.analyses.length, 1);
  assert.equal((await h.send({ type: "PAGE_STATUS" })).marked, 1);
});

test("continuously mutating feeds cannot postpone a scheduled scan forever", async () => {
  const h = await harness({ auto: true });
  await h.finish();
  h.blocks[0].text += " changed";
  const mutation = { type: "characterData", target: { nodeType: 3, parentElement: h.blocks[0] } };
  h.observer.callback([mutation]);
  const scheduled = [...h.timers.keys()];
  for (let i = 0; i < 10; i++) h.observer.callback([mutation]);
  assert.deepEqual([...h.timers.keys()], scheduled);
  await h.flushTimers();
  assert.equal(h.analyses.length, 2);
  await h.finish();
  await h.mutate(h.blocks[0]);
  assert.equal(h.analyses.length, 2, "unchanged cached text is not rescored");
});

test("mutations cannot start analysis before the new run is authorized", async () => {
  const h = await harness();
  let reply;
  const original = h.context.chrome.runtime.sendMessage;
  h.context.chrome.runtime.sendMessage = message => message.type === "BEGIN_SCAN"
    ? new Promise(resolve => { reply = resolve; }) : original(message);
  const starting = h.start();
  await h.settle();
  await h.mutate(h.blocks[0]);
  assert.equal(h.analyses.length, 0);
  assert.equal(h.requests.some(message => message.type === "PAGE_PROGRESS"), false);
  reply({ ok: true, result: { started: true } });
  await starting;
  assert.equal(h.analyses.length, 1);
  await h.finish();
});

test("navigation during inference discards the old result and scans the new page", async () => {
  const h = await harness({ auto: true, budget: 80 });
  h.context.location.href = "https://example.com/next";
  h.navigationEvents.get("currententrychange")();
  await h.flushTimers();
  assert.equal(h.analyses.length, 1);
  await h.finish(0);
  assert.equal(h.blocks[0].classes.size, 0, "old-page reply must not mark the new page");
  assert.equal(h.analyses.length, 2);
  await h.finish(1);
  assert.equal((await h.send({ type: "PAGE_STATUS" })).usedWords, 80);
  assert.equal(h.blocks[0].classes.size, 1);
});

test("worker restart reauthorizes without rescoring unchanged blocks", async () => {
  const h = await harness({ auto: true });
  await h.finish();
  h.settings.sessionId = "new-worker";
  await h.start();
  assert.equal(h.requests.filter(message => message.type === "BEGIN_SCAN").length, 2);
  assert.equal(h.analyses.length, 1);
  h.blocks[0].text += " changed";
  await h.mutate(h.blocks[0]);
  assert.equal(h.analyses.length, 2);
  await h.finish(1);
});

test("helper errors pause observation without retries and remain visible in popup status", async () => {
  const h = await harness({ auto: true });
  h.analyses[0].resolve({ ok: false, error: { code: "connect_failed", message: "Native helper missing." } });
  await h.settle();
  assert.equal(h.observer.active, false);
  assert.equal((await h.send({ type: "PAGE_STATUS" })).state, "error");
  assert.match((await h.send({ type: "PAGE_STATUS" })).detail, /Native helper missing/);
  h.blocks[0].text += " changed";
  await h.mutate(h.blocks[0]);
  assert.equal(h.analyses.length, 1);
});

test("known unsupported language is disclosed without inference or a page overlay", async () => {
  const h = await harness();
  h.context.DeckardCore.selectBlocks = () => ({ blocks: [], skipped: 0, limited: false, reason: "non_english" });
  await h.start();
  assert.equal(h.analyses.length, 0);
  assert.equal((await h.send({ type: "PAGE_STATUS" })).state, "skipped");
  assert.match((await h.send({ type: "PAGE_STATUS" })).detail, /non-English/);
  assert.equal(h.root.children.filter(node => node.shadow).length, 0);
});

test("the scanner continues top-to-bottom beyond twelve passages and publishes text-free progress", async () => {
  const h = await harness({ count: 20 });
  await h.start();
  for (let i = 0; i < 20; i++) {
    assert.equal(h.analyses.length, i + 1);
    await h.finish(i);
  }
  const status = await h.send({ type: "PAGE_STATUS" });
  assert.equal(status.scannedWords, 1600);
  assert.equal(status.usedWords, 1600);
  assert.equal(status.analyzed, 20);
  assert.equal(status.findings.length, 20);
  const updates = h.requests.filter(message => message.type === "PAGE_PROGRESS");
  assert.equal(updates[0].status.state, "scanning");
  assert.equal(updates.at(-1).status.state, "done");
  assert.equal(updates.at(-1).status.marked, 20);
  assert.ok(updates.every(message => message.scanner_version === 7));
  assert.ok(!JSON.stringify(updates).includes(h.blocks[0].text));
});

test("short neighboring paragraphs share a group mark and jump link; changes invalidate the whole group", async () => {
  const h = await harness({ count: 2 });
  h.blocks[0].text = "short ".repeat(40).trim();
  h.blocks[1].text = "next ".repeat(40).trim();
  h.context.DeckardCore.selectBlocks = () => ({
    blocks: [{ key: "combined", node: h.blocks[0], text: h.blocks.map(node => node.text).join("\n\n"), words: 80,
      parts: h.blocks.map(node => ({ node, text: node.text, whole: true, ranges: [] })) }],
    skipped: 0, limited: false, totalWords: 80,
  });
  await h.start(); await h.finish();
  assert.equal(h.analyses.length, 1);
  assert.ok(h.blocks.every(node => node.classes.size === 1));
  const status = await h.send({ type: "PAGE_STATUS" });
  assert.equal(status.marked, 1);
  assert.equal((await h.send({ type: "FOCUS_FINDING", findingId: status.findings[0].id,
    runId: h.analyses[0].message.runId })).focused, true);
  assert.equal(h.blocks[0].scrolled.block, "center");
  h.blocks[1].text += " changed";
  await h.mutate(h.blocks[1]);
  assert.ok(h.blocks.every(node => node.classes.size === 0));
  assert.equal((await h.send({ type: "FOCUS_FINDING", findingId: status.findings[0].id,
    runId: h.analyses[0].message.runId })).focused, false);
});

test("a split long element highlights only the scanned range, jumps to that range, and restores on Off", async () => {
  const h = await harness();
  const registry = new Map();
  h.context.window.CSS = { highlights: registry };
  h.context.window.Highlight = class extends Set {};
  h.context.window.innerHeight = 900;
  h.context.window.scrollBy = options => { h.context.window.scrolled = options; };
  const range = { startContainer: { parentElement: h.blocks[0] }, getBoundingClientRect: () => ({ top: 3000 }) };
  h.context.DeckardCore.selectBlocks = () => ({
    blocks: [{ key: "slice", node: h.blocks[0], text: h.blocks[0].text, words: 80,
      parts: [{ node: h.blocks[0], text: h.blocks[0].text, whole: false, ranges: [range] }] }],
    skipped: 0, limited: true, totalWords: 80,
  });
  await h.start(); await h.finish();
  assert.equal(h.blocks[0].classes.size, 0, "never color the whole partially scanned element");
  assert.ok([...registry.values()][0].has(range));
  const status = await h.send({ type: "PAGE_STATUS" });
  await h.send({ type: "FOCUS_FINDING", findingId: status.findings[0].id, runId: h.analyses[0].message.runId });
  assert.equal(h.context.window.scrolled.top, 2700);
  await h.send({ type: "STOP" });
  assert.equal(registry.size, 0);
  assert.equal(h.root.children.length, 1);
});

test("Off/On restores unchanged cached findings without spending the word budget again", async () => {
  const h = await harness();
  await h.start(); await h.finish();
  await h.send({ type: "STOP" });
  await h.start();
  assert.equal(h.analyses.length, 1);
  assert.equal(h.blocks[0].classes.size, 1);
  assert.equal((await h.send({ type: "PAGE_STATUS" })).usedWords, 80);
});

test("threshold changes re-mark cached scores without inference, including at the word cap", async () => {
  const h = await harness({ budget: 80 });
  await h.start();
  await h.finish(0, { ...result, score: 0.85, min_score: 0.85, max_score: 0.85 });
  assert.equal(h.blocks[0].classes.size, 0);
  h.settings.flagThreshold = 0.8;
  await h.send({ type: "SETTINGS_CHANGED" }); await h.settle();
  assert.equal(h.blocks[0].classes.size, 1);
  h.settings.flagThreshold = 0.9;
  await h.send({ type: "SETTINGS_CHANGED" }); await h.settle();
  assert.equal(h.blocks[0].classes.size, 0);
  assert.equal(h.analyses.length, 1);
  assert.equal((await h.send({ type: "PAGE_STATUS" })).usedWords, 80);
});

test("saved threshold applies to initial scans and an in-flight result", async () => {
  const h = await harness();
  h.settings.flagThreshold = 0.8;
  await h.start();
  h.settings.flagThreshold = 0.9;
  await h.send({ type: "SETTINGS_CHANGED" }); await h.settle();
  await h.finish(0, { ...result, score: 0.85, min_score: 0.85, max_score: 0.85 });
  assert.equal(h.blocks[0].classes.size, 0);
  h.settings.flagThreshold = 0.8;
  await h.send({ type: "SETTINGS_CHANGED" }); await h.settle();
  assert.equal(h.blocks[0].classes.size, 1);
  assert.equal(h.analyses.length, 1);
});

test("late configuration responses cannot undo a newer threshold", async () => {
  const h = await harness();
  await h.start();
  await h.finish(0, { ...result, score: 0.85, min_score: 0.85, max_score: 0.85 });
  const original = h.context.chrome.runtime.sendMessage;
  let release;
  h.context.chrome.runtime.sendMessage = message => message.type === "GET_CONFIG"
    ? new Promise(resolve => { release = resolve; }) : original(message);
  const old = h.send({ type: "SETTINGS_CHANGED" });
  await h.settle();
  h.context.chrome.runtime.sendMessage = original;
  h.settings.flagThreshold = 0.9;
  await h.send({ type: "SETTINGS_CHANGED" });
  release({ ok: true, result: { enabled: true, flagThreshold: 0.7 } });
  await old; await h.settle();
  assert.equal(h.blocks[0].classes.size, 0);
  assert.equal(h.analyses.length, 1);
});

test("structural mutation during inference rejects the result even when existing text ranges are unchanged", async () => {
  const h = await harness();
  await h.start();
  const inserted = new Node("span");
  h.blocks[0].append(inserted);
  h.observer.callback([{ type: "childList", target: h.blocks[0], addedNodes: [inserted], removedNodes: [] }]);
  await h.finish();
  assert.equal(h.blocks[0].classes.size, 0);
  assert.equal((await h.send({ type: "PAGE_STATUS" })).skipped, 1);
});

test("an unrelated sibling inserted after the budget is exhausted cannot erase findings", async () => {
  const h = await harness({ budget: 80 });
  await h.start(); await h.finish();
  const sibling = new Node("aside");
  h.root.append(sibling);
  h.observer.callback([{ type: "childList", target: h.root, addedNodes: [sibling], removedNodes: [] }]);
  await h.mutate(sibling);
  assert.equal((await h.send({ type: "PAGE_STATUS" })).marked, 1);
  assert.equal(h.blocks[0].classes.size, 1);
  assert.equal(h.analyses.length, 1);
});
