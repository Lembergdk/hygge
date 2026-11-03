import { test } from "node:test";
import assert from "node:assert/strict";
import { withSpan, clip, agentAttrs } from "../src/tracing.ts";
import { LLMClient, genAiTextMessage, traceUsageAttributes } from "../src/llm.ts";
import { onboardingMessage, onboardingMessageStream } from "../src/onboarding.ts";

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
    "instrumentation_scope.name": "agents",
    "instrumentation_scope.version": "1",
    "gen_ai.agent.name": "hygge-browser-agent",
    "gen_ai.agent.id": "hygge-staging",
    "gen_ai.conversation.id": "task-1",
    "cloudflare.agents.session.id": "task-1",
  });
  assert.deepEqual(agentAttrs("a", "b"), {
    "instrumentation_scope.name": "agents",
    "instrumentation_scope.version": "1",
    "gen_ai.agent.name": "a",
    "gen_ai.agent.id": "b",
  });
});

test("agentAttrs carries the Agents dashboard session identity block", () => {
  const attrs = agentAttrs(
    "hygge-browser-agent",
    "hygge-staging",
    "task-123",
    { id: "durable-object-123", name: "user-123" },
  );
  assert.equal(attrs["cloudflare.agents.session.id"], "durable-object-123");
  assert.equal(attrs["cloudflare.agents.session.name"], "user-123");
  assert.equal(attrs["gen_ai.conversation.id"], "task-123");
});

test("onboarding turns propagate one conversation id to the model call", async () => {
  const seen: unknown[] = [];
  const client = {
    configured: true,
    cfg: { modelFast: "m-fast", agentName: "hygge-onboarding", agentId: "hygge-test" },
    complete: async (args: Record<string, unknown>) => {
      seen.push(args.conversationId);
      return JSON.stringify({ reply: "Next question?", extracted: {} });
    },
    completeStream: async (args: Record<string, unknown>) => {
      seen.push(args.conversationId);
      return "Next question?";
    },
  };
  await onboardingMessage({
    client, step: "enjoyWork", transcript: [], profile: {}, conversationId: "onboarding-123",
  });
  const events: unknown[] = [];
  await onboardingMessageStream({
    client, step: "enjoyWork", transcript: [], profile: {}, conversationId: "onboarding-123",
  }, (event) => events.push(event));
  assert.deepEqual(seen, ["onboarding-123", "onboarding-123"]);
  assert.ok(events.length > 0);
});

test("GenAI payload and usage attributes use the current dashboard shapes", () => {
  assert.deepEqual(genAiTextMessage("assistant", "Hello", "stop"), {
    role: "assistant",
    parts: [{ type: "text", content: "Hello" }],
    finish_reason: "stop",
  });
  assert.deepEqual(traceUsageAttributes({
    prompt_tokens: 120,
    completion_tokens: 30,
    total_tokens: 150,
    prompt_tokens_details: { cached_tokens: 80 },
    completion_tokens_details: { reasoning_tokens: 12 },
  }), {
    "gen_ai.usage.input_tokens": 120,
    "gen_ai.usage.output_tokens": 30,
    "gen_ai.usage.cache_read.input_tokens": 80,
    "gen_ai.usage.reasoning.output_tokens": 12,
    "cloudflare.agents.usage.total_tokens": 150,
  });
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
