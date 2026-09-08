import test from "node:test";
import assert from "node:assert/strict";
import "../core.js";
import { modelIdentity } from "./model-fixture.js";
const C = globalThis.DeckardCore;

test("runtime settings stay fail-closed; first-install defaults belong to worker initialization", () => {
  const defaults = { enabled: false, flagThreshold: C.FLAG_THRESHOLD };
  assert.deepEqual(C.normalizeSettings(), defaults);
  assert.deepEqual(C.normalizeSettings({ threshold: NaN, hideEnabled: "yes", text: "private",
    autoSites: ["https://example.com", "https://example.com", "https://example.com/path", "file:///a", null] }),
  defaults);
  assert.deepEqual(C.normalizeSettings({ enabled: true, threshold: 0.1, hideEnabled: true }), { ...defaults, enabled: true });
  assert.deepEqual(C.normalizeSettings({ enabled: "true" }), defaults);
  assert.deepEqual(C.normalizeSettings(null), C.normalizeSettings());
});

test("HTTP(S) only and broad host permissions", () => {
  assert.equal(C.originOf("https://example.com:8443/a?b=c"), "https://example.com:8443");
  assert.deepEqual(C.HOST_PERMISSIONS, ["http://*/*", "https://*/*"]);
  for (const input of ["chrome://settings", "file:///a", "about:blank", "data:text/plain,hi", "bad"]) {
    assert.equal(C.originOf(input), null);
  }
});

test("word/Unicode counting and English page gate", () => {
  assert.equal(C.wordCount(" one\n two \tthree "), 3);
  assert.equal(C.charCount("a😀"), 2);
  for (const [lang, expected] of [["", true], ["en", true], ["en-GB", true], ["fr", false]]) {
    assert.equal(C.englishDocument({ documentElement: { lang } }), expected);
  }
});

test("red marking requires enabled scanning and complete coverage with a chunk above the fixed threshold", () => {
  const result = { ...modelIdentity, status: "complete", min_score: 0.91, max_score: 0.99, score: 0.95, truncated: false,
    chunks: [{ words: 80 }] };
  const settings = { enabled: true };
  assert.equal(C.FLAG_THRESHOLD, 0.97);
  assert.equal(C.shouldFlag(result, settings), true);
  assert.equal(C.shouldFlag(result, { enabled: false }), false);
  assert.equal(C.shouldFlag({ ...result, max_score: 0.89 }, { enabled: true, threshold: 0 }), false);
  assert.equal(C.shouldFlag({ ...result, status: "partial" }, settings), false);
  assert.equal(C.shouldFlag({ ...result, truncated: true }, settings), false);
  assert.equal(C.shouldFlag({ ...result, max_score: 0.89 }, settings), false);
  assert.equal(C.shouldFlag({ ...result, max_score: NaN }, settings), false);
  assert.equal(C.shouldFlag({ ...result, chunks: [{ words: 25 }] }, settings), false);
});

test("one high-scoring chunk flags a mixed block despite a low mean and minimum", () => {
  const result = { ...modelIdentity, status: "complete", min_score: 0.04, max_score: 0.99, score: 0.13,
    truncated: false, chunks: [{ words: 80, score: 0.99 }, { words: 800, score: 0.04 }] };
  const settings = { enabled: true };
  assert.equal(C.shouldFlag(result, settings), true);
  assert.equal(C.shouldFlag({ ...result, status: "partial" }, settings), false);
  assert.equal(C.shouldFlag({ ...result, truncated: true }, settings), false);
  assert.equal(C.shouldFlag({ ...result, chunks: [{ words: 25, score: 0.97 }, result.chunks[1]] }, settings), false);
  assert.equal(C.shouldFlag({ ...result, chunks: [result.chunks[0], { words: 25, score: 0.04 }] }, settings), false);
});

test("a stale backend or an incompatible threshold cannot authorize a Deckard mark", () => {
  const result = { ...modelIdentity, status: "complete", max_score: 0.99,
    truncated: false, chunks: [{ words: 80 }] };
  for (const change of [{ model: "editlens" }, { protocol_version: 1 }, { flag_threshold: 0.9 },
    { experimental: false }, { policy: "unknown" }, { max_score: 0.969999 }]) {
    assert.equal(C.shouldFlag({ ...result, ...change }, { enabled: true }), false);
  }
});

