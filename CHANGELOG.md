# Changelog

All notable changes to **Google Messages Web Auto-Filter** (`gmessages-filter`) will be documented in this file.

## [v1.9.4](https://github.com/russellmilliner/gmessages-filter/releases/tag/v1.9.4) — 2026-11-10

### Highlights
- KWin Script.stop hygiene, event-driven QEventLoop wait, single-pass 60ms primary-screen centering, and zero-kdotool window activation in vip_alert_popup.py

## [v1.9.3](https://github.com/russellmilliner/gmessages-filter/releases/tag/v1.9.3) — 2026-11-01

### Fixed
- **KWin `PerOutputVirtualDesktops=true` Window Visibility Detection (`src/vip_alert_popup.py`)**:
  - Updated `check_gmessages_window_visibility()` to query `workspace.currentDesktopForScreen(gm.output)` rather than global `workspace.currentDesktop`. On multi-monitor KDE Plasma 6 setups with `PerOutputVirtualDesktops=true` (where Google Messages is open on `DP-3` on `Desktop 4` while focus is on `HDMI-A-1` on `Desktop 1`), KWin now accurately reports `visible: True, onCurrentDesktop: True` instead of `other_virtual_desktop`, preventing false VIP alerts when a VIP conversation is already open and selected on another monitor.
- **Unique Thread Key & Freshness Guard for VIP Baseline (`extension/content.js`)**:
  - Keyed `vipBaseline` and `vipPendingTimers` by `getRowThreadKey(row, cleanSender)` (`<a href="/web/u/1/conversations/...">` pathname + sender) instead of `cleanSender` alone so duplicate-named historical threads (such as an older `9/28/23` group thread also titled `"Gloria Milliner, Michelle Milliner"`) never collide with or overwrite the active group thread's baseline.
  - Added an `ageDays <= 0.015` (~20 min) freshness guard in `checkVipContactRow()` so historical threads in the conversation list never fire live VIP alerts.
- **Multi-VIP Group Chat Attribution & Active Conversation Detection (`v1.9.2`–`v1.9.3`)**:
  - Moved `vipBaseline` check/update outside `for (const rawVip of vips)` so messages from later VIPs in `vip_alert_contacts` (e.g. `Gloria Milliner` in `"Gloria Milliner, Michelle Milliner"`) are never swallowed by earlier VIP entries (`Michelle Milliner`).
  - Enhanced `isRowActiveConversation()` to match the row's `/conversations/<ID>` link against `location.pathname` and added a `650ms` outgoing-message debounce.
  - Fixed `sw.js` / `background.js` auto-reload sequencing (`chrome.runtime.onInstalled`) and `directApiFallback` (`GET_STATE`, `SEND_DEBUG`, `LOG_DELETION`) so extension reloads cleanly refresh the Google Messages PWA window without invalidating the content script context.

## [v1.9.2](https://github.com/russellmilliner/gmessages-filter/releases/tag/v1.9.2) — 2026-11-01

### Highlights
- Fix active conversation detection, multi-VIP group chat alerts, and outgoing message debounce

## [v1.9.1](https://github.com/russellmilliner/gmessages-filter/releases/tag/v1.9.1) — 2026-11-01

### Highlights
- Add popup Logs tab (Handled + Jev AI evaluations) and prevent Bitwarden autofill popups

## [v1.9.0](https://github.com/russellmilliner/gmessages-filter/releases/tag/v1.9.0) — 2026-10-31

### Commits
- feat: Google Messages Web Auto-Filter v1.9.0 with Jev AI older_than age thresholds & KDE VIP alerts (7684eb9)

## [1.9.0] - 2026-10-31

### Added
- **Per-Category `older_than` Age Thresholds on OpenRouter Jev AI Categories**:
  - Added `older_than` (`-o` / `--older-than`, e.g. `1d`, `24h`, `7d`) support to AI filter categories in `server.py`, `gmessages-filter` CLI (`ai-add`, `ai-update`, `status`, `ai-list`), and the in-page WebExtension drawer (`content.js`).
  - Added built-in category descriptions and prompt guidance for **`login codes`** (OTPs, 2FA/MFA verification codes, temporary PINs) and **`food orders`** (restaurant/takeout/delivery order confirmations, ready-for-pickup notifications, curbside check-ins).
  - Configured Jev AI evaluations to classify and cache new messages immediately while deferring the configured action (`delete` / `archive` / `block_spam`) until `ageDays >= older_than_days` with zero extra OpenRouter calls.
- **MMS `"Picture"` Placeholder Auto-Inspection (`v1.8.2`)**:
  - Automatically opens recent (`<= 2d`) non-contact threads whose sidebar snippet is `"Picture"` so attached campaign/spam text inside the conversation is evaluated by static rules and Jev AI.
- **VIP Center-Desktop Alert Screen-Share Awareness**:
  - Added KWin 6 Wayland (`org.kde.KWin` + PipeWire `kwin_wayland` Screencast detection) placement onto secondary display (`DP-3`) whenever screen sharing is active on the primary display (`DP-1`), and privacy mode omitting message body text from the popup.

### Fixed
- **Concatenated Weekday Relative Timestamps (`v1.8.3`)**:
  - Fixed `parseMessageAgeDays()` in `content.js` to handle Google Messages Web's concatenated `aria-hidden` + visible weekday strings (`"ThursdayThu"`, `"WednesdayWed"`, `"FridayFri"`, etc.).
- **Named Automated Sender Static Rule Matching**:
  - Updated `canApplyStaticRuleToRow()` so static rules with explicit `pattern` or `number` criteria match alphanumeric/named senders (`"Sunpass"`, `"Dataplicity"`) even when `only_non_contacts` is enabled.
- **Automatic In-Browser Cache Invalidation on CLI Config Updates**:
  - Updated `refreshState()` in `content.js` to clear `aiEvalCache` and `processedKeys` whenever `ai_categories` or `patterns` change on the local sync daemon.
