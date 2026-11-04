// Model-led chat intent: the model decides what the user wants
// done; validation against the app-supplied context decides
// whether it may run. Invented ids, unknown kinds, and junk all
// fall back to plain conversation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chatSiteCandidates, chatIntent, validateChatIntent, validateChatIntentList } from "../src/onboarding.ts";

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
  const client = {
    configured: true,
    cfg: { modelFast: "m-fast" },
    complete: async () => JSON.stringify({ action: { kind: "email", mailId: "mail-1", act: true } }),
  };
  const out = await chatIntent({
    client,
    transcript: [{ fromAgent: false, text: "do something about that forwarded email" }],
    context: CONTEXT,
  });
  assert.deepEqual(out.action, { kind: "email", mailId: "mail-1", act: true });
  assert.equal(out.simulated, false);
});

test("chatIntent falls back to conversation when unconfigured or unparseable", async () => {
  const unconfigured = { configured: false, cfg: { modelFast: "m-fast" }, complete: async () => "{}" };
  const off = await chatIntent({ client: unconfigured, transcript: [], context: CONTEXT });
  assert.equal(off.action, null);
  assert.equal(off.simulated, true);

  const junk = { configured: true, cfg: { modelFast: "m-fast" }, complete: async () => "sure thing!" };
  const bad = await chatIntent({ client: junk, transcript: [], context: CONTEXT });
  assert.equal(bad.action, null);
  assert.equal(bad.simulated, false);
});


test("valid actions after junk survive before the five-action cap", () => {
  assert.deepEqual(validateChatIntentList({ actions: [null, {}, 1, false, { kind: "bad" },
    { kind: "scan", siteId: "rover" }] }, CONTEXT), [{ kind: "scan", siteId: "rover" }]);
});

test("both is grounded by candidates and returns both actions without singular fallback", async () => {
  const candidates = [{ name: "Contra", domain: "contra.com", siteId: null },
    { name: "Toptal", domain: "toptal.com", siteId: null }];
  const client = { configured: true, cfg: { modelFast: "m-fast" }, complete: async (args: any) => {
    const payload = JSON.parse(args.user);
    assert.deepEqual(payload.context.candidates, candidates);
    assert.match(payload.conversation, /Contra and Toptal/);
    assert.match(payload.conversation, /both/);
    return JSON.stringify({ actions: candidates.map((c) => ({ kind: "add", domain: c.domain })) });
  }};
  const out = await chatIntent({ client, context: { ...CONTEXT, candidates }, transcript: [
    { fromAgent: true, text: "Should I add Contra and Toptal?" }, { fromAgent: false, text: "both" }
  ] });
  assert.equal(out.action, null);
  assert.deepEqual(out.actions, [{ kind: "add", domain: "contra.com" }, { kind: "add", domain: "toptal.com" }]);
});

test("a one-item action list also fills the legacy singular field", async () => {
  const client = { configured: true, cfg: { modelFast: "m-fast" }, complete: async () =>
    JSON.stringify({ actions: [{ kind: "scan", siteId: "rover" }] }) };
  const out = await chatIntent({ client, context: CONTEXT });
  assert.deepEqual(out.action, { kind: "scan", siteId: "rover" });
});

test("candidates prefer open proposals, exclude approved sites, retain untracked inventory", () => {
  assert.deepEqual(chatSiteCandidates([
    { name: "Rover", domain: "rover.com", siteId: "rover", tracked: true },
    { name: "Contra inventory", domain: "contra.com", siteId: "contra", tracked: false }
  ], [{ name: "Contra proposal", domain: "contra.com", siteId: "contra" }], [
    { name: "Rover", domain: "www.rover.com", siteId: null },
    { name: "Contra catalog", domain: "contra.com", siteId: null },
    { name: "Toptal", domain: "toptal.com", siteId: null }
  ]), [{ name: "Contra proposal", domain: "contra.com", siteId: "contra" },
    { name: "Toptal", domain: "toptal.com", siteId: null }]);
});