test("user thresholds are bounded independently of native model identity", () => {
  const result = { ...modelIdentity, status: "complete", max_score: 0.85, truncated: false, chunks: [{ words: 80 }] };
  for (const value of [0.7, 0.8, 0.99]) {
    assert.equal(C.normalizeSettings({ flagThreshold: value }).flagThreshold, value);
    assert.equal(C.shouldFlag(result, { enabled: true, flagThreshold: value }), value <= 0.85);
  }
  for (const value of [null, NaN, Infinity, "0.8", 0.69, 1, true]) {
    assert.equal(C.normalizeSettings({ flagThreshold: value }).flagThreshold, C.FLAG_THRESHOLD);
  }
  assert.equal(C.shouldFlag({ ...result, flag_threshold: 0.7 }, { enabled: true, flagThreshold: 0.7 }), false);
  assert.equal(C.shouldFlag({ ...result, status: "partial" }, { enabled: true, flagThreshold: 0.7 }), false);
});
function fixture(texts, { lang = "en" } = {}) {
  const view = { getComputedStyle: node => ({ display: node.hidden ? "none" : "block",
    visibility: "visible", opacity: "1" }) };
  const doc = {
    defaultView: view,
    createTreeWalker: root => {
      let index = 0;
      const nodes = [];
      const walk = node => { for (const child of node.childrenText || []) { nodes.push(child); walk(child); } };
      walk(root);
      return { nextNode: () => nodes[index++] || null };
    },
    createRange: () => ({
      setStart(node, offset) { this.startContainer = node; this.startOffset = offset; },
      setEnd(node, offset) { this.endContainer = node; this.endOffset = offset; },
      toString() { assert.equal(this.startContainer, this.endContainer); return this.startContainer.nodeValue.slice(this.startOffset, this.endOffset); },
    }),
  };
  doc.element = (tag, children = []) => {
    const node = { nodeType: 1, tagName: tag.toUpperCase(), parentElement: null, ownerDocument: doc, isConnected: true,
      matches: function(selector) { return Boolean(this.excluded || selector.split(",").includes(this.tagName.toLowerCase())); },
      closest(selector) {
        for (let value = this; value; value = value.parentElement) {
          if (selector.startsWith("[lang]") ? Boolean(value.lang) : selector.split(",").includes(value.tagName?.toLowerCase())) return value;
        }
        return null;
      },
      getAttribute(name) { return this[name] ?? null; },
      contains(other) { for (let n = other; n; n = n.parentElement) if (n === this) return true; return false; },
      querySelector(selector) {
        for (const child of this.childrenText) {
          if (child.nodeType === 1 && (child.matches(selector) || child.querySelector(selector))) return child;
        }
        return null;
      } };
    node.childrenText = children.map(child => typeof child === "string"
      ? { nodeType: 3, parentElement: node, nodeValue: child, get isConnected() { return this.parentElement.isConnected; } } : child);
    for (const child of node.childrenText) child.parentElement = node;
    return node;
  };
  doc.nodes = texts.map(text => doc.element("p", [text]));
  doc.body = doc.element("body", doc.nodes);
  doc.documentElement = doc.element("html", [doc.body]);
  doc.documentElement.lang = lang;
  return doc;
}
const prose = "word ".repeat(80);

test("context word ordinals map exact Unicode prose across parts, inline exclusions and split nodes", () => {
  const doc = fixture([]);
  const first = doc.element("p", ["  Café 🙂 ".repeat(30), doc.element("code", ["EXCLUDED"]),
    doc.element("em", [" naïve\u00a0résumé ".repeat(15)]), "\nlast ".repeat(10)]);
  const second = doc.element("p", ["second ".repeat(100)]);
  doc.body.childrenText = [first, second];
  first.parentElement = second.parentElement = doc.body;
  const local = C.selectBlocks(doc).blocks;
  const groups = C.contextSources(local);
  assert.equal(groups.length, 1);
  assert.ok(!groups[0].text.includes("EXCLUDED"));
  const count = C.wordCount(groups[0].text);
  const plan = { ...modelIdentity, status: "planned", groups: [[
    { start_word: 0, end_word: 130, tokens: 200, complete: true },
    { start_word: 130, end_word: count, tokens: 100, complete: true },
  ]] };
  const contexts = C.contextBlocks(groups, plan, doc);
  assert.equal(contexts.map(block => block.text).join(""), groups[0].text);
  assert.ok(contexts.every(block => C.groupCurrent(block, doc.defaultView)));
  assert.equal(contexts[0].parts.at(-1).whole, false);
  assert.equal(contexts[0].parts.at(-1).ranges.map(range => range.toString()).join(""), "second ".repeat(30).trim());
  assert.equal(contexts[1].parts[0].ranges.map(range => range.toString()).join(""), "second ".repeat(70).trim());
  second.childrenText[0].nodeValue = "changed";
  assert.ok(contexts.every(block => !C.groupCurrent(block, doc.defaultView)));
});

