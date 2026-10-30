// Integration checks: spawn server.mjs on an ephemeral port with a temp data
// dir, then prove (1) vault secrets are encrypted at rest and never returned,
// (2) approval gate, (3) credential injection is traced without leaking,
// (4) site memory hints are learned then consulted, (5) interactive sessions + takeover.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const PORT = 18787;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(join(tmpdir(), "hygge-test-"));
const SECRET = "correct-horse-battery-staple-42";

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method, headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return [res.status, await res.json()];
}

const assert = (cond, msg) => { if (!cond) throw new Error(`ASSERT FAILED: ${msg}`); };

const proc = spawn("node", ["server.mjs"], {
  cwd: new URL(".", import.meta.url).pathname,
  env: { ...process.env, PORT: String(PORT), HYGGE_DATA_DIR: DATA,
         HYGGE_VAULT_KEY: randomBytes(32).toString("hex"), HYGGE_BROWSER: "simulated" },
  stdio: "pipe",
});

try {
  // wait for health
  for (let i = 0; i < 50; i++) {
    try { const [s, h] = await call("GET", "/health"); if (s === 200 && h.ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }

  // 1) Vault: store, verify encryption at rest + no secret in any response
  const [s1, cred] = await call("POST", "/credentials", { domain: "upwork.com", username: "sam@example.com", secret: SECRET });
  assert(s1 === 201 && cred.id && !JSON.stringify(cred).includes(SECRET), "credential create leaks secret");
  const vaultFile = readFileSync(join(DATA, "vault.json"), "utf8");
  assert(!vaultFile.includes(SECRET), "vault file contains plaintext secret");
  const [, list] = await call("GET", "/credentials");
  assert(list.credentials.length === 1 && !JSON.stringify(list).includes(SECRET), "credential list leaks secret");

  // 2) Approval gate: direct run refused, approve runs
  const [, task] = await call("POST", "/tasks", {
    kind: "apply", target_url: "https://www.upwork.com/jobs/123", goal: "Apply to this job",
    title: "Apply: video editor", drafted_payload: { coverLetter: "Hi!" }, credential_id: cred.id });
  assert(task.status === "awaiting_approval", "task should await approval");
  const [sRun] = await call("POST", `/tasks/${task.id}/run`, {});
  assert(sRun === 403, `direct run should be 403, got ${sRun}`);

  // 3) Approved run: credential injected (traced, redacted), skill learned
  const [sAppr, done] = await call("POST", `/tasks/${task.id}/approve`, {});
  assert(sAppr === 200 && done.status === "succeeded", "approved task should succeed");
  assert(JSON.stringify(done).includes("redacted"), "trace should note redacted credential injection");
  assert(!JSON.stringify(done).includes(SECRET), "task response leaks secret");
  assert((done.log ?? []).some((l) => l.includes("no memory yet")), "first run should start from the mission alone, no script/memory");
  const firstMemoryId = done.memory_id;
  assert(firstMemoryId, "exploration should create site memory");

  const [sAgain] = await call("POST", `/tasks/${task.id}/approve`, {});
  assert(sAgain === 409, "double approval should conflict");

  // 4) Second mission on the same domain consults (not replays) the memory
  const [, task2] = await call("POST", "/tasks", {
    kind: "apply", target_url: "https://www.upwork.com/jobs/456", goal: "Apply", title: "Apply: copywriter" });
  const [, done2] = await call("POST", `/tasks/${task2.id}/approve`, {});
  assert(done2.memory_id === firstMemoryId, "second run should update the same site memory");
  assert((done2.log ?? []).some((l) => l.includes("advisory memory hint")), "second run should consult hints as advice");
  const [, memRes] = await call("GET", "/memory");
  const memory = memRes.memories.find((m) => m.id === firstMemoryId);
  assert(memory && memory.domain === "upwork.com" && memory.successCount >= 2 &&
         Array.isArray(memory.hints) && memory.hints.length > 0 && !("steps" in memory),
    "site memory should hold advisory hints and outcomes, never replayable steps");

  // 5) Interactive session: open ANY url, act, human takeover
  const [sSess, sess] = await call("POST", "/sessions", { url: "https://some-local-pet-sitting-site.example/jobs" });
  assert(sSess === 201 && sess.sessionID && sess.elements.length > 0, "session should open any URL");
  const [, afterAct] = await call("POST", `/sessions/${sess.sessionID}/act`, { action: "click", target: "First listing card" });
  assert(afterAct.sessionID === sess.sessionID, "act should return snapshot");
  const [, taken] = await call("POST", `/sessions/${sess.sessionID}/act`, { action: "setHumanControl", value: "true" });
  assert(taken.humanControlled === true, "takeover should flip humanControlled");

  // 6) Site proposals for a pet-care user (offline/static path in this env)
  const [sProp, props] = await call("POST", "/site-proposals", { category: "petCare", locationLabel: "Leeds" });
  assert(sProp === 200 && props.proposals.length >= 3 &&
         props.proposals.every((x) => x.name && x.url.startsWith("https://")),
    "site proposals should return real candidate sites");

  // 7) Onboarding chat: suggestions must react to what the user said
  const [sOb, ob] = await call("POST", "/onboarding/message", {
    step: "skills", profile: {},
    transcript: [{ fromAgent: true, text: "What kinds of work?" },
                 { fromAgent: false, text: "I love dogs and I edit TikTok videos on weekends" }] });
  assert(sOb === 200 && typeof ob.reply === "string" && ob.reply.length > 0, "onboarding should reply");
  assert(ob.suggestedSkills.some((x) => /dog/i.test(x)) && ob.suggestedSkills.some((x) => /video/i.test(x)),
    "skill suggestions should be tailored to the user's words, not a static list");

  console.log("PASS: vault encryption, approval gate, redacted injection, mission loop + memory hints, interactive session, site proposals, tailored onboarding");
} finally {
  proc.kill("SIGTERM");
}
