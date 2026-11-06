// Mail push paths, draft/expiry notices, and the transcript
// chain, end to end through UserSandbox (PR #115 round 2):
// handleEmailInbound (not payload-level), the saveTask draft
// hook, the expiry trigger, and the strict previous_response_id
// chain. Runs UserSandbox in Node with an in-memory DO SQLite
// (see register-cloudflare-stub.mjs) and a stubbed model fetch.
// Push DELIVERY itself is not exercised here — schedulePush is
// recorded, so the assertions are on the handler's push decisions
// (which events, how many). APNs delivery is covered by
// test/push.mts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { UserSandbox } from "../src/user-sandbox.ts";
import { help } from "../src/task-help.ts";

function fakeCtx() {
  const sqlite = new DatabaseSync(":memory:");
  const kv = new Map<string, unknown>();
  let serial = 0;
  const waitUntil: Promise<unknown>[] = [];
  const sql = {
    exec(query: string, ...args: unknown[]) {
      const trimmed = query.trim();
      if (/^(SELECT|PRAGMA|WITH)\b/i.test(trimmed)) return sqlite.prepare(query).all(...args);
      if (args.length) { sqlite.prepare(query).run(...args); return []; }
      sqlite.exec(query);
      return [];
    },
  };
  const storage = {
    sql,
    transactionSync<T>(fn: () => T): T {
      const sp = `t${serial++}`;
      sqlite.exec(`SAVEPOINT ${sp}`);
      try { const v = fn(); sqlite.exec(`RELEASE ${sp}`); return v; }
      catch (e) { sqlite.exec(`ROLLBACK TO ${sp}`); sqlite.exec(`RELEASE ${sp}`); throw e; }
    },
    get: async (key: string) => kv.get(key),
    put: async (key: string, value: unknown) => { kv.set(key, value); },
    delete: async (key: string) => kv.delete(key),
    setAlarm: async () => {},
  };
  return {
    sqlite,
    waitUntil,
    ctx: {
      storage,
      container: undefined,
      id: { toString: () => "test-do-id" },
      waitUntil: (p: Promise<unknown>) => { waitUntil.push(p); },
      blockConcurrencyWhile: (fn: () => unknown) => fn(),
    },
  };
}

function makeSandbox() {
  const { ctx, waitUntil, sqlite } = fakeCtx();
  const env = {
    HYGGE_LLM_API_KEY: "test-key",
    HYGGE_LLM_BASE_URL: "https://llm.test",
    HYGGE_LLM_MODEL_FAST: "m-fast",
    HYGGE_LLM_MODEL_STRONG: "m-strong",
    HYGGE_ENV: "test",
    HYGGE_WORKSPACE_MODE: "legacy",
  };
  const sandbox = new UserSandbox(ctx as any, env as any);
  (sandbox as any).userId = "user-1";
  const pushes: any[] = [];
  (sandbox as any).schedulePush = (events: any[]) => { pushes.push(...events); };
  const drain = async () => {
    for (let i = 0; i < 10; i++) {
      const pending = waitUntil.splice(0);
      if (!pending.length) return;
      await Promise.all(pending);
    }
  };
  const stateStore = () => (sandbox as any).stateStore();
  const messages = () => stateStore().list("messages");
  const message = (id: string) => stateStore().get("messages", id)?.data;
  const taskRow = (id: string) => {
    const rows = [...sqlite.prepare("SELECT task FROM tasks WHERE id = ?").all(id)] as any[];
    return rows.length ? JSON.parse(String(rows[0].task)) : null;
  };
  const seedTask = (task: any) => {
    sqlite.prepare("INSERT INTO tasks (id, task) VALUES (?, ?)").run(task.id, JSON.stringify(task));
  };
  const eventsOfKind = (kind: string) =>
    [...sqlite.prepare("SELECT payload FROM events WHERE kind = ?").all(kind)].map((r: any) => JSON.parse(String(r.payload)));
  return { sandbox, pushes, ctx, sqlite, drain, messages, message, taskRow, seedTask, eventsOfKind };
}