test("context mapping rejects gaps, overlaps, incomplete coverage, invalid ordinals and wrong identity", () => {
  const text = "original ".repeat(100).trim();
  const span = { start_word: 0, end_word: 100, tokens: 100, complete: true };
  const plan = { ...modelIdentity, status: "planned", groups: [[span]] };
  assert.equal(C.validPlan(plan, [text]), true);
  for (const bad of [{ start_word: 1 }, { end_word: 99 }, { end_word: 101 },
    { end_word: 1.5 }, { tokens: -1 }, { complete: "true" }]) {
    assert.equal(C.validPlan({ ...plan, groups: [[{ ...span, ...bad }]] }, [text]), false);
  }
  assert.equal(C.validPlan({ ...plan, groups: [[span, span]] }, [text]), false);
  assert.equal(C.validPlan({ ...plan, policy: "old" }, [text]), false);
});

test("contexts starting inside the second part of a local group keep source order", () => {
  const doc = fixture(Array(5).fill("original ".repeat(40)));
  const groups = C.contextSources(C.selectBlocks(doc).blocks);
  const contexts = C.contextBlocks(groups, { ...modelIdentity, status: "planned", groups: [[
    { start_word: 0, end_word: 60, tokens: 60, complete: true },
    { start_word: 60, end_word: 200, tokens: 140, complete: true },
  ]] }, doc);
  assert.equal(contexts[0].index, 0);
  assert.ok(contexts[1].index > 0 && contexts[1].index < 1);
});

test("explicit articles are hard boundaries for local short groups and context partitions", () => {
  const doc = fixture([]);
  const a = doc.element("article", [doc.element("p", ["a ".repeat(30)])]);
  const b = doc.element("article", [doc.element("p", ["b ".repeat(30)])]);
  doc.body.childrenText = [a, b];
  a.parentElement = b.parentElement = doc.body;
  assert.equal(C.selectBlocks(doc).blocks.length, 0);
  a.childrenText[0].childrenText[0].nodeValue = "a ".repeat(80);
  b.childrenText[0].childrenText[0].nodeValue = "b ".repeat(80);
  const sources = C.contextSources(C.selectBlocks(doc).blocks);
  assert.equal(sources.length, 2);
  assert.ok(sources[0].text.startsWith("a ") && sources[1].text.startsWith("b "));
});

test("neighboring short prose is combined and the page continues beyond twelve paragraphs", () => {
  const doc = fixture(["word ".repeat(40), "word ".repeat(40), ...Array(20).fill(prose), "word ".repeat(20)]);
  const result = C.selectBlocks(doc);
  assert.equal(result.blocks.length, 21);
  assert.equal(result.skipped, 0);
  assert.equal(result.limited, false);
  assert.equal(result.blocks[0].parts.length, 2);
  assert.equal(result.blocks.at(-1).words, 100, "short trailing text joins the preceding group");
  assert.equal(result.totalWords, 1700);
  assert.ok(result.blocks.every(block => block.words >= C.MIN_WORDS));
  assert.equal(C.selectBlocks(fixture([prose], { lang: "de" })).reason, "non_english");
});

test("nested containers do not duplicate paragraphs, and direct div prose is included", () => {
  const doc = fixture([]);
  const inner = doc.element("article", [doc.element("p", [prose]), doc.element("div", [prose])]);
  const outer = doc.element("article", [inner]);
  doc.body.childrenText = [outer]; outer.parentElement = doc.body;
  assert.equal(C.selectBlocks(doc).blocks.length, 2);
  assert.equal(C.selectBlocks(doc).totalWords, 160);
});

test("excluded/hidden descendants do not enter extracted text", () => {
  const doc = fixture([prose]);
  const node = doc.nodes[0];
  const excluded = doc.element("code", ["secret navigation"]); excluded.parentElement = node;
  node.childrenText.push(excluded);
  assert.equal(C.readText(node, doc.defaultView), prose.trim());
  node.isConnected = false;
  assert.equal(C.readText(node, doc.defaultView), "");
});

test("hidden, editing, navigation and non-English content never enter requests", () => {
  const doc = fixture([]);
  const hidden = doc.element("p", [prose]); hidden.hidden = true;
  const french = doc.element("p", [prose]); french.lang = "fr";
  doc.body.childrenText = [doc.element("nav", ["secret navigation"]), doc.element("form", ["private input"]),
    doc.element("code", ["private code"]), hidden, french, doc.element("p", [prose])];
  for (const node of doc.body.childrenText) node.parentElement = doc.body;
  const result = C.selectBlocks(doc);
  assert.equal(result.blocks.length, 1);
  assert.equal(result.blocks[0].text, prose.trim());
});

