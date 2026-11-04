// Pricing scheme, server side: StoreKit transaction decoding
// (fields checked; signature-chain verification is the noted
// hardening follow-up), tier lookup, custom email names, and the
// free-plan rest the scheduled scans honor.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MemorySubscriptionDb,
  activeTier,
  decodeStoreKitTransaction,
} from "../src/subscriptions.ts";
import { validateEmailAlias } from "../src/email.ts";
import { monthlyLoggedEarnings } from "../src/scan.ts";
import { USER_ROUTES } from "../src/env.ts";

test("router admits the D1-side endpoint prefixes (regression: subscriptions shipped unreachable)", () => {
  // A handler behind a missing prefix 404s however correct it is.
  // /subscriptions and /subscriptions/status did exactly that in
  // production until this fix.
  for (const prefix of ["/subscriptions", "/email", "/device-tokens"]) {
    assert.ok(USER_ROUTES.includes(prefix), `${prefix} must be in USER_ROUTES`);
  }
  const admitted = (path: string) =>
    USER_ROUTES.some((r) => path === r || path.startsWith(r + "/"));
  assert.equal(admitted("/subscriptions"), true);
  assert.equal(admitted("/subscriptions/status"), true);
  assert.equal(admitted("/email/alias"), true);
});

function fakeJws(payload: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "ES256", x5c: ["fake"] })}.${enc(payload)}.fakesignature`;
}

const FUTURE = Date.parse("2027-01-01T00:00:00Z");
const NOW = new Date("2026-11-15T12:00:00Z");

test("StoreKit transactions decode only for the right product, bundle, and future expiry", () => {
  const good = decodeStoreKitTransaction(fakeJws({
    bundleId: "app.usehygge", productId: "app.usehygge.plus.monthly",
    originalTransactionId: "1000001", expiresDate: FUTURE, environment: "Production",
  }), { now: NOW, environment: "production" });
  assert.equal(good?.productId, "app.usehygge.plus.monthly");
  assert.equal(good?.originalTransactionId, "1000001");

  const base = { bundleId: "app.usehygge", productId: "app.usehygge.plus.monthly", expiresDate: FUTURE, environment: "Production" };
  assert.equal(decodeStoreKitTransaction(fakeJws({ ...base, productId: "other" }), { now: NOW, environment: "production" }), null);
  assert.equal(decodeStoreKitTransaction(fakeJws({ ...base, bundleId: "com.evil" }), { now: NOW, environment: "production" }), null);
  assert.equal(decodeStoreKitTransaction(fakeJws({ ...base, expiresDate: NOW.getTime() - 1 }), { now: NOW, environment: "production" }), null);
  assert.equal(decodeStoreKitTransaction(fakeJws({ ...base, environment: "Sandbox" }), { now: NOW, environment: "production" }), null);
  assert.equal(decodeStoreKitTransaction("not-a-jws", { now: NOW, environment: "production" }), null);
});

test("tier is plus only while a recorded subscription is unexpired", async () => {
  const db = new MemorySubscriptionDb();
  assert.equal(await activeTier(db, "user-1", NOW), "free");
  await db.upsert({
    userId: "user-1", productId: "app.usehygge.plus.monthly",
    originalTransactionId: "1000001", environment: "Production",
    expiresAt: new Date(FUTURE).toISOString(),
  });
  assert.equal(await activeTier(db, "user-1", NOW), "plus");
  assert.equal(await activeTier(db, "user-1", new Date(FUTURE + 1000)), "free");
  assert.equal(await activeTier(db, "someone-else", NOW), "free");
});

test("custom email names: shape, reserved words, and the digit space", () => {
  assert.equal(validateEmailAlias(" Mikael.L "), "mikael.l");
  assert.equal(validateEmailAlias("lemberg-works"), "lemberg-works");
  assert.equal(validateEmailAlias("ab"), null);
  assert.equal(validateEmailAlias("4839201847"), null);      // digits space stays digits-only
  assert.equal(validateEmailAlias("login"), null);           // reserved
  assert.equal(validateEmailAlias("support"), null);
  assert.equal(validateEmailAlias("-mikael"), null);
  assert.equal(validateEmailAlias("mikael..l"), null);
  assert.equal(validateEmailAlias("mikael@x"), null);
});

test("free-plan rest math counts witnessed completions in the UTC month", () => {
  const rows = [
    { kind: "workCompleted", grossAmount: 60, occurredAt: "2026-11-03T10:00:00.000Z" },
    { kind: "workCompleted", grossAmount: 52, occurredAt: "2026-11-28T10:00:00.000Z" },
    { kind: "workCompleted", grossAmount: 200, occurredAt: "2026-10-31T23:00:00.000Z" },
    { kind: "booked", grossAmount: 500, occurredAt: "2026-11-10T10:00:00.000Z" },
    { kind: "workCompleted", grossAmount: null, occurredAt: "2026-11-10T10:00:00.000Z" },
  ];
  assert.equal(monthlyLoggedEarnings(rows, NOW), 112);
  assert.equal(monthlyLoggedEarnings(rows, new Date("2026-12-01T00:00:00Z")), 0);
});
