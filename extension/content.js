(() => {
  "use strict";
  if (globalThis.__deckardLocal) return;
  globalThis.__deckardLocal = true;
  const C = globalThis.DeckardCore;
  if (!C || !C.originOf(location.href) || window.top !== window) return;
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const flagClass = `deckard-marked-${suffix}`;
  const records = new Map();
  const processed = new Map();
  const classOwners = new Map();
  let config = C.normalizeSettings();
  let runId = null;
  let authorizedRun = null;
  let lifecycle = 0;
  let refreshSequence = 0;
  let workerSession;
  let stopped = true;
  let running = false;
  let pending = false;
  let usedWords = 0;
  let progressSequence = 0;
  let activeBlock;
  let activeDirty = false;
  let highlights;
  let timer;
  let pruneTimer;
  const dirtyRecords = new Set();
  const structuralRecords = new Set();
  let currentURL = location.href;
  let sheet;
  let status = { state: "idle", analyzed: 0, partial: 0, skipped: 0, marked: 0, limited: false,
    scannedWords: 0, totalWords: 0, usedWords: 0, findings: [], detail: "" };
  const view = window;
  function request(message) {
    return chrome.runtime.sendMessage({ ...message, protocol_version: C.PROTOCOL_VERSION,
      scanner_version: C.SCANNER_VERSION }).then(response => {
      if (!response?.ok) {
        const error = new Error(response?.error?.message || "Extension unavailable. Reload the page.");
        error.code = response?.error?.code || "extension_error";
        throw error;
      }
      return response.result;
    });
  }
  function owned(tag) {
    const node = document.createElement(tag);
    node.dataset.deckardOwned = suffix;
    return node;
  }
  function ensureStyles() {
    if (sheet?.isConnected) return;
    sheet = owned("style");
    // Include common prose descendants with their own colors; never overwrite inline styles.
    sheet.textContent = `.${flagClass},.${flagClass} :is(div,section,p,span,a,em,strong,b,i,u,s,small,mark,blockquote,li,h1,h2,h3,h4,h5,h6){color:#d00!important;-webkit-text-fill-color:#d00!important}\n::highlight(${flagClass}){color:#d00}`;
    document.documentElement.append(sheet);
  }
  function updateStatus(detail) {
    if (detail !== undefined) status.detail = detail;
    status.marked = records.size;
    status.usedWords = usedWords;
    status.budgetExhausted = usedWords >= C.MAX_PAGE_WORDS;
    status.findings = [...records.values()].sort((a, b) => a.index - b.index)
      .map(record => ({ id: record.id, label: record.label, words: record.block.words }));
    if (runId && authorizedRun === runId && !stopped) {
      const id = runId;
      status.sequence = ++progressSequence;
      void request({ type: "PAGE_PROGRESS", runId: id, status: { ...status } }).catch(error => {
        if (id !== runId || stopped || error.code === "cancelled") return;
        status.state = "error";
        status.detail = `Progress reporting failed: ${error.message}`;
        observer.disconnect();
      });
    }
  }
  function removeRecord(key) {
    const record = records.get(key);
    dirtyRecords.delete(key);
    structuralRecords.delete(key);
    if (!record) return;
    for (const part of record.block.parts) {
      if (part.whole) {
        const owners = classOwners.get(part.node);
        owners?.delete(key);
        if (!owners?.size) { part.node.classList.remove(flagClass); classOwners.delete(part.node); }
      } else for (const range of part.ranges) highlights?.delete(range);
    }
    records.delete(key);
  }
  function mark(block, index) {
    if (records.has(block.key)) {
      Object.assign(records.get(block.key), { index, label: `Passage ${index + 1}` });
      return true;
    }
    if (block.parts.some(part => !part.whole) && (!view.CSS?.highlights || !view.Highlight)) {
      status.state = "error";
      updateStatus("This Chrome version cannot highlight split passages. Update Chrome and reload this page.");
      return false;
    }
    ensureStyles();
    records.set(block.key, { block, index, id: crypto.randomUUID(), label: `Passage ${index + 1}` });
    for (const part of block.parts) {
      if (part.whole) {
        if (!classOwners.has(part.node)) classOwners.set(part.node, new Set());
        classOwners.get(part.node).add(block.key);
        part.node.classList.add(flagClass);
      } else {
        if (!highlights) {
          highlights = new view.Highlight();
          view.CSS.highlights.set(flagClass, highlights);
        }
        for (const range of part.ranges) highlights.add(range);
      }
    }
    return true;
  }
  function prune(keys = records.keys()) {
    for (const key of keys) {
      const record = records.get(key);
      if (!record) continue;
      if (structuralRecords.has(key) || !C.groupCurrent(record.block, view)) removeRecord(key);
    }
  }
  function focusPart(part) {
    if (part.whole) {
      part.node.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    const range = part.ranges[0];
    // Text ranges have no scrollIntoView; account for nested scrolling panels
    // before positioning the selected fragment in the page viewport.
    for (let node = range.startContainer.parentElement; node && node !== document.body
      && node !== document.documentElement; node = node.parentElement) {
      if (/(auto|scroll|overlay)/.test(view.getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight) {
        node.scrollBy({ top: range.getBoundingClientRect().top - node.getBoundingClientRect().top - node.clientHeight / 3,
          behavior: "instant" });
      }
    }
    view.scrollBy({ top: range.getBoundingClientRect().top - view.innerHeight / 3, behavior: "smooth" });
  }
  function stop() {
    lifecycle++;
    const previous = runId;
    runId = null;
    authorizedRun = null;
    stopped = true;
    config = C.normalizeSettings();
    pending = false;
    clearTimeout(timer);
    timer = undefined;
    clearTimeout(pruneTimer);
    pruneTimer = undefined;
    dirtyRecords.clear();
    structuralRecords.clear();
    observer.disconnect();
    for (const key of [...records.keys()]) removeRecord(key);
    if (previous) void request({ type: "CANCEL_SCAN", runId: previous }).catch(() => {});
    status.state = "stopped";
    updateStatus("Text marks removed. No new analysis runs while off.");
    sheet?.remove();
    sheet = null;
    if (highlights) view.CSS.highlights.delete(flagClass);
    highlights = undefined;
    return { ...status };
  }
  async function scan(id) {
    if (stopped || id !== runId || id !== authorizedRun) return;
    if (running) { pending = true; return; }
    running = true;
    try {
      if (location.href !== currentURL) { navigate(); return; }
      prune();
      const selected = C.selectBlocks(document, view);
      const selectedKeys = new Map(selected.blocks.map(block => [block.key, block.text]));
      for (const [key, record] of records) {
        if (selectedKeys.get(key) !== record.block.text) removeRecord(key);
      }
      status.analyzed = 0;
      status.partial = 0;
      status.scannedWords = 0;
      status.totalWords = selected.totalWords;
      status.skipped = selected.skipped;
      status.limited = selected.limited;
      if (selected.reason === "non_english") {
        status.state = "skipped";
        updateStatus("Known non-English page; this English-language experiment does not analyze it.");
        return;
      }
      if (!selected.blocks.length) {
        status.state = "skipped";
        updateStatus(`Not enough eligible English prose to form a ${C.MIN_WORDS}-word passage. Short neighboring text is combined when available.`);
        return;
      }
      status.state = "scanning";
      updateStatus("Local analysis only. First analysis may take time while the native model loads.");
      for (const [index, block] of selected.blocks.entries()) {
        if (stopped || id !== runId) return;
        const { key, text, words } = block;
        const saved = processed.get(key);
        let result;
        if (saved?.text === text) result = saved.result;
        else {
          if (usedWords + words > C.MAX_PAGE_WORDS) { status.limited = true; break; }
          activeBlock = block;
          activeDirty = false;
          usedWords += words;
          try { result = await request({ type: "ANALYZE", runId: id, text }); } catch (error) {
            if (stopped || id !== runId) return;
            status.state = "error";
            observer.disconnect();
            updateStatus(`${error.code}: ${error.message} Check native helper setup, then turn Off and On to retry within the remaining page budget.`);
            return;
          }
          if (stopped || id !== runId) return;
          if (location.href !== currentURL) { navigate(); return; }
          if (activeDirty || !C.groupCurrent(block, view)) { status.skipped++; continue; }
          processed.set(key, { text, result });
        }
        if (!C.groupCurrent(block, view)) { status.skipped++; continue; }
        if (result.status === "skipped") { status.skipped++; updateStatus(); continue; }
        if (C.shouldFlag(result, config) && !mark(block, index)) return;
        status.scannedWords += words;
        status.analyzed++;
        if (result.status === "partial" || result.truncated
          || result.chunks.some(chunk => chunk.words < C.MIN_WORDS)) status.partial++;
        updateStatus();
      }
      status.state = "done";
      updateStatus(status.limited
        ? "Scan stopped at the page's word or extraction limit. Unscanned text has not been assessed."
        : "Eligible prose processed from top to bottom. Short passages are grouped; a flag applies to the group, not individual sentences. Watching for changes within the remaining budget.");
    } finally {
      activeBlock = undefined;
      running = false;
      if (pending && !stopped) {
        pending = false;
        void scan(runId);
      }
    }
  }
  function observe() {
    observer.observe(document.documentElement, {
      childList: true, subtree: true, characterData: true, attributes: true,
      attributeOldValue: true, attributeFilter: [
        "class", "style", "hidden", "aria-hidden", "lang", "contenteditable", "role", "inert", "open",
      ],
    });
  }
  function scheduleScan() {
    if (stopped || timer !== undefined) return;
    // A continuously updating feed must not postpone extraction indefinitely.
    timer = setTimeout(() => {
      timer = undefined;
      void scan(runId);
    }, 800);
  }
  function reapplyThreshold() {
    prune();
    const selected = C.selectBlocks(document, view);
    const current = new Map(selected.blocks.map(block => [block.key, block.text]));
    for (const [key, record] of records) {
      const saved = processed.get(key);
      if (current.get(key) !== record.block.text || !saved || !C.shouldFlag(saved.result, config)) removeRecord(key);
    }
    for (const [index, block] of selected.blocks.entries()) {
      const saved = processed.get(block.key);
      if (saved?.text === block.text && C.groupCurrent(block, view) && C.shouldFlag(saved.result, config)) {
        if (!mark(block, index)) break;
      }
    }
    updateStatus();
  }
  async function start(sessionId, settings) {
    const reauthorizing = !stopped && currentURL === location.href;
    const changedURL = currentURL !== location.href;
    lifecycle++;
    const previous = runId;
    if (previous) void request({ type: "CANCEL_SCAN", runId: previous }).catch(() => {});
    config = C.normalizeSettings(settings);
    workerSession = sessionId;
    stopped = false;
    if (C.pageKey(currentURL) !== C.pageKey(location.href)) {
      processed.clear();
      usedWords = 0;
      for (const key of [...records.keys()]) removeRecord(key);
    }
    currentURL = location.href;
    runId = crypto.randomUUID();
    authorizedRun = null;
    progressSequence = 0;
    const id = runId;
    clearTimeout(timer);
    timer = undefined;
    // Mutations and Off/On share a budget; a new SPA page gets a fresh one.
    if (!reauthorizing) {
      status = { state: "starting", analyzed: 0, partial: 0, skipped: 0, marked: 0, limited: false,
        scannedWords: 0, totalWords: 0, usedWords, findings: [], detail: "" };
    } else {
      status.state = "starting";
    }
    status.sequence = 0;
    prune();
    observe();
    status.detail = "Starting local scan.";
    try {
      await request({ type: "BEGIN_SCAN", runId: id });
      if (runId === id && !stopped) {
        authorizedRun = id;
        if (changedURL) scheduleScan();
        else void scan(id);
      }
    } catch (error) {
      if (runId !== id) return;
      stop();
      status.state = "error";
      updateStatus(error.message);
    }
    return { ...status };
  }
  async function refresh() {
    const generation = lifecycle;
    const sequence = ++refreshSequence;
    try {
      const value = await request({ type: "GET_CONFIG" });
      if (generation !== lifecycle || sequence !== refreshSequence) return { ...status };
      if (!value.enabled) return stop();
      if (!stopped && currentURL === location.href && workerSession === value.sessionId) {
        const next = C.normalizeSettings(value);
        if (next.flagThreshold !== config.flagThreshold) {
          config = next;
          reapplyThreshold();
        }
        return { ...status };
      }
      return start(value.sessionId, value);
    } catch (error) {
      if (generation === lifecycle && sequence === refreshSequence) {
        stop();
        status.state = "error";
        updateStatus(error.message);
      }
      return { ...status };
    }
  }
  function navigate() {
    stop();
    void refresh();
  }
  function ownMutation(mutation) {
    const target = mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement;
    if (target?.closest("[data-deckard-owned]")) return true;
    if (mutation.type === "attributes" && mutation.attributeName === "class") {
      const clean = value => (value || "").split(/\s+/).filter(name => name && name !== flagClass).sort().join(" ");
      if (clean(mutation.oldValue) === clean(target.getAttribute("class"))) return true;
    }
    if (mutation.type === "childList") {
      return [...mutation.addedNodes, ...mutation.removedNodes].every(node =>
        node.nodeType === 1 && node.hasAttribute("data-deckard-owned"));
    }
    return false;
  }
  const observer = new MutationObserver(mutations => {
    if (stopped) return;
    const previousRecords = records.size;
    for (const [key, record] of records) {
      if (!sheet?.isConnected || record.block.parts.some(part => !part.node.isConnected
        || (part.whole && !part.node.classList.contains(flagClass)))) removeRecord(key);
    }
    if (records.size !== previousRecords) updateStatus();
    const external = mutations.filter(mutation => {
      if (ownMutation(mutation)) return false;
      const target = mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement;
      return mutation.type === "attributes" || !target?.closest(C.EXCLUDED);
    });
    if (!external.length) return;
    if (location.href !== currentURL) { navigate(); return; }
    // Unrelated page animations must not repeatedly re-extract all scored text.
    const affects = (part, mutation) => {
      const target = mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement;
      if (!target) return false;
      if (mutation.type === "childList") {
        return part.node.contains(target) || [...mutation.addedNodes, ...mutation.removedNodes]
          .some(node => node === part.node || (node.nodeType === 1 && node.contains(part.node)));
      }
      return part.node.contains(target) || target.contains(part.node);
    };
    const touches = (block, structural = false) => block.parts.some(part => external.some(mutation =>
      (!structural || mutation.type === "childList") && affects(part, mutation)));
    if (activeBlock && touches(activeBlock) && (touches(activeBlock, true) || !C.groupCurrent(activeBlock, view))) activeDirty = true;
    for (const [key, record] of records) {
      if (touches(record.block)) dirtyRecords.add(key);
      if (touches(record.block, true)) structuralRecords.add(key);
    }
    if (dirtyRecords.size && pruneTimer === undefined) {
      pruneTimer = setTimeout(() => {
        pruneTimer = undefined;
        prune(dirtyRecords);
        dirtyRecords.clear();
        structuralRecords.clear();
        updateStatus();
      }, 200);
    }
    if (usedWords >= C.MAX_PAGE_WORDS || status.state === "error") return;
    scheduleScan();
  });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || sender.tab || !message || typeof message.type !== "string") return false;
    if (message.type === "PAGE_STATUS") { respond({ ...status }); return false; }
    if (message.type === "FOCUS_FINDING") {
      const record = [...records.values()].find(value => value.id === message.findingId);
      if (stopped || message.runId !== runId || !record || !C.groupCurrent(record.block, view)) {
        prune();
        updateStatus();
        respond({ focused: false });
      } else {
        focusPart(record.block.parts[0]);
        respond({ focused: true });
      }
      return false;
    }
    if (message.type === "START" || message.type === "SETTINGS_CHANGED") {
      void refresh().then(respond);
      return true;
    }
    if (message.type === "STOP") { respond(stop()); return false; }
    if (message.type === "NAVIGATED") {
      if ((!message.url || message.url === location.href)
        && (currentURL !== location.href || message.restart
          || (runId && message.cancelledRunId === runId))) navigate();
      respond({ ...status });
      return false;
    }
    return false;
  });
  window.addEventListener("pagehide", stop);
  window.addEventListener("pageshow", event => { if (event.persisted) void refresh(); });
  const checkNavigation = () => { if (location.href !== currentURL) navigate(); };
  window.navigation?.addEventListener("currententrychange", checkNavigation);
  window.addEventListener("popstate", checkNavigation);
  window.addEventListener("hashchange", checkNavigation);
  void refresh();
})();
