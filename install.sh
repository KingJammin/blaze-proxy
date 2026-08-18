#!/usr/bin/env bash
# Blaze Proxy installer
#   curl -fsSL https://raw.githubusercontent.com/KingJammin/blaze-proxy/main/install.sh | bash
# Headless (no Electron download):
#   curl -fsSL https://raw.githubusercontent.com/KingJammin/blaze-proxy/main/install.sh | BLAZE_HEADLESS=1 bash
set -euo pipefail

REPO="github:KingJammin/blaze-proxy"

if ! command -v node >/dev/null 2>&1; then
  echo "blaze-proxy needs Node.js 20+."
  if command -v brew >/dev/null 2>&1; then
    echo "Installing node via Homebrew..."
    brew install node
  else
    echo "Install Node.js first (https://nodejs.org or 'brew install node'), then re-run."
    exit 1
  fi
fi

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Node.js 20+ required (found $(node --version))."
  exit 1
fi

echo "Installing blaze-proxy from ${REPO}..."
if [ "${BLAZE_HEADLESS:-0}" = "1" ]; then
  npm install -g "$REPO" --omit=optional
else
  npm install -g "$REPO"
fi

echo
echo "Installed: $(blaze-proxy --version 2>/dev/null || echo blaze-proxy)"
echo
echo "Next steps:"
echo "  blaze-proxy start          # run the proxy (foreground; use launchd/systemd to daemonize)"
echo "  blaze-proxy app            # open the desktop UI"
echo "  blaze-proxy status         # check state"
echo
echo "Point your AI clients at:  http://127.0.0.1:8789/v1"
echo "Config lives at:           ~/.blaze-proxy/config.json"
echo "Endpoint default:          https://homeai.benpelo.com/v1"
echo "Endpoint API key:          set BLAZE_ENDPOINT_KEY env, or macOS keychain item"
echo "                           (service: homeai.benpelo.com) — see README."
