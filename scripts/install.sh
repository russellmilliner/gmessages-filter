#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHARE_DIR="$HOME/.local/share/gmessages-filter"
EXT_DIR="$SHARE_DIR/extension"
BIN_DIR="$HOME/.local/bin"
SYSTEMD_DIR="$HOME/.config/systemd/user"

mkdir -p "$SHARE_DIR" "$EXT_DIR" "$BIN_DIR" "$SYSTEMD_DIR"

cp -f "$REPO_DIR/src/server.py" "$SHARE_DIR/server.py"
cp -f "$REPO_DIR/src/vip_alert_popup.py" "$SHARE_DIR/vip_alert_popup.py"
chmod 755 "$SHARE_DIR/server.py" "$SHARE_DIR/vip_alert_popup.py"

cp -f "$REPO_DIR/src/gmessages-filter" "$BIN_DIR/gmessages-filter"
chmod 755 "$BIN_DIR/gmessages-filter"

cp -f "$REPO_DIR/extension/manifest.json" "$EXT_DIR/manifest.json"
cp -f "$REPO_DIR/extension/content.js" "$EXT_DIR/content.js"
cp -f "$REPO_DIR/extension/background.js" "$EXT_DIR/background.js"
cp -f "$REPO_DIR/extension/sw.js" "$EXT_DIR/sw.js"

(
  cd "$EXT_DIR"
  rm -f "$SHARE_DIR/gmessages-filter.xpi"
  zip -qr "$SHARE_DIR/gmessages-filter.xpi" manifest.json background.js sw.js content.js
)

cp -f "$REPO_DIR/systemd/gmessages-filter.service" "$SYSTEMD_DIR/gmessages-filter.service"
systemctl --user daemon-reload
systemctl --user enable --now gmessages-filter.service
systemctl --user restart gmessages-filter.service

echo "[OK] Installed gmessages-filter to $SHARE_DIR and restarted gmessages-filter.service"
