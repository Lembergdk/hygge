#!/usr/bin/env node
// Synthetic intent interpretation only. Never approves, joins or browses a site.
// Uses one temporary staging auth session; deletes all test rows and auth in finally.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";

const API = "https://api-staging.usehygge.app";
const userID = randomUUID();
const token = randomBytes(32).toString("base64url");
console.log(`::add-mask::${token}`);
const sql = (command) => execFileSync("npx", ["wrangler", "d1", "execute", "hygge-staging",
  "-c", "wrangler.staging.jsonc", "--remote", "--command", command],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const rows = [];
async function api(path, body, method = "POST") {
  const response = await fetch(`${API}${path}`, { method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(90000) });
  assert.equal(response.status, 200, `${path}: status=${response.status}`);
  return response.json();
}
try {
  sql(`INSERT INTO users (id, do_instance, contact_email) VALUES ('${userID}', '${userID}', 'chat-acceptance-${userID}@example.invalid')`);
  const hash = createHash("sha256").update(token).digest("hex");
  sql(`INSERT INTO auth_sessions (id, user_id, token_hash, created_at, expires_at) VALUES ('${randomUUID()}', '${userID}', '${hash}', '${new Date().toISOString()}', '${new Date(Date.now() + 1800000).toISOString()}')`);
  for (const [id, name] of [["contra.com", "Contra"], ["toptal.com", "Toptal"]]) {
    await api(`/sites/${id}`, { id, name, startURLString: `https://${id}`, category: "freelance" });
    rows.push(`/sites/${id}`);
    const proposalID = randomUUID();
    await api(`/proposals/${proposalID}`, { id: proposalID, siteID: id, status: "proposed" });
    rows.push(`/proposals/${proposalID}`);
  }
  const context = { sites: [
    { id: "rover", name: "Rover", domain: "rover.com", state: "watching" }
  ], inbox: [], paused: true };
  const intent = (transcript) => api("/onboarding/intent", {
    transcript, profile: { interests: ["freelance"], skills: ["software engineering"] }, context
  });
  const both = await intent([{ fromAgent: false, text: "I'd like to add Contra and Toptal." },
    { fromAgent: true, text: "Would you like me to add both?" }, { fromAgent: false, text: "Both" }]);
  assert.equal(both.simulated, false);
  assert.deepEqual(both.actions?.map((a) => [a.kind, a.domain]), [["add", "contra.com"], ["add", "toptal.com"]]);
  console.log("ACCEPT both-sites PASS");
  const mixed = await intent([{ fromAgent: false, text: "Resume scanning, then scan Rover for work." }]);
  assert.deepEqual(mixed.actions?.map((a) => a.kind), ["resume", "scan"]);
  assert.equal(mixed.actions?.[1]?.siteId, "rover");
  console.log("ACCEPT mixed-resume-scan PASS");
  const confirm = await intent([{ fromAgent: false, text: "Scan Rover, then approve the waiting draft." }]);
  assert.deepEqual(confirm.actions?.map((a) => a.kind), ["scan", "approve"]);
  console.log("ACCEPT mixed-scan-approve-intent PASS (execution confirmation covered by core tests)");
} finally {
  let cleanupFailed = false;
  for (const path of rows.reverse()) {
    try { await api(path, undefined, "DELETE"); } catch { cleanupFailed = true; console.error(`Cleanup failed: ${path}`); }
  }
  try { sql(`DELETE FROM auth_sessions WHERE user_id = '${userID}'; DELETE FROM users WHERE id = '${userID}'`); }
  catch { cleanupFailed = true; console.error(`Auth cleanup failed: ${userID}`); }
  if (cleanupFailed) process.exitCode = 1;
  console.log(`ACCEPT cleanup ${cleanupFailed ? "FAIL" : "PASS"} user=${userID} (empty Durable Object may remain)`);
}
