// Brief 07 push-notification tests: APNs ES256 JWT with a generated
// throwaway key, the sender against a fake fetch, device-token
// registration auth/isolation, trigger gating (paused / no token /
// one-per-batch / fresh needsHuman only), payload minimalism, and
// push_log accounting. No live APNs, no real key, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  APNS_JWT_TTL_MS, ApnsJwtCache, MemoryPushDb, apnsConfigFromEnv, apnsHostFor,
  buildPushPayload, consecutiveFailures, handleDeviceTokenRequest, importApnsKey,
  isBadTokenResult, needsHumanEvent, normalizeDeviceToken, notifyUser,
  pemToPkcs8, planTickNotifications, sendToToken, shouldNotifyNeedsHuman,
  signApnsJwt, type ApnsConfig, type PushFetch,
} from "../src/push.ts";

const TOKEN_A = "a".repeat(64);
const TOKEN_B = "b".repeat(64);
const AT = "2026-11-02T07:00:00.000Z";

async function testKey() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"],
  );
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  const b64 = Buffer.from(pkcs8).toString("base64");
  const pem = `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)?.join("\n")}\n-----END PRIVATE KEY-----`;
  return { pair, pem, b64 };
}

function testConfig(pem: string, host = "api.sandbox.push.apple.com"): ApnsConfig {
  return { keyP8: pem, keyId: "KEYID12345", teamId: "3KA38L8A4F", bundleId: "app.usehygge", host };
}

function fakeFetch(responder: (url: string, init: RequestInit, call: number) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn: PushFetch = async (url, init) => {
    calls.push({ url, init });
    return responder(url, init, calls.length);
  };
  return { fetchFn, calls };
}

const okResponse = () => new Response(null, { status: 200, headers: { "apns-id": "test" } });
const errResponse = (status: number, reason: string) =>
  new Response(JSON.stringify({ reason }), { status, headers: { "content-type": "application/json" } });

function b64urlDecode(text: string): Uint8Array {
  const padded = text.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (text.length % 4)) % 4);
  return Uint8Array.from(Buffer.from(padded, "base64"));
}

// ---- JWT -----------------------------------------------------------------

test("APNs JWT: ES256 header/claims verify against the generated test key", async () => {
  const { pair, pem } = await testKey();
  const key = await importApnsKey(pem);
  const nowSec = 1_762_000_000;
  const jwt = await signApnsJwt(key, { keyId: "KEYID12345", teamId: "3KA38L8A4F" }, nowSec);
  const [header, payload, signature] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(b64urlDecode(header)).toString("utf8")),
    { alg: "ES256", kid: "KEYID12345" });
  assert.deepEqual(JSON.parse(Buffer.from(b64urlDecode(payload)).toString("utf8")),
    { iss: "3KA38L8A4F", iat: nowSec });
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" }, pair.publicKey, b64urlDecode(signature),
    new TextEncoder().encode(`${header}.${payload}`),
  );
  assert.equal(valid, true);
});

test("PEM parsing accepts armor, literal \\n secrets, and bare base64", async () => {
  const { pem, b64 } = await testKey();
  assert.equal(pemToPkcs8(pem).byteLength > 0, true);
  const oneLine = pem.replaceAll("\n", "\\n");
  assert.deepEqual(pemToPkcs8(oneLine), pemToPkcs8(pem));
  assert.deepEqual(pemToPkcs8(b64), pemToPkcs8(pem));
  // A secret pasted in the one-line form still signs.
  const jwt = await signApnsJwt(await importApnsKey(oneLine), { keyId: "K", teamId: "T" }, 1);
  assert.equal(jwt.split(".").length, 3);
});

