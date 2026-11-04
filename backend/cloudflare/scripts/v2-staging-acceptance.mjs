#!/usr/bin/env node
// Retained-workspace V2 staging acceptance (dispatch-only CI).
//
// Mints two ephemeral staging users + sessions directly in D1
// (the same users/auth_sessions rows real sign-in writes; only
// token hashes are stored), drives the deployed staging API as
// those users, and prints one ACCEPT line per gate. Gates that
// cannot be observed from the public API are printed UNOBSERVED —
// never inferred as passed. Sessions and users are deleted at the
// end; the two Durable Objects (and any container/checkpoints
// they created) remain as named staging residue.
//
// Requires CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID in env and
// wrangler on PATH (run from backend/cloudflare after `npm ci`).
// Staging only: every target is pinned below.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";

const API = "https://api-staging.usehygge.app";
const WAVE4 = "https://hygge-wave4-jobs.lemberg-89a.workers.dev";
const DB = "hygge-staging";
const runId = Date.now().toString(36);
let failures = 0;

function report(name, result, detail = "") {
  if (result === "FAIL") failures += 1;
  console.log(`ACCEPT ${name} ${result}${detail ? ` ${detail}` : ""}`);
}

function d1(sql) {
  const out = execFileSync("npx", [
    "wrangler", "d1", "execute", DB, "-c", "wrangler.staging.jsonc",
    "--remote", "--command", sql,
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const start = out.indexOf("[");
  return start >= 0 ? JSON.parse(out.slice(start)) : [];
}

function ephemeralUser(label) {
  const userId = randomUUID();
  const token = randomBytes(32).toString("base64url");
  console.log(`::add-mask::${token}`);
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const now = new Date();
  const expires = new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString();
  d1(`INSERT INTO users (id, do_instance, contact_email) VALUES ('${userId}', '${userId}', 'acceptance-${runId}-${label}@example.invalid')`);
  d1(`INSERT INTO auth_sessions (id, user_id, token_hash, created_at, expires_at) VALUES ('${randomUUID()}', '${userId}', '${tokenHash}', '${now.toISOString()}', '${expires}')`);
  return { userId, token };
}

async function api(path, { token, method = "GET", body, timeoutMs = 30000 } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON stays null */ }
  return { status: res.status, json, text: text.slice(0, 300) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let users = [];
try {
  // 1. Deployed mode, read from outside.
  const health = await api("/health");
  report("health-mode",
    health.json?.workspace === "retained-v2" && health.json?.jobs === "queued" ? "PASS" : "FAIL",
    `workspace=${health.json?.workspace} jobs=${health.json?.jobs}`);

  // 2. The diagnostics route is not public.
  const unauth = await api("/sandbox/verify");
  report("sandbox-verify-requires-auth", unauth.status === 401 ? "PASS" : "FAIL", `status=${unauth.status}`);

  users = [ephemeralUser("a"), ephemeralUser("b")];
  const [a, b] = users;

  // 3. Fresh users provision a retained workspace (container +
  // registry + checkpoints) on first verify.
  for (const [label, u] of [["a", a], ["b", b]]) {
    try {
      const v = await api("/sandbox/verify", { token: u.token, timeoutMs: 300000 });
      report(`fresh-verify-${label}`,
        v.status === 200 && v.json?.mode === "retained-v2" ? "PASS" : "FAIL",
        `status=${v.status} mode=${v.json?.mode ?? v.text}`);
    } catch (e) {
      report(`fresh-verify-${label}`, "FAIL", String(e?.message ?? e).slice(0, 160));
    }
  }

  // 4. Task isolation: A's draft is invisible to B.
  const marker = `acceptance-${runId}`;
  const created = await api("/tasks", {
    token: a.token, method: "POST",
    body: {
      kind: "discover", target_url: `${WAVE4}/listings`,
      goal: "List the synthetic job listings.", title: marker,
      drafted_payload: {}, interaction_version: 1,
    },
  });
  const aTasks = await api("/tasks", { token: a.token });
  const bTasks = await api("/tasks", { token: b.token });
  const titles = (r) => (r.json?.tasks ?? []).map((t) => String(t.title ?? ""));
  report("task-isolation",
    created.status === 201 && titles(aTasks).includes(marker) && !titles(bTasks).includes(marker)
      ? "PASS" : "FAIL",
    `create=${created.status} aSees=${titles(aTasks).includes(marker)} bSees=${titles(bTasks).includes(marker)}`);

  // 5. Checkpoint save round-trips and verify still passes after.
  try {
    const save = await api("/sandbox/save", { token: a.token, method: "POST", body: {}, timeoutMs: 300000 });
    const again = await api("/sandbox/verify", { token: a.token, timeoutMs: 300000 });
    report("checkpoint-save",
      save.status === 200 && typeof save.json?.receiptId === "string" && again.status === 200 ? "PASS" : "FAIL",
      `save=${save.status} receipt=${typeof save.json?.receiptId} reverify=${again.status}`);
  } catch (e) {
    report("checkpoint-save", "FAIL", String(e?.message ?? e).slice(0, 160));
  }

  // 6. Wave 4 apply: the one reviewed postcondition in staging.
  // Runs through the durable job queue exactly like a user
  // approval; completion must be earned by the observed success
  // page, not the model's word.
  try {
    const draft = await api("/tasks", {
      token: a.token, method: "POST",
      body: {
        kind: "apply", target_url: `${WAVE4}/apply`,
        goal: "Submit the application using the drafted cover text.",
        title: `${marker}-apply`, interaction_version: 1,
        drafted_payload: {
          coverLetter: "Synthetic acceptance application. No real account or employer is involved.",
          listingURL: `${WAVE4}/jobs/1`,
        },
      },
    });
    const taskId = draft.json?.id;
    if (draft.status !== 201 || !taskId) throw new Error(`draft status=${draft.status}`);
    const approved = await api(`/tasks/${taskId}/approve`, { token: a.token, method: "POST", body: {} });
    if (approved.status !== 200) throw new Error(`approve status=${approved.status}`);
    let final = null;
    for (let i = 0; i < 72 && !final; i += 1) {
      await sleep(10000);
      const list = await api("/tasks", { token: a.token });
      const row = (list.json?.tasks ?? []).find((t) => t.id === taskId);
      if (row && ["succeeded", "failed", "needsHuman", "rejected"].includes(String(row.status))) final = row;
    }
    report("wave4-apply-completion",
      final?.status === "succeeded" ? "PASS" : "FAIL",
      final ? `status=${final.status} help=${final.help?.kind ?? "none"}` : "no terminal status in 12m");
  } catch (e) {
    report("wave4-apply-completion", "FAIL", String(e?.message ?? e).slice(0, 160));
  }

  // 7. Quarantine refuses an unauthorized caller (negative gate;
  // the positive path needs a published skill — see UNOBSERVED).
  const q = await api("/skills/quarantine", {
    token: a.token, method: "POST",
    body: { operationId: `acceptance-${runId}`, skillId: "acceptance-nonexistent", reason: "integrity" },
  });
  report("quarantine-requires-maintainer", q.status === 403 ? "PASS" : "FAIL", `status=${q.status}`);
} finally {
  for (const u of users) {
    try {
      d1(`DELETE FROM auth_sessions WHERE user_id = '${u.userId}'`);
      d1(`DELETE FROM users WHERE id = '${u.userId}'`);
    } catch { /* residue is named and staging-only; report below */ }
  }
}

report("retention-exact-restore", "UNOBSERVED", "needs provider destroy/restart control, not exposed via API");
report("loss-midrun-resume", "UNOBSERVED", "needs fault injection during a live mission");
report("quarantine-positive", "UNOBSERVED", "needs a published skill (3 confirming runs) and the maintainer secret");
console.log(`ACCEPT-SUMMARY failures=${failures} run=${runId}`);
process.exit(failures ? 1 : 0);
