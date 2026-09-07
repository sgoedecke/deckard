(() => {
  "use strict";
  const C = globalThis.DeckardCore;
  const $ = id => document.getElementById(id);
  $("extension-id").textContent = chrome.runtime.id;
  $("install-command").textContent = `"$HOME/Library/Application Support/Deckard/current/bin/deckard" install --extension-id ${chrome.runtime.id}`;
  let tabId;
  let busy = false;
  let editingThreshold = false;
  let generation = 0;
  let polling;
  let actionError = "";
  let findingsKey = "";
  let navigationGeneration = 0;
  async function request(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) throw new Error(response?.error?.message || "Extension request failed.");
    return response.result;
  }
  function renderEnabled(enabled) {
    $("enabled").checked = enabled;
    $("toggle-label").textContent = enabled ? "On" : "Off";
  }
  function renderThreshold(value) {
    const threshold = C.normalizeSettings({ flagThreshold: value }).flagThreshold;
    $("threshold").value = String(threshold * 100);
    $("threshold-value").textContent = (threshold * 100).toLocaleString("en-US", { maximumFractionDigits: 2 });
  }
  function error(error) {
    $("status").textContent = error.message;
    $("status").hidden = false;
  }
  function renderResults(status, enabled) {
    const findings = enabled && Array.isArray(status.findings) ? status.findings : [];
    const key = JSON.stringify(findings);
    if (key === findingsKey) return;
    findingsKey = key;
    navigationGeneration++;
    $("findings").replaceChildren();
    $("navigation-status").textContent = "";
    $("results").hidden = findings.length === 0;
    for (const finding of findings) {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `${finding.label} · ${finding.words.toLocaleString("en-US")} words`;
      button.addEventListener("click", () => {
        const current = generation;
        const navigation = ++navigationGeneration;
        button.disabled = true;
        void request({ type: "FOCUS_FINDING", tabId, findingId: finding.id }).then(result => {
          if (current !== generation || navigation !== navigationGeneration) return;
          $("navigation-status").textContent = result.focused
            ? `Jumped to ${finding.label}.` : "This passage is no longer available. The page may have changed.";
        }).catch(() => {
          if (current === generation && navigation === navigationGeneration) {
            $("navigation-status").textContent = "This passage is no longer available. Refresh the page status and try again.";
          }
        }).finally(() => { button.disabled = false; });
      });
      li.appendChild(button);
      $("findings").appendChild(li);
    }
  }
  async function refresh() {
    if (busy || editingThreshold) return;
    const current = generation;
    const config = await request({ type: "GET_SETTINGS" });
    const status = await request({ type: "STATUS", tabId });
    if (busy || current !== generation) return;
    renderEnabled(config.enabled);
    renderThreshold(config.flagThreshold);
    $("setup").hidden = status.state !== "error";
    $("status").textContent = actionError || (status.state === "error"
      ? status.detail || "Scan failed." : status.state === "unsupported" ? "Page unavailable." : "");
    $("status").hidden = !$("status").textContent;
    $("progress").textContent = config.enabled && (status.scannedWords !== undefined || status.analyzed !== undefined)
      ? `${(status.scannedWords || 0).toLocaleString("en-US")}/${(status.totalWords || 0).toLocaleString("en-US")} processed`
        + ` · ${status.analyzed || 0} scored · ${status.marked || 0} marked · ${status.partial || 0} partial · ${status.skipped || 0} skipped`
      : "";
    $("scan-progress").hidden = !config.enabled || !status.totalWords;
    $("scan-progress").max = Math.max(1, status.totalWords || 0);
    $("scan-progress").value = Math.min(status.scannedWords || 0, status.totalWords || 0);
    renderResults(status, config.enabled);
  }
  $("enabled").addEventListener("change", () => {
    const enabled = $("enabled").checked;
    generation++;
    actionError = "";
    renderResults({}, false);
    $("progress").textContent = "";
    $("scan-progress").hidden = true;
    // Chrome requires this call directly in the toggle gesture, before any await.
    // Already-granted access does not prompt again.
    const grant = enabled ? chrome.permissions.request({ origins: C.HOST_PERMISSIONS }) : Promise.resolve(true);
    busy = true;
    $("enabled").disabled = true;
    $("threshold").disabled = true;
    void (async () => {
      try {
        if (!(await grant)) throw new Error("Access declined. Deckard remains Off.");
        const config = await request({ type: "SET_ENABLED", enabled });
        renderEnabled(config.enabled);
      } catch (e) {
        // Read the actual state rather than assuming a failed save succeeded.
        try { renderEnabled((await request({ type: "GET_SETTINGS" })).enabled); } catch { renderEnabled(false); }
        actionError = e.message;
        error(e);
        return;
      } finally {
        busy = false;
        $("enabled").disabled = false;
        $("threshold").disabled = false;
      }
      await refresh();
    })().catch(error);
  });
  $("threshold").addEventListener("input", () => {
    editingThreshold = true;
    generation++;
    $("threshold-value").textContent = Number($("threshold").value).toLocaleString("en-US", { maximumFractionDigits: 2 });
  });
  function saveThreshold() {
    if (busy) return;
    const value = Number($("threshold").value) / 100;
    editingThreshold = false;
    generation++;
    actionError = "";
    busy = true;
    $("enabled").disabled = true;
    $("threshold").disabled = true;
    void (async () => {
      try {
        const config = await request({ type: "SET_THRESHOLD", flagThreshold: value });
        renderThreshold(config.flagThreshold);
      } catch (e) {
        actionError = e.message;
        error(e);
        const config = await request({ type: "GET_SETTINGS" });
        renderThreshold(config.flagThreshold);
      } finally {
        busy = false;
        $("enabled").disabled = false;
        $("threshold").disabled = false;
      }
      await refresh();
    })().catch(error);
  }
  $("threshold").addEventListener("change", saveThreshold);
  $("threshold").addEventListener("blur", () => { if (editingThreshold) saveThreshold(); });
  async function initialize() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const safe = tab && !tab.incognito && C.originOf(tab.url);
    tabId = safe ? tab.id : undefined;
    $("page-title").textContent = safe ? (tab.title || "Current page").slice(0, 200) : "Page unavailable or private";
    await refresh();
    $("enabled").disabled = false;
    $("threshold").disabled = false;
    polling = setInterval(() => { void refresh().catch(error); }, 1500);
  }
  window.addEventListener("pagehide", () => clearInterval(polling));
  void initialize().catch(error);
})();