/// The model, stubbed at the fetch layer: every composition gets
/// this text (the Responses body shape mirrors
/// test/llm-responses.mts). Returns a restore function.
function stubModel(text: string) {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    id: "resp-test", model: "m-strong", status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text }] }],
    usage: { input_tokens: 1, output_tokens: 1 },
  }), { status: 200, headers: { "Content-Type": "application/json" } })) as any;
  return () => { globalThis.fetch = original; };
}

function stubModelFailure() {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: "boom" }),
    { status: 500, headers: { "Content-Type": "application/json" } })) as any;
  return () => { globalThis.fetch = original; };
}

const BASE_TASK = {
  kind: "signup",
  target_url: "https://www.rover.com/join",
  goal: "Join Rover",
  title: "Join Rover",
  drafted_payload: {},
  interaction_version: 1,
  browser_trace: [],
  extracted_items: [],
  information_requests: [],
  log: [],
};

function mailDelivery(overrides: Record<string, any> = {}): any {
  const base: any = {
    kind: "other",
    receivedAt: "2026-11-05T12:00:00.000Z",
    contentHash: "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
    summary: {
      sender: "Someone", senderDomain: "gmail.com", subject: "New jobs near you",
      date: "2026-11-05T12:00:00Z", kind: "other",
      summary: "Two new dog-sitting jobs were just posted near Leeds.",
      actionableItems: [], attachments: [],
    },
    code: null,
    verification: null,
    triage: {
      senderEmail: "someone@gmail.com", ownerVerified: false, senderAuthenticated: true,
      highlights: [{ kind: "job_alert", label: "Possible new work mentioned" }],
      reading: {
        summary: "Two new dog-sitting jobs near Leeds.",
        mentions: [{ kind: "job_alert", detail: "2 new dog-sitting jobs near Leeds" }],
        jobs: [],
        instruction: null,
      },
    },
  };
  return { ...base, ...overrides };
}

test("mail question push: unknown-sender job-alert mail asks in chat and pushes exactly once", async () => {
  const t = makeSandbox();
  const restore = stubModel("Two new dog-sitting jobs near Leeds — want me to look into them?");
  try {
    const result = await (t.sandbox as any).handleEmailInbound(mailDelivery());
    assert.equal(result.outcome, "chat_asked");
    await t.drain();
    assert.equal(t.pushes.length, 1, "one mail, one push");
    assert.equal(t.pushes[0].kind, "needs_you");
    assert.equal(t.pushes[0].refKind, "chat");
    assert.equal(t.pushes[0].body, "Two new dog-sitting jobs near Leeds — want me to look into them?");
    const rows = t.messages();
    assert.equal(rows.length, 1, "the question is the one chat message");
    assert.equal(rows[0].data.text, "Two new dog-sitting jobs near Leeds — want me to look into them?");
  } finally {
    restore();
  }
});

test("one mail, one push: a mail that both asks a question and mentions a client message pushes only the question", async () => {
  const t = makeSandbox();
  const restore = stubModel("Composed question about this mail.");
  try {
    const delivery = mailDelivery({
      triage: {
        senderEmail: "someone@gmail.com", ownerVerified: false, senderAuthenticated: true,
        highlights: [
          { kind: "job_alert", label: "Possible new work mentioned" },
          { kind: "client_message", label: "Someone may have messaged you" },
        ],
        reading: {
          summary: "Jobs and a message.",
          mentions: [
            { kind: "job_alert", detail: "2 new dog-sitting jobs near Leeds" },
            { kind: "client_message", detail: "A client sent you a message" },
          ],
          jobs: [],
          instruction: null,
        },
      },
    });
    const result = await (t.sandbox as any).handleEmailInbound(delivery);
    assert.equal(result.outcome, "chat_asked");
    await t.drain();
    assert.equal(t.pushes.length, 1, "the question's push is the mail's one push");
    assert.equal(t.pushes[0].kind, "needs_you");
    assert.ok(!t.pushes.some((p: any) => p.kind === "message_waiting"), "no client-message backing push");
    assert.equal(t.messages().length, 1, "no backing message row either");
  } finally {
    restore();
  }
});

