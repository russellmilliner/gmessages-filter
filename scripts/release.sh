#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

VERSION="$(python3 -c 'import json; print(json.load(open("extension/manifest.json"))["version"])')"
echo "Building Google Messages Auto-Filter v${VERSION}..."

node --check extension/content.js
node --check extension/background.js
node --check extension/sw.js
python3 -m py_compile src/server.py src/vip_alert_popup.py src/gmessages-filter
python3 -m json.tool extension/manifest.json > /dev/null

mkdir -p dist
rm -f dist/gmessages-filter.xpi
(
  cd extension
  zip -q -r ../dist/gmessages-filter.xpi manifest.json background.js sw.js content.js
)
sha256sum dist/gmessages-filter.xpi > dist/gmessages-filter.xpi.sha256

echo "[OK] Built dist/gmessages-filter.xpi (v${VERSION})"
