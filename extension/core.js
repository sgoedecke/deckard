(() => {
  "use strict";
  if (globalThis.DeckardCore?.SCANNER_VERSION === 7) return;
  const MAX_CHARS = 20000;
  const MIN_WORDS = 50;
  const MAX_PAGE_WORDS = 25000;
  const SCANNER_VERSION = 7;
  const MAX_DOM_NODES = 50000;
  const MAX_PAGE_CHARS = 500000;
  const TARGET_WORDS = 300;
  const BLOCK_ELEMENTS = "p,li,blockquote,h1,h2,h3,h4,h5,h6,div,section,article";
  const nodeIds = new WeakMap();
  let nextNodeId = 0;
  const PROTOCOL_VERSION = 3;
  const MODEL = "ShantanuT01/gradient-ai-text-detector";
  const MODEL_REVISION = "c2e8b6df87f8a211cbffb713fa9873a0c3a9713f";
  const POLICY = "gradient-q4-two-scale-v1";
  const FLAG_THRESHOLD = 0.97;
  const SOURCE_BOUNDARY = "article,[role='article'],[itemprop='comment'],[data-comment-id],.comment";
  const HOST_PERMISSIONS = Object.freeze(["http://*/*", "https://*/*"]);
  const EXCLUDED = "nav,header,footer,aside,form,button,input,textarea,select,option,pre,code,script,style,noscript,svg,details:not([open]),[inert],[contenteditable]:not([contenteditable='false']),[role='navigation'],[role='menu'],[role='textbox'],[hidden],[aria-hidden='true'],[data-deckard-owned]";
  function originOf(value) {
    try {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) ? url.origin : null;
    } catch { return null; }
  }
  function pageKey(value) {
    const url = new URL(value);
    // Ordinary in-page anchors do not replenish the budget; hash-router pages do.
    if (!/^#!?\//.test(url.hash)) url.hash = "";
    return url.href;
  }
  function normalizeSettings(value = {}) {
    const raw = value && typeof value === "object" ? value : {};
    return { enabled: raw.enabled === true, flagThreshold: validThreshold(raw.flagThreshold) ? raw.flagThreshold : FLAG_THRESHOLD };
  }
  function validThreshold(value) { return Number.isFinite(value) && value >= 0.70 && value <= 0.99; }
  function wordCount(text) {
    return (text.match(/\S+/gu) || []).length;
  }
  function charCount(text) { return [...text].length; }
  function normalizeText(text) {
    return text.split(/\n/).map(line => line.replace(/\s+/gu, " ").trim()).filter(Boolean).join("\n");
  }
  function englishDocument(document) {
    const language = (document.documentElement.lang || "").trim().toLowerCase();
    return !language || language === "en" || language.startsWith("en-");
  }
  function isVisible(element, view, cache = new WeakMap()) {
    const visited = [];
    let visible = true;
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
      if (cache.has(node)) { visible = cache.get(node); break; }
      visited.push(node);
      if (node.matches(EXCLUDED)) { visible = false; break; }
      const style = view.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse"
        || style.opacity === "0") { visible = false; break; }
    }
    for (const node of visited) cache.set(node, visible);
    return visible;
  }
  function readText(element, view) {
    const visibility = new WeakMap();
    if (!element.isConnected || !isVisible(element, view, visibility)) return "";
    const pieces = [];
    const walker = element.ownerDocument.createTreeWalker(element, 5);
    let node;
    let previousBlock;
    let size = 0;
    let visited = 0;
    while ((node = walker.nextNode())) {
      if (++visited > 5000) return "x".repeat(MAX_CHARS + 1);
      if (node.nodeType === 1) {
        if (node.tagName === "BR" && isVisible(node, view, visibility)) pieces.push("\n");
        continue;
      }
      if (node.parentElement && isVisible(node.parentElement, view, visibility)) {
        size += node.nodeValue.length;
        // Bound extraction itself, including pathological markup or huge whitespace nodes.
        if (size > MAX_CHARS * 2) return "x".repeat(MAX_CHARS + 1);
        const block = node.parentElement.closest("p,div,section,article,li,blockquote,h1,h2,h3,h4,h5,h6") || element;
        if (previousBlock && previousBlock !== block) pieces.push("\n");
        pieces.push(node.nodeValue);
        previousBlock = block;
      }
    }
    // Keep paragraph boundaries in the original text sent to Gradient.
    return normalizeText(pieces.join(""));
  }
  function selectBlocks(document, view = document.defaultView) {
    if (!englishDocument(document)) return { blocks: [], totalWords: 0, skipped: 0, limited: false, reason: "non_english" };
    const blocks = [];
    const visibility = new WeakMap();
    let skipped = 0;
    let limited = false;
    let examinedWords = 0;
    let visited = 0;
    let characters = 0;
    let unit;
    let pending = [];
    const textOf = parts => parts.map(part => part.text).join("\n\n");
    function emit(parts) {
      const first = parts[0].ranges[0];
      const last = parts.at(-1).ranges.at(-1);
      for (const node of [first.startContainer, last.endContainer]) {
        if (!nodeIds.has(node)) nodeIds.set(node, ++nextNodeId);
      }
      const text = textOf(parts);
      blocks.push({ key: `${nodeIds.get(first.startContainer)}:${first.startOffset}-${nodeIds.get(last.endContainer)}:${last.endOffset}`,
        node: parts[0].node, parts, text, words: wordCount(text) });
    }
    function accept(part) {
      const source = part.node.closest(SOURCE_BOUNDARY);
      if (pending.length && pending[0].node.closest(SOURCE_BOUNDARY) !== source) {
        skipped++;
        pending = [];
      }
      if (pending.length && textOf([...pending, part]).length > MAX_CHARS) {
        skipped++;
        limited = true;
        pending = [];
      }
      pending.push(part);
      if (wordCount(textOf(pending)) >= MIN_WORDS) {
        emit(pending);
        pending = [];
      }
    }
    function flush() {
      if (!unit) return;
      const current = unit;
      unit = undefined;
      const words = [];
      for (const match of current.raw.matchAll(/\S+/gu)) {
        if (current.cut && match.index + match[0].length === current.raw.length) break;
        if (examinedWords + words.length >= MAX_PAGE_WORDS) { limited = true; break; }
        words.push({ start: match.index, end: match.index + match[0].length });
      }
      examinedWords += words.length;
      if (!words.length) return;
      const count = Math.ceil(words.length / TARGET_WORDS);
      const size = Math.floor(words.length / count);
      let index = 0;
      for (let chunk = 0; index < words.length; chunk++) {
        let end = Math.min(words.length, index + size + (chunk < words.length % count ? 1 : 0));
        while (end > index && words[end - 1].end - words[index].start > MAX_CHARS) end--;
        if (end === index) { skipped++; limited = true; index++; if (index >= words.length) break; continue; }
        const startOffset = words[index].start, endOffset = words[end - 1].end;
        const ranges = [], snapshots = [];
        for (const segment of current.segments) {
          if (!segment.node || segment.end <= startOffset || segment.start >= endOffset) continue;
          const range = document.createRange();
          range.setStart(segment.node, Math.max(0, startOffset - segment.start));
          range.setEnd(segment.node, Math.min(segment.end, endOffset) - segment.start);
          ranges.push(range);
          snapshots.push(segment.node.nodeValue.slice(range.startOffset, range.endOffset));
        }
        const text = normalizeText(current.raw.slice(startOffset, endOffset));
        const whole = index === 0 && end === words.length && !current.cut && !limited
          && !current.node.querySelector(`${BLOCK_ELEMENTS},${EXCLUDED}`);
        accept({ node: current.node, ranges, snapshots, text, whole,
          sourceWords: words.slice(index, end), segments: current.segments });
        index = end;
      }
    }
    const walker = document.createTreeWalker(document.body || document.documentElement, 5);
    let node;
    while ((node = walker.nextNode())) {
      if (++visited > MAX_DOM_NODES || characters >= MAX_PAGE_CHARS) { limited = true; break; }
      const element = node.nodeType === 1 ? node : node.parentElement;
      const language = element.closest("[lang]:not([lang=''])")?.getAttribute("lang")?.trim().toLowerCase();
      if (!isVisible(element, view, visibility) || (language && language !== "en" && !language.startsWith("en-"))) {
        flush();
        continue;
      }
      if (node.nodeType === 1) {
        if (node.tagName === "BR" && unit) unit.raw += "\n";
        continue;
      }
      const block = element.closest(BLOCK_ELEMENTS) || element;
      if (unit && unit.node !== block) flush();
      if (examinedWords >= MAX_PAGE_WORDS) {
        if (/\S/u.test(node.nodeValue)) limited = true;
        break;
      }
      unit ||= { node: block, raw: "", segments: [], cut: false };
      const raw = node.nodeValue.slice(0, MAX_PAGE_CHARS - characters);
      const start = unit.raw.length;
      unit.raw += raw;
      unit.segments.push({ node, start, end: start + raw.length });
      characters += raw.length;
      if (raw.length < node.nodeValue.length) { unit.cut = true; limited = true; break; }
    }
    flush();
    if (pending.length) {
      const previous = blocks.at(-1);
      if (previous && previous.node.closest(SOURCE_BOUNDARY) === pending[0].node.closest(SOURCE_BOUNDARY)
        && textOf([...previous.parts, ...pending]).length <= MAX_CHARS) {
        blocks.pop();
        emit([...previous.parts, ...pending]);
      } else skipped++;
    }
    return { blocks, totalWords: examinedWords, skipped, limited,
      reason: !blocks.length && skipped ? "insufficient_text" : null };
  }
  function groupCurrent(block, view) {
    const visibility = new WeakMap();
    return block.parts.every(part => part.node.isConnected && (part.whole
      ? readText(part.node, view) === part.text
      : part.ranges.every((range, index) => range.startContainer === range.endContainer
        && range.startContainer.nodeType === 3 && range.startContainer.isConnected
        && range.startContainer.nodeValue.slice(range.startOffset, range.endOffset) === part.snapshots[index]
        && isVisible(range.startContainer.parentElement, view, visibility))));
  }
  function contextSources(blocks) {
    const groups = [];
    for (const block of blocks) {
      // Explicit articles/comments are hard boundaries. Unmarked authors cannot be inferred.
      const source = block.node.closest(SOURCE_BOUNDARY);
      const previous = groups.at(-1);
      if (previous && previous.source === source) previous.blocks.push(block);
      else groups.push({ source, blocks: [block] });
    }
    return groups.map(group => ({ ...group, text: group.blocks.map(block => block.text).join("\n\n") }));
  }
  function contextMatches(text) {
    return [...text.matchAll(/[^\s\u001c-\u001f\u0085]+/gu)];
  }
  function validPlan(result, texts) {
    if (!validModelIdentity(result) || result.status !== "planned" || !Array.isArray(result.groups)
      || result.groups.length !== texts.length) return false;
    return result.groups.every((spans, index) => {
      if (!Array.isArray(spans) || spans.length > MAX_PAGE_WORDS) return false;
      const count = contextMatches(texts[index]).length;
      let end = 0;
      for (const span of spans) {
        if (!span || span.start_word !== end || !Number.isSafeInteger(span.end_word)
          || span.end_word <= end || span.end_word > count || !Number.isSafeInteger(span.tokens)
          || span.tokens < 1 || typeof span.complete !== "boolean") return false;
        end = span.end_word;
      }
      return end === count;
    });
  }
  function contextBlocks(groups, plan, document) {
    const texts = groups.map(group => group.text);
    if (!validPlan(plan, texts)) throw new Error("Invalid native context mapping.");
    const output = [];
    for (const [groupIndex, group] of groups.entries()) {
      const matches = contextMatches(group.text);
      const boundaries = [0, ...matches.slice(1).map(match => match.index), group.text.length];
      const parts = [];
      let cursor = 0;
      for (const [blockIndex, block] of group.blocks.entries()) {
        const blockStart = cursor;
        for (const part of block.parts) {
          parts.push({ part, start: cursor, end: cursor + part.text.length, blockIndex, blockStart });
          cursor += part.text.length + 2;
        }
      }
      for (const [index, span] of plan.groups[groupIndex].entries()) {
        const start = boundaries[span.start_word], end = boundaries[span.end_word];
        const mapped = [];
        const firstEntry = parts.find(entry => entry.end > start && entry.start < end);
        for (const entry of parts) {
          if (entry.end <= start || entry.start >= end) continue;
          const part = entry.part;
          if (start <= entry.start && end >= entry.end) { mapped.push(part); continue; }
          const words = contextMatches(part.text);
          const selected = words.map(word => ({ word })).filter(({ word }) =>
            entry.start + word.index >= start && entry.start + word.index < end);
          if (!selected.length) continue;
          const normalizedWords = [...part.text.matchAll(/\S+/gu)];
          const rawOffset = offset => {
            const i = normalizedWords.findIndex(word => offset >= word.index && offset <= word.index + word[0].length);
            if (i < 0 || !part.sourceWords?.[i]) throw new Error("Missing context source offsets.");
            return part.sourceWords[i].start + offset - normalizedWords[i].index;
          };
          const first = rawOffset(selected[0].word.index);
          const last = rawOffset(selected.at(-1).word.index + selected.at(-1).word[0].length);
          if (!Array.isArray(part.segments)) throw new Error("Missing context source ranges.");
          const ranges = [], snapshots = [];
          for (const segment of part.segments) {
            if (segment.end <= first || segment.start >= last) continue;
            const range = document.createRange();
            range.setStart(segment.node, Math.max(0, first - segment.start));
            range.setEnd(segment.node, Math.min(segment.end, last) - segment.start);
            ranges.push(range);
            snapshots.push(segment.node.nodeValue.slice(range.startOffset, range.endOffset));
          }
          mapped.push({ node: part.node, ranges, snapshots, whole: false,
            text: part.text.slice(selected[0].word.index, selected.at(-1).word.index + selected.at(-1).word[0].length) });
        }
        const text = group.text.slice(start, end);
        if (!mapped.length) throw new Error("Empty context source mapping.");
        output.push({ key: `context:${group.blocks[0].key}:${index}`, text, words: wordCount(text),
          node: mapped[0].node, parts: mapped, scale: "context",
          complete: span.complete && charCount(text) <= MAX_CHARS,
          index: groups.slice(0, groupIndex).reduce((n, g) => n + g.blocks.length, 0)
            + firstEntry.blockIndex + Math.max(0, start - firstEntry.blockStart)
              / (group.blocks[firstEntry.blockIndex].text.length + 2) });
      }
    }
    return output;
  }
  function shouldFlag(result, settings) {
    return settings.enabled && validModelIdentity(result) && result.status === "complete"
      && !result.truncated && Number.isFinite(result.max_score)
      && Array.isArray(result.chunks) && result.chunks.length > 0
      && result.chunks.every(chunk => chunk.words >= MIN_WORDS)
      && result.max_score >= normalizeSettings(settings).flagThreshold;
  }
  function validModelIdentity(result) {
    return Boolean(result && typeof result === "object" && result.protocol_version === PROTOCOL_VERSION
      && result.model === MODEL && result.revision === MODEL_REVISION && result.policy === POLICY
      && result.flag_threshold === FLAG_THRESHOLD && result.experimental === true && result.min_words === MIN_WORDS);
  }
  globalThis.DeckardCore = Object.freeze({
    MAX_CHARS, MIN_WORDS, MAX_PAGE_WORDS, SCANNER_VERSION, FLAG_THRESHOLD, PROTOCOL_VERSION, MODEL, MODEL_REVISION, POLICY,
    validModelIdentity, validThreshold, HOST_PERMISSIONS, EXCLUDED, originOf, pageKey,
    normalizeSettings, wordCount, charCount, englishDocument, isVisible,
    readText, selectBlocks, groupCurrent, shouldFlag, contextSources, contextBlocks, validPlan,
  });
})();