test("tracked-site mail mentioning a client message pushes once, backed by its message", async () => {
  const t = makeSandbox();
  const restore = stubModel("Rover wrote about a message from a client.");
  try {
    const store = (t.sandbox as any).stateStore();
    store.upsert("sites", "rover.com", {
      id: "rover.com", name: "Rover", startURLString: "https://www.rover.com",
      category: "petCare", goalTemplate: "Find work.",
    });
    store.upsert("accountStates", "rover.com", { siteID: "rover.com", state: "watching" });
    const delivery = mailDelivery({
      summary: {
        sender: "Rover", senderDomain: "rover.com", subject: "You have a new message",
        date: "2026-11-05T12:00:00Z", kind: "other",
        summary: "A client sent you a message about Friday.",
        actionableItems: [], attachments: [],
      },
      triage: {
        senderEmail: "noreply@rover.com", ownerVerified: false, senderAuthenticated: true,
        highlights: [{ kind: "client_message", label: "Someone may have messaged you" }],
        reading: {
          summary: "A client sent you a message about Friday.",
          mentions: [{ kind: "client_message", detail: "A client sent you a message" }],
          jobs: [],
          instruction: null,
        },
      },
    });
    const result = await (t.sandbox as any).handleEmailInbound(delivery);
    assert.equal(result.relation, "site");
    await t.drain();
    assert.equal(t.pushes.length, 1, "one backing push");
    assert.equal(t.pushes[0].kind, "message_waiting");
    assert.equal(t.pushes[0].refKind, "chat");
    const rows = t.messages();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].data.text, "Rover wrote about a message from a client.");
    assert.deepEqual(rows[0].data.context, { kind: "mail", id: rows[0].id }, "the backing message carries the embedded mail card");
  } finally {
    restore();
  }
});

test("draft/awaitingApproval: a fresh draft gets a composed message with task context + one push; a re-save does not re-message", async () => {
  const t = makeSandbox();
  const restore = stubModel("Your Rover signup draft is ready for your review.");
  try {
    const task = {
      ...BASE_TASK,
      id: "11111111-1111-4111-8111-111111111111",
      status: "awaiting_approval",
      mobile_task: {
        id: "11111111-1111-4111-8111-111111111111", kind: "signup", siteID: "rover.com",
        targetURLString: "https://www.rover.com/join", title: "Join Rover", goal: "Join Rover",
        draftedPayload: {}, status: "awaitingApproval", log: [], createdAt: Date.now() / 1000 - 978307200,
      },
    };
    (t.sandbox as any).saveTask(task);
    await t.drain();
    const messageId = "draft-chat-11111111-1111-4111-8111-111111111111";
    const row = t.message(messageId);
    assert.ok(row, "the draft message is written");
    assert.equal(row.text, "Your Rover signup draft is ready for your review.");
    assert.deepEqual(row.context, { kind: "task", taskId: "11111111-1111-4111-8111-111111111111" });
    assert.equal(t.pushes.length, 1, "one push for the draft");
    assert.equal(t.pushes[0].kind, "needs_you");
    assert.equal(t.pushes[0].refId, messageId);
    // A re-save of the same draft (already awaiting approval) is
    // not a fresh entry: no second message, no second push.
    (t.sandbox as any).saveTask({ ...task });
    await t.drain();
    assert.equal(t.messages().length, 1);
    assert.equal(t.pushes.length, 1);
  } finally {
    restore();
  }
});