test("JWT cache reuses within the hour and re-mints after the TTL", async () => {
  const { pem } = await testKey();
  const cache = new ApnsJwtCache();
  const config = testConfig(pem);
  const t0 = 1_762_000_000_000;
  const first = await cache.token(config, t0);
  assert.equal(await cache.token(config, t0 + 60_000), first);
  const refreshed = await cache.token(config, t0 + APNS_JWT_TTL_MS + 1);
  assert.notEqual(refreshed, first);
  const claims = JSON.parse(Buffer.from(b64urlDecode(refreshed.split(".")[1])).toString("utf8"));
  assert.equal(claims.iat, Math.floor((t0 + APNS_JWT_TTL_MS + 1) / 1000));
});

test("APNs config: missing pieces mean unconfigured; host follows environment", () => {
  assert.equal(apnsHostFor("sandbox"), "api.sandbox.push.apple.com");
  assert.equal(apnsHostFor("production"), "api.push.apple.com");
  assert.equal(apnsHostFor(undefined), "api.push.apple.com");
  assert.equal(apnsConfigFromEnv({}), null);
  assert.equal(apnsConfigFromEnv({ HYGGE_APNS_KEY_P8: "k", HYGGE_APNS_KEY_ID: "id" }), null);
  assert.equal(apnsConfigFromEnv({ HYGGE_APNS_KEY_P8: "  ", HYGGE_APNS_KEY_ID: "id", HYGGE_APNS_TEAM_ID: "t" }), null);
  const cfg = apnsConfigFromEnv({
    HYGGE_APNS_KEY_P8: "k", HYGGE_APNS_KEY_ID: "id", HYGGE_APNS_TEAM_ID: "t",
    HYGGE_APNS_ENVIRONMENT: "sandbox", HYGGE_APPLE_BUNDLE_ID: "app.usehygge",
  });
  assert.equal(cfg?.host, "api.sandbox.push.apple.com");
  assert.equal(cfg?.bundleId, "app.usehygge");
});

// ---- payload --------------------------------------------------------------

test("payload is title + reference only, with no room for sensitive fields", () => {
  const needs = buildPushPayload(needsHumanEvent("task-1"));
  assert.deepEqual(Object.keys(needs).sort(), ["aps", "hyggeKind", "hyggeRef", "hyggeRoute"]);
  assert.deepEqual(Object.keys(needs.aps).sort(), ["alert", "sound"]);
  assert.equal(typeof needs.aps.alert, "string"); // title only: no body can exist
  assert.equal(needs.aps.alert, "Hygge needs you");
  assert.equal(needs.hyggeRoute, "task/task-1");
  const work = buildPushPayload({ kind: "new_work", refKind: "feed", refId: "item-1" });
  assert.equal(work.aps.alert, "New work found");
  assert.equal(work.hyggeRoute, "feed/item-1");
  assert.equal(buildPushPayload({ kind: "new_work", refKind: "feed", refId: null }).hyggeRoute, "home");
  for (const payload of [needs, work]) {
    const serialized = JSON.stringify(payload).toLowerCase();
    for (const banned of ["password", "secret", "code", "token", "credential", "body", "subject", "pay", "$", "£"]) {
      assert.equal(serialized.includes(banned), false, `payload must not contain ${banned}: ${serialized}`);
    }
  }
});

// ---- trigger gating ---------------------------------------------------------

test("needsHuman notifies only on a fresh, non-scan transition", () => {
  assert.equal(shouldNotifyNeedsHuman("approved", "needsHuman"), true);
  assert.equal(shouldNotifyNeedsHuman("awaiting_approval", "needsHuman"), true);
  assert.equal(shouldNotifyNeedsHuman("needsHuman", "needsHuman"), false);
  assert.equal(shouldNotifyNeedsHuman("approved", "succeeded"), false);
  assert.equal(shouldNotifyNeedsHuman("approved", "needsHuman", { scheduledScan: true }), false);
});

