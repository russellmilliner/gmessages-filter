const API_BASE = "http://127.0.0.1:8768";

const DEFAULT_CONFIG = {
  enabled: true,
  dry_run: false,
  only_non_contacts: true,
  scan_interval_ms: 2000,
  ai_filter_enabled: true,
  ai_political_filter_enabled: true,
  ai_political_model: "typesafe/jev-router",
  ai_political_action: "block_spam",
  ai_categories: [
    { id: "cat-political", name: "Political", action: "block_spam", enabled: true },
    { id: "cat-religion", name: "Religion", action: "block_spam", enabled: true }
  ],
  vip_alerts_enabled: true,
  vip_alert_contacts: ["Michelle Milliner"],
  patterns: [
    { id: "pat-deborah", pattern: "deborah", number: "", is_regex: false, case_sensitive: false, action: "block_spam", block_spam: true, archive: false, enabled: true },
    { id: "pat-trump", pattern: "trump", number: "", is_regex: false, case_sensitive: false, action: "block_spam", block_spam: true, archive: false, enabled: true },
    { id: "pat-vance", pattern: "vance", number: "", is_regex: false, case_sensitive: false, action: "block_spam", block_spam: true, archive: false, enabled: true }
  ],
  whitelist: []
};

async function getStoredState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["config", "logs"], (res) => {
      resolve({
        config: res.config || DEFAULT_CONFIG,
        logs: res.logs || []
      });
    });
  });
}

async function saveStoredState(config, logs) {
  return new Promise((resolve) => {
    const payload = {};
    if (config) payload.config = config;
    if (logs) payload.logs = logs;
    chrome.storage.local.set(payload, () => resolve());
  });
}

function reloadGoogleMessagesTabs() {
  try {
    chrome.tabs.query({ url: "https://messages.google.com/*" }, (tabs) => {
      for (const t of tabs || []) {
        if (t.id) chrome.tabs.reload(t.id);
      }
    });
  } catch (e) {}
}

chrome.runtime.onInstalled.addListener(() => {
  reloadGoogleMessagesTabs();
});

