(() => {
  "use strict";

  if (window.__GMESSAGES_AUTO_FILTER_LOADED__) return;
  window.__GMESSAGES_AUTO_FILTER_LOADED__ = true;

  const BROWSER_NAME = navigator.userAgent.includes("Firefox") ? "Zen/Firefox" : "Chromium";

  let state = {
    online: false,
    openrouter_key_configured: false,
    ai_cache_count: 0,
    deleted_count: 0,
    logs: [],
    config: {
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
    }
  };

  const processedKeys = new Set();
  const aiEvalCache = new Map();
  const vipBaseline = new Map();
  const inspectedMediaThreads = new Set();
  let vipBaselineInitialized = false;
  let isDeleting = false;
  let isAutoInspectingMedia = false;
  let isManualScanning = false;
  let abortManualScan = false;
  let manualScanStatusText = "";
  let lastHandledScanId = null;
  let lastHandledOpenConvId = null;
  const deleteQueue = [];

  const API_BASE = "http://127.0.0.1:8768";
  const EXT_VERSION = "1.9.0";

  async function directApiFallback(type, payload = {}) {
    const routeMap = {
      EVALUATE_AI: "/api/evaluate",
      EVALUATE_POLITICAL: "/api/evaluate",
      ADD_AI_CATEGORY: "/api/ai-categories",
      UPDATE_AI_CATEGORY: "/api/ai-categories/update",
      DELETE_AI_CATEGORY: "/api/ai-categories/delete",
      VIP_ALERT: "/api/vip-alert",
      ADD_VIP_CONTACT: "/api/vip-contacts",
      DELETE_VIP_CONTACT: "/api/vip-contacts/delete"
    };
    const path = routeMap[type];
    if (!path) return { ok: false };
    try {
      const r = await fetch(`${API_BASE}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload || {})
      });
      if (r.ok) {
        return await r.json();
      }
    } catch (e) {}
    return { ok: false };
  }

  function sendMsg(type, payload = {}) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type, payload }, async (resp) => {
          if (chrome.runtime.lastError || !resp || !resp.ok) {
            const fb = await directApiFallback(type, payload);
            if (fb && fb.ok) {
              resolve(fb);
            } else {
              resolve(resp || { ok: false });
            }
          } else {
            resolve(resp);
          }
        });
      } catch (e) {
        directApiFallback(type, payload).then(resolve);
      }
    });
  }

  function cleanBidi(str) {
    return (str || "")
      .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "")
      .trim();
  }

  function getRuleAction(p) {
    if (!p) return "delete";
    if (p.action === "block_spam" || p.action === "archive" || p.action === "delete") {
      return p.action;
    }
    if (p.block_spam) return "block_spam";
    if (p.archive) return "archive";
    return "delete";
  }

  function parseRuleOlderThanDays(p) {
    if (!p) return null;
    if (typeof p.older_than_days === "number" && p.older_than_days > 0) {
      return p.older_than_days;
    }
    const raw = cleanBidi(String(p.older_than || "")).toLowerCase();
    if (!raw || raw === "0" || raw === "0d" || raw === "off" || raw === "none") {
      return null;
    }
    const m = raw.match(
      /^(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|wks|week|weeks|mo|month|months|y|yr|yrs|year|years)?$/
    );
    if (!m) return null;
    const num = parseFloat(m[1]);
    if (!(num > 0)) return null;
    const unit = m[2] || "d";
    if (unit.startsWith("m") && !unit.startsWith("mo")) return num / 1440.0;
    if (unit.startsWith("h")) return num / 24.0;
    if (unit.startsWith("w")) return num * 7.0;
    if (unit.startsWith("mo")) return num * 30.0;
    if (unit.startsWith("y")) return num * 365.0;
    return num;
  }

  function parseMessageAgeDays(rawTimestamp) {
    const s = cleanBidi(rawTimestamp)
      .replace(/[\u00a0\u202f]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!s) return null;
    const lower = s.toLowerCase();
    const now = new Date();

    if (lower === "now" || lower === "just now") {
      return 0;
    }

    let m = lower.match(/^(\d+)\s*(?:m|min|mins|minute|minutes)(?:\s+ago)?$/);
    if (m) {
      return parseInt(m[1], 10) / 1440.0;
    }

    m = lower.match(/^(\d+)\s*(?:h|hr|hrs|hour|hours)(?:\s+ago)?$/);
    if (m) {
      return parseInt(m[1], 10) / 24.0;
    }

    if (lower === "yesterday" || lower.startsWith("yesterday")) {
      return 1.0;
    }

    m = lower.match(/^(\d{1,2}):(\d{2})(?:\s*(am|pm))?$/);
    if (m) {
      let hr = parseInt(m[1], 10);
      const min = parseInt(m[2], 10);
      const ampm = m[3];
      if (ampm === "pm" && hr < 12) hr += 12;
      if (ampm === "am" && hr === 12) hr = 0;
      const dt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hr, min, 0);
      let diffMs = now.getTime() - dt.getTime();
      if (diffMs < -60000) {
        diffMs += 86400000;
      }
      return Math.max(0, diffMs / 86400000.0);
    }

    const daysMap = {
      sun: 0, sunday: 0, sundaysun: 0,
      mon: 1, monday: 1, mondaymon: 1,
      tue: 2, tues: 2, tuesday: 2, tuesdaytue: 2,
      wed: 3, wednesday: 3, wednesdaywed: 3,
      thu: 4, thur: 4, thurs: 4, thursday: 4, thursdaythu: 4,
      fri: 5, friday: 5, fridayfri: 5,
      sat: 6, saturday: 6, saturdaysat: 6
    };
    const dayPrefixMatch = lower.match(/^(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues|tue|wed|thurs|thur|thu|fri|sat)$/);
    const dayKey = daysMap[lower] !== undefined ? lower : (dayPrefixMatch ? dayPrefixMatch[1] : null);
    if (dayKey && daysMap[dayKey] !== undefined) {
      let diffDays = (now.getDay() - daysMap[dayKey] + 7) % 7;
      if (diffDays === 0) diffDays = 7;
      return diffDays;
    }

    const monthsMap = {
      jan: 0, january: 0,
      feb: 1, february: 1,
      mar: 2, march: 2,
      apr: 3, april: 3,
      may: 4,
      jun: 5, june: 5,
      jul: 6, july: 6,
      aug: 7, august: 7,
      sep: 8, sept: 8, september: 8,
      oct: 9, october: 9,
      nov: 10, november: 10,
      dec: 11, december: 11
    };
    m = lower.match(/^([a-z]+)\s+(\d{1,2})(?:,?\s+(\d{4}))?$/) ||
        lower.match(/^(\d{1,2})\s+([a-z]+)(?:,?\s+(\d{4}))?$/);
    if (m) {
      const isMonthFirst = isNaN(parseInt(m[1], 10));
      const monName = isMonthFirst ? m[1] : m[2];
      const dayNum = parseInt(isMonthFirst ? m[2] : m[1], 10);
      const monIdx = monthsMap[monName];
      if (monIdx !== undefined && dayNum >= 1 && dayNum <= 31) {
        let yr = m[3] ? parseInt(m[3], 10) : now.getFullYear();
        let dt = new Date(yr, monIdx, dayNum, 12, 0, 0);
        if (!m[3] && dt.getTime() > now.getTime() + 86400000) {
          dt = new Date(yr - 1, monIdx, dayNum, 12, 0, 0);
        }
        return Math.max(0, (now.getTime() - dt.getTime()) / 86400000.0);
      }
    }

    const parsedMs = Date.parse(s);
    if (!isNaN(parsedMs)) {
      return Math.max(0, (now.getTime() - parsedMs) / 86400000.0);
    }

    return null;
  }

  function formatRuleLabel(p) {
    if (!p) return "(empty)";
    if (p.custom_label) return p.custom_label;
    const num = (p.number || "").trim();
    const pat = (p.pattern || "").trim();
    const older = (p.older_than || "").trim();
    const parts = [];
    if (num) parts.push(`📞 "${num}"`);
    if (pat) parts.push(p.is_regex ? `💬 /${pat}/i` : `💬 "${pat}"`);
    if (older) parts.push(`⏳ >${older}`);
    return parts.join(" + ") || "(empty)";
  }

  function isAiFilterActive() {
    if (!state.config) return false;
    if (state.config.ai_filter_enabled === false || state.config.ai_political_filter_enabled === false) {
      return false;
    }
    const cats = state.config.ai_categories || [];
    return cats.some((c) => c.enabled !== false);
  }

  function getMatchedAiCategoryConfig(evalRes) {
    if (!evalRes || !state.config) return null;
    const cats = state.config.ai_categories || [];
    const prim = (evalRes.primary_category || "").toLowerCase();
    if (prim) {
      const found = cats.find((c) => (c.name || "").toLowerCase() === prim && c.enabled !== false);
      if (found) return found;
    }
    const matchedList = evalRes.matched_categories || [];
    for (const mName of matchedList) {
      const mLower = (mName || "").toLowerCase();
      const found = cats.find((c) => (c.name || "").toLowerCase() === mLower && c.enabled !== false);
      if (found) return found;
    }
    return null;
  }

  function doesAiMatchMeetAgeRequirement(evalRes, ageDays) {
    if (!evalRes || !evalRes.matched) return false;
    const catCfg = getMatchedAiCategoryConfig(evalRes);
    const reqOlderDays = catCfg ? parseRuleOlderThanDays(catCfg) : parseRuleOlderThanDays(evalRes);
    if (reqOlderDays !== null && reqOlderDays > 0) {
      if (ageDays === null || ageDays === undefined || ageDays < reqOlderDays) {
        return false;
      }
    }
    return true;
  }

  function makeJevRuleObject(evalRes) {
    const modelTag = evalRes && evalRes.routed_model ? evalRes.routed_model : "jev-router";
    const catCfg = getMatchedAiCategoryConfig(evalRes);
    const cats = (evalRes && evalRes.matched_categories && evalRes.matched_categories.length > 0)
      ? evalRes.matched_categories.join("+")
      : (evalRes && evalRes.primary_category ? evalRes.primary_category : "Political");
    const act = (catCfg && catCfg.action)
      ? catCfg.action
      : ((evalRes && evalRes.action_if_matched && evalRes.action_if_matched !== "none")
          ? evalRes.action_if_matched
          : "block_spam");
    const olderStr = (catCfg && catCfg.older_than) || (evalRes && evalRes.older_than) || "";
    const olderTag = olderStr ? ` ⏳ >${olderStr}` : "";
    return {
      id: `ai-jev-${cats.toLowerCase()}`,
      action: act,
      older_than: olderStr,
      block_spam: act === "block_spam",
      archive: act === "archive",
      custom_label: `🤖 Jev [${cats}${olderTag}] (${modelTag})`,
      ai_evaluation: evalRes
    };
  }

  function isProtectedContact(rawSender) {
    const sender = cleanBidi(rawSender);
    if (!sender) return false;
    const senderLower = sender.toLowerCase();

    const wl = state.config.whitelist || [];
    for (const item of wl) {
      if (item && senderLower === item.trim().toLowerCase()) {
        return true;
      }
    }
    const vips = state.config.vip_alert_contacts || [];
    for (const rawVip of vips) {
      const vipLower = cleanBidi(rawVip || "").toLowerCase();
      if (vipLower && (senderLower === vipLower || senderLower.includes(vipLower))) {
        return true;
      }
    }
    return false;
  }

  function isNonContact(rawSender) {
    const sender = cleanBidi(rawSender);
    if (!sender) return false;
    if (isProtectedContact(sender)) return false;

    if (sender.toLowerCase() === "unknown") return true;

    const stripped = sender.replace(/[\s+\-().,•·#*\/]/g, "");
    const digitCount = (stripped.match(/\d/g) || []).length;
    const hasLetters = /[a-zA-Z]/.test(sender);

    return !hasLetters && digitCount >= 3;
  }

  function canApplyStaticRuleToRow(sender, snippet, matchedPat) {
    if (!matchedPat || !sender) return false;
    if (isProtectedContact(sender)) return false;
    if (!state.config.only_non_contacts || isNonContact(sender)) return true;

    // When only_non_contacts is true, still allow static rules if:
    // 1) The rule explicitly targets this sender name (e.g. "SunPass" matching RCS sender "Sunpass"), OR
    // 2) The rule is an ARCHIVE rule matching an automated verification/opt-out message on a non-VIP sender
    const hasPat = !!(matchedPat.pattern && matchedPat.pattern.trim());
    if (hasPat && matchesMessagePattern(sender, matchedPat)) {
      return true;
    }
    if (
      getRuleAction(matchedPat) === "archive" &&
      /\b(verification code|passcode|security code|one-time code|your code is|reply stop|reply help)\b/i.test(snippet || "")
    ) {
      return true;
    }
    return false;
  }

  function matchesCallerNumber(rawSender, ruleNumber) {
    const sender = cleanBidi(rawSender);
    const target = cleanBidi(ruleNumber);
    if (!target) return true;
    if (!sender) return false;

    if (sender.toLowerCase().includes(target.toLowerCase())) {
      return true;
    }

    const senderDigits = sender.replace(/\D/g, "");
    const targetDigits = target.replace(/\D/g, "");
    if (targetDigits && senderDigits && senderDigits.includes(targetDigits)) {
      return true;
    }
    return false;
  }

  function matchesMessagePattern(rawText, p) {
    const pat = (p.pattern || "").trim();
    if (!pat) return true;
    const cleanText = cleanBidi(rawText);
    if (!cleanText) return false;

    try {
      if (p.is_regex) {
        const flags = p.case_sensitive ? "" : "i";
        const re = new RegExp(pat, flags);
        return re.test(cleanText);
      } else {
        if (p.case_sensitive) {
          return cleanText.includes(pat);
        } else {
          return cleanText.toLowerCase().includes(pat.toLowerCase());
        }
      }
    } catch (err) {
      console.warn("[GMessages-Filter] Invalid regex pattern:", pat, err);
      return false;
    }
  }

  function findMatchingRule(sender, messageText, ageDays = null) {
    const patterns = (state.config && state.config.patterns) || [];
    for (const p of patterns) {
      if (p.enabled === false) continue;
      const hasNum = !!(p.number && p.number.trim());
      const hasPat = !!(p.pattern && p.pattern.trim());
      const reqOlderDays = parseRuleOlderThanDays(p);
      const hasOlder = reqOlderDays !== null && reqOlderDays > 0;
      if (!hasNum && !hasPat && !hasOlder) continue;

      if (hasNum && !matchesCallerNumber(sender, p.number)) {
        continue;
      }
      if (hasPat && !matchesMessagePattern(`${sender}\n${messageText}`, p)) {
        continue;
      }
      if (hasOlder) {
        if (ageDays === null || ageDays === undefined || ageDays < reqOlderDays) {
          continue;
        }
      }
      return p;
    }
    return null;
  }

  const PLACEHOLDER_MEDIA_SNIPPETS = new Set([
    "picture",
    "image",
    "photo",
    "video",
    "audio",
    "gif",
    "attachment",
    "mms",
    "view on your phone"
  ]);

  function isPlaceholderMediaSnippet(text) {
    const t = cleanBidi(text || "").toLowerCase();
    return PLACEHOLDER_MEDIA_SNIPPETS.has(t);
  }

  function isSystemBannerText(text) {
    const t = cleanBidi(text || "").toLowerCase();
    return (
      t.startsWith("texting with ") ||
      t.startsWith("rcs chat with ") ||
      t.startsWith("mms with ")
    );
  }

  async function evaluateAiAsync(rowEl, sender, snippet, ageDays = null) {
    const normKey = cleanBidi(snippet).toLowerCase();
    if (!normKey || normKey.length < 6) return;
    if (isPlaceholderMediaSnippet(normKey) || isSystemBannerText(normKey)) return;
    if (aiEvalCache.has(normKey)) {
      const existing = aiEvalCache.get(normKey);
      if (
        existing.status === "done" &&
        existing.res &&
        existing.res.matched &&
        doesAiMatchMeetAgeRequirement(existing.res, ageDays)
      ) {
        const matchedPat = makeJevRuleObject(existing.res);
        const ruleAction = getRuleAction(matchedPat);
        const key = `${sender}::${snippet}::${ruleAction}::${state.config.dry_run ? "dry" : "live"}`;
        if (!processedKeys.has(key)) {
          processedKeys.add(key);
          deleteQueue.push({ rowEl, sender, snippet, matchedPat, key });
          processDeleteQueue();
        }
      }
      return;
    }

    aiEvalCache.set(normKey, { status: "pending", res: null });
    const res = await sendMsg("EVALUATE_AI", { sender, snippet });
    if (res && res.ok) {
      aiEvalCache.set(normKey, { status: "done", res });
      if (
        res.matched &&
        state.config &&
        state.config.enabled &&
        isAiFilterActive() &&
        doesAiMatchMeetAgeRequirement(res, ageDays)
      ) {
        const matchedPat = makeJevRuleObject(res);
        const ruleAction = getRuleAction(matchedPat);
        const key = `${sender}::${snippet}::${ruleAction}::${state.config.dry_run ? "dry" : "live"}`;
        if (!processedKeys.has(key)) {
          processedKeys.add(key);
          deleteQueue.push({ rowEl, sender, snippet, matchedPat, key });
          processDeleteQueue();
        }
      }
    } else {
      aiEvalCache.delete(normKey);
    }
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function waitForElement(selectorFn, timeoutMs = 1800, intervalMs = 50) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const el = selectorFn();
      if (el) return el;
      await sleep(intervalMs);
    }
    return null;
  }

  function getConversationRows() {
    const items = document.querySelectorAll("mws-conversation-list-item");
    if (items.length > 0) return Array.from(items);
    return Array.from(document.querySelectorAll("[data-e2e-conversation]"));
  }

  let lastActionDebug = null;

  async function reportDebugSnapshot(extra = {}) {
    try {
      const rows = getConversationRows();
      const sample = rows.slice(0, 60).map((r) => {
        const { sender, snippet, timestampText, ageDays } = extractRowInfo(r);
        const mp = findMatchingRule(sender, snippet, ageDays);
        const btn =
          r.querySelector("mws-conversation-list-item-menu button") ||
          r.querySelector("[data-e2e-conversation-list-item-menu] button") ||
          r.querySelector('button[aria-haspopup="menu"]') ||
          r.querySelector("button");
        return {
          sender,
          snippet: (snippet || "").slice(0, 300),
          timestamp: timestampText,
          age_days: ageDays !== null && ageDays !== undefined ? Number(ageDays.toFixed(2)) : null,
          non_contact: isNonContact(sender),
          matched_rule: mp ? formatRuleLabel(mp) : null,
          has_menu_btn: !!btn,
          row_tag: r.tagName,
        };
      });
      await sendMsg("SEND_DEBUG", {
        url: location.href,
        browser: BROWSER_NAME,
        ext_version: EXT_VERSION,
        ai_filter_active: isAiFilterActive(),
        ai_categories_count: (state.config && state.config.ai_categories ? state.config.ai_categories.length : 0),
        row_count: rows.length,
        sample_rows: sample,
        last_action_debug: lastActionDebug,
        ...extra,
      });
    } catch (e) {}
  }

  async function handleConversationRow(rowEl, sender, snippet, matchedPat) {
    if (!rowEl || !rowEl.isConnected) return { ok: false, action: "none" };

    const ruleAction = getRuleAction(matchedPat);

    rowEl.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    rowEl.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    await sleep(100);

    const menuTrigger =
      rowEl.querySelector("mws-conversation-list-item-menu button") ||
      rowEl.querySelector("[data-e2e-conversation-list-item-menu] button") ||
      rowEl.querySelector('button[aria-haspopup="menu"]') ||
      rowEl.querySelector("button.mat-mdc-menu-trigger, button.mat-menu-trigger") ||
      rowEl.querySelector("button");

    if (!menuTrigger) {
      lastActionDebug = {
        step: "find_menu_trigger_failed",
        sender,
        row_html: rowEl.innerHTML.slice(0, 600),
      };
      await reportDebugSnapshot();
      console.warn("[GMessages-Filter] Could not find 3-dot menu button for row:", sender);
      return { ok: false, action: "none" };
    }

    menuTrigger.click();

    const menuReady = await waitForElement(() => {
      return document.querySelector(
        "[data-e2e-conversation-menu-archive], [data-e2e-conversation-menu-block], [data-e2e-conversation-delete], .cdk-overlay-container button[mat-menu-item], .cdk-overlay-container [role='menuitem'], .cdk-overlay-container button"
      );
    }, 1800);

    if (!menuReady) {
      lastActionDebug = {
        step: "menu_overlay_did_not_open",
        sender,
        trigger_html: menuTrigger.outerHTML.slice(0, 300),
      };
      await reportDebugSnapshot();
      console.warn("[GMessages-Filter] Menu overlay did not open for:", sender);
      document.body.click();
      return { ok: false, action: "none" };
    }

    // 1. ARCHIVE ACTION
    if (ruleAction === "archive") {
      let archiveItem = document.querySelector("[data-e2e-conversation-menu-archive]");
      if (!archiveItem) {
        const items = document.querySelectorAll(
          ".cdk-overlay-container button[mat-menu-item], .cdk-overlay-container [role='menuitem'], .cdk-overlay-container button"
        );
        for (const item of items) {
          const txt = (item.textContent || "").trim().toLowerCase();
          if (txt === "archive" || txt.includes("archive")) {
            archiveItem = item;
            break;
          }
        }
      }
      if (!archiveItem) {
        const overlayEl = document.querySelector(".cdk-overlay-container");
        lastActionDebug = {
          step: "archive_item_not_found",
          sender,
          overlay_html: overlayEl ? overlayEl.innerHTML.slice(0, 800) : "no-overlay",
        };
        await reportDebugSnapshot();
        console.warn("[GMessages-Filter] Could not find Archive option in menu for:", sender);
        document.body.click();
        return { ok: false, action: "none" };
      }
      archiveItem.click();
      lastActionDebug = { step: "archived_ok", sender };
      await sleep(350);
      return { ok: true, action: "archived" };
    }

    // 2. BLOCK & REPORT SPAM ACTION (with fallback to DELETE if unavailable on group thread)
    let chosenAction = "deleted";
    let targetMenuItem = null;

    if (ruleAction === "block_spam") {
      targetMenuItem =
        document.querySelector("[data-e2e-conversation-menu-block]") ||
        document.querySelector(".cdk-overlay-container .block-and-report-button");
      if (!targetMenuItem) {
        const items = document.querySelectorAll(
          ".cdk-overlay-container button[mat-menu-item], .cdk-overlay-container [role='menuitem']"
        );
        for (const item of items) {
          const txt = (item.textContent || "").trim().toLowerCase();
          if (txt.includes("block")) {
            targetMenuItem = item;
            break;
          }
        }
      }
      if (targetMenuItem) {
        chosenAction = "blocked_and_reported_spam";
      }
    }

    // 3. DELETE ACTION (or fallback)
    if (!targetMenuItem) {
      targetMenuItem = document.querySelector("[data-e2e-conversation-delete]");
      if (!targetMenuItem) {
        const items = document.querySelectorAll(
          ".cdk-overlay-container button[mat-menu-item], .cdk-overlay-container [role='menuitem']"
        );
        for (const item of items) {
          if ((item.textContent || "").trim().toLowerCase() === "delete") {
            targetMenuItem = item;
            break;
          }
        }
      }
      chosenAction = "deleted";
    }

    if (!targetMenuItem) {
      console.warn("[GMessages-Filter] Could not find Block or Delete option in menu for:", sender);
      document.body.click();
      return { ok: false, action: "none" };
    }

    targetMenuItem.click();

    const confirmBtn = await waitForElement(() => {
      const byAttr = document.querySelector(
        "mws-dialog button[data-e2e-action-button-confirm], mat-dialog-container button[data-e2e-action-button-confirm], button[data-e2e-action-button-confirm]"
      );
      if (byAttr) return byAttr;
      const btns = document.querySelectorAll("mws-dialog button, mat-dialog-container button");
      for (const b of btns) {
        const t = (b.textContent || "").trim().toLowerCase();
        if (t === "delete" || t === "ok" || t === "block") {
          return b;
        }
      }
      return null;
    }, 1800);

    if (!confirmBtn) {
      console.warn("[GMessages-Filter] Could not find confirm dialog button for:", sender);
      return { ok: false, action: "none" };
    }

    if (chosenAction === "blocked_and_reported_spam") {
      const spamCheckbox = document.querySelector(
        "[data-e2e-report-spam-checkbox] input[type='checkbox'], [data-e2e-block-and-report-spam-dialog] input[type='checkbox'], mws-dialog input[type='checkbox']"
      );
      if (spamCheckbox && !spamCheckbox.checked) {
        spamCheckbox.click();
        await sleep(100);
      }
    }

    confirmBtn.click();
    await sleep(350);
    return { ok: true, action: chosenAction };
  }

  async function processDeleteQueue() {
    if (isDeleting || deleteQueue.length === 0) return;
    isDeleting = true;
    try {
      while (deleteQueue.length > 0) {
        const item = deleteQueue.shift();
        const { rowEl, sender, snippet, matchedPat, key } = item;
        if (!rowEl || !rowEl.isConnected) continue;

        const ruleAction = getRuleAction(matchedPat);
        const ruleDesc = formatRuleLabel(matchedPat);

        if (state.config.dry_run) {
          rowEl.style.outline = "2px dashed #ff5252";
          rowEl.style.backgroundColor = "rgba(255, 82, 82, 0.12)";
          rowEl.setAttribute(
            "title",
            `[Dry-Run Match] Rule: ${ruleDesc} (Action: ${ruleAction})`
          );
          await sendMsg("LOG_DELETION", {
            action: `dry-run (${ruleAction})`,
            sender,
            snippet,
            matched_pattern: ruleDesc,
            browser: BROWSER_NAME,
            ai_evaluation: matchedPat.ai_evaluation || undefined
          });
          await refreshState();
        } else {
          console.info(
            `[GMessages-Filter] Applying rule action "${ruleAction}" to message from ${sender} matching ${ruleDesc}`
          );
          const res = await handleConversationRow(rowEl, sender, snippet, matchedPat);
          if (res.ok) {
            await sendMsg("LOG_DELETION", {
              action: res.action,
              sender,
              snippet,
              matched_pattern: ruleDesc,
              browser: BROWSER_NAME,
              ai_evaluation: matchedPat.ai_evaluation || undefined
            });
            await refreshState();
          } else {
            processedKeys.delete(key);
          }
        }
        await sleep(300);
      }
    } finally {
      isDeleting = false;
    }
  }

  function extractRowInfo(row) {
    const nameEl =
      row.querySelector("[data-e2e-conversation-name]") ||
      row.querySelector(".name") ||
      row.querySelector("h2, h3");
    const snippetEl =
      row.querySelector("[data-e2e-conversation-snippet]") ||
      row.querySelector("mws-conversation-snippet") ||
      row.querySelector(".snippet-text");
    const tsEl =
      row.querySelector("mws-relative-timestamp") ||
      row.querySelector("[data-e2e-conversation-timestamp]") ||
      row.querySelector(".timestamp, .conv-timestamp, time");
    const sender = cleanBidi(nameEl ? nameEl.textContent : "");
    const snippet = cleanBidi(snippetEl ? snippetEl.textContent : "");
    const timestampText = cleanBidi(
      tsEl ? tsEl.textContent || tsEl.getAttribute("aria-label") || "" : ""
    );
    const ageDays = parseMessageAgeDays(timestampText);
    return { sender, snippet, timestampText, ageDays };
  }

  function isRowActiveConversation(row, cleanSender) {
    const activeHeader = document.querySelector("[data-e2e-header-title]");
    if (activeHeader) {
      const activeTitle = cleanBidi(activeHeader.textContent || "");
      if (activeTitle && activeTitle.toLowerCase() === cleanSender.toLowerCase()) {
        return true;
      }
    }
    if (row) {
      if (
        row.classList.contains("selected") ||
        row.querySelector(".selected, [aria-selected='true'], a.selected")
      ) {
        return true;
      }
    }
    return false;
  }

  function checkVipContactRow(row, sender, snippet, timestampText, isInitialPass) {
    if (!state.config || state.config.vip_alerts_enabled === false) return;
    const vips = state.config.vip_alert_contacts || [];
    if (!vips.length || !sender) return;

    const cleanSender = cleanBidi(sender);
    const cleanSnip = cleanBidi(snippet);
    const senderLower = cleanSender.toLowerCase();
    const snipLower = cleanSnip.toLowerCase();

    for (const rawVip of vips) {
      const vip = cleanBidi(rawVip);
      if (!vip) continue;
      const vipLower = vip.toLowerCase();
      const firstNameLower = vipLower.split(/\s+/)[0];

      const isDirectThread = senderLower === vipLower;
      const isGroupWithVip = !isDirectThread && senderLower.includes(vipLower);
      if (!isDirectThread && !isGroupWithVip) continue;

      const prevSnip = vipBaseline.get(cleanSender);
      if (isInitialPass || prevSnip === undefined) {
        vipBaseline.set(cleanSender, cleanSnip);
        continue;
      }

      if (cleanSnip && cleanSnip !== prevSnip) {
        vipBaseline.set(cleanSender, cleanSnip);
        if (snipLower.startsWith("you:") || snipLower.startsWith("you ")) {
          continue;
        }
        if (isGroupWithVip) {
          if (!snipLower.startsWith(firstNameLower + ":") && !snipLower.startsWith(vipLower + ":")) {
            continue;
          }
        }
        const isActiveConv = isRowActiveConversation(row, cleanSender);
        sendMsg("VIP_ALERT", {
          sender: isDirectThread ? vip : `${vip} (${cleanSender})`,
          thread_sender: cleanSender,
          snippet: cleanSnip,
          timestamp: timestampText || "",
          page_hidden: document.hidden,
          is_active_conversation: isActiveConv
        });
      }
    }
  }

  function scanConversations() {
    if (!state.config) return;

    const rows = getConversationRows();
    const isInitialVipPass = !vipBaselineInitialized && rows.length > 0;
    for (const row of rows) {
      const { sender, snippet, timestampText } = extractRowInfo(row);
      if (sender) {
        checkVipContactRow(row, sender, snippet, timestampText, isInitialVipPass);
      }
    }
    if (isInitialVipPass) {
      vipBaselineInitialized = true;
    }

    if (!state.config.enabled) return;
    if (isDeleting) return;

    for (const row of rows) {
      const { sender, snippet, ageDays } = extractRowInfo(row);
      if (!sender) continue;

      const matchedPat = findMatchingRule(sender, snippet, ageDays);
      if (matchedPat && canApplyStaticRuleToRow(sender, snippet, matchedPat)) {
        const ruleAction = getRuleAction(matchedPat);
        const key = `${sender}::${snippet}::${ruleAction}::${state.config.dry_run ? "dry" : "live"}`;
        if (!processedKeys.has(key)) {
          processedKeys.add(key);
          deleteQueue.push({ rowEl: row, sender, snippet, matchedPat, key });
        }
        continue;
      }

      if (state.config.only_non_contacts && !isNonContact(sender)) {
        continue;
      }

      // If no static rule matched and OpenRouter Jev AI Category Filter is active, evaluate in 1 call
      if (isAiFilterActive() && snippet) {
        if (isPlaceholderMediaSnippet(snippet)) {
          // MMS with attached image/media hides text in sidebar under "Picture"
          const isRecent = ageDays !== null && ageDays !== undefined && ageDays <= 2.0;
          const { timestampText } = extractRowInfo(row);
          const mediaKey = `${sender}::${snippet}::${timestampText}`;
          if (isRecent && !inspectedMediaThreads.has(mediaKey) && !isAutoInspectingMedia && !isManualScanning) {
            inspectedMediaThreads.add(mediaKey);
            autoInspectMediaRow(row, sender, ageDays);
          }
        } else {
          evaluateAiAsync(row, sender, snippet, ageDays);
        }
      }
    }

    // Also inspect the currently active/open conversation if its sender is a non-contact
    let activeRow = null;
    let activeSender = "";
    let activeAgeDays = null;

    const activeHeader = document.querySelector("[data-e2e-header-title], mws-conversation-header h2, mws-header h2");
    const headerTitle = activeHeader ? cleanBidi(activeHeader.textContent || "") : "";

    for (const row of rows) {
      const { sender, ageDays } = extractRowInfo(row);
      if (!sender) continue;
      if ((headerTitle && sender === headerTitle) || isRowActiveConversation(row, sender)) {
        activeRow = row;
        activeSender = sender;
        activeAgeDays = ageDays;
        break;
      }
    }

    if (activeRow && activeSender && (!state.config.only_non_contacts || isNonContact(activeSender))) {
      const msgNodes = document.querySelectorAll(
        "[data-e2e-text-message-content], mws-text-message-part"
      );
      for (const mNode of msgNodes) {
        const mText = cleanBidi(mNode.textContent || "");
        if (!mText || isSystemBannerText(mText) || isPlaceholderMediaSnippet(mText)) continue;
        const matchedPat = findMatchingRule(activeSender, mText, activeAgeDays);
        if (matchedPat) {
          const ruleAction = getRuleAction(matchedPat);
          const key = `${activeSender}::${mText.slice(0, 80)}::${ruleAction}::${state.config.dry_run ? "dry" : "live"}`;
          if (!processedKeys.has(key)) {
            processedKeys.add(key);
            deleteQueue.push({
              rowEl: activeRow,
              sender: activeSender,
              snippet: mText.slice(0, 200),
              matchedPat,
              key
            });
          }
          break;
        }
        if (isAiFilterActive() && mText.length >= 8) {
          evaluateAiAsync(activeRow, activeSender, mText.slice(0, 400), activeAgeDays);
        }
      }
    }

    if (deleteQueue.length > 0) {
      processDeleteQueue();
    }
  }

  async function autoInspectMediaRow(rowEl, sender, ageDays) {
    if (isAutoInspectingMedia || isDeleting || isManualScanning) return;
    isAutoInspectingMedia = true;
    try {
      if (!rowEl || !rowEl.isConnected) return;
      const rows = getConversationRows();
      let prevSelectedRow = null;
      for (const r of rows) {
        const info = extractRowInfo(r);
        if (isRowActiveConversation(r, info.sender)) {
          prevSelectedRow = r;
          break;
        }
      }

      const clickTarget = rowEl.querySelector("a") || rowEl;
      clickTarget.click();
      await sleep(500);

      const msgNodes = document.querySelectorAll(
        "[data-e2e-text-message-content], mws-text-message-part"
      );
      let matched = false;
      for (const mNode of msgNodes) {
        const mText = cleanBidi(mNode.textContent || "");
        if (!mText || isSystemBannerText(mText) || isPlaceholderMediaSnippet(mText)) continue;
        const mp = findMatchingRule(sender, mText, ageDays);
        if (mp) {
          const ruleAction = getRuleAction(mp);
          const key = `${sender}::${mText.slice(0, 80)}::${ruleAction}::${state.config.dry_run ? "dry" : "live"}`;
          if (!processedKeys.has(key)) {
            processedKeys.add(key);
            deleteQueue.push({
              rowEl,
              sender,
              snippet: mText.slice(0, 200),
              matchedPat: mp,
              key
            });
            processDeleteQueue();
          }
          matched = true;
          break;
        }
        if (isAiFilterActive() && mText.length >= 8) {
          const aiRes = await sendMsg("EVALUATE_AI", { sender, snippet: mText.slice(0, 400) });
          if (aiRes && aiRes.ok) {
            aiEvalCache.set(mText.slice(0, 400).toLowerCase(), { status: "done", res: aiRes });
            if (aiRes.matched && state.config && state.config.enabled && doesAiMatchMeetAgeRequirement(aiRes, ageDays)) {
              const matchedPat = makeJevRuleObject(aiRes);
              const ruleAction = getRuleAction(matchedPat);
              const key = `${sender}::${mText.slice(0, 80)}::${ruleAction}::${state.config.dry_run ? "dry" : "live"}`;
              if (!processedKeys.has(key)) {
                processedKeys.add(key);
                deleteQueue.push({
                  rowEl,
                  sender,
                  snippet: mText.slice(0, 200),
                  matchedPat,
                  key
                });
                processDeleteQueue();
              }
              matched = true;
              break;
            }
          }
        }
      }

      if (!matched && prevSelectedRow && prevSelectedRow !== rowEl && prevSelectedRow.isConnected) {
        const prevClick = prevSelectedRow.querySelector("a") || prevSelectedRow;
        prevClick.click();
      }
    } catch (e) {
    } finally {
      isAutoInspectingMedia = false;
    }
  }

  function findScrollableConversationList() {
    const candidates = [
      document.querySelector("mws-conversations-list"),
      document.querySelector("[data-e2e-conversation-list]"),
      ...document.querySelectorAll("mws-conversations-list *, [data-e2e-conversation-list] *")
    ];
    for (const el of candidates) {
      if (!el) continue;
      const st = window.getComputedStyle(el);
      if (
        (st.overflowY === "auto" || st.overflowY === "scroll") &&
        el.scrollHeight > el.clientHeight
      ) {
        return el;
      }
    }
    return document.querySelector("mws-conversations-list") || document.querySelector("[data-e2e-conversation-list]");
  }

  async function runExistingMessagesScan(mode = "quick", maxThreads = 50) {
    if (isManualScanning) return;
    isManualScanning = true;
    abortManualScan = false;
    processedKeys.clear();

    try {
      const scrollEl = findScrollableConversationList();
      const inspectedSenders = new Set();
      let checkedCount = 0;
      let matchedCount = 0;

      for (let step = 0; step < 25 && !abortManualScan && checkedCount < maxThreads; step++) {
        const rows = getConversationRows();
        let foundNewInPass = false;

        for (const row of rows) {
          if (abortManualScan || checkedCount >= maxThreads) break;
          if (!row.isConnected) continue;

          const { sender, snippet, ageDays } = extractRowInfo(row);
          if (!sender || inspectedSenders.has(sender)) continue;
          inspectedSenders.add(sender);
          foundNewInPass = true;

          let matchedPat = findMatchingRule(sender, snippet, ageDays);
          let matchedSnippet = snippet;
          const staticAllowed = matchedPat && canApplyStaticRuleToRow(sender, snippet, matchedPat);
          if (!staticAllowed) {
            matchedPat = null;
          }

          if (!staticAllowed && state.config.only_non_contacts && !isNonContact(sender)) {
            continue;
          }

          checkedCount++;
          manualScanStatusText = `Scanning (${mode}): ${checkedCount}/${maxThreads} (${sender})...`;
          renderUI();

          // 2. Check OpenRouter Jev AI Categories on snippet if enabled and not yet matched
          if (!matchedPat && isAiFilterActive() && snippet && !isPlaceholderMediaSnippet(snippet) && !isSystemBannerText(snippet)) {
            const aiRes = await sendMsg("EVALUATE_AI", { sender, snippet });
            if (aiRes && aiRes.ok) {
              aiEvalCache.set(cleanBidi(snippet).toLowerCase(), { status: "done", res: aiRes });
              if (aiRes.matched && doesAiMatchMeetAgeRequirement(aiRes, ageDays)) {
                matchedPat = makeJevRuleObject(aiRes);
                matchedSnippet = snippet;
              }
            }
          }

          // 3. If deep mode (or media placeholder like "Picture") and not yet matched on snippet, click thread to inspect full messages
          if (!matchedPat && (mode === "deep" || isPlaceholderMediaSnippet(snippet))) {
            const clickTarget = row.querySelector("a") || row;
            clickTarget.click();
            await sleep(500);

            const msgNodes = document.querySelectorAll(
              "[data-e2e-text-message-content], mws-text-message-part"
            );
            for (const mNode of msgNodes) {
              const mText = cleanBidi(mNode.textContent || "");
              if (!mText || isSystemBannerText(mText) || isPlaceholderMediaSnippet(mText)) continue;
              const mp = findMatchingRule(sender, mText, ageDays);
              if (mp) {
                matchedPat = mp;
                matchedSnippet = mText.slice(0, 200);
                break;
              }
              if (isAiFilterActive() && mText.length >= 8) {
                const aiRes = await sendMsg("EVALUATE_AI", { sender, snippet: mText.slice(0, 400) });
                if (aiRes && aiRes.ok) {
                  aiEvalCache.set(mText.slice(0, 400).toLowerCase(), { status: "done", res: aiRes });
                  if (aiRes.matched && doesAiMatchMeetAgeRequirement(aiRes, ageDays)) {
                    matchedPat = makeJevRuleObject(aiRes);
                    matchedSnippet = mText.slice(0, 200);
                    break;
                  }
                }
              }
            }
          }

          if (matchedPat) {
            matchedCount++;
            const ruleAction = getRuleAction(matchedPat);
            const key = `${sender}::${matchedSnippet}::${ruleAction}::${state.config.dry_run ? "dry" : "live"}`;
            processedKeys.add(key);
            deleteQueue.push({
              rowEl: row,
              sender,
              snippet: matchedSnippet,
              matchedPat,
              key
            });
            await processDeleteQueue();
          }
        }

        if (!foundNewInPass) break;
        const lastRow = rows[rows.length - 1];
        if (lastRow && lastRow.scrollIntoView) {
          lastRow.scrollIntoView({ behavior: "instant", block: "end" });
        }
        if (scrollEl) {
          scrollEl.scrollTop += 600;
        }
        await sleep(600);
      }

      const currentRows = getConversationRows();
      if (currentRows[0] && currentRows[0].scrollIntoView) {
        currentRows[0].scrollIntoView({ behavior: "instant", block: "start" });
      }
      if (scrollEl) {
        scrollEl.scrollTop = 0;
      }
      manualScanStatusText = abortManualScan
        ? `Scan stopped (${checkedCount} non-contacts checked, ${matchedCount} matched).`
        : `Scan complete: ${checkedCount} non-contacts checked, ${matchedCount} matched.`;
      await reportDebugSnapshot({ last_scan_summary: manualScanStatusText });
    } finally {
      isManualScanning = false;
      abortManualScan = false;
      renderUI();
    }
  }

  // --- Floating UI Badge & Drawer ---
  let badgeEl = null;
  let drawerEl = null;
  let drawerOpen = false;

  function ensureUI() {
    if (document.getElementById("gmf-root")) return;

    const root = document.createElement("div");
    root.id = "gmf-root";
    root.innerHTML = `
      <style>
        #gmf-badge {
          position: fixed;
          bottom: 14px;
          left: 14px;
          z-index: 99999;
          background: #1e293b;
          color: #f8fafc;
          border: 1px solid #334155;
          border-radius: 999px;
          padding: 6px 12px;
          font-family: system-ui, -apple-system, sans-serif;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          box-shadow: 0 4px 12px rgba(0,0,0,0.35);
          display: flex;
          align-items: center;
          gap: 6px;
          user-select: none;
          transition: transform 0.15s ease, background 0.15s ease;
        }
        #gmf-badge:hover {
          background: #334155;
          transform: translateY(-1px);
        }
        #gmf-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: #22c55e;
          display: inline-block;
        }
        #gmf-drawer {
          position: fixed;
          bottom: 50px;
          left: 14px;
          width: 430px;
          max-height: 650px;
          z-index: 99999;
          background: #0f172a;
          color: #f1f5f9;
          border: 1px solid #334155;
          border-radius: 12px;
          box-shadow: 0 10px 28px rgba(0,0,0,0.55);
          font-family: system-ui, -apple-system, sans-serif;
          font-size: 13px;
          display: none;
          flex-direction: column;
          overflow: hidden;
        }
        #gmf-drawer.open {
          display: flex;
        }
        .gmf-header {
          padding: 10px 14px;
          background: #1e293b;
          border-bottom: 1px solid #334155;
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-weight: 700;
        }
        .gmf-body {
          padding: 12px 14px;
          overflow-y: auto;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .gmf-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
        }
        .gmf-input-row {
          display: flex;
          gap: 5px;
          align-items: center;
        }
        .gmf-input-row input[type="text"] {
          flex: 1;
          min-width: 0;
          background: #1e293b;
          color: #f8fafc;
          border: 1px solid #475569;
          border-radius: 6px;
          padding: 5px 8px;
          font-size: 12px;
        }
        .gmf-select {
          background: #1e293b;
          color: #f8fafc;
          border: 1px solid #475569;
          border-radius: 6px;
          padding: 4px 6px;
          font-size: 11px;
        }
        .gmf-btn {
          background: #3b82f6;
          color: #fff;
          border: none;
          border-radius: 6px;
          padding: 5px 10px;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
        }
        .gmf-btn:hover { background: #2563eb; }
        .gmf-btn-sec {
          background: #334155;
          color: #f8fafc;
          border: 1px solid #475569;
          border-radius: 6px;
          padding: 5px 8px;
          font-size: 11px;
          font-weight: 600;
          cursor: pointer;
          flex: 1;
        }
        .gmf-btn-sec:hover { background: #475569; }
        .gmf-rule-list {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .gmf-rule-item {
          background: #1e293b;
          border: 1px solid #334155;
          border-radius: 6px;
          padding: 5px 8px;
          font-size: 12px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
        }
        .gmf-rule-del {
          background: none;
          border: none;
          color: #f87171;
          cursor: pointer;
          font-weight: bold;
          padding: 0 4px;
          font-size: 14px;
        }
        .gmf-logs {
          max-height: 125px;
          overflow-y: auto;
          background: #020617;
          border: 1px solid #1e293b;
          border-radius: 6px;
          padding: 6px 8px;
          font-size: 11px;
          color: #94a3b8;
        }
        .gmf-log-item {
          padding: 4px 0;
          border-bottom: 1px solid #1e293b;
        }
        .gmf-log-item:last-child { border-bottom: none; }
      </style>
      <div id="gmf-badge" title="Click to configure Google Messages Auto-Filter">
        <span id="gmf-dot"></span>
        <span id="gmf-badge-text">Filter: 3 rules</span>
      </div>
      <div id="gmf-drawer">
        <div class="gmf-header">
          <span>🛡️ Messages Auto-Filter</span>
          <span id="gmf-sync-status" style="font-size:11px;font-weight:400;color:#94a3b8;">Synced</span>
        </div>
        <div class="gmf-body">
          <div class="gmf-row">
            <label><input type="checkbox" id="gmf-enabled"> Enable Auto-Filter</label>
            <label><input type="checkbox" id="gmf-dryrun"> Dry-Run</label>
          </div>
          <div class="gmf-row">
            <label><input type="checkbox" id="gmf-noncontacts"> Only numbers not in contacts</label>
          </div>
          <div style="border-top:1px solid #334155;padding-top:8px;">
            <div class="gmf-row" style="margin-bottom:5px;">
              <label style="display:flex;align-items:center;gap:6px;font-weight:600;" title="Pops up a center-of-primary-desktop alert when one of these contacts messages you and Google Messages is not visible on the desktop">
                <input type="checkbox" id="gmf-vip-enabled">
                <span>🔔 VIP Center-Desktop Alert Contacts</span>
              </label>
              <button class="gmf-btn-sec" id="gmf-vip-test-btn" style="padding:3px 8px;font-size:11px;" title="Test the center-of-primary-desktop alert popup">Test Alert</button>
            </div>
            <div class="gmf-input-row" style="margin-bottom:6px;">
              <input type="text" id="gmf-new-vip" placeholder="👤 Contact name (e.g. Michelle Milliner)...">
              <button class="gmf-btn" id="gmf-add-vip-btn">Add</button>
            </div>
            <div class="gmf-rule-list" id="gmf-vip-contacts"></div>
          </div>
          <div style="border-top:1px solid #334155;padding-top:8px;">
            <div class="gmf-row" style="margin-bottom:5px;">
              <label style="display:flex;align-items:center;gap:6px;font-weight:600;" title="Evaluates non-contact messages against all active AI categories in a single OpenRouter Jev (typesafe/jev-router) call">
                <input type="checkbox" id="gmf-ai-enabled">
                <span>🤖 OpenRouter <b>Jev</b> AI Categories (1-Call)</span>
              </label>
            </div>
            <div class="gmf-input-row" style="margin-bottom:6px;">
              <input type="text" id="gmf-new-ai-cat" placeholder="🤖 Add AI category (e.g. login codes, food orders)...">
              <input type="text" id="gmf-new-ai-older" placeholder="⏳ age (e.g. 1d)" style="max-width:95px;" title="Only apply when message is older than X (e.g. 1d, 24h, or blank for immediate)">
              <select id="gmf-new-ai-action" class="gmf-select" title="Action when matched">
                <option value="block_spam" selected>Block &amp; Spam</option>
                <option value="archive">Archive</option>
                <option value="delete">Delete</option>
              </select>
              <button class="gmf-btn" id="gmf-add-ai-btn">Add</button>
            </div>
            <div class="gmf-rule-list" id="gmf-ai-categories"></div>
          </div>
          <div style="border-top:1px solid #334155;padding-top:8px;">
            <div style="font-weight:600;margin-bottom:5px;">Scan Existing Messages</div>
            <div class="gmf-input-row">
              <button class="gmf-btn-sec" id="gmf-scan-quick" title="Scroll down inbox and scan existing conversation previews &amp; numbers">🔍 Scan Inbox (Scroll)</button>
              <button class="gmf-btn-sec" id="gmf-scan-deep" title="Open each non-contact conversation to inspect full message history">🔬 Deep Scan Threads</button>
              <button class="gmf-btn-sec" id="gmf-scan-stop" style="display:none;background:#dc2626;border-color:#ef4444;">⏹ Stop</button>
            </div>
            <div id="gmf-scan-status" style="font-size:11px;color:#38bdf8;margin-top:4px;display:none;"></div>
          </div>
          <div style="border-top:1px solid #334155;padding-top:8px;">
            <div style="font-weight:600;margin-bottom:4px;">Add Static Rule (Number, Message, Age, or Combined)</div>
            <div class="gmf-input-row" style="margin-bottom:5px;">
              <input type="text" id="gmf-new-num" placeholder="📞 Caller # (optional, e.g. 88022)">
              <input type="text" id="gmf-new-pat" placeholder="💬 Message text / regex (optional)">
            </div>
            <div class="gmf-input-row" style="justify-content:flex-end;">
              <input type="text" id="gmf-new-older" placeholder="⏳ Older than (e.g. 7d, 24h)" style="max-width:138px;" title="Only match messages older than X (e.g. 7 or 7d = 7 days, 24h = 24 hours, 2w = 2 weeks)">
              <label style="font-size:11px;display:flex;align-items:center;gap:3px;margin-right:auto;">
                <input type="checkbox" id="gmf-new-regex"> Regex
              </label>
              <select id="gmf-new-action" class="gmf-select" title="Action when matched">
                <option value="delete">Delete</option>
                <option value="block_spam" selected>Block &amp; Spam</option>
                <option value="archive">Archive</option>
              </select>
              <button class="gmf-btn" id="gmf-add-btn">Add Rule</button>
            </div>
            <div class="gmf-rule-list" id="gmf-patterns" style="margin-top:8px;"></div>
          </div>
          <div style="border-top:1px solid #334155;padding-top:8px;">
            <div style="font-weight:600;margin-bottom:4px;">Recent Auto-Filter Audit Log</div>
            <div class="gmf-logs" id="gmf-logs"></div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(root);

    badgeEl = document.getElementById("gmf-badge");
    drawerEl = document.getElementById("gmf-drawer");

    badgeEl.addEventListener("click", () => {
      drawerOpen = !drawerOpen;
      drawerEl.classList.toggle("open", drawerOpen);
      if (drawerOpen) renderUI();
    });

    document.getElementById("gmf-enabled").addEventListener("change", async (e) => {
      await sendMsg("UPDATE_CONFIG", { enabled: e.target.checked });
      await refreshState();
    });

    document.getElementById("gmf-dryrun").addEventListener("change", async (e) => {
      await sendMsg("UPDATE_CONFIG", { dry_run: e.target.checked });
      processedKeys.clear();
      await refreshState();
    });

    document.getElementById("gmf-noncontacts").addEventListener("change", async (e) => {
      await sendMsg("UPDATE_CONFIG", { only_non_contacts: e.target.checked });
      await refreshState();
    });

    document.getElementById("gmf-vip-enabled").addEventListener("change", async (e) => {
      await sendMsg("UPDATE_CONFIG", { vip_alerts_enabled: e.target.checked });
      await refreshState();
    });

    document.getElementById("gmf-vip-test-btn").addEventListener("click", async () => {
      const vips = (state.config && state.config.vip_alert_contacts) || ["Michelle Milliner"];
      const contact = vips[0] || "Michelle Milliner";
      await sendMsg("VIP_ALERT", {
        sender: contact,
        snippet: "Test alert — Google Messages center-of-primary-desktop notification is active!",
        timestamp: "Just now",
        force: true,
        respect_visibility: false
      });
    });

    const addVipContactHandler = async () => {
      const vipInput = document.getElementById("gmf-new-vip");
      const nameVal = (vipInput.value || "").trim();
      if (!nameVal) return;
      vipInput.value = "";
      await sendMsg("ADD_VIP_CONTACT", { name: nameVal });
      await refreshState();
      scanConversations();
    };

    document.getElementById("gmf-add-vip-btn").addEventListener("click", addVipContactHandler);
    document.getElementById("gmf-new-vip").addEventListener("keydown", (e) => {
      if (e.key === "Enter") addVipContactHandler();
    });

    document.getElementById("gmf-ai-enabled").addEventListener("change", async (e) => {
      await sendMsg("UPDATE_CONFIG", { ai_filter_enabled: e.target.checked, ai_political_filter_enabled: e.target.checked });
      processedKeys.clear();
      aiEvalCache.clear();
      await refreshState();
      if (e.target.checked) scanConversations();
    });

    const addAiCategoryHandler = async () => {
      const catInput = document.getElementById("gmf-new-ai-cat");
      const olderInput = document.getElementById("gmf-new-ai-older");
      const actionSel = document.getElementById("gmf-new-ai-action");
      const nameVal = (catInput.value || "").trim();
      const olderVal = olderInput ? (olderInput.value || "").trim() : "";
      if (!nameVal) return;
      catInput.value = "";
      if (olderInput) olderInput.value = "";
      await sendMsg("ADD_AI_CATEGORY", {
        name: nameVal,
        action: actionSel.value,
        older_than: olderVal
      });
      processedKeys.clear();
      aiEvalCache.clear();
      await refreshState();
      scanConversations();
    };

    document.getElementById("gmf-add-ai-btn").addEventListener("click", addAiCategoryHandler);
    document.getElementById("gmf-new-ai-cat").addEventListener("keydown", (e) => {
      if (e.key === "Enter") addAiCategoryHandler();
    });
    const newAiOlderEl = document.getElementById("gmf-new-ai-older");
    if (newAiOlderEl) {
      newAiOlderEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") addAiCategoryHandler();
      });
    }

    document.getElementById("gmf-scan-quick").addEventListener("click", () => {
      runExistingMessagesScan("quick", 60);
    });

    document.getElementById("gmf-scan-deep").addEventListener("click", () => {
      runExistingMessagesScan("deep", 40);
    });

    document.getElementById("gmf-scan-stop").addEventListener("click", () => {
      abortManualScan = true;
    });

    const addPatternHandler = async () => {
      const numInput = document.getElementById("gmf-new-num");
      const patInput = document.getElementById("gmf-new-pat");
      const olderInput = document.getElementById("gmf-new-older");
      const isRegex = document.getElementById("gmf-new-regex").checked;
      const action = document.getElementById("gmf-new-action").value;
      const numVal = (numInput.value || "").trim();
      const patVal = (patInput.value || "").trim();
      const olderVal = (olderInput.value || "").trim();
      if (!numVal && !patVal && !olderVal) return;
      numInput.value = "";
      patInput.value = "";
      olderInput.value = "";
      await sendMsg("ADD_PATTERN", {
        number: numVal,
        pattern: patVal,
        older_than: olderVal,
        is_regex: isRegex,
        case_sensitive: false,
        action
      });
      processedKeys.clear();
      await refreshState();
      scanConversations();
    };

    document.getElementById("gmf-add-btn").addEventListener("click", addPatternHandler);
    document.getElementById("gmf-new-pat").addEventListener("keydown", (e) => {
      if (e.key === "Enter") addPatternHandler();
    });
    document.getElementById("gmf-new-num").addEventListener("keydown", (e) => {
      if (e.key === "Enter") addPatternHandler();
    });
    document.getElementById("gmf-new-older").addEventListener("keydown", (e) => {
      if (e.key === "Enter") addPatternHandler();
    });

    renderUI();
  }

  function renderUI() {
    ensureUI();
    const cfg = state.config || {};
    const pats = cfg.patterns || [];
    const aiCats = cfg.ai_categories || [];
    const enabledAiCats = aiCats.filter((c) => c.enabled !== false);
    const dot = document.getElementById("gmf-dot");
    const badgeText = document.getElementById("gmf-badge-text");
    const syncStatus = document.getElementById("gmf-sync-status");
    const aiTag = (cfg.ai_filter_enabled !== false && enabledAiCats.length > 0)
      ? ` + 🤖Jev(${enabledAiCats.length})`
      : "";

    if (isManualScanning) {
      dot.style.background = "#38bdf8";
      badgeText.textContent = manualScanStatusText || "Scanning existing messages...";
    } else if (!cfg.enabled) {
      dot.style.background = "#94a3b8";
      badgeText.textContent = `Filter: Paused`;
    } else if (cfg.dry_run) {
      dot.style.background = "#f59e0b";
      badgeText.textContent = `Filter (Dry-Run): ${pats.length} rules${aiTag}`;
    } else {
      dot.style.background = "#22c55e";
      badgeText.textContent = `Filter: ${pats.length} rules${aiTag} | ${state.deleted_count || 0} handled`;
    }

    const scanStatusEl = document.getElementById("gmf-scan-status");
    const stopBtn = document.getElementById("gmf-scan-stop");
    if (scanStatusEl && stopBtn) {
      if (manualScanStatusText) {
        scanStatusEl.style.display = "block";
        scanStatusEl.textContent = manualScanStatusText;
      } else {
        scanStatusEl.style.display = "none";
      }
      stopBtn.style.display = isManualScanning ? "inline-block" : "none";
    }

    syncStatus.textContent = state.online ? "● Local Daemon Synced" : "○ Local Storage Mode";
    syncStatus.style.color = state.online ? "#4ade80" : "#fbbf24";

    document.getElementById("gmf-enabled").checked = cfg.enabled !== false;
    document.getElementById("gmf-dryrun").checked = !!cfg.dry_run;
    document.getElementById("gmf-noncontacts").checked = cfg.only_non_contacts !== false;
    const vipCheck = document.getElementById("gmf-vip-enabled");
    if (vipCheck) {
      vipCheck.checked = cfg.vip_alerts_enabled !== false;
    }
    const vipContainer = document.getElementById("gmf-vip-contacts");
    if (vipContainer) {
      vipContainer.innerHTML = "";
      const vips = cfg.vip_alert_contacts || [];
      for (const v of vips) {
        const row = document.createElement("div");
        row.className = "gmf-rule-item";
        const label = document.createElement("span");
        label.style.flex = "1";
        label.textContent = `🔔 ${v}`;
        const delBtn = document.createElement("button");
        delBtn.className = "gmf-rule-del";
        delBtn.textContent = "×";
        delBtn.title = "Remove VIP contact";
        delBtn.addEventListener("click", async () => {
          await sendMsg("DELETE_VIP_CONTACT", { name: v });
          await refreshState();
        });
        row.appendChild(label);
        row.appendChild(delBtn);
        vipContainer.appendChild(row);
      }
    }
    const aiCheck = document.getElementById("gmf-ai-enabled");
    if (aiCheck) {
      aiCheck.checked = cfg.ai_filter_enabled !== false;
    }

    const aiCatContainer = document.getElementById("gmf-ai-categories");
    if (aiCatContainer) {
      aiCatContainer.innerHTML = "";
      for (const c of aiCats) {
        const row = document.createElement("div");
        row.className = "gmf-rule-item";

        const toggle = document.createElement("input");
        toggle.type = "checkbox";
        toggle.checked = c.enabled !== false;
        toggle.title = "Enable/disable this AI category";
        toggle.addEventListener("change", async (e) => {
          await sendMsg("UPDATE_AI_CATEGORY", {
            id: c.id,
            enabled: e.target.checked
          });
          processedKeys.clear();
          aiEvalCache.clear();
          await refreshState();
        });

        const label = document.createElement("span");
        label.style.flex = "1";
        label.style.overflow = "hidden";
        label.style.textOverflow = "ellipsis";
        label.textContent = c.older_than ? `🤖 ${c.name} [⏳ >${c.older_than}]` : `🤖 ${c.name}`;
        label.title = c.description || c.name;

        const olderInput = document.createElement("input");
        olderInput.type = "text";
        olderInput.value = c.older_than || "";
        olderInput.placeholder = "⏳ age";
        olderInput.title = "Only apply when message is older than X (e.g. 1d, 24h, or blank for immediate). Press Enter to save.";
        olderInput.style.width = "54px";
        olderInput.style.background = "#0f172a";
        olderInput.style.color = "#f8fafc";
        olderInput.style.border = "1px solid #475569";
        olderInput.style.borderRadius = "5px";
        olderInput.style.padding = "3px 5px";
        olderInput.style.fontSize = "11px";
        const saveAiOlder = async () => {
          const nextVal = (olderInput.value || "").trim();
          if (nextVal === (c.older_than || "")) return;
          await sendMsg("UPDATE_AI_CATEGORY", {
            id: c.id,
            older_than: nextVal
          });
          processedKeys.clear();
          await refreshState();
          scanConversations();
        };
        olderInput.addEventListener("change", saveAiOlder);
        olderInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            olderInput.blur();
          }
        });

        const actSelect = document.createElement("select");
        actSelect.className = "gmf-select";
        const curAction = getRuleAction(c);
        for (const [val, txt] of [
          ["block_spam", "Block & Spam"],
          ["archive", "Archive"],
          ["delete", "Delete"]
        ]) {
          const opt = document.createElement("option");
          opt.value = val;
          opt.textContent = txt;
          if (val === curAction) opt.selected = true;
          actSelect.appendChild(opt);
        }
        actSelect.addEventListener("change", async (e) => {
          await sendMsg("UPDATE_AI_CATEGORY", {
            id: c.id,
            action: e.target.value
          });
          processedKeys.clear();
          await refreshState();
        });

        const delBtn = document.createElement("button");
        delBtn.className = "gmf-rule-del";
        delBtn.textContent = "×";
        delBtn.title = "Remove AI category";
        delBtn.addEventListener("click", async () => {
          await sendMsg("DELETE_AI_CATEGORY", { id: c.id });
          processedKeys.clear();
          aiEvalCache.clear();
          await refreshState();
        });

        row.appendChild(toggle);
        row.appendChild(label);
        row.appendChild(olderInput);
        row.appendChild(actSelect);
        row.appendChild(delBtn);
        aiCatContainer.appendChild(row);
      }
    }

    const patContainer = document.getElementById("gmf-patterns");
    patContainer.innerHTML = "";
    for (const p of pats) {
      const row = document.createElement("div");
      row.className = "gmf-rule-item";

      const label = document.createElement("span");
      label.style.flex = "1";
      label.style.overflow = "hidden";
      label.style.textOverflow = "ellipsis";
      label.textContent = formatRuleLabel(p);
      label.title = formatRuleLabel(p);

      const olderInput = document.createElement("input");
      olderInput.type = "text";
      olderInput.value = p.older_than || "";
      olderInput.placeholder = "⏳ age";
      olderInput.title = "Older than (e.g. 7d, 24h, or blank for any age). Press Enter to save.";
      olderInput.style.width = "54px";
      olderInput.style.background = "#0f172a";
      olderInput.style.color = "#f8fafc";
      olderInput.style.border = "1px solid #475569";
      olderInput.style.borderRadius = "5px";
      olderInput.style.padding = "3px 5px";
      olderInput.style.fontSize = "11px";
      const saveOlder = async () => {
        const nextVal = (olderInput.value || "").trim();
        if (nextVal === (p.older_than || "")) return;
        await sendMsg("UPDATE_PATTERN", {
          id: p.id,
          older_than: nextVal
        });
        processedKeys.clear();
        await refreshState();
      };
      olderInput.addEventListener("change", saveOlder);
      olderInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          saveOlder();
        }
      });

      const actSelect = document.createElement("select");
      actSelect.className = "gmf-select";
      const curAction = getRuleAction(p);
      for (const [val, txt] of [
        ["delete", "Delete"],
        ["block_spam", "Block & Spam"],
        ["archive", "Archive"]
      ]) {
        const opt = document.createElement("option");
        opt.value = val;
        opt.textContent = txt;
        if (val === curAction) opt.selected = true;
        actSelect.appendChild(opt);
      }
      actSelect.addEventListener("change", async (e) => {
        await sendMsg("UPDATE_PATTERN", {
          id: p.id,
          action: e.target.value
        });
        processedKeys.clear();
        await refreshState();
      });

      const delBtn = document.createElement("button");
      delBtn.className = "gmf-rule-del";
      delBtn.textContent = "×";
      delBtn.title = "Remove rule";
      delBtn.addEventListener("click", async () => {
        await sendMsg("DELETE_PATTERN", { id: p.id });
        await refreshState();
      });

      row.appendChild(label);
      row.appendChild(olderInput);
      row.appendChild(actSelect);
      row.appendChild(delBtn);
      patContainer.appendChild(row);
    }

    const logContainer = document.getElementById("gmf-logs");
    const logs = state.logs || [];
    if (logs.length === 0) {
      logContainer.innerHTML = "<div>No messages auto-filtered yet.</div>";
    } else {
      logContainer.innerHTML = "";
      for (const l of logs.slice(0, 15)) {
        const div = document.createElement("div");
        div.className = "gmf-log-item";
        div.textContent = `[${(l.action || "deleted").toUpperCase()}] ${l.sender} (${l.matched_pattern}): ${l.snippet}`;
        logContainer.appendChild(div);
      }
    }
  }

  let lastConfigSig = "";

  async function refreshState() {
    const res = await sendMsg("GET_STATE");
    if (res && res.ok && res.config) {
      const nextSig = JSON.stringify({
        ai: res.config.ai_categories || [],
        pats: res.config.patterns || [],
        dry: !!res.config.dry_run,
        ai_on: res.config.ai_filter_enabled !== false
      });
      if (lastConfigSig && nextSig !== lastConfigSig) {
        processedKeys.clear();
        aiEvalCache.clear();
      }
      lastConfigSig = nextSig;

      state.config = res.config;
      state.openrouter_key_configured = !!res.openrouter_key_configured;
      state.ai_cache_count = res.ai_cache_count || 0;
      state.logs = res.logs || [];
      state.deleted_count = res.deleted_count || 0;
      state.online = !!res.online;

      const sr = res.scan_request;
      if (sr && sr.scan_id && sr.scan_id !== lastHandledScanId) {
        if (lastHandledScanId !== null) {
          lastHandledScanId = sr.scan_id;
          runExistingMessagesScan(sr.mode || "quick", sr.max_threads || 50);
        } else {
          lastHandledScanId = sr.scan_id;
        }
      }
      const ocr = res.open_conv_request;
      if (ocr && ocr.request_id && ocr.request_id !== lastHandledOpenConvId) {
        if (lastHandledOpenConvId !== null && ocr.sender) {
          lastHandledOpenConvId = ocr.request_id;
          const targetLower = cleanBidi(ocr.sender).toLowerCase();
          for (const row of getConversationRows()) {
            const { sender } = extractRowInfo(row);
            if (sender && (sender.toLowerCase() === targetLower || sender.toLowerCase().includes(targetLower))) {
              const clickTarget = row.querySelector("a") || row;
              clickTarget.click();
              break;
            }
          }
        } else {
          lastHandledOpenConvId = ocr.request_id;
        }
      }
      renderUI();
    }
  }

  async function init() {
    await refreshState();
    if (!lastHandledScanId) {
      lastHandledScanId = "init";
    }
    if (!lastHandledOpenConvId) {
      lastHandledOpenConvId = "init";
    }
    ensureUI();
    scanConversations();

    const observer = new MutationObserver(() => {
      ensureUI();
      scanConversations();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    setInterval(() => {
      ensureUI();
      scanConversations();
    }, 2000);

    setInterval(() => {
      refreshState();
    }, 4000);
    setInterval(() => {
      if (getConversationRows().length > 0) {
        reportDebugSnapshot();
      }
    }, 60000);
    setTimeout(() => reportDebugSnapshot(), 2500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