test("a scan tick plans at most one push; needs-you wins; paused/empty plan none", () => {
  assert.deepEqual(planTickNotifications({ paused: true, surfacedIds: ["s1"], needsYouItemIds: ["n1"] }), []);
  assert.deepEqual(planTickNotifications({ paused: false, surfacedIds: [], needsYouItemIds: [] }), []);
  assert.deepEqual(planTickNotifications({ paused: false, surfacedIds: ["s1", "s2"], needsYouItemIds: [] }),
    [{ kind: "new_work", refKind: "feed", refId: "s1" }]);
  const both = planTickNotifications({ paused: false, surfacedIds: ["s1"], needsYouItemIds: ["n1", "n2"] });
  assert.equal(both.length, 1);
  assert.deepEqual(both[0], { kind: "needs_you", refKind: "feed", refId: "n1" });
});

// ---- token registration -------------------------------------------------------

test("device tokens: hex-only normalization", () => {
  assert.equal(normalizeDeviceToken(TOKEN_A.toUpperCase()), TOKEN_A);
  assert.equal(normalizeDeviceToken(`<${TOKEN_A}>`), TOKEN_A);
  assert.equal(normalizeDeviceToken("not-hex"), null);
  assert.equal(normalizeDeviceToken("ab12"), null);
  assert.equal(normalizeDeviceToken(""), null);
  assert.equal(normalizeDeviceToken(undefined), null);
});

function tokenRequest(method: string, path: string, body?: unknown) {
  return new Request(`https://api.test${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("register / update / list / unregister round-trip, own tokens only", async () => {
  const db = new MemoryPushDb();
  const registered = await handleDeviceTokenRequest(tokenRequest("POST", "/device-tokens", { token: TOKEN_A }), "user-1", db);
  assert.equal(registered.status, 201);
  // The response never echoes the token back.
  assert.equal((await registered.text()).includes(TOKEN_A), false);
  // Re-registering updates the same row (token rotation / reinstall).
  const again = await handleDeviceTokenRequest(
    tokenRequest("POST", "/device-tokens", { token: TOKEN_A, platform: "ios" }), "user-1", db,
    new Date("2026-11-03T07:00:00.000Z"),
  );
  assert.equal(again.status, 201);
  assert.equal((await db.listTokens("user-1")).length, 1);
  assert.equal((await db.listTokens("user-1"))[0].updatedAt, "2026-11-03T07:00:00.000Z");

  // Isolation: user-2 sees none of user-1's tokens, and deleting the
  // same token string as user-2 leaves user-1's row standing.
  const otherList = await (await handleDeviceTokenRequest(tokenRequest("GET", "/device-tokens"), "user-2", db)).json() as { tokens: unknown[] };
  assert.equal(otherList.tokens.length, 0);
  const foreignDelete = await (await handleDeviceTokenRequest(
    tokenRequest("DELETE", `/device-tokens/${TOKEN_A}`), "user-2", db)).json() as { removed: boolean };
  assert.equal(foreignDelete.removed, false);
  assert.equal((await db.listTokens("user-1")).length, 1);

  const mine = await (await handleDeviceTokenRequest(tokenRequest("GET", "/device-tokens"), "user-1", db)).json() as { tokens: { token: string }[] };
  assert.equal(mine.tokens[0].token, TOKEN_A);
  const removed = await (await handleDeviceTokenRequest(
    tokenRequest("DELETE", "/device-tokens", { token: TOKEN_A }), "user-1", db)).json() as { removed: boolean };
  assert.equal(removed.removed, true);
  assert.equal((await db.listTokens("user-1")).length, 0);
});

test("registration rejects malformed tokens and platforms", async () => {
  const db = new MemoryPushDb();
  assert.equal((await handleDeviceTokenRequest(tokenRequest("POST", "/device-tokens", { token: "nope" }), "u", db)).status, 400);
  assert.equal((await handleDeviceTokenRequest(tokenRequest("POST", "/device-tokens", {}), "u", db)).status, 400);
  assert.equal((await handleDeviceTokenRequest(
    tokenRequest("POST", "/device-tokens", { token: TOKEN_A, platform: "android" }), "u", db)).status, 400);
  assert.equal((await handleDeviceTokenRequest(tokenRequest("DELETE", "/device-tokens", {}), "u", db)).status, 400);
  assert.equal((await db.listTokens("u")).length, 0);
});

// ---- sender + notifyUser -----------------------------------------------------

async function seededDb() {
  const db = new MemoryPushDb();
  await db.upsertToken("user-1", TOKEN_A, "ios", AT);
  return db;
}

test("sendToToken posts the APNs request APNs expects", async () => {
  const { pem } = await testKey();
  const { fetchFn, calls } = fakeFetch(okResponse);
  const result = await sendToToken(testConfig(pem), "jwt-here", TOKEN_A, buildPushPayload(needsHumanEvent("t1")), fetchFn);
  assert.equal(result.ok, true);
  assert.equal(calls[0].url, `https://api.sandbox.push.apple.com/3/device/${TOKEN_A}`);
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.authorization, "bearer jwt-here");
  assert.equal(headers["apns-topic"], "app.usehygge");
  assert.equal(headers["apns-push-type"], "alert");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), buildPushPayload(needsHumanEvent("t1")));
});

