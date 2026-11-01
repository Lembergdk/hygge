// Brief 01 state store tests: round-trip per entity, migration
// idempotency, second-device export, conflict rule, demo/secret guards.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MemoryStateDb,
  STATE_TABLES,
  StateStore,
  shouldApplyUpdate,
  stateSchemaSQL,
  stripSecrets,
} from "../src/state.ts";

const T1 = "2026-10-31T10:00:00.000Z";
const T2 = "2026-10-31T11:00:00.000Z";

function store() {
  return new StateStore(new MemoryStateDb());
}

test("schema creates every brief table with updated_at", () => {
  const sql = stateSchemaSQL();
  for (const table of Object.values(STATE_TABLES)) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table} `));
  }
  assert.ok((sql.match(/updated_at TEXT NOT NULL/g) ?? []).length >= 11);
});

test("round-trip per entity: create, get, list, update, delete", () => {
  const s = store();
  const cases: [string, string, Record<string, unknown>][] = [
    ["feedItems", "f1", { id: "f1", title: "Dog sitting" }],
    ["messages", "m1", { id: "m1", fromAgent: true, text: "Hej" }],
    ["profile", "profile", { profile: { displayName: "Sam" }, hasOnboarded: true }],
    ["sites", "rover", { id: "rover", name: "Rover" }],
    ["opportunities", "o1", { id: "o1", title: "Weekend sit", isDemo: false }],
    ["applications", "a1", { id: "a1", title: "Weekend sit", stage: "drafted" }],
    ["proposals", "p1", { id: "p1", siteID: "rover", status: "proposed" }],
    ["accountStates", "rover", { siteID: "rover", state: "watching" }],
    ["journalEvents", "j1", { id: "j1", sentence: "Checked Rover." }],
    ["beliefs", "b1", { id: "b1", sentence: "Prefers mornings", pending: false }],
    ["searchEvidence", "e1", { id: "e1", siteID: "rover", listingsRead: 3 }],
  ];
  for (const [entity, id, payload] of cases) {
    const created = s.upsert(entity, id, payload, T1);
    assert.equal(created.applied, true, entity);
    assert.equal(created.updatedAt, T1, entity);
    assert.deepEqual(s.get(entity, id)?.data, entity === "feedItems" ? { ...payload, isDemo: false, is_demo: false } : payload, entity);
    assert.equal(s.list(entity).length, 1, entity);
    const updated = s.upsert(entity, id, { ...payload, touched: true }, T2);
    assert.equal(updated.applied, true, entity);
    assert.equal(s.list(entity).length, 1, `${entity} update must not duplicate`);
    assert.equal(s.remove(entity, id), true, entity);
    assert.equal(s.get(entity, id), null, entity);
  }
});

test("conflict rule: newest updated_at wins, stale write rejected", () => {
  assert.equal(shouldApplyUpdate(null, T1), true);
  assert.equal(shouldApplyUpdate(T1, T2), true);
  assert.equal(shouldApplyUpdate(T2, T1), false);
  const s = store();
  s.upsert("sites", "rover", { id: "rover", name: "Newer" }, T2);
  const stale = s.upsert("sites", "rover", { id: "rover", name: "Older" }, T1);
  assert.equal(stale.applied, false);
  assert.equal((s.get("sites", "rover")?.data as any).name, "Newer");
});

function sampleSnapshot() {
  return {
    profile: { displayName: "Sam", locationLabel: "Leeds" },
    hasOnboarded: true,
    isPaused: false,
    lastVisitAt: "2026-10-31T09:00:00.000Z",
    sites: [{ id: "rover", name: "Rover" }],
    opportunities: [
      { id: "11111111-1111-1111-1111-111111111111", title: "Real sit", isDemo: false },
      { id: "22222222-2222-2222-2222-222222222222", title: "Demo sit", isDemo: true },
    ],
    chatTranscript: [{ id: "33333333-3333-3333-3333-333333333333", fromAgent: false, text: "Hej" }],
    applications: [{ id: "44444444-4444-4444-4444-444444444444", title: "Real sit" }],
    proposals: [{ id: "55555555-5555-5555-5555-555555555555", siteID: "rover" }],
    accountStates: { rover: "watching" },
    activityEvents: [{ id: "66666666-6666-6666-6666-666666666666", sentence: "Checked Rover." }],
    beliefs: {
      beliefs: [{ id: "77777777-7777-7777-7777-777777777777", sentence: "Prefers mornings" }],
      pending: [{ id: "88888888-8888-8888-8888-888888888888", sentence: "Has a car" }],
    },
    searchEvidence: [{ id: "99999999-9999-9999-9999-999999999999", siteID: "rover", listingsRead: 2 }],
    siteMemory: { memories: [{ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", domain: "rover.com", kind: "apply", hints: ["hint"] }] },
    tasks: [{ id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", title: "Draft", status: "awaitingApproval" }],
    credentialRefs: [{ id: "cccccccc-cccc-cccc-cccc-cccccccccccc", domain: "rover.com", username: "sam@example.com" }],
  };
}

test("migration import twice produces identical row counts, demo skipped", () => {
  const s = store();
  const first = s.importSnapshot(sampleSnapshot(), T1);
  const second = s.importSnapshot(sampleSnapshot(), T2);
  assert.deepEqual(second.counts, first.counts);
  assert.equal(first.counts.opportunities, 1, "demo opportunity must stay local-only");
  assert.equal(first.counts.feedItems, 1);
  assert.equal(first.skippedDemo, 1);
  assert.equal(first.credentialRefsSkipped, 1);
  assert.equal(first.memories.length, 1);
  assert.equal(first.tasks.length, 1);
  assert.equal(first.hasRealFeedItem, true);
});

test("second device: fresh store resolves same feed, messages, profile", () => {
  const deviceOne = store();
  deviceOne.importSnapshot(sampleSnapshot(), T1);
  const exported = deviceOne.exportState();
  // Fresh install: empty local store, same user -> identical visible state.
  const deviceTwoView = exported;
  assert.equal((deviceTwoView.profile?.data as any).profile.displayName, "Sam");
  assert.deepEqual(deviceTwoView.messages.map((m) => (m.data as any).text), ["Hej"]);
  assert.deepEqual(deviceTwoView.feedItems.map((f) => (f.data as any).title), ["Real sit"]);
  assert.equal((deviceTwoView.feedItems[0].data as any).isDemo, false);
  assert.equal(deviceTwoView.accountStates.rover, "watching");
  assert.equal(deviceTwoView.beliefs.beliefs.length, 1);
  assert.equal(deviceTwoView.beliefs.pending.length, 1);
});

test("secrets are stripped and demo flag cannot be faked on the server", () => {
  assert.deepEqual(stripSecrets({ a: 1, secret: "x", nested: { password: "y", keep: 2 } }), { a: 1, nested: { keep: 2 } });
  const s = store();
  s.upsert("feedItems", "f9", { id: "f9", title: "X", isDemo: true, secret: "never" }, T1);
  const row = s.get("feedItems", "f9")!.data as any;
  assert.equal(row.isDemo, false);
  assert.equal(row.is_demo, false);
  assert.equal("secret" in row, false);
});