test("draft/awaitingApproval: a snapshot import never messages or pushes", async () => {
  const t = makeSandbox();
  const restore = stubModel("Must never be composed.");
  try {
    const task = {
      ...BASE_TASK,
      id: "22222222-2222-4222-8222-222222222222",
      status: "awaiting_approval",
      _fromSnapshot: true,
      mobile_task: {
        id: "22222222-2222-4222-8222-222222222222", kind: "signup", siteID: "rover.com",
        targetURLString: "https://www.rover.com/join", title: "Join Rover", goal: "Join Rover",
        draftedPayload: {}, status: "awaitingApproval", log: [], createdAt: Date.now() / 1000 - 978307200,
      },
    };
    (t.sandbox as any).saveTask(task);
    await t.drain();
    assert.equal(t.messages().length, 0);
    assert.equal(t.pushes.length, 0);
  } finally {
    restore();
  }
});

test("saveTask push is gated on the mirror row existing: an empty help message pushes nothing", async () => {
  const t = makeSandbox();
  const restore = stubModel("Must never be composed.");
  try {
    const task = {
      ...BASE_TASK,
      id: "33333333-3333-4333-8333-333333333333",
      status: "needsHuman",
      help: { id: "44444444-4444-4444-8444-444444444444", kind: "information", message: "   ", questions: [], actionLabel: "Continue", deadline: null },
      mobile_task: {
        id: "33333333-3333-4333-8333-333333333333", kind: "signup", siteID: "rover.com",
        targetURLString: "https://www.rover.com/join", title: "Join Rover", goal: "Join Rover",
        draftedPayload: {}, status: "needsHuman", log: [], createdAt: Date.now() / 1000 - 978307200,
      },
    };
    (t.sandbox as any).saveTask(task);
    await t.drain();
    assert.equal(t.messages().length, 0, "no relay text, no message row");
    assert.equal(t.pushes.length, 0, "no message row, no push");
  } finally {
    restore();
  }
});

test("static help: the mirror writes the literal, then the upgrade composes it and pushes the composed words", async () => {
  const t = makeSandbox();
  const restore = stubModel("Rover's session ended — I can open a new one and check where we left off.");
  try {
    const task = {
      ...BASE_TASK,
      id: "55555555-5555-4555-8555-555555555555",
      status: "needsHuman",
      help: help("recovery", "This browser session ended before we finished. I can open a new session and check where we left off, or you can stop here.", [], "Open new session", null, { staticText: true }),
      mobile_task: {
        id: "55555555-5555-4555-8555-555555555555", kind: "signup", siteID: "rover.com",
        targetURLString: "https://www.rover.com/join", title: "Join Rover", goal: "Join Rover",
        draftedPayload: {}, status: "needsHuman", log: [], createdAt: Date.now() / 1000 - 978307200,
      },
    };
    (t.sandbox as any).saveTask(task);
    // The mirror wrote synchronously; the push waits for the composer.
    assert.equal(t.messages().length, 1, "the literal relay is written at once");
    assert.equal(t.messages()[0].data.text, "This browser session ended before we finished. I can open a new session and check where we left off, or you can stop here.");
    assert.equal(t.pushes.length, 0, "no push until the composition lands");
    await t.drain();
    assert.equal(t.messages().length, 1, "the upgrade replaces the text, it does not duplicate the message");
    assert.equal(t.messages()[0].data.text, "Rover's session ended — I can open a new one and check where we left off.");
    assert.equal(t.pushes.length, 1, "one push, with the composed words");
    assert.equal(t.pushes[0].body, "Rover's session ended — I can open a new one and check where we left off.");
  } finally {
    restore();
  }
});

