#!/usr/bin/env python3
"""
Google Messages Auto-Filter Local Sync & Audit Server
-----------------------------------------------------
Synchronizes filter rules (matching message text/regex, caller number, or both,
with per-rule actions: delete, block_spam, archive), multi-category OpenRouter
Jev AI content evaluation (e.g. Political, Religion, and user-defined categories),
settings, and audit logs between the Chromium Google Messages PWA, Zen Browser,
and the CLI.

Listens on http://127.0.0.1:8768
"""

from concurrent.futures import ThreadPoolExecutor
import datetime
import hashlib
import json
import logging
import os
import re
import secrets
import subprocess
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HOST = "127.0.0.1"
PORT = 8768

CONFIG_DIR = Path.home() / ".config" / "gmessages-filter"
CONFIG_PATH = CONFIG_DIR / "config.json"
OPENROUTER_KEY_PATH = CONFIG_DIR / "openrouter.key"
DATA_DIR = Path.home() / ".local" / "share" / "gmessages-filter"
AUDIT_JSONL = DATA_DIR / "deleted.jsonl"
AUDIT_LOG = DATA_DIR / "deleted.log"
AI_CACHE_PATH = DATA_DIR / "ai_eval_cache.json"
VIP_ALERT_SCRIPT = DATA_DIR / "vip_alert_popup.py"
CONVERSATIONS_PATH = DATA_DIR / "recent_conversations.json"

OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions"
DEFAULT_AI_MODEL = "typesafe/jev-router"

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("gmessages-filter")

VALID_ACTIONS = ("delete", "block_spam", "archive")

BUILTIN_CATEGORY_DESCRIPTIONS = {
    "political": (
        "Political campaign messages, candidate endorsements, election/voting/ballot reminders, "
        "political fundraising, PAC/SuperPAC appeals, donation requests, partisan petitions or thank-you cards, "
        "partisan attacks, ballot measure/amendment advocacy, political surveys/polls, or messages referencing "
        "politicians, political parties, MAGA/GOP/Democrat/Liberal campaigns, or political commentary/propaganda."
    ),
    "religion": (
        "Religious proselytizing, church/ministry outreach, prayer chains or prayer invitations, "
        "Bible/scripture/religious courses or DVD/book promotions (such as Genesis or biblical studies), "
        "faith-based fundraising/solicitation, or unsolicited religious preaching, prophecies, and devotionals."
    ),
    "real estate": (
        "Unsolicited real estate purchase offers, cash-for-homes inquiries, property buying/selling solicitations, "
        "wholesaler/investor outreach asking to buy a residence or land, or realtor marketing spam."
    ),
    "financial offers": (
        "Unsolicited loan approvals, pre-approved credit or funding offers (e.g. 'approved for 100k', 'low monthly payments'), "
        "debt consolidation/relief pitches, cash advance/payday loan spam, refinancing solicitations, or credit-repair marketing. "
        "(Do NOT match legitimate fraud/security/identity monitoring alerts or existing bank account notifications.)"
    ),
    "finance": (
        "Unsolicited loan approvals, pre-approved credit or funding offers, debt consolidation/relief pitches, "
        "cash advance/payday loan spam, refinancing solicitations, or credit-repair marketing."
    ),
    "login codes": (
        "One-time passcodes (OTP), 2FA / multi-factor authentication codes, login/security verification codes, "
        "or temporary account verification PINs sent via SMS (e.g. 'Your verification code is...', 'Your passcode is...', "
        "'Your code is...', 'never share this code')."
    ),
    "verification codes": (
        "One-time passcodes (OTP), 2FA / multi-factor authentication codes, login/security verification codes, "
        "or temporary account verification PINs sent via SMS."
    ),
    "food orders": (
        "Restaurant, fast-food, or food-delivery order confirmations, ready-for-pickup notices, curbside check-in prompts, "
        "or food delivery status updates (e.g. Olive Garden, Culver's, DoorDash, Uber Eats, Grubhub, Raising Cane's, "
        "pizza/takeout order ready notifications)."
    ),
    "restaurant orders": (
        "Restaurant, fast-food, or food-delivery order confirmations, ready-for-pickup notices, curbside check-in prompts, "
        "or food delivery status updates."
    ),
}

DEFAULT_AI_CATEGORIES = [
    {
        "id": "cat-political",
        "name": "Political",
        "description": BUILTIN_CATEGORY_DESCRIPTIONS["political"],
        "action": "block_spam",
        "enabled": True,
    },
    {
        "id": "cat-religion",
        "name": "Religion",
        "description": BUILTIN_CATEGORY_DESCRIPTIONS["religion"],
        "action": "block_spam",
        "enabled": True,
    },
]

SCAN_REQUEST = {
    "scan_id": None,
    "mode": "quick",
    "max_threads": 50,
    "requested_at": None,
}

OPEN_CONV_REQUEST = {
    "request_id": None,
    "sender": None,
    "requested_at": None,
}

LAST_CLIENTS = {}
DEBUG_SNAPSHOT = {}
_ai_cache_lock = threading.Lock()
_ai_cache: dict[str, dict] = {}
_vip_alert_lock = threading.Lock()
_last_vip_alert_by_sender: dict[str, str] = {}
VIP_HISTORY: list[dict] = []


def check_gmessages_window_visible(simulate_screenshare: bool = False) -> dict:
    """Invoke vip_alert_popup.py --check-visibility to determine if the Google Messages window is visible on the desktop."""
    if not VIP_ALERT_SCRIPT.is_file():
        return {"found": False, "visible": False, "reason": "script_missing"}
    cmd = ["/usr/bin/python3", str(VIP_ALERT_SCRIPT), "--check-visibility"]
    if simulate_screenshare:
        cmd.append("--simulate-screenshare")
    try:
        out = subprocess.check_output(cmd, text=True, timeout=2.5)
        return json.loads(out.strip())
    except Exception as e:
        logger.warning(f"[VIP-Alert] Visibility check failed: {e}")
        return {"found": False, "visible": False, "reason": f"error: {e}"}


