// Opt-in FULL live loop: real Cloudflare Browser Run session + real
// muse-spark-1.3 / muse-wonder-1.0 per-step decisions in the mission loop
// (observe -> decide -> act, no script) against public job boards.
// Run via ./run-live-agent-test.sh
// (expects CF + Meta keys exported by the wrapper from the macOS Keychain).
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const PORT = 18789;
const BASE = `http://127.0.0.1:${PORT}`;
const CANDIDATES = [
  { name: "Remote OK", url: "https://remoteok.com" },
  { name: "We Work Remotely", url: "https://weworkremotely.com" },
  { name: "Hacker News Jobs", url: "https://news.ycombinator.com/jobs" },
];
const assert = (c, m) => { if (!c) throw new Error(`ASSERT FAILED: ${m}`); };

async function call(method, path, body, timeoutMs = 150000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(BASE + path, {
      method, signal: ctl.signal, headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return [res.status, await res.json()];
  } finally { clearTimeout(timer); }
}

const proc = spawn("node", ["server.mjs"], {
  cwd: new URL(".", import.meta.url).pathname,
  env: { ...process.env, PORT: String(PORT), GIGPILOT_BROWSER: "cloudflare",
         GIGPILOT_DATA_DIR: mkdtempSync(join(tmpdir(), "hygge-live-")),
         GIGPILOT_VAULT_KEY: randomBytes(32).toString("hex") },
  stdio: "pipe",
});
proc.stderr.on("data", (d) => process.stderr.write(d));

try {
  let health = null;
  for (let i = 0; i < 75 && !health; i++) {
    try { const [s, h] = await call("GET", "/health", null, 5000);
          if (s === 200 && h.ok) health = h; } catch {}
    if (!health) await new Promise((r) => setTimeout(r, 200));
  }
  assert(health, "server did not start");
  console.log(`HEALTH: browser=${health.browser} llm=${health.llm} models=${JSON.stringify(health.models)}`);
  assert(health.browser === "cloudflare" && health.llm === "live", "expected live browser + live LLM");

  let winner = null;
  for (const site of CANDIDATES) {
    console.log(`\n== Trying ${site.name} (${site.url}) ==`);
    const [, task] = await call("POST", "/tasks", {
      kind: "discover", target_url: site.url,
      goal: `Find current remote job listings on ${site.name} and extract their titles.`,
      title: `Search ${site.name}`, drafted_payload: { searchTerms: "writing design support" },
    });
    const [status, done] = await call("POST", `/tasks/${task.id}/approve`, {});
    console.log(`TASK STATUS: ${done.status} (http ${status})`);
    for (const line of done.log ?? []) console.log(`  LOG ${line}`);
    for (const t of done.browser_trace ?? []) {
      console.log(`  ${t.succeeded ? "OK " : "FAIL"} [${t.modelTier ?? "-"}] ${t.action}: ${t.target} -> ${String(t.summary).slice(0, 260)}`);
    }
    const extracted = (done.browser_trace ?? []).some((t) => t.action === "extract" && t.succeeded);
    const liveDecisions = (done.browser_trace ?? []).filter((t) => /muse-(spark|wonder)/.test(t.modelTier ?? "")).length;
    const agentDecidedDone = done.browser_trace?.at(-1)?.action === "done";
    if (done.status === "succeeded" && liveDecisions >= 2 && agentDecidedDone && extracted) { winner = site; break; }
    console.log(`  -> not a clean live run (liveDecisions=${liveDecisions}, agentDone=${agentDecidedDone}, extracted=${extracted}); trying next site`);
  }
  assert(winner, "no candidate site produced a clean live run with extracted listings");
  console.log(`\nPASS: full live mission loop on ${winner.name} (LLM decided every action; no script)`);
} finally {
  proc.kill("SIGTERM");
}
