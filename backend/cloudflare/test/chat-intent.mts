// Model-led chat intent: the model decides what the user wants
// done; validation against the app-supplied context decides
// whether it may run. Invented ids, unknown kinds, and junk all
// fall back to plain conversation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chatIntent, validateChatIntent, validateChatIntentList } from "../src/onboarding.ts";

const CONTEXT = {
  sites: [
    { id: "rover", name: "Rover", domain: "rover.com", state: "watching" },
    { id: "upwork", name: "Upwork", domain: "upwork.com", state: "proposed" },
  ],
  inbox: [
    { id: "mail-1", senderDomain: "gmail.com", subject: "Fwd: New maintenance jobs at ApartmentIQ", summary: "Jobs near Leeds", highlights: ["Possible new work mentioned"] },
  ],
  paused: false,
};

test("validateChatIntent keeps only known kinds with context-bound ids", () => {
  assert.deepEqual(validateChatIntent({ action: { kind: "scan", siteId: "rover" } }, CONTEXT),
    { kind: "scan", siteId: "rover" });
  assert.deepEqual(validateChatIntent({ action: { kind: "email", mailId: "mail-1", act: true } }, CONTEXT),
    { kind: "email", mailId: "mail-1", act: true });
  assert.deepEqual(validateChatIntent({ action: { kind: "add", domain: "https://www.pawshake.com/jobs" } }, CONTEXT),
    { kind: "add", domain: "pawshake.com" });
  assert.deepEqual(validateChatIntent({ action: { kind: "floor", amount: 30 } }, CONTEXT),
    { kind: "floor", amount: 30 });
  assert.equal(validateChatIntent({ action: { kind: "scan", siteId: "invented" } }, CONTEXT), null);
  assert.equal(validateChatIntent({ action: { kind: "email", mailId: "nope" } }, CONTEXT), null);
  assert.equal(validateChatIntent({ action: { kind: "wire_money", amount: 5 } }, CONTEXT), null);
  assert.equal(validateChatIntent({ action: { kind: "floor", amount: 50000 } }, CONTEXT), null);

test("validateChatIntentList validates each tool call, drops the bad ones", () => {
  // "Both" for two named sites: two validated calls.
  assert.deepEqual(
    validateChatIntentList({ actions: [
      { kind: "add", domain: "contra.com" },
      { kind: "add", domain: "https://www.toptal.com/" },
    ] }, CONTEXT),
    [{ kind: "add", domain: "contra.com" }, { kind: "add", domain: "toptal.com" }]);
  // Unknown ids and junk fall out; the good call survives.
  assert.deepEqual(
    validateChatIntentList({ actions: [
      { kind: "join", siteId: "invented" },
      { kind: "scan", siteId: "rover" },
      { kind: "wire_money", amount: 5 },
    ] }, CONTEXT),
    [{ kind: "scan", siteId: "rover" }]);
  // Caps at five; empty or missing reads as none.
  assert.equal(
    validateChatIntentList({ actions: [1, 2, 3, 4, 5, 6, 7].map(() => ({ kind: "pause" })) }, CONTEXT)?.length, 5);
  assert.equal(validateChatIntentList({ actions: [] }, CONTEXT), null);
  assert.equal(validateChatIntentList({}, CONTEXT), null);
});
  assert.equal(validateChatIntent({ action: null }, CONTEXT), null);
  assert.equal(validateChatIntent({}, CONTEXT), null);
  assert.equal(validateChatIntent(null, CONTEXT), null);
});

test("chatIntent returns the model's validated action", async () => {
  const seen: any[] = [];
  const client = {
    configured: true,
    cfg: { modelFast: "m-fast" },
    completeWithTools: async (args: any) => {
      seen.push(args);
      return { text: "", calls: [{ name: "email", arguments: { mailId: "mail-1", act: true } }] };
    },
  };
  const out = await chatIntent({
    client,
    transcript: [{ fromAgent: false, text: "do something about that forwarded email" }],
    context: CONTEXT,
  });
  assert.deepEqual(out.action, { kind: "email", mailId: "mail-1", act: true });
  assert.deepEqual(out.actions, [{ kind: "email", mailId: "mail-1", act: true }]);
  assert.equal(out.simulated, false);
  assert.deepEqual(seen[0].tools.map((t: any) => t.name), ["scan", "join", "stop", "add", "email", "floor", "pause", "resume", "approve", "book", "explainDropped"]);
});