def trigger_vip_desktop_alert(
    sender: str,
    snippet: str = "",
    timestamp_str: str = "",
    page_hidden: bool = False,
    is_active_conversation: bool = False,
    thread_sender: str = "",
    force: bool = False,
    respect_visibility: bool = True,
    simulate_screenshare: bool = False,
) -> dict:
    """
    Evaluate whether to display the center-screen alert for a VIP contact message.
    Displays the alert if EITHER:
      1) The Google Messages window is not currently visible on the desktop
         (e.g. minimized, on another virtual desktop, covered >=35% by another window, or browser tab hidden), OR
      2) The conversation is not the currently active/open conversation inside Google Messages,
    unless force=True and respect_visibility=False.
    """
    cfg = load_config()
    if not force and not cfg.get("vip_alerts_enabled", True):
        return {"ok": True, "alerted": False, "reason": "vip_alerts_disabled"}

    clean_sender = (sender or "Unknown").strip()
    clean_thread = (thread_sender or clean_sender).strip()
    clean_snippet = re.sub(r"\s+", " ", (snippet or "").strip())
    clean_ts = (timestamp_str or "").strip()

    dedup_sig = f"{clean_snippet}"
    with _vip_alert_lock:
        prev_sig = _last_vip_alert_by_sender.get(clean_thread.lower())
        if not force and clean_snippet and prev_sig == dedup_sig:
            return {"ok": True, "alerted": False, "reason": "already_alerted"}
        if clean_snippet:
            _last_vip_alert_by_sender[clean_thread.lower()] = dedup_sig

    vis = check_gmessages_window_visible(simulate_screenshare=simulate_screenshare)
    is_win_visible = bool(vis.get("visible", False)) and not bool(page_hidden)

    if respect_visibility and is_win_visible and is_active_conversation:
        logger.info(
            f"[VIP-Alert] Suppressed alert for {clean_sender!r} (Google Messages window is visible AND conversation is active)"
        )
        return {
            "ok": True,
            "alerted": False,
            "reason": "window_visible_and_conversation_active",
            "visibility": vis,
        }

    if not is_win_visible:
        trigger_reason = vis.get("reason", "hidden" if page_hidden else "not_visible")
    else:
        trigger_reason = "not_active_conversation"

    cmd = [
        "/usr/bin/python3",
        str(VIP_ALERT_SCRIPT),
        "--sender",
        clean_sender,
        "--thread-sender",
        clean_thread,
        "--timestamp",
        clean_ts,
    ]
    if simulate_screenshare:
        cmd.append("--simulate-screenshare")

    try:
        subprocess.Popen(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        target_disp = vis.get("target_display", {})
        evt = {
            "timestamp": datetime.datetime.now(datetime.timezone.utc).astimezone().isoformat(timespec="seconds"),
            "sender": clean_sender,
            "thread_sender": clean_thread,
            "msg_timestamp": clean_ts,
            "visibility_reason": trigger_reason,
            "target_display": target_disp.get("name", "DP-1"),
            "rerouted_from_primary": target_disp.get("rerouted_from_primary", False),
        }
        VIP_HISTORY.insert(0, evt)
        del VIP_HISTORY[25:]
        logger.info(
            f"[VIP-Alert] Displayed center-desktop alert for {clean_sender!r} on {evt['target_display']} "
            f"(reason={trigger_reason}, win_visible={is_win_visible}, active_conv={is_active_conversation}, rerouted={evt['rerouted_from_primary']})"
        )
        return {
            "ok": True,
            "alerted": True,
            "reason": trigger_reason,
            "target_display": target_disp,
            "visibility": vis,
            "event": evt,
        }
    except Exception as e:
        logger.error(f"[VIP-Alert] Failed launching popup for {clean_sender!r}: {e}")
        return {"ok": False, "alerted": False, "error": str(e)}


def load_ai_cache() -> dict[str, dict]:
    global _ai_cache
    with _ai_cache_lock:
        if _ai_cache:
            return _ai_cache
        if AI_CACHE_PATH.is_file():
            try:
                _ai_cache = json.loads(AI_CACHE_PATH.read_text(encoding="utf-8"))
            except Exception as e:
                logger.warning(f"Failed reading AI cache {AI_CACHE_PATH}: {e}")
                _ai_cache = {}
        return _ai_cache


def save_ai_cache() -> None:
    with _ai_cache_lock:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        tmp = AI_CACHE_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(_ai_cache, indent=2, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, AI_CACHE_PATH)


def get_openrouter_api_key(cfg: dict | None = None) -> str:
    env_key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if env_key:
        return env_key
    if cfg and cfg.get("openrouter_api_key"):
        return str(cfg["openrouter_api_key"]).strip()
    if OPENROUTER_KEY_PATH.is_file():
        try:
            return OPENROUTER_KEY_PATH.read_text(encoding="utf-8").strip()
        except Exception:
            pass
    return ""


def slugify_category(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (name or "").strip().lower()).strip("-")
    return f"cat-{s}" if s else f"cat-{secrets.token_hex(3)}"


def parse_older_than_days(val) -> tuple[str, float | None]:
    """Parse an older_than specification (e.g. '7', '7d', '12h', '30m', '2w') into (canonical_str, days_float)."""
    if val is None or val == "" or val is False:
        return "", None
    if isinstance(val, (int, float)):
        if val <= 0:
            return "", None
        return f"{val:g}d", float(val)
    s = str(val).strip().lower()
    if not s or s in ("0", "0d", "none", "off", "false"):
        return "", None
    m = re.match(
        r"^(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|wks|week|weeks|mo|month|months|y|yr|yrs|year|years)?$",
        s,
    )
    if not m:
        return "", None
    num = float(m.group(1))
    if num <= 0:
        return "", None
    unit = m.group(2) or "d"
    if unit.startswith("m") and not unit.startswith("mo"):
        return f"{num:g}m", num / 1440.0
    if unit.startswith("h"):
        return f"{num:g}h", num / 24.0
    if unit.startswith("w"):
        return f"{num:g}w", num * 7.0
    if unit.startswith("mo"):
        return f"{num:g}mo", num * 30.0
    if unit.startswith("y"):
        return f"{num:g}y", num * 365.0
    return f"{num:g}d", num


def normalize_ai_category(c: dict) -> dict:
    name = (c.get("name") or "").strip()
    cid = (c.get("id") or "").strip() or slugify_category(name)
    desc = (c.get("description") or "").strip()
    generic_desc = f"Messages related to or promoting {name}."
    if (not desc or desc.lower() == generic_desc.lower()) and name.lower() in BUILTIN_CATEGORY_DESCRIPTIONS:
        desc = BUILTIN_CATEGORY_DESCRIPTIONS[name.lower()]
    elif not desc:
        desc = generic_desc
    action = c.get("action")
    if action not in VALID_ACTIONS:
        action = "block_spam"
    raw_older = c.get("older_than") if "older_than" in c else c.get("older_than_days")
    older_str, older_days = parse_older_than_days(raw_older)
    enabled = bool(c.get("enabled", True))
    return {
        "id": cid,
        "name": name,
        "description": desc,
        "action": action,
        "older_than": older_str,
        "older_than_days": older_days,
        "block_spam": action == "block_spam",
        "archive": action == "archive",
        "enabled": enabled,
    }


def normalize_pattern_rule(p: dict) -> dict:
    """Ensure every rule has normalized pattern, number, older_than, older_than_days, and action fields."""
    p["pattern"] = (p.get("pattern") or "").strip()
    p["number"] = (p.get("number") or "").strip()
    raw_older = p.get("older_than") if "older_than" in p else p.get("older_than_days")
    older_str, older_days = parse_older_than_days(raw_older)
    p["older_than"] = older_str
    p["older_than_days"] = older_days
    action = p.get("action")
    if action not in VALID_ACTIONS:
        if p.get("block_spam"):
            action = "block_spam"
        elif p.get("archive"):
            action = "archive"
        else:
            action = "delete"
    p["action"] = action
    p["block_spam"] = action == "block_spam"
    p["archive"] = action == "archive"
    return p


DEFAULT_CONFIG = {
    "enabled": True,
    "dry_run": False,
    "only_non_contacts": True,
    "scan_interval_ms": 2000,
    "ai_filter_enabled": True,
    "ai_political_filter_enabled": True,
    "ai_political_model": DEFAULT_AI_MODEL,
    "ai_political_action": "block_spam",
    "ai_categories": [normalize_ai_category(c) for c in DEFAULT_AI_CATEGORIES],
    "vip_alerts_enabled": True,
    "vip_alert_contacts": ["Michelle Milliner"],
    "patterns": [
        normalize_pattern_rule({
            "id": "pat-deborah",
            "pattern": "deborah",
            "number": "",
            "is_regex": False,
            "case_sensitive": False,
            "action": "block_spam",
            "enabled": True,
            "created_at": "2026-10-22T07:55:00Z",
        }),
        normalize_pattern_rule({
            "id": "pat-trump",
            "pattern": "trump",
            "number": "",
            "is_regex": False,
            "case_sensitive": False,
            "action": "block_spam",
            "enabled": True,
            "created_at": "2026-10-22T07:55:00Z",
        }),
        normalize_pattern_rule({
            "id": "pat-vance",
            "pattern": "vance",
            "number": "",
            "is_regex": False,
            "case_sensitive": False,
            "action": "block_spam",
            "enabled": True,
            "created_at": "2026-10-22T07:55:00Z",
        }),
    ],
    "whitelist": [],
}


def ensure_ai_config_fields(cfg: dict) -> dict:
    if "ai_filter_enabled" not in cfg:
        cfg["ai_filter_enabled"] = bool(cfg.get("ai_political_filter_enabled", True))
    cfg["ai_political_filter_enabled"] = bool(cfg["ai_filter_enabled"])
    cfg.setdefault("ai_political_model", DEFAULT_AI_MODEL)
    cfg.setdefault("ai_political_action", "block_spam")
    raw_cats = cfg.get("ai_categories")
    if not raw_cats or not isinstance(raw_cats, list):
        cfg["ai_categories"] = [normalize_ai_category(dict(c)) for c in DEFAULT_AI_CATEGORIES]
    else:
        cfg["ai_categories"] = [normalize_ai_category(c) for c in raw_cats if (c.get("name") or "").strip()]
    cfg.setdefault("vip_alerts_enabled", True)
    raw_vips = cfg.get("vip_alert_contacts")
    if not isinstance(raw_vips, list):
        cfg["vip_alert_contacts"] = ["Michelle Milliner"]
    else:
        cfg["vip_alert_contacts"] = [str(v).strip() for v in raw_vips if str(v).strip()]
    return cfg


def load_config() -> dict:
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    if not CONFIG_PATH.is_file():
        save_config(DEFAULT_CONFIG)
        return dict(DEFAULT_CONFIG)
    try:
        cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        ensure_ai_config_fields(cfg)
        cfg["patterns"] = [normalize_pattern_rule(p) for p in cfg.get("patterns", [])]
        return cfg
    except Exception as e:
        logger.error(f"Failed loading {CONFIG_PATH}: {e}")
        return dict(DEFAULT_CONFIG)


def save_config(cfg: dict) -> None:
    ensure_ai_config_fields(cfg)
    cfg["patterns"] = [normalize_pattern_rule(p) for p in cfg.get("patterns", [])]
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = CONFIG_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    os.replace(tmp, CONFIG_PATH)


def build_categories_system_prompt(enabled_cats: list[dict]) -> str:
    cat_lines = []
    for c in enabled_cats:
        cat_lines.append(f"- {c['name']}: {c['description']}")
    cats_block = "\n".join(cat_lines)
    cat_names_json = json.dumps([c["name"] for c in enabled_cats])
    return (
        "You are an SMS classification engine. Evaluate whether the SMS message belongs to ANY of the following "
        "active filter categories:\n\n"
        f"{cats_block}\n\n"
        "IMPORTANT: Always match a message if it fits ANY of the active filter categories listed above (including "
        "categories like 'login codes' or 'food orders' when they are listed above).\n"
        "Do NOT flag normal personal or transactional messages that do NOT fit any of the active categories above, such as:\n"
        "- Medical/telehealth appointments, healthcare questionnaires/measures, pharmacy/prescription/vaccine alerts (e.g. CVS, Walgreens, APG)\n"
        "- Bank balance/fraud/identity alerts (e.g. Allstate Identity Protection) or toll/utility notifications (e.g. SunPass)\n"
        "- School/youth sports/band fundraisers (e.g. Snap! Raise) or personal messages (unless they match an active category above)\n\n"
        "Respond ONLY with a single raw JSON object (no markdown fences):\n"
        "{\n"
        '  "matched": true or false,\n'
        f'  "matched_categories": subset of {cat_names_json} that apply (or [] if none),\n'
        '  "primary_category": name of the single best-matching category from the list above (or null if none),\n'
        '  "confidence": 0.0 to 1.0,\n'
        '  "reason": "brief 1-sentence explanation"\n'
        "}"
    )


def evaluate_categories_openrouter(
    sender: str,
    snippet: str,
    model: str | None = None,
    force: bool = False,
    categories_override: list[dict] | None = None,
) -> dict:
    """Evaluate whether an SMS message matches any active AI category using OpenRouter (default: typesafe/jev-router)."""
    clean_snippet = re.sub(r"\s+", " ", (snippet or "").strip())
    clean_sender = (sender or "unknown").strip()
    cfg = load_config()
    target_model = (model or cfg.get("ai_political_model") or DEFAULT_AI_MODEL).strip()

    all_cats = categories_override if categories_override is not None else cfg.get("ai_categories", [])
    enabled_cats = [normalize_ai_category(c) for c in all_cats if c.get("enabled", True)]

    if not clean_snippet or not enabled_cats:
        return {
            "ok": True,
            "matched": False,
            "is_political": False,
            "matched_categories": [],
            "primary_category": None,
            "action_if_matched": "none",
            "confidence": 1.0,
            "reason": "Empty message snippet or no active AI categories",
            "model": target_model,
            "routed_model": None,
            "cached": True,
        }

    cat_sig = "|".join(f"{c['name'].lower()}:{c['description'].lower()}" for c in sorted(enabled_cats, key=lambda x: x["name"].lower()))
    cache_key = hashlib.sha256(f"{target_model}::{cat_sig}::{clean_snippet.lower()}".encode("utf-8")).hexdigest()[:24]

    cache = load_ai_cache()
    if not force and cache_key in cache:
        cached_entry = dict(cache[cache_key])
        cached_entry["cached"] = True
        if not cached_entry.get("sender") and clean_sender:
            cached_entry["sender"] = clean_sender
        if not cached_entry.get("snippet") and clean_snippet:
            cached_entry["snippet"] = clean_snippet[:300]
        # Ensure action and older_than reflect current category config
        prim = cached_entry.get("primary_category")
        if cached_entry.get("matched") and prim:
            for c in enabled_cats:
                if c["name"].lower() == str(prim).lower():
                    cached_entry["action_if_matched"] = c["action"]
                    cached_entry["older_than"] = c.get("older_than", "")
                    cached_entry["older_than_days"] = c.get("older_than_days")
                    break
        return cached_entry

    api_key = get_openrouter_api_key(cfg)
    if not api_key:
        return {
            "ok": False,
            "error": f"OpenRouter API key not configured in {OPENROUTER_KEY_PATH}",
            "matched": False,
            "is_political": False,
            "matched_categories": [],
            "primary_category": None,
            "action_if_matched": "none",
            "confidence": 0.0,
            "reason": "Missing OpenRouter API key",
            "model": target_model,
        }

    sys_prompt = build_categories_system_prompt(enabled_cats)
    payload = {
        "model": target_model,
        "temperature": 0.0,
        "messages": [
            {"role": "system", "content": sys_prompt},
            {"role": "user", "content": f"Sender: {clean_sender}\nMessage: {clean_snippet}"},
        ],
    }

    try:
        req = urllib.request.Request(
            OPENROUTER_API_URL,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "HTTP-Referer": "http://127.0.0.1:8768",
                "X-Title": "gmessages-filter",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=25) as resp:
            resp_data = json.loads(resp.read().decode("utf-8"))

        routed_model = resp_data.get("model") or target_model
        choices = resp_data.get("choices") or []
        raw_content = ""
        if choices:
            raw_content = (choices[0].get("message", {}).get("content") or "").strip()

        cleaned_json_str = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw_content, flags=re.IGNORECASE).strip()
        m_json = re.search(r"\{.*\}", cleaned_json_str, flags=re.DOTALL)
        if m_json:
            parsed = json.loads(m_json.group(0))
        else:
            parsed = json.loads(cleaned_json_str)

        raw_matched_cats = parsed.get("matched_categories") or []
        if isinstance(raw_matched_cats, str):
            raw_matched_cats = [raw_matched_cats]

        # Canonicalize category names against enabled_cats
        cat_by_lower = {c["name"].lower(): c for c in enabled_cats}
        canonical_cats = []
        for mc in raw_matched_cats:
            mc_str = str(mc).strip().lower()
            if mc_str in cat_by_lower:
                cname = cat_by_lower[mc_str]["name"]
                if cname not in canonical_cats:
                    canonical_cats.append(cname)

        raw_primary = parsed.get("primary_category")
        if raw_primary and str(raw_primary).strip().lower() in cat_by_lower:
            primary_cat = cat_by_lower[str(raw_primary).strip().lower()]["name"]
            if primary_cat not in canonical_cats:
                canonical_cats.insert(0, primary_cat)
        elif canonical_cats:
            primary_cat = canonical_cats[0]
        else:
            primary_cat = None

        matched = bool(parsed.get("matched", False) or parsed.get("is_political", False)) and bool(primary_cat)
        if not matched:
            canonical_cats = []
            primary_cat = None

        chosen_action = "none"
        chosen_older_str = ""
        chosen_older_days = None
        if matched and primary_cat:
            cat_info = cat_by_lower[primary_cat.lower()]
            chosen_action = cat_info["action"]
            chosen_older_str = cat_info.get("older_than", "")
            chosen_older_days = cat_info.get("older_than_days")

        conf = float(parsed.get("confidence", 0.0) or 0.0)
        reason = str(parsed.get("reason", "")).strip()
        cost = resp_data.get("usage", {}).get("cost")

        result = {
            "ok": True,
            "sender": clean_sender,
            "snippet": clean_snippet[:300],
            "matched": matched,
            "is_political": matched,  # backward compatibility for callers checking is_political
            "matched_categories": canonical_cats,
            "primary_category": primary_cat,
            "action_if_matched": chosen_action,
            "older_than": chosen_older_str,
            "older_than_days": chosen_older_days,
            "confidence": conf,
            "reason": reason,
            "model": target_model,
            "routed_model": routed_model,
            "cost": cost,
            "evaluated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
            "cached": False,
        }

        with _ai_cache_lock:
            _ai_cache[cache_key] = {k: v for k, v in result.items() if k != "cached"}
        save_ai_cache()

        logger.info(
            f"[AI-Jev] sender={clean_sender!r} matched={matched} categories={canonical_cats} "
            f"action={chosen_action} conf={conf:.2f} routed={routed_model} reason={reason!r}"
        )
        return result

    except Exception as e:
        logger.error(f"[AI-Jev] OpenRouter evaluation error for {clean_sender!r}: {e}")
        return {
            "ok": False,
            "error": str(e),
            "matched": False,
            "is_political": False,
            "matched_categories": [],
            "primary_category": None,
            "action_if_matched": "none",
            "confidence": 0.0,
            "reason": f"Evaluation error: {e}",
            "model": target_model,
            "cached": False,
        }