test("bad-token verdicts: 410 and BadDeviceToken/Unregistered only", () => {
  assert.equal(isBadTokenResult({ ok: false, status: 410, reason: "Unregistered" }), true);
  assert.equal(isBadTokenResult({ ok: false, status: 410, reason: null }), true);
  assert.equal(isBadTokenResult({ ok: false, status: 400, reason: "BadDeviceToken" }), true);
  assert.equal(isBadTokenResult({ ok: false, status: 500, reason: null }), false);
  assert.equal(isBadTokenResult({ ok: false, status: 429, reason: "TooManyRequests" }), false);
});

test("success is delivered once and logged ok", async () => {
  const { pem } = await testKey();
  const db = await seededDb();
  const { fetchFn, calls } = fakeFetch(okResponse);
  const result = await notifyUser(db, testConfig(pem), "user-1", needsHumanEvent("task-9"), { fetchFn, jwtCache: new ApnsJwtCache() });
  assert.deepEqual(result, { outcome: "sent", attempted: 1, delivered: 1, removedTokens: 0 });
  assert.equal(calls.length, 1);
  assert.deepEqual(db.log.map((r) => [r.kind, r.apnsStatus]), [["needs_you", "ok"]]);
  assert.equal((await db.listTokens("user-1")).length, 1);
});

test("410 deletes the token; a later event then attempts nothing for it", async () => {
  const { pem } = await testKey();
  const db = await seededDb();
  const { fetchFn, calls } = fakeFetch(() => errResponse(410, "Unregistered"));
  const cache = new ApnsJwtCache();
  const first = await notifyUser(db, testConfig(pem), "user-1", needsHumanEvent("task-9"), { fetchFn, jwtCache: cache });
  assert.deepEqual(first, { outcome: "failed", attempted: 1, delivered: 0, removedTokens: 1 });
  assert.equal((await db.listTokens("user-1")).length, 0);
  assert.deepEqual(db.log.map((r) => r.apnsStatus), ["410:Unregistered"]);
  const second = await notifyUser(db, testConfig(pem), "user-1", needsHumanEvent("task-10"), { fetchFn, jwtCache: cache });
  assert.equal(second.outcome, "no_tokens");
  assert.equal(calls.length, 1); // never sent to the dead token again
});

test("BadDeviceToken deletes; other errors keep the token, counted once, no retry", async () => {
  const { pem } = await testKey();
  const db = await seededDb();
  await db.upsertToken("user-1", TOKEN_B, "ios", AT);
  const { fetchFn, calls } = fakeFetch((url) =>
    url.endsWith(TOKEN_A) ? errResponse(400, "BadDeviceToken") : errResponse(500, "InternalServerError"));
  const result = await notifyUser(db, testConfig(pem), "user-1",
    { kind: "new_work", refKind: "feed", refId: "item-1" }, { fetchFn, jwtCache: new ApnsJwtCache() });
  assert.deepEqual(result, { outcome: "failed", attempted: 2, delivered: 0, removedTokens: 1 });
  assert.equal(calls.length, 2); // exactly one attempt per token
  assert.deepEqual((await db.listTokens("user-1")).map((t) => t.token), [TOKEN_B]);
  assert.deepEqual(db.log.map((r) => r.apnsStatus).sort(), ["400:BadDeviceToken", "500:InternalServerError"]);
});

