import { test } from "node:test";
import assert from "node:assert/strict";
import { withSpan, clip, agentAttrs } from "../src/tracing.ts";
import { LLMClient } from "../src/llm.ts";

// The tracing wrapper must be a transparent no-op outside Workers:
// the callback runs, its value returns, errors propagate.
test("withSpan runs the callback and returns its value without a tracer", async () => {
  const seen: Array<[string, unknown]> = [];
  const value = await withSpan("chat test", { "gen_ai.operation.name": "chat" }, async (span) => {
    span.setAttribute("k", "v");
    seen.push(["ran", true]);
    return 42;
  });
  assert.equal(value, 42);
  assert.deepEqual(seen, [["ran", true]]);
  await assert.rejects(
    withSpan("chat test", {}, async () => { throw new Error("boom"); }),
    /boom/,
  );
});

test("agentAttrs carries the GenAI identity fields", () => {
  assert.deepEqual(agentAttrs("hygge-browser-agent", "hygge-staging", "task-1"), {
    "gen_ai.agent.name": "hygge-browser-agent",
    "gen_ai.agent.id": "hygge-staging",
    "gen_ai.conversation.id": "task-1",
  });
  assert.deepEqual(agentAttrs("a", "b"), { "gen_ai.agent.name": "a", "gen_ai.agent.id": "b" });
});

test("clip truncates long payloads", () => {
  assert.equal(clip("short"), "short");
  assert.ok(clip("x".repeat(9000)).endsWith("…[clipped]"));
});

test("LLMClient.complete parses text and tolerates a usage block", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    choices: [{ message: { content: "{\"action\":\"done\"}" } }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  }), { status: 200, headers: { "Content-Type": "application/json" } })) as any;
  try {
    const client = new LLMClient({
      apiKey: "test-key", baseUrl: "https://example.invalid/v1",
      modelFast: "m-fast", modelStrong: "m-strong",
      agentName: "hygge-browser-agent", agentId: "hygge-test", tracePayloads: true,
    });
    const text = await client.complete({ model: "m-fast", system: "s", user: "u", conversationId: "c1" });
    assert.equal(text, "{\"action\":\"done\"}");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
