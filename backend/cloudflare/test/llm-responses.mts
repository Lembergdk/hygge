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

test('native agent transport persists chains and forwards native results without rewriting call IDs', async()=>{
 const previous=globalThis.fetch;const seen:any[]=[];
 globalThis.fetch=(async(_url:any,init:any)=>{seen.push(JSON.parse(init.body));return jsonResponse({...responsesBody(''),output:[{type:'function_call',call_id:'native-call',name:'read_profile',arguments:'{}'}]});}) as any;
 try {
  const result=await client().agentTurn({model:'m-strong',instructions:'policy',previousResponseId:'older',input:[{type:'function_call_output',call_id:'prior-call',output:'{"status":"saved"}'}],tools:[{type:'function',name:'read_profile'}]});
  assert.equal(seen[0].store,true);assert.equal(seen[0].previous_response_id,'older');assert.equal(seen[0].input[0].call_id,'prior-call');
  assert.deepEqual(result.calls,[{callId:'native-call',name:'read_profile',arguments:{}}]);
 } finally {globalThis.fetch=previous;}
});

test('native stream records early response identity but never returns partial tool arguments',async()=>{
 const previous=globalThis.fetch;const created:string[]=[];
 globalThis.fetch=(async()=>sseResponse([
  {type:'response.created',response:{id:'early'}},
  {type:'response.function_call_arguments.delta',delta:'{"domain":'},
  {type:'response.incomplete',response:{id:'early',status:'incomplete'}}
 ].map(e=>`data: ${JSON.stringify(e)}\n\n`))) as any;
 try {await assert.rejects(client().agentTurn({model:'m-strong',instructions:'policy',input:[],onDelta:()=>{},onResponseCreated:id=>created.push(id)}),/interrupted/);assert.deepEqual(created,['early']);}
 finally {globalThis.fetch=previous;}
});

test('native transport distinguishes expired chain, context exhaustion, and unrelated HTTP 400',async()=>{
 const previous=globalThis.fetch;
 try {for(const [body,expired,context] of [
  [{error:{code:'previous_response_not_found'}},true,false],
  [{error:{type:'invalid_request_error',message:'referenced response not found or expired'}},true,false],
  [{error:{code:'context_length_exceeded'}},false,true],
  [{error:{code:'invalid_tool_schema'}},false,false],
 ] as any[]){globalThis.fetch=(async()=>jsonResponse(body,400)) as any;
  await assert.rejects(client().agentTurn({model:'m-strong',instructions:'policy',input:[],previousResponseId:'old'}),(e:any)=>e.chainExpired===expired&&e.contextExceeded===context);
 }}finally{globalThis.fetch=previous;}
});

test('provider cleanup retries generic route failures but accepts an already deleted response',async()=>{
 const previous=globalThis.fetch;let url='',method='';
 try {
  globalThis.fetch=(async(u:any,i:any)=>{url=String(u);method=i.method;return jsonResponse({error:{message:'Route not found'}},404);}) as any;
  await assert.rejects(client().deleteAgentResponse('resp/test'));
  assert.ok(url.endsWith('/responses/resp%2Ftest'));assert.equal(method,'DELETE');
  globalThis.fetch=(async()=>jsonResponse({error:{code:'response_not_found'}},404)) as any;
  await client().deleteAgentResponse('old');
 }finally{globalThis.fetch=previous;}
});

test('text and stream requests share a bounded deadline, preserve timeout, and never retry',async()=>{
 const originalFetch=globalThis.fetch,originalTimeout=AbortSignal.timeout;
 const deadlines:number[]=[];let calls=0;
 (AbortSignal as any).timeout=(ms:number)=>{deadlines.push(ms);const c=new AbortController();setTimeout(()=>c.abort(new DOMException('Timed out','TimeoutError')),1);return c.signal;};
 globalThis.fetch=(async(_url:any,init:any)=>{calls++;return new Promise((_resolve,reject)=>{init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true});});}) as any;
 try{
  await assert.rejects(client().complete({model:'m-fast',system:'s',user:'u'}),(e:any)=>e.name==='TimeoutError');
  await assert.rejects(client().completeStream({model:'m-fast',system:'s',user:'u'},()=>{}),(e:any)=>e.name==='TimeoutError');
  assert.deepEqual(deadlines,[120000,120000]);assert.equal(calls,2);
 }finally{globalThis.fetch=originalFetch;(AbortSignal as any).timeout=originalTimeout;}
});
