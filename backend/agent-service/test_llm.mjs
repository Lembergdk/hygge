// Tier routing for mission-loop decisions + decision parsing (no network).
import { selectTier, parseDecision } from "./llm.mjs";

const assert = (c, m) => { if (!c) throw new Error(`ASSERT FAILED: ${m}`); };
delete process.env.MUSE_SPARK_MODEL;
delete process.env.MUSE_WONDER_MODEL;

let d = selectTier({ taskKind: "discover" });
assert(d.tier === "spark" && d.model === "muse-spark-1.3", "routine decision should use muse-spark-1.3");

d = selectTier({ taskKind: "discover", failures: 1 });
assert(d.tier === "wonder" && d.model === "muse-wonder-1.0", "failed action should escalate to wonder");

d = selectTier({ taskKind: "discover", repeatedAction: true });
assert(d.tier === "wonder", "looping should escalate to wonder");

d = selectTier({ taskKind: "apply", isFinalSubmit: true });
assert(d.tier === "wonder", "final submit on apply should use wonder");

d = selectTier({ taskKind: "apply", drafting: true });
assert(d.tier === "wonder", "drafting user-facing text should use wonder");

d = selectTier({ taskKind: "apply" });
assert(d.tier === "spark", "ordinary mid-mission apply steps stay on spark");

const parsed = parseDecision('Sure! ```json\n{"action":"click","target":"Log in"}\n```');
assert(parsed?.action === "click" && parsed?.target === "Log in", "decision JSON should parse through fences/prose");
assert(parseDecision("no json here") === null, "non-JSON should parse to null");

console.log("PASS: spark-by-default routing, wonder escalation, tolerant decision parsing");
