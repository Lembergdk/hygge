import test from "node:test";
import assert from "node:assert/strict";
import { handlePurgeRequest, purgeAllUsers, PURGE_CONFIRMATION, type PurgeDeps } from "../src/purge.ts";

function fakeDeps(overrides: Partial<PurgeDeps> = {}): PurgeDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async listUsers() { calls.push("users"); return [{ id: "u1" }, { id: "u2" }]; },
    async listTables() { return ["users", "linked_methods", "site_catalog", "brand_new_table", "d1_migrations"]; },
    async deleteFromTable(table) { calls.push(`delete:${table}`); return 3; },
    async purgeSandbox(userId) { calls.push(`do:${userId}`); return userId !== "u2"; },
    async emptyBucket() { calls.push("r2"); return 5; },
    ...overrides,
  };
}

const ENV = { HYGGE_ENV: "staging", HYGGE_PURGE_TOKEN: "test-token" } as any;

function purgeRequest(token: string | null, body: unknown): Request {
  return new Request("https://api.test/admin/purge-users", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

test("purge route is inert without the secret, and rejects wrong token/confirmation", async () => {
  const deps = fakeDeps();
  const noSecret = await handlePurgeRequest(purgeRequest("test-token", { confirm: PURGE_CONFIRMATION }), { HYGGE_ENV: "staging" } as any, deps);
  assert.equal(noSecret.status, 404);
  const wrongToken = await handlePurgeRequest(purgeRequest("nope", { confirm: PURGE_CONFIRMATION }), ENV, deps);
  assert.equal(wrongToken.status, 404);
  const noConfirm = await handlePurgeRequest(purgeRequest("test-token", {}), ENV, deps);
  assert.equal(noConfirm.status, 400);
  assert.deepEqual(deps.calls, []); // nothing ran
});

test("purgeAllUsers wipes DOs first, then R2, then D1 children-before-users incl. drift tables", async () => {
  const deps = fakeDeps();
  const report = await purgeAllUsers(ENV, deps);
  assert.equal(report.users, 2);
  assert.equal(report.durableObjectsPurged, 1);
  assert.equal(report.durableObjectFailures, 1);
  assert.equal(report.r2ObjectsDeleted, 10); // two buckets x fake 5
  assert.equal(report.d1RowsDeleted, 12); // 4 existing tables x 3
  const order = deps.calls.filter((c) => c.startsWith("delete:"));
  assert.deepEqual(order, ["delete:linked_methods", "delete:site_catalog", "delete:users", "delete:brand_new_table"]);
  assert.ok(deps.calls.indexOf("do:u1") < deps.calls.indexOf("r2"));
  assert.ok(deps.calls.indexOf("r2") < deps.calls.indexOf("delete:linked_methods"));
  assert.ok(!report.d1Tables.includes("d1_migrations"));
});

test("authorized purge request returns counts only", async () => {
  const deps = fakeDeps({ async purgeSandbox() { return true; } });
  const res = await handlePurgeRequest(purgeRequest("test-token", { confirm: PURGE_CONFIRMATION }), ENV, deps);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.users, 2);
  assert.equal(body.durableObjectsPurged, 2);
  assert.equal(body.durableObjectFailures, 0);
});
