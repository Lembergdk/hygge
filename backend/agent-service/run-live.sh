#!/bin/sh
# Starts the agent service with the LIVE Cloudflare Browser Run worker.
# Token: read from macOS Keychain ("Muse Cloudflare Token") at runtime,
# never written to disk. Account ID: auto-discovered. Vault key: read from
# keychain item "Hygge Vault Key" if present, else ephemeral (dev only).
set -eu
cd "$(dirname "$0")"

CF_API_TOKEN=$(security find-generic-password -s "Muse Cloudflare Token" -w)
export CF_API_TOKEN
if [ -z "${CF_ACCOUNT_ID:-}" ]; then
  CF_ACCOUNT_ID=$(curl -s -H "Authorization: Bearer $CF_API_TOKEN" \
    https://api.cloudflare.com/client/v4/accounts | \
    python3 -c "import json,sys; print(json.load(sys.stdin)['result'][0]['id'])")
  export CF_ACCOUNT_ID
fi
if VAULT_KEY=$(security find-generic-password -s "Hygge Vault Key" -w 2>/dev/null); then
  export GIGPILOT_VAULT_KEY="$VAULT_KEY"
fi
# Optional: Meta Model API key (dev.meta.ai) for live muse-spark-1.3 / muse-wonder-1.0
if LLM_KEY=$(security find-generic-password -s "Muse Meta Model API Key" -w 2>/dev/null) || \
   LLM_KEY=$(security find-generic-password -s "Muse Meta Model API key" -w 2>/dev/null); then
  export MUSE_LLM_API_KEY="$LLM_KEY"
fi
# LAN=1 ./run-live.sh  -> reachable from a phone on the same Wi-Fi.
# Requires (and prints) an API token; paste URL + token into the app's
# Agent service settings. The server refuses non-loopback without a token.
if [ "${LAN:-}" = "1" ]; then
  export HOST=0.0.0.0
  if [ -z "${GIGPILOT_API_TOKEN:-}" ]; then
    GIGPILOT_API_TOKEN=$(openssl rand -hex 16); export GIGPILOT_API_TOKEN
  fi
  IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "<this-mac-ip>")
  echo "LAN mode: in the Hygge app (server icon) set Base URL to http://$IP:8787"
  echo "LAN mode: API token to paste: $GIGPILOT_API_TOKEN"
fi
export GIGPILOT_BROWSER=cloudflare

exec node server.mjs
