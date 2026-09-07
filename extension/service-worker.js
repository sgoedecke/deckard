import "./core.js";
import { NativeQueue, NativeError } from "./native-queue.js";

const C = globalThis.DeckardCore;
const broker = new NativeQueue(() => chrome.runtime.connectNative("com.sgoedecke.deckard"));
const runs = new Map();
const tabGenerations = new Map();
const badgeJobs = new Map();
const badgeVersions = new Map();
const MAX_PAGE_WORDS = C.MAX_PAGE_WORDS;
const MAX_FINDINGS = Math.ceil(MAX_PAGE_WORDS / C.MIN_WORDS);
const SCRIPT_ID = "deckard-global";
const sessionId = crypto.randomUUID();
let tabSequence = 0;
let enabled = false;
let flagThreshold = C.FLAG_THRESHOLD;
let revision = 0;
let synchronization = Promise.resolve();
let persistence = Promise.resolve();

function safeTab(tab) {
  return tab && Number.isInteger(tab.id) && !tab.incognito && C.originOf(tab.url);
}
function contentSender(sender) {
  return sender.id === chrome.runtime.id && sender.tab && !sender.tab.incognito
    && sender.frameId === 0 && validRun(sender.documentId)
    && (!sender.documentLifecycle || sender.documentLifecycle === "active") && C.originOf(sender.url);
}
function popupSender(sender) {
  return sender.id === chrome.runtime.id && !sender.tab && sender.url === chrome.runtime.getURL("popup.html");
}
function validRun(value) { return typeof value === "string" && /^[a-zA-Z0-9-]{1,100}$/.test(value); }
function validFinding(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
function sanitizeStatus(value) {
  if (!value || typeof value !== "object"
    || !["starting", "scanning", "done", "skipped", "error", "stopped"].includes(value.state)) {
    throw new NativeError("invalid_request", "Invalid page progress.");
  }
  const count = (key, max = MAX_PAGE_WORDS) => Number.isSafeInteger(value[key])
    ? Math.min(max, Math.max(0, value[key])) : 0;
  const findings = [];
  const seen = new Set();
  for (const item of Array.isArray(value.findings) ? value.findings.slice(0, MAX_FINDINGS) : []) {
    if (!item || !validFinding(item.id) || seen.has(item.id)) continue;
    seen.add(item.id);
    findings.push({ id: item.id, label: `Passage ${findings.length + 1}`,
      words: Number.isSafeInteger(item.words) ? Math.min(MAX_PAGE_WORDS, Math.max(0, item.words)) : 0 });
  }
  return {
    state: value.state, analyzed: count("analyzed"), partial: count("partial"), skipped: count("skipped"),
    marked: count("marked", MAX_FINDINGS), limited: value.limited === true,
    budgetExhausted: value.budgetExhausted === true,
    detail: typeof value.detail === "string" ? value.detail.slice(0, 300).replace(/[\u0000-\u001f\u007f]/g, " ") : "",
    sequence: count("sequence", Number.MAX_SAFE_INTEGER),
    scannedWords: count("scannedWords"), totalWords: count("totalWords"),
    usedWords: count("usedWords"), findings,
  };
}
function badge(status) {
  if (!status || status.state === "stopped") return { text: "", color: "#737980", title: "Deckard — Off or waiting for a scan" };
  const progress = `${status.scannedWords.toLocaleString("en-US")} words processed; ${status.marked} flagged passages`;
  if (["starting", "scanning"].includes(status.state)) return { text: "...", color: "#216bce", title: `Deckard — Scanning: ${progress}` };
  if (status.state === "error") return { text: "!", color: "#b45309", title: `Deckard — Scan error; coverage incomplete. ${progress}` };
  const incomplete = status.state === "skipped" || status.limited || status.budgetExhausted
    || status.partial > 0 || status.skipped > 0 || status.analyzed === 0;
  if (status.marked) return { text: String(status.marked), color: "#b42318",
    title: `Deckard — ${progress}.${incomplete ? " Coverage incomplete." : ""} Possible AI involvement, not proof.` };
  return { text: "0", color: "#287a46", title: incomplete
    ? `Deckard — No flags in analyzed text; incomplete or insufficient text. ${progress}. Not proof of human authorship.`
    : `Deckard — Scan complete; no flags. ${progress}. Not proof of human authorship.` };
}
function updateBadge(tabId, status = null) {
  const version = (badgeVersions.get(tabId) || 0) + 1;
  badgeVersions.set(tabId, version);
  const appearance = badge(status);
  // Serialize writes: even a Chrome call already in flight is followed by the
  // newest clear/update, and superseded queued writes never run.
  const job = (badgeJobs.get(tabId) || Promise.resolve()).catch(() => {}).then(async () => {
    for (const [method, fields] of [
      ["setBadgeText", { text: appearance.text }],
      ["setBadgeBackgroundColor", { color: appearance.color }],
      ["setTitle", { title: appearance.title }],
    ]) {
      if (badgeVersions.get(tabId) !== version) return;
      await chrome.action[method]({ tabId, ...fields });
    }
  }).catch(error => {
    if (!/No tab with id|tab was closed/i.test(error?.message || "")) console.error("Deckard: badge_update_failed");
  });
  badgeJobs.set(tabId, job);
  void job.then(() => {
    if (badgeJobs.get(tabId) === job) {
      badgeJobs.delete(tabId);
      badgeVersions.delete(tabId);
    }
  });
}
function hasPermission() { return chrome.permissions.contains({ origins: C.HOST_PERMISSIONS }); }
async function sendToTab(tabId, message, documentId) {
  try { return await chrome.tabs.sendMessage(tabId, message, documentId ? { documentId } : { frameId: 0 }); } catch { return null; }
}
function cancelTab(tabId) {
  tabGenerations.set(tabId, ++tabSequence);
  runs.delete(tabId);
  updateBadge(tabId);
  broker.cancel(owner => owner.tabId === tabId);
}
function saveSettings(value) {
  persistence = persistence.catch(() => {}).then(() => chrome.storage.local.set({ deckardSettings: { enabled: value } }));
  return persistence;
}
function disable() {
  revision++;
  enabled = false;
  for (const tabId of new Set([...runs.keys(), ...badgeJobs.keys()])) updateBadge(tabId);
  runs.clear();
  broker.disconnect();
}
async function restoreTabs(generation = revision) {
  const tabs = await chrome.tabs.query({});
  if (enabled || generation !== revision) return;
  await Promise.all(tabs.map(tab => {
    // Even after permission revocation Chrome still exposes tab IDs, but not URLs.
    if (Number.isInteger(tab.id) && !tab.incognito) {
      updateBadge(tab.id);
      return sendToTab(tab.id, { type: "STOP" });
    }
    return null;
  }));
}
async function activateTab(tab, generation = revision) {
  if (!enabled || generation !== revision || !safeTab(tab)) return;
  const tabGeneration = tabGenerations.get(tab.id);
  if (!runs.has(tab.id)) updateBadge(tab.id);
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: ["core.js", "content.js"] });
    if (enabled && generation === revision && tabGeneration === tabGenerations.get(tab.id)) {
      await sendToTab(tab.id, { type: "START" });
    }
  } catch { /* Restricted pages (including the Chrome Web Store) cannot be injected. */ }
}
async function synchronize() {
  const generation = revision;
  const active = enabled;
  const existing = (await chrome.scripting.getRegisteredContentScripts())
    .filter(script => script.id === SCRIPT_ID || script.id.startsWith("deckard-site-"));
  if (generation !== revision) return;
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: existing.map(script => script.id) });
  if (generation !== revision) return;
  if (active) {
    await chrome.scripting.registerContentScripts([{
      id: SCRIPT_ID, matches: C.HOST_PERMISSIONS, js: ["core.js", "content.js"],
      runAt: "document_idle", allFrames: false, persistAcrossSessions: true,
    }]);
    if (generation !== revision) return;
    // One slow/loading tab must not block activation of others or a later Off.
    for (const tab of await chrome.tabs.query({})) void activateTab(tab, generation);
  } else {
    await restoreTabs();
  }
}
function scheduleSync() {
  synchronization = synchronization.catch(() => {}).then(synchronize);
  return synchronization;
}
const ready = (async () => {
  const generation = revision;
  const stored = await chrome.storage.local.get(["deckardSettings", "deckardFlagThreshold"]);
  const config = C.normalizeSettings({ ...stored.deckardSettings, flagThreshold: stored.deckardFlagThreshold });
  flagThreshold = config.flagThreshold;
  const allowed = config.enabled && await hasPermission();
  if (generation !== revision) return;
  enabled = Boolean(allowed);
  // Persist only Deckard's opt-in state; legacy extension settings are untouched.
  await saveSettings(enabled);
})().catch(error => { disable(); console.error(error); });

