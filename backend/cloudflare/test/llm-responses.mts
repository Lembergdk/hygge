// LLMClient over the Responses API: request shape, chained calls,
// the chained-400 restart, image inputs, and stream event parsing.
// The client posts to {baseUrl}/responses with instructions + input;
// history travels via previous_response_id, never as a transcript.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LLMClient, extractResponsesText } from "../src/llm.ts";

function client() {
  return new LLMClient({
    apiKey: "test-key", baseUrl: "https://example.invalid/v1",
    modelFast: "m-fast", modelStrong: "m-strong",
    agentName: "hygge-browser-agent", agentId: "hygge-test", tracePayloads: true,
  });
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function responsesBody(text: string, id = "resp-1") {
  return {
    id, model: "m-fast", status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text }] }],
    usage: { input_tokens: 11, output_tokens: 7 },
  };
}

test("complete posts instructions + input to /responses and reports the response id", async () => {
  const originalFetch = globalThis.fetch;
  const seen: Array<{ url: string; body: any }> = [];
  let reported: string | undefined;
  globalThis.fetch = (async (url: any, init: any) => {
    seen.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return jsonResponse(responsesBody("{\"action\":\"done\"}"));
  }) as any;
  try {
    const text = await client().complete({
      model: "m-fast", system: "s", user: "u",
      onResponseId: async (id) => { reported = id; },
    });
    assert.equal(text, "{\"action\":\"done\"}");
    assert.equal(seen.length, 1);
    assert.ok(seen[0].url.endsWith("/responses"));
    assert.equal(seen[0].body.model, "m-fast");
    assert.equal(seen[0].body.instructions, "s");
    assert.equal(seen[0].body.input, "u");
    assert.ok(!("previous_response_id" in seen[0].body));
    assert.equal(reported, "resp-1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("complete surfaces a chained 400 with status and does not retry", async () => {
  // No silent fresh restart: the caller compacts and retries with a
  // summary, or lets the error propagate — the client never drops
  // the chain on its own.
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return jsonResponse({ error: "chain too long" }, 400);
  }) as any;
  try {
    await assert.rejects(
      client().complete({ model: "m-fast", system: "s", user: "u", previousResponseId: "resp-stale" }),
      (e: any) => e.status === 400 && /returned 400/.test(e.message),
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("complete sends image turns as input_text + input_image parts", async () => {
  const originalFetch = globalThis.fetch;
  let body: any;
  globalThis.fetch = (async (_url: any, init: any) => {
    body = JSON.parse(String(init.body));
    return jsonResponse(responsesBody("{\"action\":\"done\"}"));
  }) as any;
  try {
    await client().complete({
      model: "m-fast", system: "s", user: "u",
      imageDataURL: "data:image/png;base64,AAAA",
    });
    assert.deepEqual(body.input, [
      { type: "input_text", text: "u" },
      { type: "input_image", image_url: "data:image/png;base64,AAAA" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

test("completeStream parses output_text deltas across chunk boundaries and reports the id", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => sseResponse([
    "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp-stream-1\",\"model\":\"m-fa",
    "st\"}}\n\ndata: {\"type\":\"response.reasoning_summary_text.delta\",\"delta\":\"thinking\"}\n\n: keepalive\n\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"Hello \"}\n\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"world\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-stream-1\",\"model\":\"m-fast\",\"status\":\"completed\",\"usage\":{\"input_tokens\":5,\"output_tokens\":3}}}\n\n",
  ])) as any;
  try {
    const deltas: string[] = [];
    let reported: string | undefined;
    const full = await client().completeStream(
      { model: "m-fast", system: "s", user: "u", onResponseId: async (id) => { reported = id; } },
      (d) => { deltas.push(d); },
    );
    assert.equal(full, "Hello world");
    assert.deepEqual(deltas, ["Hello ", "world"]);
    assert.equal(reported, "resp-stream-1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("completeStream surfaces a chained 400 with status and does not retry", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return jsonResponse({ error: "chain too long" }, 400);
  }) as any;
  try {
    await assert.rejects(
      client().completeStream({ model: "m-fast", system: "s", user: "u", previousResponseId: "resp-stale" }, () => {}),
      (e: any) => e.status === 400,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("extractResponsesText skips reasoning items, joins message parts, falls back to output_text", () => {
  assert.equal(extractResponsesText({
    output: [
      { type: "reasoning", summary: [{ type: "summary_text", text: "thinking" }] },
      { type: "message", content: [{ type: "output_text", text: "Hello " }, { type: "output_text", text: "world" }] },
    ],
  }), "Hello world");
  assert.equal(extractResponsesText({ output_text: "aggregate" }), "aggregate");
  assert.equal(extractResponsesText({ output: [] }), "");
});

test("completeWithTools passes function definitions and parses function_call items", async () => {
  const originalFetch = globalThis.fetch;
  const seen: Array<{ url: string; body: any }> = [];
  let reported: string | undefined;
  globalThis.fetch = (async (url: any, init: any) => {
    seen.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return jsonResponse({
      id: "resp-t1", model: "m-fast", status: "completed",
      output: [
        { type: "message", content: [{ type: "output_text", text: "done" }] },
        { type: "function_call", call_id: "call-1", name: "add", arguments: "{\"domain\":\"contra.com\"}" },
        { type: "function_call", call_id: "call-2", name: "scan", arguments: "{\"siteId\":\"rover\"}" },
        { type: "reasoning", content: [] },
      ],
      usage: { input_tokens: 11, output_tokens: 7 },
    });
  }) as any;
  try {
    const out = await client().completeWithTools({
      model: "m-fast", system: "s", user: "u", previousResponseId: "resp-prev",
      tools: [
        { name: "add", description: "Track a site.", parameters: { type: "object", properties: { domain: { type: "string" } }, required: ["domain"] } },
        { name: "scan", description: "Search a site.", parameters: { type: "object", properties: { siteId: { type: "string" } }, required: ["siteId"] } },
      ],
      onResponseId: async (id) => { reported = id; },
    });
    assert.equal(out.text, "done");
    assert.deepEqual(out.calls, [
      { name: "add", arguments: { domain: "contra.com" } },
      { name: "scan", arguments: { siteId: "rover" } },
    ]);
    assert.equal(seen[0].body.previous_response_id, "resp-prev");
    assert.deepEqual(seen[0].body.tools, [
      { type: "function", name: "add", description: "Track a site.", parameters: { type: "object", properties: { domain: { type: "string" } }, required: ["domain"] } },
      { type: "function", name: "scan", description: "Search a site.", parameters: { type: "object", properties: { siteId: { type: "string" } }, required: ["siteId"] } },
    ]);
    assert.equal(reported, "resp-t1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("completeWithTools nulls unparseable function arguments", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => jsonResponse({
    id: "resp-t2", model: "m-fast", status: "completed",
    output: [{ type: "function_call", call_id: "call-1", name: "add", arguments: "{bad json" }],
    usage: { input_tokens: 1, output_tokens: 1 },
  })) as any;
  try {
    const out = await client().completeWithTools({ model: "m-fast", system: "s", user: "u", tools: [] });
    assert.deepEqual(out.calls, [{ name: "add", arguments: null }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