def append_audit_entry(entry: dict) -> dict:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    now_iso = datetime.datetime.now(datetime.timezone.utc).astimezone().isoformat(timespec="seconds")
    record = {
        "id": entry.get("id") or f"act-{secrets.token_hex(4)}",
        "timestamp": entry.get("timestamp") or now_iso,
        "action": entry.get("action", "deleted"),
        "sender": entry.get("sender", "unknown"),
        "snippet": entry.get("snippet", ""),
        "matched_pattern": entry.get("matched_pattern", ""),
        "browser": entry.get("browser", "unknown"),
    }
    if "ai_evaluation" in entry:
        record["ai_evaluation"] = entry["ai_evaluation"]

    with AUDIT_JSONL.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")

    log_line = (
        f"[{record['timestamp']}] [{record['action'].upper()}] "
        f"sender={record['sender']!r} rule={record['matched_pattern']!r} "
        f"browser={record['browser']} snippet={record['snippet']!r}\n"
    )
    with AUDIT_LOG.open("a", encoding="utf-8") as f:
        f.write(log_line)

    logger.info(log_line.strip())
    return record


def read_audit_entries(limit: int = 100) -> list:
    if not AUDIT_JSONL.is_file():
        return []
    lines = AUDIT_JSONL.read_text(encoding="utf-8", errors="replace").splitlines()
    out = []
    for line in reversed(lines[-limit:]):
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except Exception:
            pass
    return out


