// Staging end-to-end checks. Usage:
//   node e2e-staging.mjs            (tokens from /tmp/hygge_staging_tokens.json)
// Covers: health, auth, two-user isolation, vault canary, approval
// gate 403, live onboarding (+SSE), site proposals, a real Browser
// Run discover mission, memory hints, snapshot save/restore.
import { readFileSync } from "node:fs";

const BASE = process.env.HYGGE_BASE ?? "https://api-staging.usehygge.app";
const tokens = JSON.parse(readFileSync(process.env.HYGGE_TOKENS ?? "/tmp/hygge_staging_tokens.json", "utf8"));
const [tokenA, tokenB] = Object.keys(tokens);
const CANARY = "canary-secret-9f27c-never-print-me";
const LEAKED = [];
let failures = 0;

function scan(text, where) {
  if (String(text).includes(CANARY)) LEAKED.push(where);
}
function check(name, ok, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);
  if (!ok) failures++;
}
async function call(token, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  scan(text, `${method} ${path}`);
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {}
  return { status: res.status, body: parsed, text };
}

console.log(`E2E against ${BASE}`);

const health = await call(null, "GET", "/health");
check("health ok", health.status === 200 && health.body?.ok === true);

const unauth = await call(null, "GET", "/credentials");
check("unauthenticated -> 401", unauth.status === 401);

// Vault: user A stores a canary; only metadata comes back.
const add = await call(tokenA, "POST", "/credentials", { domain: "example-sitters.test", username: "sam@example.com", secret: CANARY });
check("credential add 201, metadata only", add.status === 201 && add.body?.id && !("secret" in (add.body ?? {})));
const listA = await call(tokenA, "GET", "/credentials");
check("user A lists 1 credential", listA.body?.credentials?.length >= 1);
const listB = await call(tokenB, "GET", "/credentials");
check("user B sees none of A's credentials (isolation)", listB.body?.credentials?.length === 0);

// Onboarding (live LLM) + SSE stream.
const onb = await call(tokenA, "POST", "/onboarding/message", {
  step: "enjoyWork",
  transcript: [{ fromAgent: false, text: "I love dogs and I'm free on weekends" }],
  profile: {},
});
check("onboarding reply generated", onb.status === 200 && typeof onb.body?.reply === "string" && onb.body.reply.length > 0,
  `simulated=${onb.body?.simulated}`);

const sse = await fetch(`${BASE}/onboarding/stream`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${tokenA}` },
  body: JSON.stringify({ step: "lowestRate", transcript: [], profile: {} }),
});
const sseText = await sse.text();
scan(sseText, "onboarding/stream");
check("onboarding SSE streams deltas + final", sse.status === 200 && sseText.includes('"reply-delta"') && sseText.includes('"final"'));

// Site proposals.
const proposals = await call(tokenA, "POST", "/site-proposals", { category: "petCare", locationLabel: "Austin", interests: ["petCare"] });
check("site proposals returned", proposals.status === 200 && proposals.body?.proposals?.length > 0,
  `${proposals.body?.proposals?.length} proposals`);

// Approval gate: write task cannot /run (403), can be rejected.
const writeTask = await call(tokenA, "POST", "/tasks", {
  kind: "signup", target_url: "https://example-sitters.test", goal: "Create an account", title: "Join test site",
});
check("write task awaits approval", writeTask.status === 201 && writeTask.body?.status === "awaiting_approval" && writeTask.body?.requires_approval === true);
const gateRes = await call(tokenA, "POST", `/tasks/${writeTask.body.id}/run`, {});
check("approval gate: /run on write task -> 403", gateRes.status === 403);
const crossUser = await call(tokenB, "POST", `/tasks/${writeTask.body.id}/approve`, {});
check("user B cannot touch A's task (404 in B's sandbox)", crossUser.status === 404);
const reject = await call(tokenA, "POST", `/tasks/${writeTask.body.id}/reject`, {});
check("task reject works", reject.status === 200 && reject.body?.status === "rejected");

// Real mission: discover on a public page via Browser Run + LLM.
console.log("running live discover mission (may take a minute)…");
const task = await call(tokenA, "POST", "/tasks", {
  kind: "discover", target_url: "https://example.org", goal: "Look at this page and extract any listings or links", title: "Look at example.org",
});
check("discover task created (no approval needed)", task.status === 201 && task.body?.requires_approval === false);
const run = await call(tokenA, "POST", `/tasks/${task.body.id}/run`, {});
const traceLen = run.body?.browser_trace?.length ?? 0;
check("mission ran with a real trace", run.status === 200 && traceLen > 0,
  `status=${run.body?.status}, steps=${traceLen}, first tier=${run.body?.browser_trace?.[0]?.modelTier ?? "?"}`);

const memory = await call(tokenA, "GET", "/memory");
check("memory endpoint works", memory.status === 200 && Array.isArray(memory.body?.memories));

// Snapshot save -> restore path.
const save = await call(tokenA, "POST", "/sandbox/save", {});
check("snapshot saved", save.status === 200 && Boolean(save.body?.snapshotId));
const verify = await call(tokenA, "GET", "/sandbox/verify");
check("sandbox restores and executes after save", verify.status === 200 && String(verify.body?.stdout ?? "").includes("Linux"));

check("canary secret never appeared in any response", LEAKED.length === 0, LEAKED.join(", "));

console.log(failures === 0 ? "\nALL E2E CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures ? 1 : 0);
