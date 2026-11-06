// Agent-composed chat messages (policy Nov 5, 2026): prompt
// construction names only the given facts, output validation
// rejects empty/overlong/code-shaped text, and any failure returns
// null — never a canned string. A fake LLM client stands in for
// the model; no network, no key.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  composePrompt, createCardMessageComposer, recentChatContext, validateComposedText,
  type CardMessageInput,
} from "../src/chat-composer.ts";

function fakeClient(opts: {
  apiKey?: string | null;
  replies?: (string | Error)[];
  models?: string[];
} = {}) {
  const calls: { model: string; system: string; user: string }[] = [];
  let n = 0;
  return {
    calls,
    client: {
      cfg: {
        apiKey: opts.apiKey === undefined ? "test-key" : (opts.apiKey ?? undefined),
        baseUrl: "https://example.invalid",
        modelFast: "muse-spark-1.3",
        modelStrong: "muse-wonder-1.0",
      },
      complete: async ({ model, system, user }: { model: string; system: string; user: string }) => {
        calls.push({ model, system, user });
        const next = (opts.replies ?? ["Composed message."])[n++] ?? "Composed message.";
        if (next instanceof Error) throw next;
        return next;
      },
    } as never,
  };
}

test("the prompt names only the given facts and forbids invention", () => {
  const input: CardMessageInput = {
    surface: "offer",
    facts: { site: "Rover", listing: "Weekend dog sitting", pay: "£25/night", place: "Leeds", moreListings: "1" },
    recentChat: ["Earlier you asked about dog walking."],
  };
  const { system, user } = composePrompt(input);
  assert.match(system, /never invent/);
  assert.match(system, /Never include a code, password/);
  for (const fact of ["Rover", "Weekend dog sitting", "£25/night", "Leeds", "1"]) {
    assert.ok(user.includes(fact), `prompt names the fact ${fact}`);
  }
  assert.ok(user.includes("Earlier you asked about dog walking."), "recent chat is supplied as tone context");
  // Nothing else is asserted as fact: no invented site, date, or amount appears.
  assert.equal(user.includes("Upwork"), false);
  assert.equal(user.includes("tomorrow"), false);
});

test("the prompt differs per surface but keeps the same guardrails", () => {
  const mail = composePrompt({ surface: "mail", facts: { site: "Rover", subject: "New message", summary: "A client asked about Friday." } });
  assert.match(mail.user, /tracked job site/);
  const question = composePrompt({ surface: "mail-question", facts: { sender: "rover.com", subject: "Two roles" } });
  assert.match(question.user, /needs the user's decision/);
  for (const { system } of [mail, question]) assert.match(system, /never invent/);
});

test("composition uses the drafting tier (wonder) and returns the model text", async () => {
  const { client, calls } = fakeClient({ replies: ["I found weekend dog sitting on Rover."] });
  const compose = createCardMessageComposer(client)!;
  assert.equal(await compose({ surface: "offer", facts: { site: "Rover", listing: "Weekend dog sitting" } }), "I found weekend dog sitting on Rover.");
  assert.equal(calls[0].model, "muse-wonder-1.0", "drafting user-facing text uses wonder-1.0");
});

test("an unconfigured client means no composer — never a canned fallback", () => {
  assert.equal(createCardMessageComposer(null), null);
  const { client } = fakeClient({ apiKey: null });
  assert.equal(createCardMessageComposer(client), null);
});

test("one retry, then null: failure, empty, overlong, and code-shaped replies all fail closed", async () => {
  const failing = fakeClient({ replies: [new Error("boom"), new Error("boom")] });
  assert.equal(await createCardMessageComposer(failing.client)!({ surface: "offer", facts: {} }), null);
  assert.equal(failing.calls.length, 2, "one retry, then give up");

  const empty = fakeClient({ replies: ["  ", ""] });
  assert.equal(await createCardMessageComposer(empty.client)!({ surface: "offer", facts: {} }), null);
  assert.equal(empty.calls.length, 2);

  const overlong = fakeClient({ replies: ["x".repeat(601), "y".repeat(601)] });
  assert.equal(await createCardMessageComposer(overlong.client)!({ surface: "offer", facts: {} }), null);

  const coded = fakeClient({ replies: ["Your code is 731904, enter it now", "Your code is 731904, enter it now"] });
  assert.equal(await createCardMessageComposer(coded.client)!({ surface: "mail", facts: { site: "Rover" } }), null, "a code must never travel in a message");

  const recovers = fakeClient({ replies: [new Error("boom"), "Second try worked."] });
  assert.equal(await createCardMessageComposer(recovers.client)!({ surface: "offer", facts: {} }), "Second try worked.");
  assert.equal(recovers.calls.length, 2);
});

test("validateComposedText: trims, caps length, rejects codes and non-strings", () => {
  assert.equal(validateComposedText("  Hello.  "), "Hello.");
  assert.equal(validateComposedText(""), null);
  assert.equal(validateComposedText("   "), null);
  assert.equal(validateComposedText(null), null);
  assert.equal(validateComposedText(42), null);
  assert.equal(validateComposedText("x".repeat(600)), "x".repeat(600));
  assert.equal(validateComposedText("x".repeat(601)), null);
  assert.equal(validateComposedText("call me at 731904"), null);
  assert.equal(validateComposedText("£25 a night is fine"), "£25 a night is fine", "short digit runs (pay labels) are not codes");
});

test("recentChatContext takes the last few message texts, oldest first, truncated", () => {
  const rows = [
    { data: { text: "first" } },
    { data: { text: "second" } },
    { data: {} },
    { data: { text: "   " } },
    { data: { text: "third" } },
    { data: { text: "x".repeat(300) } },
  ];
  const out = recentChatContext(rows, 3);
  assert.deepEqual(out, ["second", "third", "x".repeat(200)], "blank and missing texts drop out; long texts truncate");
  assert.deepEqual(recentChatContext([]), []);
});