def evaluate_audit_logs(limit: int = 100, only_blocked: bool = False, force: bool = False) -> dict:
    """Evaluate historical messages in deleted.jsonl using OpenRouter Jev across all active AI categories."""
    entries = list(reversed(read_audit_entries(limit=limit)))
    if only_blocked:
        entries = [e for e in entries if "block" in (e.get("action") or "").lower()]

    cfg = load_config()
    model = cfg.get("ai_political_model") or DEFAULT_AI_MODEL
    enabled_cats = [c for c in cfg.get("ai_categories", []) if c.get("enabled", True)]

    unique_map: dict[str, tuple[str, str]] = {}
    for e in entries:
        snip = re.sub(r"\s+", " ", (e.get("snippet") or "").strip())
        key = snip.lower()
        if key not in unique_map:
            unique_map[key] = (e.get("sender", "unknown"), snip)

    eval_by_key: dict[str, dict] = {}

    def _worker(item: tuple[str, tuple[str, str]]):
        k, (snd, snp) = item
        eval_by_key[k] = evaluate_categories_openrouter(snd, snp, model=model, force=force)

    with ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(_worker, unique_map.items()))

    results = []
    would_match_count = 0
    would_not_match_count = 0
    previously_blocked_total = 0
    previously_blocked_matched = 0
    previously_blocked_unmatched = 0
    by_category_counts: dict[str, int] = {}

    for idx, e in enumerate(entries, start=1):
        snip = re.sub(r"\s+", " ", (e.get("snippet") or "").strip())
        ev = eval_by_key.get(snip.lower(), {})
        matched = bool(ev.get("matched", False))
        cats = ev.get("matched_categories") or []
        prim_cat = ev.get("primary_category")
        action_if = ev.get("action_if_matched", "none")
        prev_action = e.get("action", "deleted")
        was_blocked = "block" in prev_action.lower()

        for c in cats:
            by_category_counts[c] = by_category_counts.get(c, 0) + 1

        if matched:
            would_match_count += 1
        else:
            would_not_match_count += 1

        if was_blocked:
            previously_blocked_total += 1
            if matched:
                previously_blocked_matched += 1
            else:
                previously_blocked_unmatched += 1

        results.append({
            "index": idx,
            "id": e.get("id"),
            "timestamp": e.get("timestamp"),
            "sender": e.get("sender"),
            "previous_action": prev_action,
            "matched_pattern": e.get("matched_pattern"),
            "snippet": snip,
            "jev_matched": matched,
            "jev_is_political": matched,
            "jev_categories": cats,
            "jev_primary_category": prim_cat,
            "jev_action": action_if,
            "jev_confidence": ev.get("confidence", 0.0),
            "jev_reason": ev.get("reason", ""),
            "jev_routed_model": ev.get("routed_model"),
            "jev_cost": ev.get("cost"),
            "cached": ev.get("cached", False),
        })

    return {
        "ok": True,
        "model": model,
        "active_categories": [c["name"] for c in enabled_cats],
        "total_evaluated": len(results),
        "unique_messages": len(unique_map),
        "would_block_count": would_match_count,
        "would_not_block_count": would_not_match_count,
        "previously_blocked_total": previously_blocked_total,
        "previously_blocked_political": previously_blocked_matched,
        "previously_blocked_non_political": previously_blocked_unmatched,
        "by_category_counts": by_category_counts,
        "results": results,
    }


class FilterRequestHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _send_json(self, data: dict, status: int = 200):
        raw = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(raw)

    def do_OPTIONS(self):
        self._send_json({"ok": True})

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/status":
            ua = self.headers.get("User-Agent", "unknown")
            LAST_CLIENTS[ua] = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
            cfg = load_config()
            logs = read_audit_entries(limit=1000)
            cache = load_ai_cache()
            recent_ai_evals = sorted(
                (v for v in cache.values() if isinstance(v, dict)),
                key=lambda x: str(x.get("evaluated_at") or ""),
                reverse=True,
            )[:60]
            ext_ver = "1.7.0"
            try:
                manifest_path = DATA_DIR / "extension" / "manifest.json"
                if manifest_path.is_file():
                    ext_ver = json.loads(manifest_path.read_text(encoding="utf-8")).get("version", ext_ver)
            except Exception:
                pass
            self._send_json({
                "ok": True,
                "extension_version": ext_ver,
                "config": cfg,
                "openrouter_key_configured": bool(get_openrouter_api_key(cfg)),
                "ai_cache_count": len(cache),
                "deleted_count": len(logs),
                "recent_logs": logs[:80],
                "recent_ai_evals": recent_ai_evals,
                "scan_request": SCAN_REQUEST,
                "open_conv_request": OPEN_CONV_REQUEST,
                "last_clients": LAST_CLIENTS,
            })
        elif parsed.path == "/api/debug":
            self._send_json({
                "last_clients": LAST_CLIENTS,
                "debug_snapshot": DEBUG_SNAPSHOT,
                "scan_request": SCAN_REQUEST,
            })
        elif parsed.path == "/api/conversations":
            convs = []
            if CONVERSATIONS_PATH.is_file():
                try:
                    convs = json.loads(CONVERSATIONS_PATH.read_text(encoding="utf-8"))
                except Exception:
                    convs = []
            if not convs and DEBUG_SNAPSHOT.get("sample_rows"):
                convs = DEBUG_SNAPSHOT.get("sample_rows", [])
            self._send_json({
                "ok": True,
                "count": len(convs),
                "conversations": convs,
                "updated_at": DEBUG_SNAPSHOT.get("updated_at"),
            })
        elif parsed.path == "/api/config":
            self._send_json(load_config())
        elif parsed.path == "/api/logs":
            qs = parse_qs(parsed.query)
            limit = int(qs.get("limit", ["100"])[0])
            self._send_json({"logs": read_audit_entries(limit=limit)})
        elif parsed.path == "/api/ai-cache":
            cache = load_ai_cache()
            self._send_json({"ok": True, "count": len(cache), "cache": cache})
        elif parsed.path == "/gmessages-filter.xpi":
            xpi_path = DATA_DIR / "gmessages-filter.xpi"
            if xpi_path.is_file():
                raw = xpi_path.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "application/x-xpinstall")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
            else:
                self._send_json({"error": "XPI not found"}, status=404)
        else:
            self._send_json({"error": "Not found"}, status=404)

    def do_POST(self):
        parsed = urlparse(self.path)
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length).decode("utf-8") if length > 0 else "{}"
        try:
            payload = json.loads(body) if body else {}
        except Exception:
            self._send_json({"error": "Invalid JSON"}, status=400)
            return

        if parsed.path == "/api/config":
            cfg = load_config()
            for key in (
                "enabled",
                "dry_run",
                "only_non_contacts",
                "scan_interval_ms",
                "ai_filter_enabled",
                "ai_political_filter_enabled",
                "ai_political_model",
                "ai_political_action",
                "ai_categories",
                "vip_alerts_enabled",
                "vip_alert_contacts",
                "patterns",
                "whitelist",
            ):
                if key in payload:
                    cfg[key] = payload[key]
            if "ai_political_filter_enabled" in payload and "ai_filter_enabled" not in payload:
                cfg["ai_filter_enabled"] = bool(payload["ai_political_filter_enabled"])
            elif "ai_filter_enabled" in payload:
                cfg["ai_political_filter_enabled"] = bool(payload["ai_filter_enabled"])
            if "openrouter_api_key" in payload and payload["openrouter_api_key"]:
                OPENROUTER_KEY_PATH.parent.mkdir(parents=True, exist_ok=True)
                OPENROUTER_KEY_PATH.write_text(str(payload["openrouter_api_key"]).strip() + "\n", encoding="utf-8")
                os.chmod(OPENROUTER_KEY_PATH, 0o600)
            save_config(cfg)
            self._send_json({"ok": True, "config": cfg})

        elif parsed.path == "/api/ai-categories":
            cfg = load_config()
            name = (payload.get("name") or "").strip()
            if not name:
                self._send_json({"error": "Category name is required"}, status=400)
                return
            desc = (payload.get("description") or "").strip()
            action = payload.get("action")
            if action not in VALID_ACTIONS:
                action = "block_spam"
            raw_older = payload.get("older_than") if "older_than" in payload else payload.get("older_than_days")
            older_str, _ = parse_older_than_days(raw_older)
            cats = cfg.get("ai_categories", [])
            for idx, existing in enumerate(cats):
                if existing.get("name", "").lower() == name.lower() or existing.get("id") == payload.get("id"):
                    existing["name"] = name
                    if desc:
                        existing["description"] = desc
                    existing["action"] = action
                    if "older_than" in payload or "older_than_days" in payload:
                        existing["older_than"] = older_str
                    existing["enabled"] = True
                    cats[idx] = normalize_ai_category(existing)
                    save_config(cfg)
                    self._send_json({"ok": True, "config": cfg, "added": cats[idx]})
                    return
            new_cat = normalize_ai_category({
                "id": slugify_category(name),
                "name": name,
                "description": desc,
                "action": action,
                "older_than": older_str,
                "enabled": True,
            })
            cats.append(new_cat)
            cfg["ai_categories"] = cats
            save_config(cfg)
            logger.info(f"Added AI category: {new_cat}")
            self._send_json({"ok": True, "config": cfg, "added": new_cat})

        elif parsed.path == "/api/ai-categories/update":
            cfg = load_config()
            target = (payload.get("id") or payload.get("target") or payload.get("name") or "").strip()
            updated_cat = None
            for idx, c in enumerate(cfg.get("ai_categories", [])):
                if c.get("id") == target or c.get("name", "").lower() == target.lower():
                    if "name" in payload and payload["name"]:
                        c["name"] = str(payload["name"]).strip()
                    if "description" in payload and payload["description"] is not None:
                        c["description"] = str(payload["description"]).strip()
                    if "action" in payload and payload["action"] in VALID_ACTIONS:
                        c["action"] = payload["action"]
                    if "older_than" in payload or "older_than_days" in payload:
                        raw_o = payload.get("older_than") if "older_than" in payload else payload.get("older_than_days")
                        c["older_than"], c["older_than_days"] = parse_older_than_days(raw_o)
                    if "enabled" in payload:
                        c["enabled"] = bool(payload["enabled"])
                    cfg["ai_categories"][idx] = normalize_ai_category(c)
                    updated_cat = cfg["ai_categories"][idx]
                    break
            if not updated_cat:
                self._send_json({"error": f"AI category {target!r} not found"}, status=404)
                return
            save_config(cfg)
            logger.info(f"Updated AI category {target!r} -> {updated_cat}")
            self._send_json({"ok": True, "config": cfg, "updated": updated_cat})

        elif parsed.path == "/api/ai-categories/delete":
            cfg = load_config()
            target = (payload.get("id") or payload.get("target") or payload.get("name") or "").strip()
            before = len(cfg.get("ai_categories", []))
            cfg["ai_categories"] = [
                c for c in cfg.get("ai_categories", [])
                if c.get("id") != target and c.get("name", "").lower() != target.lower()
            ]
            save_config(cfg)
            logger.info(f"Removed AI category {target!r} ({before - len(cfg['ai_categories'])} removed)")
            self._send_json({"ok": True, "config": cfg})

        elif parsed.path == "/api/evaluate":
            sender = payload.get("sender", "unknown")
            snippet = payload.get("snippet", "")
            model = payload.get("model")
            force = bool(payload.get("force", False))
            res = evaluate_categories_openrouter(sender, snippet, model=model, force=force)
            self._send_json(res)

        elif parsed.path == "/api/evaluate-logs":
            limit = int(payload.get("limit", 100))
            only_blocked = bool(payload.get("only_blocked", False))
            force = bool(payload.get("force", False))
            res = evaluate_audit_logs(limit=limit, only_blocked=only_blocked, force=force)
            self._send_json(res)

        elif parsed.path == "/api/vip-alert":
            sender = payload.get("sender", "Michelle Milliner")
            thread_sender = payload.get("thread_sender", sender)
            snippet = payload.get("snippet", "")
            timestamp_str = payload.get("timestamp", "")
            page_hidden = bool(payload.get("page_hidden", False))
            is_active_conv = bool(payload.get("is_active_conversation", False))
            force = bool(payload.get("force", False))
            respect_visibility = bool(payload.get("respect_visibility", True))
            simulate_screenshare = bool(payload.get("simulate_screenshare", False))
            res = trigger_vip_desktop_alert(
                sender=sender,
                snippet=snippet,
                timestamp_str=timestamp_str,
                page_hidden=page_hidden,
                is_active_conversation=is_active_conv,
                thread_sender=thread_sender,
                force=force,
                respect_visibility=respect_visibility,
                simulate_screenshare=simulate_screenshare,
            )
            self._send_json(res)

        elif parsed.path == "/api/open-conversation":
            target_sender = (payload.get("sender") or "").strip()
            if target_sender:
                OPEN_CONV_REQUEST["request_id"] = f"open-{secrets.token_hex(4)}"
                OPEN_CONV_REQUEST["sender"] = target_sender
                OPEN_CONV_REQUEST["requested_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
                logger.info(f"Requested opening conversation for {target_sender!r} ({OPEN_CONV_REQUEST['request_id']})")
            self._send_json({"ok": True, "open_conv_request": OPEN_CONV_REQUEST})

        elif parsed.path == "/api/vip-contacts":
            cfg = load_config()
            name = (payload.get("name") or "").strip()
            if not name:
                self._send_json({"error": "Contact name is required"}, status=400)
                return
            vips = cfg.get("vip_alert_contacts", [])
            if not any(v.lower() == name.lower() for v in vips):
                vips.append(name)
            cfg["vip_alert_contacts"] = vips
            save_config(cfg)
            logger.info(f"Added VIP alert contact: {name!r}")
            self._send_json({"ok": True, "config": cfg, "added": name})

        elif parsed.path == "/api/vip-contacts/delete":
            cfg = load_config()
            target = (payload.get("name") or payload.get("target") or "").strip()
            before = len(cfg.get("vip_alert_contacts", []))
            cfg["vip_alert_contacts"] = [
                v for v in cfg.get("vip_alert_contacts", []) if v.lower() != target.lower()
            ]
            save_config(cfg)
            logger.info(f"Removed VIP alert contact {target!r} ({before - len(cfg['vip_alert_contacts'])} removed)")
            self._send_json({"ok": True, "config": cfg})

        elif parsed.path == "/api/patterns":
            cfg = load_config()
            pat_str = (payload.get("pattern") or "").strip()
            num_str = (payload.get("number") or "").strip()
            raw_older = payload.get("older_than") if "older_than" in payload else payload.get("older_than_days")
            older_str, older_days = parse_older_than_days(raw_older)
            if not pat_str and not num_str and older_days is None:
                self._send_json(
                    {"error": "At least one of message pattern, caller number, or older_than is required"},
                    status=400,
                )
                return
            is_regex = bool(payload.get("is_regex", False))
            case_sensitive = bool(payload.get("case_sensitive", False))
            action = payload.get("action")
            if action not in VALID_ACTIONS:
                if payload.get("block_spam"):
                    action = "block_spam"
                elif payload.get("archive"):
                    action = "archive"
                else:
                    action = "delete"

            for existing in cfg.get("patterns", []):
                if (
                    existing.get("pattern", "") == pat_str
                    and existing.get("number", "") == num_str
                    and existing.get("is_regex") == is_regex
                ):
                    existing["enabled"] = True
                    existing["action"] = action
                    existing["older_than"] = older_str
                    normalize_pattern_rule(existing)
                    save_config(cfg)
                    self._send_json({"ok": True, "config": cfg})
                    return

            new_pat = normalize_pattern_rule({
                "id": f"pat-{secrets.token_hex(4)}",
                "pattern": pat_str,
                "number": num_str,
                "older_than": older_str,
                "is_regex": is_regex,
                "case_sensitive": case_sensitive,
                "action": action,
                "enabled": True,
                "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
            })
            cfg.setdefault("patterns", []).append(new_pat)
            save_config(cfg)
            logger.info(
                f"Added rule: pattern={pat_str!r}, number={num_str!r}, older_than={older_str!r} (regex={is_regex}, action={action})"
            )
            self._send_json({"ok": True, "config": cfg, "added": new_pat})

        elif parsed.path == "/api/patterns/update":
            cfg = load_config()
            target = payload.get("id") or payload.get("target") or payload.get("pattern") or payload.get("number")
            updated_rule = None
            for p in cfg.get("patterns", []):
                if (
                    p.get("id") == target
                    or (p.get("pattern") and p.get("pattern") == target)
                    or (p.get("number") and p.get("number") == target)
                ):
                    if "pattern" in payload and payload.get("id"):
                        p["pattern"] = (payload["pattern"] or "").strip()
                    if "number" in payload and (payload.get("id") or "number" in payload):
                        p["number"] = (payload["number"] or "").strip()
                    if "older_than" in payload or "older_than_days" in payload:
                        raw_o = payload.get("older_than") if "older_than" in payload else payload.get("older_than_days")
                        p["older_than"], p["older_than_days"] = parse_older_than_days(raw_o)
                    if "action" in payload and payload["action"] in VALID_ACTIONS:
                        p["action"] = payload["action"]
                    elif "block_spam" in payload:
                        p["action"] = "block_spam" if payload["block_spam"] else "delete"
                    elif "archive" in payload:
                        p["action"] = "archive" if payload["archive"] else "delete"
                    if "enabled" in payload:
                        p["enabled"] = bool(payload["enabled"])
                    if "is_regex" in payload:
                        p["is_regex"] = bool(payload["is_regex"])
                    if "case_sensitive" in payload:
                        p["case_sensitive"] = bool(payload["case_sensitive"])
                    normalize_pattern_rule(p)
                    updated_rule = p
                    break
            if not updated_rule:
                self._send_json({"error": f"Rule {target!r} not found"}, status=404)
                return
            save_config(cfg)
            logger.info(f"Updated rule {target!r} -> {updated_rule}")
            self._send_json({"ok": True, "config": cfg, "updated": updated_rule})

        elif parsed.path == "/api/patterns/delete":
            cfg = load_config()
            target = payload.get("id") or payload.get("pattern") or payload.get("number")
            before = len(cfg.get("patterns", []))
            cfg["patterns"] = [
                p for p in cfg.get("patterns", [])
                if p.get("id") != target and p.get("pattern") != target and p.get("number") != target
            ]
            save_config(cfg)
            logger.info(f"Removed rule {target!r} ({before - len(cfg['patterns'])} removed)")
            self._send_json({"ok": True, "config": cfg})

        elif parsed.path == "/api/log":
            rec = append_audit_entry(payload)
            self._send_json({"ok": True, "entry": rec})

        elif parsed.path == "/api/logs/clear":
            if AUDIT_JSONL.is_file():
                AUDIT_JSONL.unlink()
            self._send_json({"ok": True})

        elif parsed.path == "/api/scan":
            SCAN_REQUEST["scan_id"] = f"scan-{secrets.token_hex(4)}"
            SCAN_REQUEST["mode"] = payload.get("mode", "quick")
            SCAN_REQUEST["max_threads"] = int(payload.get("max_threads", 50))
            SCAN_REQUEST["requested_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
            logger.info(
                f"Triggered manual scan: id={SCAN_REQUEST['scan_id']} mode={SCAN_REQUEST['mode']} max_threads={SCAN_REQUEST['max_threads']}"
            )
            self._send_json({"ok": True, "scan_request": SCAN_REQUEST})

        elif parsed.path == "/api/debug":
            incoming_rows = payload.get("sample_rows")
            if isinstance(incoming_rows, list) and len(incoming_rows) == 0 and DEBUG_SNAPSHOT.get("sample_rows"):
                payload = dict(payload)
                payload["sample_rows"] = DEBUG_SNAPSHOT["sample_rows"]
                payload["row_count"] = DEBUG_SNAPSHOT.get("row_count", len(DEBUG_SNAPSHOT["sample_rows"]))
            DEBUG_SNAPSHOT.update(payload)
            DEBUG_SNAPSHOT["updated_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
            if isinstance(incoming_rows, list) and len(incoming_rows) > 0:
                try:
                    existing_map = {}
                    if CONVERSATIONS_PATH.is_file():
                        for item in json.loads(CONVERSATIONS_PATH.read_text(encoding="utf-8")):
                            if isinstance(item, dict) and item.get("sender"):
                                existing_map[item["sender"]] = item
                    now_str = DEBUG_SNAPSHOT["updated_at"]
                    for row in incoming_rows:
                        if isinstance(row, dict) and row.get("sender"):
                            r_copy = dict(row)
                            r_copy["seen_at"] = now_str
                            existing_map[row["sender"]] = r_copy
                    merged = list(existing_map.values())
                    CONVERSATIONS_PATH.write_text(json.dumps(merged, indent=2, ensure_ascii=False), encoding="utf-8")
                except Exception as e:
                    logger.warning(f"Failed saving {CONVERSATIONS_PATH}: {e}")
            logger.info(f"Debug snapshot received: {json.dumps(payload, ensure_ascii=False)[:400]}")
            self._send_json({"ok": True})

        else:
            self._send_json({"error": "Not found"}, status=404)


def main():
    cfg = load_config()
    save_config(cfg)
    load_ai_cache()
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer((HOST, PORT), FilterRequestHandler)
    active_cats = [c["name"] for c in cfg.get("ai_categories", []) if c.get("enabled", True)]
    logger.info(
        f"Google Messages Filter Server listening on http://{HOST}:{PORT} "
        f"(AI Filter: enabled={cfg.get('ai_filter_enabled')}, model={cfg.get('ai_political_model')}, categories={active_cats})"
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
