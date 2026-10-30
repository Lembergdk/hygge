// SSE onboarding stream checks (offline simulated streaming + extractor units).
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { ReplyStreamExtractor } from "./onboarding.mjs";

const assert = (c, m) => { if (!c) throw new Error(`ASSERT FAILED: ${m}`); };

// Extractor: chunk boundaries, escapes, content after reply ignored.
{
  const ex = new ReplyStreamExtractor();
  let out = "";
  out += ex.push('{"rep');
  out += ex.push('ly":"Hi \\"Sam\\"\\nwel');
  out += ex.push('come \\u2014 friend","extracted":{}}');
  assert(out === 'Hi "Sam"\nwelcome — friend', `extractor decoded wrongly: ${JSON.stringify(out)}`);
  assert(ex.done, "extractor should finish at closing quote");
}

// Full SSE round-trip against a spawned (simulated) server.
const PORT = 18791;
const proc = spawn("node", ["server.mjs"], {
  cwd: new URL(".", import.meta.url).pathname,
  env: { ...process.env, PORT: String(PORT), HYGGE_DATA_DIR: mkdtempSync(join(tmpdir(), "gp-stream-")),
         HYGGE_VAULT_KEY: randomBytes(32).toString("hex") },
  stdio: "pipe",
});
delete process.env.MUSE_LLM_API_KEY;
try {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/health`); if (r.ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 120));
  }
  const res = await fetch(`http://127.0.0.1:${PORT}/onboarding/stream`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ step: "welcome", transcript: [], profile: {} }),
  });
  assert(res.headers.get("content-type")?.includes("text/event-stream"), "must respond with SSE");
  const raw = await res.text();
  const events = raw.split("\n\n").filter(Boolean).map((l) => JSON.parse(l.replace(/^data: /, "")));
  const deltas = events.filter((e) => e.type === "reply-delta").map((e) => e.text).join("");
  const final = events.find((e) => e.type === "final");
  assert(final?.data?.reply, "stream must end with a final event");
  assert(deltas === final.data.reply, "streamed deltas must reassemble into the final reply");
  assert(events.filter((e) => e.type === "reply-delta").length > 3, "reply must arrive incrementally");
  console.log("PASS: reply extractor (boundaries/escapes) + SSE deltas reassemble to final");
} finally {
  proc.kill("SIGTERM");
}
