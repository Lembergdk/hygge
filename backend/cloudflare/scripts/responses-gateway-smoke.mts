// Manual staging-only verification. All tool calls are synthetic and have no
// external side effects. Prints pass/fail metadata, never credentials or payloads.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LLMClient, llmRequestHeaders } from "../src/llm.ts";

const source = readFileSync(new URL("../wrangler.staging.jsonc", import.meta.url), "utf8");
const config = (key: string) => {
  const value = source.match(new RegExp(`"${key}"\\s*:\\s*"([^"\\n]+)"`))?.[1];
  if (!value) throw new Error(`Missing staging config ${key}`);
  return value;
};
const baseUrl = config("HYGGE_LLM_BASE_URL");
assert.match(baseUrl, /^https:\/\/gateway\.ai\.cloudflare\.com\/v1\/[^/]+\/hygge-staging\//);
const gatewayToken = process.env.HYGGE_GATEWAY_SMOKE_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN;
if (!gatewayToken) throw new Error("Missing existing gateway Run credential");
const cfg = { baseUrl, gatewayToken, gatewayCollectPayload: false,
  modelFast: config("HYGGE_LLM_MODEL_FAST"), modelStrong: config("HYGGE_LLM_MODEL_STRONG") };
const client = new LLMClient(cfg);
let failures = 0;
let activeCheck = "";
const originalFetch = globalThis.fetch;
globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
  const response = await originalFetch(...args);
  if (!response.ok) {
    const body = await response.clone().json().catch(() => ({})) as any;
    const error = body?.error ?? body;
    const detail = JSON.stringify({ code: error?.code, type: error?.type, param: error?.param,
      message: String(error?.message ?? "").slice(0, 350) }).replaceAll(gatewayToken, "[redacted]");
    console.error(`GATEWAY ${activeCheck} DETAIL ${detail}`);
  }
  return response;
};
const check = async (name: string, run: () => Promise<void>) => {
  activeCheck = name;
  try { await run(); console.log(`GATEWAY ${name} PASS`); }
  catch (error: any) {
    failures++;
    // LLMClient exposes status-only errors; assert failures do not print bodies.
    console.error(`GATEWAY ${name} FAIL ${error?.status ? `HTTP ${error.status}` : error?.name ?? "Error"}`);
  }
};
// A valid 64x64 RGB PNG, with no user content.
const imageDataURL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAfklEQVR4nNXOQREAIAzAsK4K8W8GRPDYNQoynEuZxEmcxEmcxEmcxEmcxEmcxEmcxEmcxEmcxEmcxEmcxEmcxEmcxEmcxEmcxEmcxEmcxEmcxEmcxEmcxEmcxEmcxEmcxEmcxEmcxEmcxEmcxEmcxEmcxEmcxEmcxEmcxEmc24FfD2TIAc+I9emSAAAAAElFTkSuQmCC";
for (const model of new Set([cfg.modelFast, cfg.modelStrong])) {
  await check(`text-${model}`, async () => {
    const text = await client.complete({ model, system: "Reply with exactly OK.", user: "Synthetic transport check." });
    assert.ok(text.trim());
  });
  await check(`image-${model}`, async () => {
    const text = await client.complete({ model, system: "Describe the supplied test image in at most five words.", user: "Synthetic image check.", imageDataURL });
    assert.ok(text.trim());
  });
}
await check("stream", async () => {
  let deltas = "";
  const text = await client.completeStream({ model: cfg.modelFast, system: "Reply with exactly OK.", user: "Synthetic stream check." }, (d) => { deltas += d; });
  assert.ok(text.trim());
  assert.equal(deltas, text);
});
await check("native-tools-and-results", async () => {
  const post = async (body: unknown) => {
    const res = await fetch(`${baseUrl}/responses`, { method: "POST", headers: llmRequestHeaders(cfg, cfg.modelFast),
      body: JSON.stringify(body), signal: AbortSignal.timeout(90000) });
    if (!res.ok) throw Object.assign(new Error("Gateway request failed"), { status: res.status });
    return res.json() as Promise<any>;
  };
  activeCheck = "native-tools-call";
  const first = await post({ model: cfg.modelFast, store: false, include: ["reasoning.encrypted_content"],
    input: "Call record_test for synthetic site contra.com. This records no real data.",
    tool_choice: { type: "function", name: "record_test" },
    tools: [{ type: "function", name: "record_test", description: "Synthetic transport test; no side effects.",
      parameters: { type: "object", properties: { domain: { type: "string" } }, required: ["domain"], additionalProperties: false } }] });
  assert.equal(first.status, "completed");
  const calls = first.output?.filter((i: any) => i.type === "function_call") ?? [];
  assert.ok(calls.length > 0);
  for (const call of calls) { assert.equal(call.name, "record_test"); assert.ok(call.call_id); }
  activeCheck = "native-tools-result";
  const next = await post({ model: cfg.modelFast, store: false,
    instructions: "Report the supplied synthetic tool result in one short sentence. Do not call any tools.",
    input: [...first.output, ...calls.map((call: any) => ({ type: "function_call_output", call_id: call.call_id,
      output: JSON.stringify({ ok: true, synthetic: true }) }))] });
  assert.equal(next.status, "completed");
  assert.ok(next.output?.some((i: any) => i.type === "message"));
});
console.log(`GATEWAY-SUMMARY failures=${failures} target=staging no-deployment=true`);
process.exitCode = failures ? 1 : 0;