test("chatIntent falls back to conversation when unconfigured or when the model calls nothing", async () => {
  const unconfigured = { configured: false, cfg: { modelFast: "m-fast" }, completeWithTools: async () => ({ text: "", calls: [] }) };
  const off = await chatIntent({ client: unconfigured, transcript: [], context: CONTEXT });
  assert.equal(off.action, null);
  assert.equal(off.simulated, true);

  const junk = { configured: true, cfg: { modelFast: "m-fast" }, completeWithTools: async () => ({ text: "sure thing!", calls: [] }) };
  const bad = await chatIntent({ client: junk, transcript: [], context: CONTEXT });
  assert.equal(bad.action, null);
  assert.equal(bad.actions, null);
  assert.equal(bad.simulated, false);
});

test("chatIntent passes native tool definitions and drops invalid calls", async () => {
  const seen: any[] = [];
  const client = {
    configured: true,
    cfg: { modelFast: "m-fast" },
    completeWithTools: async (args: any) => {
      seen.push(args);
      if (args.onResponseId) await args.onResponseId("resp-1");
      return { text: "", calls: [
        { name: "scan", arguments: { siteId: "rover" } },
        { name: "join", arguments: { siteId: "no-such-site" } },
        { name: "add", arguments: { domain: "not a domain" } },
        { name: "floor", arguments: { amount: 5000 } },
        { name: "wire_money", arguments: {} },
        { name: "add", arguments: null },
      ] };
    },
  };
  const out = await chatIntent({
    client,
    transcript: [{ fromAgent: false, text: "scan Rover and whatever" }],
    context: CONTEXT,
  });
  assert.deepEqual(out.actions, [{ kind: "scan", siteId: "rover" }]);
  assert.deepEqual(out.action, { kind: "scan", siteId: "rover" });
  assert.equal(seen[0].tools.length, 11);
});

test("chatIntent on a live chain sends only the latest message, chained, and saves the new id", async () => {
  const seen: any[] = [];
  let stored: string | undefined = "resp-prev";
  const client = {
    configured: true,
    cfg: { modelFast: "m-fast" },
    completeWithTools: async (args: any) => {
      seen.push(args);
      if (args.onResponseId) await args.onResponseId("resp-new");
      return { text: "", calls: [{ name: "add", arguments: { domain: "contra.com" } }] };
    },
  };
  const chain = {
    get: async () => stored,
    set: async (id: string) => { stored = id; },
  };
  const out = await chatIntent({
    client,
    transcript: [
      { fromAgent: true, text: "Which other sites did you have in mind — Contra or Toptal for example?" },
      { fromAgent: false, text: "Both" },
    ],
    context: CONTEXT,
    chain,
  });
  assert.deepEqual(out.actions, [{ kind: "add", domain: "contra.com" }]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].previousResponseId, "resp-prev");
  // No transcript blob: only the latest message travels; the thread
  // lives server-side under the chain.
  assert.equal(seen[0].user, "Both");
  // Per-turn context still travels, in instructions.
  assert.ok(String(seen[0].system).includes("rover.com"));
  assert.equal(stored, "resp-new");
});

test("chatIntent bootstraps a missing chain with the legacy blob, then saves the id", async () => {
  const seen: any[] = [];
  let stored: string | undefined = undefined;
  const client = {
    configured: true,
    cfg: { modelFast: "m-fast" },
    completeWithTools: async (args: any) => {
      seen.push(args);
      if (args.onResponseId) await args.onResponseId("resp-1");
      return { text: "", calls: [{ name: "scan", arguments: { siteId: "rover" } }] };
    },
  };
  const chain = {
    get: async () => stored,
    set: async (id: string) => { stored = id; },
  };
  const out = await chatIntent({
    client,
    transcript: [{ fromAgent: false, text: "scan Rover" }],
    context: CONTEXT,
    chain,
  });
  assert.deepEqual(out.actions, [{ kind: "scan", siteId: "rover" }]);
  assert.equal(seen[0].previousResponseId, undefined);
  assert.ok(JSON.parse(seen[0].user).conversation.includes("scan Rover"));
  assert.equal(stored, "resp-1");
});