test("a novel in one text node is split and stopped at exactly 25,000 words", () => {
  const doc = fixture(["novel ".repeat(200000)]);
  const result = C.selectBlocks(doc);
  assert.equal(result.totalWords, 25000);
  assert.equal(result.blocks.reduce((n, block) => n + block.words, 0), 25000);
  assert.equal(result.limited, true);
  assert.ok(result.blocks.length > 12);
  assert.ok(result.blocks.every(block => block.text.length <= C.MAX_CHARS && block.words >= C.MIN_WORDS));
  assert.ok(result.blocks.every(block => block.parts.every(part => !part.whole)), "never color the entire unscanned novel");
  assert.equal(result.blocks.flatMap(block => block.parts).flatMap(part => part.ranges).at(-1).endOffset, 149999);
});

test("word limit also applies across thousands of small elements", () => {
  const result = C.selectBlocks(fixture(Array(3000).fill("short ".repeat(10))));
  assert.equal(result.totalWords, 25000);
  assert.equal(result.blocks.reduce((sum, block) => sum + block.words, 0), 25000);
  assert.equal(result.limited, true);
});

test("oversized pathological words are bounded without emitting invalid or overlong requests", () => {
  const result = C.selectBlocks(fixture(["x".repeat(600000)]));
  assert.equal(result.limited, true);
  assert.equal(result.blocks.length, 0);
  const chunks = C.selectBlocks(fixture([("x".repeat(1000) + " ").repeat(100)])).blocks;
  assert.ok(chunks.every(block => block.text.length <= C.MAX_CHARS && block.words >= C.MIN_WORDS));
});

test("a genuinely short page is explicitly unscorable, not reported as human", () => {
  const result = C.selectBlocks(fixture(["tiny ".repeat(30)]));
  assert.equal(result.totalWords, 30);
  assert.equal(result.blocks.length, 0);
  assert.equal(result.reason, "insufficient_text");
});

test("50 words is the exact extraction and marking floor, including combined comments", () => {
  assert.equal(C.MIN_WORDS, 50);
  assert.equal(C.selectBlocks(fixture(["word ".repeat(49)])).reason, "insufficient_text");
  for (const count of [50, 74, 75]) {
    const selected = C.selectBlocks(fixture(["word ".repeat(count)]));
    assert.equal(selected.blocks.length, 1);
    assert.equal(selected.blocks[0].words, count);
  }
  const combined = C.selectBlocks(fixture(["first ".repeat(25), "second ".repeat(25)]));
  assert.equal(combined.blocks.length, 1);
  assert.equal(combined.blocks[0].parts.length, 2);
  assert.equal(combined.blocks[0].words, 50);
  const result = { ...modelIdentity, status: "complete", max_score: 0.99, truncated: false };
  for (const count of [49, 50, 74, 75]) {
    assert.equal(C.shouldFlag({ ...result, chunks: [{ words: count }] }, { enabled: true }), count >= 50);
  }
  for (const min_words of [undefined, 75]) {
    assert.equal(C.validModelIdentity({ ...modelIdentity, min_words }), false);
  }
});

test("group keys are stable and range snapshots reject changed or hidden text", () => {
  const doc = fixture(["word ".repeat(700)]);
  const blocks = C.selectBlocks(doc).blocks;
  assert.deepEqual(C.selectBlocks(doc).blocks.map(block => block.key), blocks.map(block => block.key));
  assert.ok(blocks.every(block => C.groupCurrent(block, doc.defaultView)));
  doc.nodes[0].childrenText[0].nodeValue = "other ".repeat(700);
  assert.equal(C.groupCurrent(blocks[0], doc.defaultView), false);
  doc.nodes[0].hidden = true;
  assert.equal(C.groupCurrent(blocks.at(-1), doc.defaultView), false);
});

test("extraction preserves paragraph boundaries and inline text, caching ancestor visibility", () => {
  const doc = fixture([""]);
  const root = doc.nodes[0];
  const paragraph = () => { const node = doc.element("p"); node.parentElement = root; return node; };
  const header = paragraph();
  const body = paragraph();
  const inline = { nodeType: 1, parentElement: body, matches: () => false, closest: () => body };
  const br = { nodeType: 1, tagName: "BR", parentElement: body, matches: () => false };
  root.childrenText = [
    { nodeType: 3, parentElement: header, nodeValue: "Sure, here it is." },
    { nodeType: 3, parentElement: body, nodeValue: " A para" },
    { nodeType: 3, parentElement: inline, nodeValue: "graph" },
    { nodeType: 3, parentElement: body, nodeValue: " with inline markup." },
    br,
    { nodeType: 3, parentElement: body, nodeValue: "Another line. " },
  ];
  const reads = new Map();
  const view = { getComputedStyle(node) {
    reads.set(node, (reads.get(node) || 0) + 1);
    return doc.defaultView.getComputedStyle(node);
  } };
  assert.equal(C.readText(root, view), "Sure, here it is.\nA paragraph with inline markup.\nAnother line.");
  assert.ok([...reads.values()].every(count => count === 1));
});