test("static help, composition failure: the literal stays, its push goes out, and the failure is reported", async () => {
  const t = makeSandbox();
  const restore = stubModelFailure();
  try {
    const task = {
      ...BASE_TASK,
      id: "66666666-6666-4666-8666-666666666666",
      status: "needsHuman",
      help: help("recovery", "This browser session ended before we finished. I can open a new session and check where we left off, or you can stop here.", [], "Open new session", null, { staticText: true }),
      mobile_task: {
        id: "66666666-6666-4666-8666-666666666666", kind: "signup", siteID: "rover.com",
        targetURLString: "https://www.rover.com/join", title: "Join Rover", goal: "Join Rover",
        draftedPayload: {}, status: "needsHuman", log: [], createdAt: Date.now() / 1000 - 978307200,
      },
    };
    (t.sandbox as any).saveTask(task);
    await t.drain();
    assert.equal(t.messages().length, 1);
    assert.equal(t.messages()[0].data.text, "This browser session ended before we finished. I can open a new session and check where we left off, or you can stop here.", "the documented fallback keeps the literal");
    assert.equal(t.pushes.length, 1, "the fallback push still goes out");
    assert.match(t.pushes[0].body, /This browser session ended/);
    const failures = t.eventsOfKind("chat-composer-failure");
    assert.equal(failures.length, 1, "the failure is observable server-side, not just a log line");
    assert.equal(failures[0].surface, "help");
    assert.equal(failures[0].reason, "compose_failed");
  } finally {
    restore();
  }
});

test("transcript chain: consecutive messages carry previousResponseId pointing at the prior message", async () => {
  const t = makeSandbox();
  const restore = stubModel("Composed follow-up question.");
  try {
    // First message: the mirror, on an empty transcript — no predecessor.
    const first = {
      ...BASE_TASK,
      id: "77777777-7777-4777-8777-777777777777",
      status: "needsHuman",
      help: help("information", "What city should I search in?", [{ text: "Which city?" }]),
      mobile_task: {
        id: "77777777-7777-4777-8777-777777777777", kind: "signup", siteID: "rover.com",
        targetURLString: "https://www.rover.com/join", title: "Join Rover", goal: "Join Rover",
        draftedPayload: {}, status: "needsHuman", log: [], createdAt: Date.now() / 1000 - 978307200,
      },
    };
    (t.sandbox as any).saveTask(first);
    const firstId = first.help.id;
    assert.equal(t.message(firstId).previousResponseId, null, "the first message has no predecessor");
    // Second message: a composer path (mail question) — it chains to the mirror.
    await (t.sandbox as any).handleEmailInbound(mailDelivery());
    await t.drain();
    const rows = t.messages();
    assert.equal(rows.length, 2);
    const second = rows.find((r: any) => r.id !== firstId)!;
    assert.equal(second.data.previousResponseId, firstId, "the composer message points at the mirror message");
    // Third message: another mirror — it chains to the composer message.
    const third = {
      ...BASE_TASK,
      id: "88888888-8888-4888-8888-888888888888",
      status: "needsHuman",
      help: help("verification", "Finish the check on Rover."),
      mobile_task: {
        id: "88888888-8888-4888-8888-888888888888", kind: "signup", siteID: "rover.com",
        targetURLString: "https://www.rover.com/join", title: "Join Rover", goal: "Join Rover",
        draftedPayload: {}, status: "needsHuman", log: [], createdAt: Date.now() / 1000 - 978307200,
      },
    };
    (t.sandbox as any).saveTask(third);
    assert.equal(t.message(third.help.id).previousResponseId, second.id, "the next mirror points at the composer message");
  } finally {
    restore();
  }
});