async function setEnabled(value) {
  if (typeof value !== "boolean") throw new NativeError("invalid_request", "Expected an On/Off value.");
  const generation = ++revision;
  if (!value) {
    disable();
    const saved = saveSettings(false);
    await Promise.all([saved, restoreTabs(), scheduleSync()]);
    return { enabled };
  }
  if (!(await hasPermission())) {
    throw new NativeError("permission_required", "Allow access to HTTP and HTTPS pages to turn Deckard on.");
  }
  if (generation !== revision) return { enabled };
  enabled = true;
  try {
    await saveSettings(true);
    if (generation === revision) await scheduleSync();
  } catch (error) {
    if (generation === revision) {
      disable();
      await Promise.all([saveSettings(false), restoreTabs(), scheduleSync()]);
    }
    throw error;
  }
  return { enabled };
}
async function handlePopup(message) {
  // Off takes effect before any pending initialization or permission checks finish.
  if (message.type === "SET_ENABLED") return setEnabled(message.enabled);
  await ready;
  switch (message.type) {
    case "GET_SETTINGS": return { enabled, flagThreshold };
    case "SET_THRESHOLD": {
      if (!C.validThreshold(message.flagThreshold)) throw new NativeError("invalid_request", "Threshold must be between 70 and 99.");
      const value = message.flagThreshold;
      persistence = persistence.catch(() => {}).then(async () => {
        await chrome.storage.local.set({ deckardFlagThreshold: value });
        flagThreshold = value;
      });
      await persistence;
      if (enabled) {
        for (const [tabId, run] of runs) void sendToTab(tabId, { type: "SETTINGS_CHANGED" }, run.documentId);
      }
      return { enabled, flagThreshold };
    }
    case "STATUS": {
      if (!enabled) return { state: "off", detail: "Off. Page content is restored; no new analysis runs." };
      if (!Number.isInteger(message.tabId)) return { state: "unsupported", detail: "This page cannot be scanned. Normal HTTP(S) pages only." };
      const generation = revision;
      const tab = await chrome.tabs.get(message.tabId);
      if (!safeTab(tab)) return { state: "unsupported", detail: "This page cannot be scanned. Normal non-private HTTP(S) pages only." };
      if (!enabled || generation !== revision) return { state: "off", detail: "Off." };
      let run = runs.get(tab.id);
      if (!run) {
        await activateTab(tab, generation);
        run = runs.get(tab.id);
      }
      if (!run) return { state: "unsupported", detail: "This page is loading or does not allow extension access." };
      (await authorizeRun(tab.id, run))();
      const previous = run.status;
      const response = await sendToTab(tab.id, { type: "PAGE_STATUS", runId: run.runId }, run.documentId);
      (await authorizeRun(tab.id, run))();
      if (response && run.status === previous && (response.sequence || 0) >= run.status.sequence) {
        run.status = sanitizeStatus(response);
        updateBadge(tab.id, run.status);
      }
      return run.status || sanitizeStatus({ state: "starting" });
    }
    case "FOCUS_FINDING": {
      if (!Number.isInteger(message.tabId) || !validFinding(message.findingId)) {
        throw new NativeError("invalid_request", "Invalid passage link.");
      }
      const run = runs.get(message.tabId);
      (await authorizeRun(message.tabId, run))();
      if (!run.status?.findings.some(finding => finding.id === message.findingId)) return { focused: false };
      const response = await sendToTab(message.tabId,
        { type: "FOCUS_FINDING", findingId: message.findingId, runId: run.runId }, run.documentId);
      (await authorizeRun(message.tabId, run))();
      return { focused: response?.focused === true };
    }
    default: throw new NativeError("invalid_request", "Unknown popup request.");
  }
}
async function authorizeRun(tabId, run, sender, runId) {
  const current = () => enabled && run && runs.get(tabId) === run
    && (!sender || (run.runId === runId && run.documentId === sender.documentId && run.url === sender.url));
  if (!current()) throw new NativeError("cancelled", "Scan is no longer current.");
  const generation = revision;
  const allowed = await hasPermission();
  const tab = allowed ? await chrome.tabs.get(tabId) : null;
  if (!allowed || generation !== revision || !current() || !safeTab(tab) || tab.url !== run.url) {
    throw new NativeError("cancelled", "Scan is no longer current.");
  }
  // The caller resumes in another microtask; recheck before it commits metadata
  // or routes a request so Off/navigation cannot slip between authorization and use.
  return () => {
    if (generation !== revision || !current()) throw new NativeError("cancelled", "Scan is no longer current.");
  };
}
async function handleContent(message, sender) {
  if (message.protocol_version !== C.PROTOCOL_VERSION || message.scanner_version !== C.SCANNER_VERSION) {
    throw new NativeError("extension_update_required", "Reload this page to use the updated Gradient extension.");
  }
  await ready;
  const tabId = sender.tab.id;
  switch (message.type) {
    case "GET_CONFIG": return { enabled, flagThreshold, sessionId };
    case "BEGIN_SCAN": {
      if (!validRun(message.runId)) throw new NativeError("invalid_request", "Invalid scan.");
      const generation = revision;
      cancelTab(tabId);
      const tabGeneration = tabGenerations.get(tabId);
      const allowed = enabled && await hasPermission();
      const tab = allowed ? await chrome.tabs.get(tabId) : null;
      if (!allowed || !enabled || generation !== revision || tabGeneration !== tabGenerations.get(tabId)
        || !safeTab(tab) || tab.url !== sender.url) {
        throw new NativeError("cancelled", "Scanning is off or this page has changed.");
      }
      const status = sanitizeStatus({ state: "starting" });
      runs.set(tabId, { runId: message.runId, documentId: sender.documentId, url: sender.url, status });
      updateBadge(tabId, status);
      return { started: true };
    }
    case "ANALYZE": {
      const run = runs.get(tabId);
      (await authorizeRun(tabId, run, sender, message.runId))();
      return broker.request("analyze", message.text, { tabId, runId: message.runId });
    }
    case "PAGE_PROGRESS": {
      const run = runs.get(tabId);
      (await authorizeRun(tabId, run, sender, message.runId))();
      if (!Number.isSafeInteger(message.status?.sequence) || message.status.sequence < 1) {
        throw new NativeError("invalid_request", "Invalid progress sequence.");
      }
      const status = sanitizeStatus(message.status);
      if (status.sequence <= run.status.sequence) return { updated: false };
      run.status = status;
      updateBadge(tabId, run.status);
      return { updated: true };
    }
    case "CANCEL_SCAN":
      if (!validRun(message.runId)) throw new NativeError("invalid_request", "Invalid scan.");
      if (runs.get(tabId)?.runId === message.runId) {
        (await authorizeRun(tabId, runs.get(tabId), sender, message.runId))();
        cancelTab(tabId);
      }
      return { cancelled: true };
    default: throw new NativeError("invalid_request", "Unknown content request.");
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!message || typeof message !== "object" || typeof message.type !== "string"
    || (!popupSender(sender) && !contentSender(sender))) {
    respond({ ok: false, error: { code: "invalid_sender", message: "Unsupported request." } });
    return false;
  }
  Promise.resolve().then(() => popupSender(sender) ? handlePopup(message) : handleContent(message, sender))
    .then(result => respond({ ok: true, result }), error => respond({
      ok: false, error: { code: error.code || "extension_error", message: error.message || "Extension request failed." },
    }));
  return true;
});
chrome.tabs.onRemoved.addListener(tabId => {
  cancelTab(tabId);
  tabGenerations.delete(tabId);
});
chrome.tabs.onUpdated.addListener((tabId, changes, tab) => {
  if (changes.status === "loading" || changes.url) {
    const run = runs.get(tabId);
    // The content script can observe pushState before this event arrives.
    // Do not cancel a run already bound to the destination URL.
    if (!changes.url || run?.url !== changes.url) {
      cancelTab(tabId);
      void sendToTab(tabId, { type: "NAVIGATED", url: changes.url || tab?.url,
        cancelledRunId: run?.runId, restart: !run });
    }
  }
  if (changes.status === "complete") void ready.then(() => activateTab(tab)).catch(console.error);
});
function reconcile() { void ready.then(scheduleSync).catch(console.error); }
chrome.runtime.onInstalled.addListener(reconcile);
chrome.runtime.onStartup.addListener(reconcile);
chrome.permissions.onRemoved.addListener(() => {
  // Fail closed immediately, including pending authorizations and native replies.
  disable();
  void Promise.all([saveSettings(false), restoreTabs(), scheduleSync()]).catch(console.error);
});
reconcile();
