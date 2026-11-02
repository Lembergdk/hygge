// Unit tests for the ported pure logic. Run: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectTier, parseDecision, llmRequestHeaders, type LLMConfig } from "../src/llm.ts";
import { generateDEK, wrapDEK, unwrapDEK, seal, open, masterKey } from "../src/vault.ts";
import { ReplyStreamExtractor, heuristicSuggestions } from "../src/onboarding.ts";
import { distillHints } from "../src/agent.ts";

const CFG: LLMConfig = { baseUrl: "https://api.meta.ai/v1", modelFast: "muse-spark-1.3", modelStrong: "muse-wonder-1.0" };

test("tier routing: routine spark, failures escalate", () => {
  assert.equal(selectTier(CFG, { taskKind: "discover" }).model, "muse-spark-1.3");
  assert.equal(selectTier(CFG, { taskKind: "discover", failures: 1 }).tier, "wonder");
  assert.equal(selectTier(CFG, { repeatedAction: true }).tier, "wonder");
  assert.equal(selectTier(CFG, { taskKind: "signup", isFinalSubmit: true }).tier, "wonder");
  assert.equal(selectTier(CFG, { taskKind: "discover", isFinalSubmit: true }).tier, "spark");
});

test("gateway headers: direct calls unchanged, gateway calls fail closed on payloads", () => {
  const direct = llmRequestHeaders({ ...CFG, apiKey: "meta-key" }, "muse-spark-1.3");
  assert.deepEqual(direct, {
    "Content-Type": "application/json",
    Authorization: "Bearer meta-key",
  });

  const prod = llmRequestHeaders({
    ...CFG, apiKey: "meta-key", gatewayToken: "run-token",
    agentName: "hygge-browser-agent", agentId: "hygge-production",
  }, "muse-wonder-1.0");
  assert.equal(prod.Authorization, "Bearer meta-key");
  assert.equal(prod["cf-aig-authorization"], "Bearer run-token");
  // Unset collect flag = metadata only, never raw bodies.
  assert.equal(prod["cf-aig-collect-log-payload"], "false");
  assert.deepEqual(JSON.parse(prod["cf-aig-metadata"]), {
    agent: "hygge-browser-agent", agent_id: "hygge-production",
  });

  const staging = llmRequestHeaders({
    ...CFG, apiKey: "meta-key", gatewayToken: "run-token", gatewayCollectPayload: true,
  }, "muse-spark-1.3");
  assert.equal(staging["cf-aig-collect-log-payload"], "true");
});

test("gateway custom costs: Meta list prices per token, unknown models unpriced", () => {
  const spark = llmRequestHeaders(
    { ...CFG, apiKey: "meta-key", gatewayToken: "run-token" }, "muse-spark-1.3");
  assert.deepEqual(JSON.parse(spark["cf-aig-custom-cost"]), {
    per_token_in: 0.00000125, per_token_out: 0.00000425, per_cache_read_token: 1.5e-7,
  });

  const wonder = llmRequestHeaders(
    { ...CFG, apiKey: "meta-key", gatewayToken: "run-token" }, "muse-wonder-1.0");
  assert.deepEqual(JSON.parse(wonder["cf-aig-custom-cost"]), {
    per_token_in: 0.000004, per_token_out: 0.00002, per_cache_read_token: 2e-7,
  });

  const unknown = llmRequestHeaders(
    { ...CFG, apiKey: "meta-key", gatewayToken: "run-token" }, "some-future-model");
  assert.equal(unknown["cf-aig-custom-cost"], undefined);
});

test("parseDecision tolerates prose and fences", () => {
  assert.deepEqual(parseDecision('```json\n{"action":"click"}\n```'), { action: "click" });
  assert.equal(parseDecision("no json here"), null);
});

test("vault: per-user DEK wraps, seals, and AAD binds", async () => {
  const masterKeyB64 = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
  const master = await masterKey({ HYGGE_MASTER_KEY: masterKeyB64 });
  const dek = await generateDEK();
  const wrapped = await wrapDEK(dek, master);
  const dek2 = await unwrapDEK(wrapped, master);
  const blob = await seal(dek2, "s3cret-value", "rover.com\nsam@example.com");
  assert.equal(await open(dek2, blob, "rover.com\nsam@example.com"), "s3cret-value");
  await assert.rejects(open(dek2, blob, "other.com\nsam@example.com"));
  const otherDek = await generateDEK();
  await assert.rejects(open(otherDek, blob, "rover.com\nsam@example.com"));
});

test("ReplyStreamExtractor streams decoded reply only", () => {
  const ex = new ReplyStreamExtractor();
  let out = "";
  for (const chunk of ['{"rep', 'ly":"Hel', 'lo \\nworld","extracted":{}}']) out += ex.push(chunk);
  assert.equal(out, "Hello \nworld");
});

test("heuristicSuggestions tailors to transcript", () => {
  const s = heuristicSuggestions("I love dogs and cats");
  assert.ok(s.suggestedCategories.includes("petCare"));
  assert.ok(s.suggestedSkills.includes("Dog walking"));
});

test("distillHints learns from successes, caps at 12", () => {
  const hints = distillHints({
    domain: "rover.com",
    trace: [
      { action: "click", target: "Log in", succeeded: true, summary: "ok" },
      { action: "type", target: "Password field", succeeded: true, summary: "vault" },
      { action: "click", target: "Missing", succeeded: false, summary: "no" },
    ],
    extractedItems: ["x"],
    existing: [],
  });
  assert.ok(hints.some((h) => h.includes('Clicking "Log in" worked')));
  assert.ok(!hints.some((h) => h.includes("Password field")));
  assert.ok(hints.length <= 12);
});