test("expiry: a lapsed deadline notifies once, and a later tick does not re-fire", async () => {
  const t = makeSandbox();
  const restore = stubModel("The Rover signup check expired — it is still in your feed to review or dismiss.");
  try {
    const deadline = new Date("2026-11-05T18:00:00.000Z").toISOString();
    const task = {
      ...BASE_TASK,
      id: "99999999-9999-4999-8999-999999999999",
      status: "needsHuman",
      help: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", kind: "verification",
        message: "Finish the check on Rover before it expires.", questions: [],
        actionLabel: "Complete check", deadline,
      },
      mobile_task: {
        id: "99999999-9999-4999-8999-999999999999", kind: "signup", siteID: "rover.com",
        targetURLString: "https://www.rover.com/join", title: "Join Rover", goal: "Join Rover",
        draftedPayload: {}, status: "needsHuman", log: [], createdAt: Date.now() / 1000 - 978307200,
      },
    };
    // Seed realistically, through saveTask as the mission path
    // would: the help is mirrored (+1 message, +1 push) when the
    // task first becomes needsHuman, so the expiry notice is the
    // SECOND message. Seeding the tasks table directly would make
    // the flag-setting saveTask inside notifyExpiredCards write
    // that mirror itself — a side effect of the test seed, not of
    // the expiry path.
    (t.sandbox as any).saveTask(task);
    await t.drain();
    const messagesBefore = t.messages().length;
    const pushesBefore = t.pushes.length;
    const later = new Date("2026-11-05T19:00:00.000Z");
    await (t.sandbox as any).notifyExpiredCards(later);
    await t.drain();
    const messageId = "expiry-chat-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const row = t.message(messageId);
    assert.ok(row, "the expiry message is written");
    assert.equal(row.text, "The Rover signup check expired — it is still in your feed to review or dismiss.");
    assert.deepEqual(row.context, { kind: "task", taskId: "99999999-9999-4999-8999-999999999999" });
    assert.equal(t.messages().length, messagesBefore + 1, "the expiry notice is exactly one new message");
    assert.equal(t.pushes.length, pushesBefore + 1, "one push for the expiry");
    assert.equal(t.pushes[t.pushes.length - 1].refId, messageId);
    const stored = t.taskRow(task.id);
    assert.equal(stored.expiryNotifiedFor, deadline, "the dedupe flag names the deadline it fired for");
    assert.ok(stored.expiryNotifiedAt, "the flag carries the notice time");
    // A later tick: the flag holds, so nothing re-fires.
    await (t.sandbox as any).notifyExpiredCards(new Date("2026-11-06T19:00:00.000Z"));
    await t.drain();
    assert.equal(t.messages().filter((m: any) => m.id === messageId).length, 1);
    assert.equal(t.messages().length, messagesBefore + 1);
    assert.equal(t.pushes.length, pushesBefore + 1);
  } finally {
    restore();
  }
});

test("expiry: already-acted-on cards, deadline-free cards, and scan episodes never trigger", async () => {
  const t = makeSandbox();
  const restore = stubModel("Must never be composed.");
  try {
    // Direct seeding is correct here: notifyExpiredCards skips
    // every one of these before any saveTask, so no mirror can
    // fire for them — the assertions below are on the expiry path
    // alone.
    const deadline = new Date("2026-11-05T18:00:00.000Z").toISOString();
    const withHelp = (id: string, status: string, extra: any = {}) => ({
      ...BASE_TASK, id, status,
      help: {
        id: `help-${id.slice(0, 8)}`, kind: "verification",
        message: "Finish the check.", questions: [], actionLabel: "Complete check", deadline,
      },
      mobile_task: {
        id, kind: "signup", siteID: "rover.com",
        targetURLString: "https://www.rover.com/join", title: "Join Rover", goal: "Join Rover",
        draftedPayload: {}, status, log: [], createdAt: Date.now() / 1000 - 978307200,
      },
      ...extra,
    });
    // Acted on: succeeded (the card is gone from the feed).
    t.seedTask(withHelp("a0000000-0000-4000-8000-000000000001", "succeeded"));
    // No deadline: needsHuman with a null deadline.
    t.seedTask({
      ...withHelp("a0000000-0000-4000-8000-000000000002", "needsHuman"),
      help: { id: "help-a0000002", kind: "verification", message: "Finish the check.", questions: [], actionLabel: "Complete check", deadline: null },
    });
    // Scan episode: a scheduled-scan mission's needsHuman card.
    t.seedTask(withHelp("a0000000-0000-4000-8000-000000000003", "needsHuman", { scheduled_scan: true }));
    // Rejected: the user already dismissed it.
    t.seedTask(withHelp("a0000000-0000-4000-8000-000000000004", "rejected"));
    await (t.sandbox as any).notifyExpiredCards(new Date("2026-11-05T19:00:00.000Z"));
    await t.drain();
    assert.equal(t.messages().length, 0, "no expiry message for any of these");
    assert.equal(t.pushes.length, 0, "no expiry push for any of these");
  } finally {
    restore();
  }
});