test("a network error is counted, the token kept, and nothing pretends success", async () => {
  const { pem } = await testKey();
  const db = await seededDb();
  const fetchFn: PushFetch = async () => { throw new Error("unreachable"); };
  const result = await notifyUser(db, testConfig(pem), "user-1", needsHumanEvent("task-9"), { fetchFn, jwtCache: new ApnsJwtCache() });
  assert.deepEqual(result, { outcome: "failed", attempted: 1, delivered: 0, removedTokens: 0 });
  assert.deepEqual(db.log.map((r) => r.apnsStatus), ["network_error"]);
  assert.equal((await db.listTokens("user-1")).length, 1);
});

test("unconfigured is a logged no-op: zero fetches, never a fake success", async () => {
  const db = await seededDb();
  const { fetchFn, calls } = fakeFetch(okResponse);
  const result = await notifyUser(db, null, "user-1", needsHumanEvent("task-9"), { fetchFn });
  assert.deepEqual(result, { outcome: "unconfigured", attempted: 0, delivered: 0, removedTokens: 0 });
  assert.equal(calls.length, 0);
  assert.deepEqual(db.log.map((r) => [r.kind, r.apnsStatus]), [["needs_you", "unconfigured"]]);
});

test("paused user and missing token each send nothing and log no attempt", async () => {
  const { pem } = await testKey();
  const db = await seededDb();
  const { fetchFn, calls } = fakeFetch(okResponse);
  const paused = await notifyUser(db, testConfig(pem), "user-1", needsHumanEvent("t"), { fetchFn, isPaused: true });
  assert.equal(paused.outcome, "paused");
  const noToken = await notifyUser(db, testConfig(pem), "user-without-tokens", needsHumanEvent("t"), { fetchFn });
  assert.equal(noToken.outcome, "no_tokens");
  assert.equal(calls.length, 0);
  assert.equal(db.log.length, 0);
});

test("repeated failures suppress further sends instead of storming", async () => {
  const { pem } = await testKey();
  const db = await seededDb();
  for (let i = 0; i < 5; i++) await db.logAttempt("user-1", "needs_you", "500:InternalServerError");
  assert.equal(consecutiveFailures(await db.recentLog("user-1", 10)), 5);
  const { fetchFn, calls } = fakeFetch(okResponse);
  const result = await notifyUser(db, testConfig(pem), "user-1", needsHumanEvent("t"), { fetchFn, jwtCache: new ApnsJwtCache() });
  assert.equal(result.outcome, "suppressed");
  assert.equal(calls.length, 0);
  assert.equal(db.log.at(-1)?.apnsStatus, "suppressed");
});

test("every attempt lands in push_log, success and failure alike", async () => {
  const { pem } = await testKey();
  const db = await seededDb();
  await db.upsertToken("user-1", TOKEN_B, "ios", AT);
  const { fetchFn } = fakeFetch((url) => (url.endsWith(TOKEN_A) ? okResponse() : errResponse(429, "TooManyRequests")));
  const result = await notifyUser(db, testConfig(pem), "user-1",
    { kind: "new_work", refKind: "feed", refId: "i" }, { fetchFn, jwtCache: new ApnsJwtCache() });
  assert.equal(result.outcome, "partial");
  assert.equal(db.log.length, 2);
  assert.deepEqual(db.log.map((r) => r.apnsStatus).sort(), ["429:TooManyRequests", "ok"]);
  // Log rows carry kind + status only: no token, no payload contents.
  for (const row of db.log) {
    assert.deepEqual(Object.keys(row).sort(), ["apnsStatus", "createdAt", "kind", "userId"]);
    assert.equal(JSON.stringify(row).includes(TOKEN_A), false);
  }
});
