// Opt-in LIVE check against Cloudflare Browser Run (real isolated Chrome).
// Not part of the offline suite. Run via: ./run-live-test.sh
// Requires env: CF_ACCOUNT_ID, CF_API_TOKEN, GIGPILOT_BROWSER=cloudflare,
// and the playwright-core package.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

const PORT = 18788;
const BASE = `http://127.0.0.1:${PORT}`;
const assert = (c, m) => { if (!c) throw new Error(`ASSERT FAILED: ${m}`); };

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method, headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return [res.status, await res.json()];
}

const proc = spawn("node", ["server.mjs"], {
  cwd: new URL(".", import.meta.url).pathname,
  env: { ...process.env, PORT: String(PORT), GIGPILOT_BROWSER: "cloudflare",
         GIGPILOT_VAULT_KEY: randomBytes(32).toString("hex") },
  stdio: "pipe",
});
proc.stderr.on("data", (d) => process.stderr.write(d));

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try { const [s, h] = await call("GET", "/health"); up = s === 200 && h.ok && h.browser === "cloudflare"; } catch {}
    if (!up) await new Promise((r) => setTimeout(r, 200));
  }
  assert(up, "server did not come up in cloudflare mode");

  const [sSess, sess] = await call("POST", "/sessions", { url: "https://example.com" });
  assert(sSess === 201, `session create failed (${sSess}): ${JSON.stringify(sess).slice(0, 200)}`);
  assert(/example/i.test(sess.title), `unexpected page title: ${sess.title}`);
  assert(sess.elements.length > 0, "no elements extracted from live page");
  assert(sess.screenshotBase64 && sess.screenshotBase64.length > 1000, "no live screenshot returned");
  console.log(`LIVE SESSION OK: title="${sess.title}", elements=${sess.elements.length}, screenshot=${sess.screenshotBase64.length} b64 chars`);

  const [sAct, after] = await call("POST", `/sessions/${sess.sessionID}/act`,
    { action: "navigate", value: "https://example.org" });
  assert(sAct === 200 && /example\.org/.test(after.currentURLString), "live navigation failed");
  console.log(`LIVE NAVIGATION OK: now at ${after.currentURLString}`);

  await call("DELETE", `/sessions/${sess.sessionID}`);
  console.log("PASS: live Cloudflare Browser Run session + navigation");
} finally {
  proc.kill("SIGTERM");
}