async function syncFromServer() {
  try {
    const resp = await fetch(`${API_BASE}/api/status`, { cache: "no-store" });
    if (resp.ok) {
      const data = await resp.json();
      if (data && data.extension_version) {
        try {
          const curVer = chrome.runtime.getManifest().version;
          if (curVer && data.extension_version !== curVer) {
            chrome.runtime.reload();
            return;
          }
        } catch (e) {}
      }
      if (data && data.config) {
        await saveStoredState(data.config, data.recent_logs || []);
        return {
          ok: true,
          online: true,
          config: data.config,
          openrouter_key_configured: !!data.openrouter_key_configured,
          ai_cache_count: data.ai_cache_count || 0,
          logs: data.recent_logs || [],
          ai_evals: data.recent_ai_evals || [],
          deleted_count: data.deleted_count || 0,
          scan_request: data.scan_request || null,
          open_conv_request: data.open_conv_request || null
        };
      }
    }
  } catch (err) {
    // Fallback to local storage when daemon is unreachable
  }
  const local = await getStoredState();
  return {
    ok: true,
    online: false,
    config: local.config,
    openrouter_key_configured: false,
    ai_cache_count: 0,
    logs: local.logs,
    deleted_count: local.logs.length
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === "GET_STATE") {
      const state = await syncFromServer();
      sendResponse(state);
    } else if (msg.type === "UPDATE_CONFIG") {
      try {
        const resp = await fetch(`${API_BASE}/api/config`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(msg.payload || {})
        });
        if (resp.ok) {
          const data = await resp.json();
          await saveStoredState(data.config, null);
          sendResponse({ ok: true, config: data.config });
          return;
        }
      } catch (e) {}
      const local = await getStoredState();
      const updated = Object.assign({}, local.config, msg.payload || {});
      await saveStoredState(updated, null);
      sendResponse({ ok: true, config: updated });
    } else if (msg.type === "EVALUATE_POLITICAL" || msg.type === "EVALUATE_AI") {
      try {
        const resp = await fetch(`${API_BASE}/api/evaluate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(msg.payload || {})
        });
        if (resp.ok) {
          const data = await resp.json();
          sendResponse(data);
          return;
        }
      } catch (e) {}
      sendResponse({ ok: false, matched: false, is_political: false });
    } else if (msg.type === "ADD_AI_CATEGORY") {
      try {
        const resp = await fetch(`${API_BASE}/api/ai-categories`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(msg.payload || {})
        });
        if (resp.ok) {
          const data = await resp.json();
          await saveStoredState(data.config, null);
          sendResponse({ ok: true, config: data.config });
          return;
        }
      } catch (e) {}
      sendResponse({ ok: false });
    } else if (msg.type === "UPDATE_AI_CATEGORY") {
      try {
        const resp = await fetch(`${API_BASE}/api/ai-categories/update`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(msg.payload || {})
        });
        if (resp.ok) {
          const data = await resp.json();
          await saveStoredState(data.config, null);
          sendResponse({ ok: true, config: data.config });
          return;
        }
      } catch (e) {}
      sendResponse({ ok: false });
    } else if (msg.type === "DELETE_AI_CATEGORY") {
      try {
        const resp = await fetch(`${API_BASE}/api/ai-categories/delete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(msg.payload || {})
        });
        if (resp.ok) {
          const data = await resp.json();
          await saveStoredState(data.config, null);
          sendResponse({ ok: true, config: data.config });
          return;
        }
      } catch (e) {}
      sendResponse({ ok: false });
    } else if (msg.type === "VIP_ALERT") {
      try {
        const resp = await fetch(`${API_BASE}/api/vip-alert`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(msg.payload || {})
        });
        if (resp.ok) {
          const data = await resp.json();
          sendResponse(data);
          return;
        }
      } catch (e) {}
      sendResponse({ ok: false });
    } else if (msg.type === "ADD_VIP_CONTACT") {
      try {
        const resp = await fetch(`${API_BASE}/api/vip-contacts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(msg.payload || {})
        });
        if (resp.ok) {
          const data = await resp.json();
          await saveStoredState(data.config, null);
          sendResponse({ ok: true, config: data.config });
          return;
        }
      } catch (e) {}
      sendResponse({ ok: false });
    } else if (msg.type === "DELETE_VIP_CONTACT") {
      try {
        const resp = await fetch(`${API_BASE}/api/vip-contacts/delete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(msg.payload || {})
        });
        if (resp.ok) {
          const data = await resp.json();
          await saveStoredState(data.config, null);
          sendResponse({ ok: true, config: data.config });
          return;
        }
      } catch (e) {}
      sendResponse({ ok: false });
    } else if (msg.type === "ADD_PATTERN") {
      try {
        const resp = await fetch(`${API_BASE}/api/patterns`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(msg.payload || {})
        });
        if (resp.ok) {
          const data = await resp.json();
          await saveStoredState(data.config, null);
          sendResponse({ ok: true, config: data.config });
          return;
        }
      } catch (e) {}
      const local = await getStoredState();
      const pats = local.config.patterns || [];
      const act = msg.payload.action || "delete";
      pats.push({
        id: "pat-" + Math.random().toString(36).slice(2, 8),
        pattern: (msg.payload.pattern || "").trim(),
        number: (msg.payload.number || "").trim(),
        older_than: (msg.payload.older_than || "").trim(),
        is_regex: !!msg.payload.is_regex,
        case_sensitive: !!msg.payload.case_sensitive,
        action: act,
        block_spam: act === "block_spam",
        archive: act === "archive",
        enabled: true
      });
      local.config.patterns = pats;
      await saveStoredState(local.config, null);
      sendResponse({ ok: true, config: local.config });
    } else if (msg.type === "UPDATE_PATTERN") {
      try {
        const resp = await fetch(`${API_BASE}/api/patterns/update`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(msg.payload || {})
        });
        if (resp.ok) {
          const data = await resp.json();
          await saveStoredState(data.config, null);
          sendResponse({ ok: true, config: data.config });
          return;
        }
      } catch (e) {}
      const local = await getStoredState();
      const target = msg.payload.id || msg.payload.pattern || msg.payload.number;
      for (const p of local.config.patterns || []) {
        if (p.id === target || p.pattern === target || p.number === target) {
          if (msg.payload.action) {
            p.action = msg.payload.action;
            p.block_spam = p.action === "block_spam";
            p.archive = p.action === "archive";
          }
          if (msg.payload.older_than !== undefined) {
            p.older_than = (msg.payload.older_than || "").trim();
          }
          break;
        }
      }
      await saveStoredState(local.config, null);
      sendResponse({ ok: true, config: local.config });
    } else if (msg.type === "DELETE_PATTERN") {
      try {
        const resp = await fetch(`${API_BASE}/api/patterns/delete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(msg.payload || {})
        });
        if (resp.ok) {
          const data = await resp.json();
          await saveStoredState(data.config, null);
          sendResponse({ ok: true, config: data.config });
          return;
        }
      } catch (e) {}
      const local = await getStoredState();
      const target = msg.payload.id || msg.payload.pattern || msg.payload.number;
      local.config.patterns = (local.config.patterns || []).filter(
        (p) => p.id !== target && p.pattern !== target && p.number !== target
      );
      await saveStoredState(local.config, null);
      sendResponse({ ok: true, config: local.config });
    } else if (msg.type === "LOG_DELETION") {
      const entry = Object.assign({}, msg.payload, {
        timestamp: new Date().toISOString()
      });
      try {
        await fetch(`${API_BASE}/api/log`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(entry)
        });
      } catch (e) {}
      const local = await getStoredState();
      const logs = [entry, ...(local.logs || [])].slice(0, 100);
      await saveStoredState(null, logs);
      sendResponse({ ok: true });
    } else if (msg.type === "SEND_DEBUG") {
      try {
        await fetch(`${API_BASE}/api/debug`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(msg.payload || {})
        });
      } catch (e) {}
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false });
    }
  })();
  return true;
});