// Full chain object (summary storage included), as the Durable
// Object route builds it. The fake model answers summarizations
// with a fixed summary and chat calls with an add action.
function fullChain(initialId?: string) {
  let id = initialId;
  let summary: { text: string; turns: number } | null = null;
  return {
    get: async () => id,
    set: async (v: string) => { id = v; },
    clear: async () => { id = undefined; },
    getSummary: async () => summary,
    setSummary: async (s: { text: string; turns: number }) => { summary = s; },
    clearSummary: async () => { summary = null; },
    state: () => ({ id, summary }),
  };
}

function summarizingClient(seen: any[], summaries: string[]) {
  return {
    configured: true,
    cfg: { modelFast: "m-fast" },
    complete: async (args: any) => {
      seen.push(args);
      summaries.push(args.user);
      return "Summary: user discussed Rover; assistant offered Contra and Toptal, awaiting reply.";
    },
    completeWithTools: async (args: any) => {
      seen.push(args);
      if (args.onResponseId) await args.onResponseId("resp-new");
      return { text: "", calls: [{ name: "add", arguments: { domain: "contra.com" } }] };
    },
  };
}

test("chatIntent proactively compacts a long thread: summary stored, chain reset, latest message only", async () => {
  const filler = Array.from({ length: 30 }, (_, i) => ({
    fromAgent: i % 2 === 0, text: `filler turn ${i} `.padEnd(300, "x"),
  }));
  const transcript = [...filler, { fromAgent: false, text: "Both" }];
  const seen: any[] = [];
  const summaries: string[] = [];
  const chain = fullChain("resp-prev");
  const out = await chatIntent({
    client: summarizingClient(seen, summaries),
    transcript,
    context: CONTEXT,
    chain,
  });
  assert.deepEqual(out.actions, [{ kind: "add", domain: "contra.com" }]);
  // One summarization, then the chat call on a fresh chain.
  assert.equal(summaries.length, 1);
  const chatCall = seen.find((a) => !String(a.system).includes("Summarize a chat thread"));
  assert.equal(chatCall.previousResponseId, undefined);
  assert.equal(chatCall.user, "Both");
  // Summary travels in instructions alongside per-turn context.
  assert.ok(String(chatCall.system).includes("awaiting reply"));
  assert.ok(String(chatCall.system).includes("rover.com"));
  // Chain advanced to the fresh response; summary covers the filler.
  assert.equal(chain.state().id, "resp-new");
  assert.equal(chain.state().summary?.turns, 30);
  assert.ok((chain.state().summary?.text ?? "").includes("awaiting reply"));
});

test("chatIntent on a chained 400 compacts and retries WITH the summary", async () => {
  const transcript = [
    { fromAgent: true, text: "Which other sites did you have in mind — Contra or Toptal for example?" },
    { fromAgent: false, text: "Both" },
  ];
  const seen: any[] = [];
  const chain = fullChain("resp-prev");
  const client = {
    configured: true,
    cfg: { modelFast: "m-fast" },
    complete: async (args: any) => {
      seen.push(args);
      return "Summary: assistant offered Contra and Toptal, awaiting reply.";
    },
    completeWithTools: async (args: any) => {
      seen.push(args);
      if (args.previousResponseId === "resp-prev") {
        const err = new Error("LLM m-fast returned 400") as any;
        err.status = 400;
        throw err;
      }
      if (args.onResponseId) await args.onResponseId("resp-retry");
      return { text: "", calls: [{ name: "add", arguments: { domain: "contra.com" } }] };
    },
  };
  const out = await chatIntent({ client, transcript, context: CONTEXT, chain });
  assert.deepEqual(out.actions, [{ kind: "add", domain: "contra.com" }]);
  // Chained call, summarization, retry on a fresh chain with summary.
  assert.equal(seen.filter((a) => !String(a.system).includes("Summarize a chat thread")).length, 2);
  const retry = seen[seen.length - 1];
  assert.equal(retry.previousResponseId, undefined);
  assert.ok(String(retry.system).includes("awaiting reply"));
  assert.equal(chain.state().id, "resp-retry");
  assert.ok((chain.state().summary?.text ?? "").includes("awaiting reply"));
});

