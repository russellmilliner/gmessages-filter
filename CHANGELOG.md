# Changelog

All notable changes to **Google Messages Web Auto-Filter** (`gmessages-filter`) will be documented in this file.

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