test("expiry: a draft with an explicit deadline fires once", async () => {
  const t = makeSandbox();
  const restore = stubModel("The Rover signup draft expired — it is still in your feed to review or dismiss.");
  try {
    const deadline = new Date("2026-11-05T18:00:00.000Z").toISOString();
    const task = {
      ...BASE_TASK,
      id: "b0000000-0000-4000-8000-000000000001",
      status: "awaiting_approval",
      deadline,
      mobile_task: {
        id: "b0000000-0000-4000-8000-000000000001", kind: "signup", siteID: "rover.com",
        targetURLString: "https://www.rover.com/join", title: "Join Rover", goal: "Join Rover",
        draftedPayload: {}, status: "awaitingApproval", log: [], createdAt: Date.now() / 1000 - 978307200,
      },
    };
    // Seed realistically, through saveTask: the draft's own
    // ready-message is composed first (background), then the
    // expiry notice is a second, distinct message. Baselines
    // keep the assertions on the expiry path alone.
    (t.sandbox as any).saveTask(task);
    await t.drain();
    const messagesBefore = t.messages().length;
    const pushesBefore = t.pushes.length;
    await (t.sandbox as any).notifyExpiredCards(new Date("2026-11-05T19:00:00.000Z"));
    await t.drain();
    const row = t.message("expiry-chat-b0000000-0000-4000-8000-000000000001");
    assert.ok(row, "the draft's expiry message is written");
    assert.equal(t.messages().length, messagesBefore + 1, "the expiry notice is exactly one new message");
    assert.equal(t.pushes.length, pushesBefore + 1, "one push for the expiry");
    assert.equal(t.taskRow(task.id).expiryNotifiedFor, deadline);
  } finally {
    restore();
  }
});

test("expiry: a failed composition still sets the flag — no message, no push, no re-fire", async () => {
  const t = makeSandbox();
  const restore = stubModelFailure();
  try {
    const deadline = new Date("2026-11-05T18:00:00.000Z").toISOString();
    const task = {
      ...BASE_TASK,
      id: "c0000000-0000-4000-8000-000000000001",
      status: "needsHuman",
      help: {
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", kind: "verification",
        message: "Finish the check on Rover.", questions: [],
        actionLabel: "Complete check", deadline,
      },
      mobile_task: {
        id: "c0000000-0000-4000-8000-000000000001", kind: "signup", siteID: "rover.com",
        targetURLString: "https://www.rover.com/join", title: "Join Rover", goal: "Join Rover",
        draftedPayload: {}, status: "needsHuman", log: [], createdAt: Date.now() / 1000 - 978307200,
      },
    };
    // Seed realistically, through saveTask: the help is mirrored
    // when the task first becomes needsHuman, so a failed expiry
    // composition must add nothing on top of that baseline.
    (t.sandbox as any).saveTask(task);
    await t.drain();
    const messagesBefore = t.messages().length;
    const pushesBefore = t.pushes.length;
    await (t.sandbox as any).notifyExpiredCards(new Date("2026-11-05T19:00:00.000Z"));
    await t.drain();
    assert.equal(t.messages().length, messagesBefore, "exactly-once wins: no notice is ever written for this deadline");
    assert.equal(t.pushes.length, pushesBefore);
    assert.equal(t.taskRow(task.id).expiryNotifiedFor, deadline, "the flag is set before composition, so a retry cannot double-send");
    const failures = t.eventsOfKind("chat-composer-failure");
    assert.equal(failures.length, 1);
    assert.equal(failures[0].surface, "expiry");
    // A later tick still does not re-fire.
    await (t.sandbox as any).notifyExpiredCards(new Date("2026-11-06T19:00:00.000Z"));
    await t.drain();
    assert.equal(t.messages().length, messagesBefore);
    assert.equal(t.pushes.length, pushesBefore);
  } finally {
    restore();
  }
});
