// Stateless Responses transport: text, images, streaming and terminal failure handling.
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

test("complete posts instructions + input to /responses without retaining provider state", async () => {
  const originalFetch = globalThis.fetch;
  const seen: Array<{ url: string; body: any }> = [];
  globalThis.fetch = (async (url: any, init: any) => {
    seen.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return jsonResponse(responsesBody("{\"action\":\"done\"}"));
  }) as any;
  try {
    const text = await client().complete({
      model: "m-fast", system: "s", user: "u",
    });
    assert.equal(text, "{\"action\":\"done\"}");
    assert.equal(seen.length, 1);
    assert.ok(seen[0].url.endsWith("/responses"));
    assert.equal(seen[0].body.model, "m-fast");
    assert.equal(seen[0].body.instructions, "s");
    assert.equal(seen[0].body.input, "u");
    assert.ok(!("previous_response_id" in seen[0].body));
    assert.equal(seen[0].body.store, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("complete surfaces a HTTP 400 with status and does not retry", async () => {
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
      client().complete({ model: "m-fast", system: "s", user: "u" }),
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
      { role: "user", content: [{ type: "input_text", text: "u" },
        { type: "input_image", image_url: "data:image/png;base64,AAAA" }] },
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

test("completeStream parses output_text deltas across chunk boundaries and completes", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => sseResponse([
    "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp-stream-1\",\"model\":\"m-fa",
    "st\"}}\n\ndata: {\"type\":\"response.reasoning_summary_text.delta\",\"delta\":\"thinking\"}\n\n: keepalive\n\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"Hello \"}\n\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"world\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-stream-1\",\"model\":\"m-fast\",\"status\":\"completed\",\"usage\":{\"input_tokens\":5,\"output_tokens\":3}}}\n\n",
  ])) as any;
  try {
    const deltas: string[] = [];
    const full = await client().completeStream(
      { model: "m-fast", system: "s", user: "u", onResponseId: async (id) => { reported = id; } },
      (d) => { deltas.push(d); },
    );
    assert.equal(full, "Hello world");
    assert.deepEqual(deltas, ["Hello ", "world"]);

  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("completeStream surfaces a HTTP 400 with status and does not retry", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return jsonResponse({ error: "chain too long" }, 400);
  }) as any;
  try {
    await assert.rejects(
      client().completeStream({ model: "m-fast", system: "s", user: "u" }, () => {}),
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


for (const status of ["failed", "incomplete", "cancelled", "in_progress"]) {
  test(`complete rejects a 200 response with status ${status}`, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => jsonResponse({ ...responsesBody("partial"), status })) as any;
    try {
      await assert.rejects(client().complete({ model: "m-fast", system: "s", user: "u" }), /did not complete/);
    } finally { globalThis.fetch = originalFetch; }
  });
}

for (const terminal of ["response.failed", "response.incomplete", "response.cancelled", "error", "missing"]) {
  test(`stream rejects ${terminal} after partial text`, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => sseResponse([
      'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
      terminal === "missing" ? "" : `data: ${JSON.stringify({ type: terminal })}\n\n`,
    ])) as any;
    try {
      await assert.rejects(client().completeStream({ model: "m-fast", system: "s", user: "u" }, () => {}),
        /did not complete|before completion/);
    } finally { globalThis.fetch = originalFetch; }
  });
}

test("stream accepts a completed final event without a trailing newline and sends store false", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init: any) => {
    const body = JSON.parse(String(init.body));
    assert.equal(body.store, false);
    assert.ok(!("previous_response_id" in body));
    return sseResponse(['data: {"type":"response.output_text.delta","delta":"ok"}\n\n',
      'data: {"type":"response.completed","response":{"id":"r","status":"completed"}}']);
  }) as any;
  try {
    assert.equal(await client().completeStream({ model: "m-fast", system: "s", user: "u" }, () => {}), "ok");
  } finally { globalThis.fetch = originalFetch; }
});
