#!/bin/sh
# Full live-loop check: Cloudflare Browser Run + Meta Model API planner.
# Secrets are read from the macOS Keychain at runtime, never written to disk:
#   "Muse Cloudflare Token", "Muse Meta Model API key" (either K casing)
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
if ! MUSE_LLM_API_KEY=$(security find-generic-password -s "Muse Meta Model API key" -w 2>/dev/null); then
  MUSE_LLM_API_KEY=$(security find-generic-password -s "Muse Meta Model API Key" -w)
fi
export MUSE_LLM_API_KEY

node test_live_agent.mjs
