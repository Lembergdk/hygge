// One-off APNs test send (used by .github/workflows/apns-test-send.yml).
//
// Reads the newest registered device token from the environment's D1
// (via wrangler, inside CI where the deployment credentials live),
// mints a provider JWT from the HYGGE_APNS_KEY_P8 GitHub secret, and
// POSTs one alert to Apple's host for that environment. The token is
// masked and never printed; only the APNs HTTP status and reason are.
//
// Usage (from backend/cloudflare, with CLOUDFLARE_* env set):
//   APNS_ENV=production node scripts/apns-test-send.mjs
//   APNS_ENV=staging    node scripts/apns-test-send.mjs
import { execFileSync } from "node:child_process";
import { createSign } from "node:crypto";
import { connect } from "node:http2";

const ENVS = {
  staging: { db: "hygge-staging", config: "wrangler.staging.jsonc", host: "api.sandbox.push.apple.com" },
  production: { db: "hygge-production", config: "wrangler.production.jsonc", host: "api.push.apple.com" },
};
const envName = process.env.APNS_ENV || "production";
const cfg = ENVS[envName];
if (!cfg) { console.error(`APNS_ENV must be staging|production, got ${envName}`); process.exit(2); }

const KEY_ID = process.env.HYGGE_APNS_KEY_ID || "P7AKJ8SZL4";
const TEAM_ID = process.env.HYGGE_APNS_TEAM_ID || "3KA38L8A4F";
const TOPIC = process.env.HYGGE_APPLE_BUNDLE_ID || "app.usehygge";
const p8 = process.env.HYGGE_APNS_KEY_P8 || "";
if (!p8.trim()) { console.error("HYGGE_APNS_KEY_P8 secret is empty"); process.exit(2); }

// --- newest device token (never printed) -----------------------------------
// APNS_DEVICE_TOKEN bypasses the D1 lookup (local JWT/transport checks
// against a fake token expect 400 BadDeviceToken).
const out = process.env.APNS_DEVICE_TOKEN ? null : execFileSync(
  "npx",
  ["wrangler", "d1", "execute", cfg.db, "-c", cfg.config, "--remote", "--json",
   "--command", "SELECT token FROM device_tokens ORDER BY updated_at DESC LIMIT 1"],
  { encoding: "utf8" },
);
const parsed = out ? JSON.parse(out.slice(out.indexOf("["))) : null;
const token = process.env.APNS_DEVICE_TOKEN || parsed?.[0]?.results?.[0]?.token;
if (!token) {
  console.log(`NO-TOKEN: no registered device tokens in ${envName} yet — open the app signed in, allow notifications, then re-run.`);
  process.exit(3);
}
console.log(`::add-mask::${token}`);
console.log(`Found newest ${envName} device token (masked, ${token.length} hex chars).`);

// --- provider JWT (ES256) ----------------------------------------------------
const b64 = (buf) => Buffer.from(buf).toString("base64url");
const head = b64(JSON.stringify({ alg: "ES256", kid: KEY_ID }));
const claims = b64(JSON.stringify({ iss: TEAM_ID, iat: Math.floor(Date.now() / 1000) }));
const signer = createSign("SHA256");
signer.update(`${head}.${claims}`);
const sig = signer.sign({ key: p8, dsaEncoding: "ieee-p1363" }, "base64url");
const jwt = `${head}.${claims}.${sig}`;

// --- send ---------------------------------------------------------------------
const payload = {
  aps: { alert: { title: "Hygge push test", body: "If you can read this, APNs delivery works." }, sound: "default" },
  hyggeKind: "needs_you",
  hyggeRef: null,
  hyggeRoute: "home",
};
// APNs requires HTTP/2 (undici fetch would negotiate HTTP/1.1).
const { status, text } = await new Promise((resolve, reject) => {
  const client = connect(`https://${cfg.host}`);
  client.on("error", reject);
  const req = client.request({
    ":method": "POST",
    ":path": `/3/device/${token}`,
    authorization: `bearer ${jwt}`,
    "apns-topic": TOPIC,
    "apns-push-type": "alert",
    "apns-priority": "10",
    "content-type": "application/json",
  });
  let code = 0;
  let body = "";
  req.on("response", (headers) => { code = headers[":status"]; });
  req.setEncoding("utf8");
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => { client.close(); resolve({ status: code, text: body }); });
  req.on("error", reject);
  req.end(JSON.stringify(payload));
});
console.log(`APNS-RESULT env=${envName} host=${cfg.host} status=${status} body=${text || "(empty)"}`);
process.exit(status === 200 ? 0 : 1);