test("chatIntent never restarts fresh without a summary: an uncompactable 400 propagates, chain untouched", async () => {
  const transcript = [{ fromAgent: false, text: "scan Rover" }];
  let calls = 0;
  const chain = fullChain("resp-prev");
  const client = {
    configured: true,
    cfg: { modelFast: "m-fast" },
    completeWithTools: async () => {
      calls++;
      const err = new Error("LLM m-fast returned 400") as any;
      err.status = 400;
      throw err;
    },
  };
  const out = await chatIntent({ client, transcript, context: CONTEXT, chain });
  // Falls back to conversation; no retry, no chain reset, no summary.
  assert.equal(out.action, null);
  assert.equal(out.actions, null);
  assert.equal(calls, 1);
  assert.equal(chain.state().id, "resp-prev");
  assert.equal(chain.state().summary, null);
});

test("chatIntent survives a proactive summarizer failure: live chain, turn succeeds", async () => {
  // Proactive compaction is an optimization, not a precondition: a
  // failing summarizer must not kill a turn the live chain could
  // still serve.
  const filler = Array.from({ length: 30 }, (_, i) => ({
    fromAgent: i % 2 === 0, text: `filler turn ${i} `.padEnd(300, "x"),
  }));
  const transcript = [...filler, { fromAgent: false, text: "Both" }];
  const seen: any[] = [];
  let summarizerCalls = 0;
  const chain = fullChain("resp-prev");
  const client = {
    configured: true,
    cfg: { modelFast: "m-fast" },
    complete: async () => {
      summarizerCalls++;
      throw new Error("summarizer down");
    },
    completeWithTools: async (args: any) => {
      seen.push(args);
      if (args.onResponseId) await args.onResponseId("resp-new");
      return { text: "", calls: [{ name: "add", arguments: { domain: "contra.com" } }] };
    },
  };
  const out = await chatIntent({ client, transcript, context: CONTEXT, chain });
  assert.deepEqual(out.actions, [{ kind: "add", domain: "contra.com" }]);
  assert.equal(summarizerCalls, 1);
  // Proceeded with the live chain, not a reset.
  const chatCall = seen.find((a) => !String(a.system).includes("Summarize a chat thread"));
  assert.equal(chatCall.previousResponseId, "resp-prev");
  assert.equal(chatCall.user, "Both");
  assert.equal(chain.state().id, "resp-new");
  assert.equal(chain.state().summary, null);
});

test("chatIntent caps summarizer input on a giant thread: most recent turns only, chain still resets", async () => {
  const filler = Array.from({ length: 100 }, (_, i) => ({
    fromAgent: i % 2 === 0, text: `filler turn ${i} `.padEnd(300, "x"),
  }));
  const transcript = [...filler, { fromAgent: false, text: "Both" }];
  let summarizerInput = "";
  const chain = fullChain("resp-prev");
  const client = {
    configured: true,
    cfg: { modelFast: "m-fast" },
    complete: async (args: any) => {
      summarizerInput = args.user;
      return "Summary: long thread condensed.";
    },
    completeWithTools: async (args: any) => {
      if (args.onResponseId) await args.onResponseId("resp-new");
      return { text: "", calls: [{ name: "add", arguments: { domain: "contra.com" } }] };
    },
  };
  const out = await chatIntent({ client, transcript, context: CONTEXT, chain });
  assert.deepEqual(out.actions, [{ kind: "add", domain: "contra.com" }]);
  // 30,000 chars of turns capped to the most recent ~8,000.
  assert.ok(summarizerInput.length < 9000);
  assert.ok(summarizerInput.includes("filler turn 99 "));
  assert.ok(!summarizerInput.includes("filler turn 0 "));
  // Compaction still happened; the turn count is a high-water mark.
  assert.equal(chain.state().id, "resp-new");
  assert.equal(chain.state().summary?.turns, 100);
});
