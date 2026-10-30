#!/bin/sh
# Runs the live Cloudflare Browser Run check. The API token is read from the
# macOS Keychain at runtime ("Muse Cloudflare Token") and never written to
# disk. The account ID is auto-discovered from the API.
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

node test_live.mjs
