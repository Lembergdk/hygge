// Identity tests: Apple sign-in + email magic links (passwords are gone).
// Run via npm test (node --test test/*.mts).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AuthProblem,
  MAGIC_LINK_MAX_SENDS_PER_HOUR,
  MAGIC_LINK_TTL_MS,
  appleAppSiteAssociation,
  appleSignIn,
  consumeMagicLink,
  handleAuthRequest,
  linkApple,
  requestMagicLink,
  resolveSessionUserId,
  revokeSession,
  unlinkMethod,
  verifyAppleIdentityToken,
  type AuthDb,
  type AuthSessionRow,
  type LinkedMethodRow,
  type MagicLinkRow,
} from "../src/auth.ts";

class MemDb {
  users = new Map<string, { id: string; contactEmail: string | null; displayName: string | null }>();
  methods = new Map<string, LinkedMethodRow>();
  sessions = new Map<string, AuthSessionRow>();
  magic = new Map<string, MagicLinkRow>();

  async createUser(u: { id: string; contactEmail: string | null; displayName: string | null }) {
    this.users.set(u.id, u);
  }
  async findAppleMethod(sub: string) {
    return [...this.methods.values()].find((m) => m.appleSub === sub) ?? null;
  }
  async findEmailMethod(email: string) {
    return [...this.methods.values()].find((m) => m.email === email) ?? null;
  }
  async getMethodById(id: string) {
    return this.methods.get(id) ?? null;
  }
  async listMethods(userId: string) {
    return [...this.methods.values()].filter((m) => m.userId === userId);
  }
  async addMethod(row: LinkedMethodRow) {
    for (const m of this.methods.values()) {
      if (row.appleSub && m.appleSub === row.appleSub) throw new Error("UNIQUE apple_sub");
      if (row.email && m.email === row.email) throw new Error("UNIQUE email");
    }
    this.methods.set(row.id, row);
  }
  async deleteMethod(id: string) {
    this.methods.delete(id);
  }
  async markEmailVerifiedAndClearPassword(id: string) {
    const m = this.methods.get(id);
    if (m) { m.emailVerified = true; m.passwordHash = null; }
  }
  async createSession(row: AuthSessionRow) {
    this.sessions.set(row.tokenHash, row);
  }
  async findSessionByHash(tokenHash: string) {
    return this.sessions.get(tokenHash) ?? null;
  }
  async revokeSessionByHash(tokenHash: string, revokedAt: string) {
    const s = this.sessions.get(tokenHash);
    if (s) s.revokedAt = revokedAt;
  }
  async revokeAllSessions(userId: string, revokedAt: string) {
    for (const s of this.sessions.values()) if (s.userId === userId && !s.revokedAt) s.revokedAt = revokedAt;
  }
  magicRequests: Array<{ ipHash: string; at: string }> = [];
  async countMagicRequestsByIpSince(ipHash: string, since: string) {
    return this.magicRequests.filter((r) => r.ipHash === ipHash && r.at >= since).length;
  }
  async recordMagicRequest(ipHash: string, at: string) {
    this.magicRequests.push({ ipHash, at });
  }
  async createMagicLink(row: MagicLinkRow) {
    this.magic.set(row.tokenHash, row);
  }
  async findMagicLinkByHash(tokenHash: string) {
    return this.magic.get(tokenHash) ?? null;
  }
  async invalidateMagicLinks(email: string, at: string) {
    for (const r of this.magic.values()) if (r.email === email && !r.consumedAt) r.consumedAt = at;
  }
  async countMagicLinksSince(email: string, since: string) {
    return [...this.magic.values()].filter((r) => r.email === email && r.createdAt >= since).length;
  }
  async consumeMagicLink(tokenHash: string, at: string) {
    const r = this.magic.get(tokenHash);
    if (!r || r.consumedAt) return false;
    r.consumedAt = at;
    return true;
  }
}

async function problem(promise: Promise<unknown>): Promise<AuthProblem> {
  try {
    await promise;
  } catch (e) {
    assert.ok(e instanceof AuthProblem, `expected AuthProblem, got ${e}`);
    return e;
  }
  assert.fail("expected AuthProblem");
}

// ---- Apple JWT fixtures ---------------------------------------------------

const BUNDLE = "app.usehygge";
const NOW = 1_800_000_000;

function b64url(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return Buffer.from(bytes).toString("base64url");
}

async function appleFixture() {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const kid = "test-key-1";
  const fetchJwks = async () => ({ keys: [{ ...jwk, kid }] });
  async function sign(claims: Record<string, unknown>, key: CryptoKey = pair.privateKey): Promise<string> {
    const header = b64url(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
    const payload = b64url(JSON.stringify(claims));
    const sig = new Uint8Array(
      await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${payload}`)),
    );
    return `${header}.${payload}.${b64url(sig)}`;
  }
  const base = {
    iss: "https://appleid.apple.com",
    aud: BUNDLE,
    exp: NOW + 600,
    iat: NOW,
    sub: "apple-sub-1",
    email: "Sam@Example.com",
    is_private_email: false,
  };
  return { pair, fetchJwks, sign, base };
}

test("apple JWT: valid token verifies to its sub", async () => {
  const f = await appleFixture();
  const claims = await verifyAppleIdentityToken(await f.sign(f.base), {
    bundleId: BUNDLE,
    nowSeconds: NOW,
    fetchJwks: f.fetchJwks,
  });
  assert.equal(claims.sub, "apple-sub-1");
  assert.equal(claims.email, "sam@example.com");
  assert.equal(claims.isPrivateEmail, false);
});

test("apple JWT: expired, wrong audience, wrong issuer, tampered all reject", async () => {
  const f = await appleFixture();
  const opts = { bundleId: BUNDLE, nowSeconds: NOW, fetchJwks: f.fetchJwks };
  assert.equal((await problem(verifyAppleIdentityToken(await f.sign({ ...f.base, exp: NOW - 1 }), opts))).code, "apple_token_expired");
  assert.equal((await problem(verifyAppleIdentityToken(await f.sign({ ...f.base, aud: "app.other" }), opts))).code, "wrong_audience");
  assert.equal((await problem(verifyAppleIdentityToken(await f.sign({ ...f.base, iss: "https://evil.example" }), opts))).code, "wrong_issuer");
  const good = await f.sign(f.base);
  const tampered = good.slice(0, -2) + (good.endsWith("A") ? "BC" : "AB");
  assert.equal((await problem(verifyAppleIdentityToken(tampered, opts))).code, "invalid_apple_token");
  const other = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  assert.equal((await problem(verifyAppleIdentityToken(await f.sign(f.base, other.privateKey), opts))).code, "invalid_apple_token");
  assert.equal((await problem(verifyAppleIdentityToken(good, { nowSeconds: NOW, fetchJwks: f.fetchJwks }))).code, "apple_not_configured");
  assert.equal(
    (await problem(verifyAppleIdentityToken(await f.sign({ ...f.base, nonce: "n-1" }), { ...opts, nonce: "n-2" }))).code,
    "nonce_mismatch",
  );
});

// ---- magic-link helpers ---------------------------------------------------

const BASE = "https://api.test";
// Sessions are issued at wall-clock now, so the magic-link clock must
// start there too for expiry checks to line up.
const T0 = Date.now();

function mailTrap() {
  const sent: { to: string; from: string; subject: string; text: string; html: string }[] = [];
  return {
    sent,
    send: async (m: { to: string; from: string; subject: string; text: string; html: string }) => { sent.push(m); },
    tokenAt(i: number): string {
      const match = sent[i]?.text.match(/token=([A-Za-z0-9_-]+)/);
      assert.ok(match, "mail carries a token link");
      return decodeURIComponent(match[1]);
    },
  };
}

async function requestAndToken(db: AuthDb & MemDb, email: string, nowMs = T0) {
  const trap = mailTrap();
  await requestMagicLink(db, email, { nowMs, baseUrl: BASE, send: trap.send });
  assert.equal(trap.sent.length, 1);
  return trap.tokenAt(0);
}

test("magic request stores only the hash and mails from the login sender", async () => {
  const db = new MemDb() as unknown as AuthDb & MemDb;
  const trap = mailTrap();
  await requestMagicLink(db, "  Sam@Example.COM ", { nowMs: T0, baseUrl: BASE, send: trap.send });
  assert.equal(trap.sent.length, 1);
  assert.equal(trap.sent[0].to, "sam@example.com");
  assert.equal(trap.sent[0].from, "Hygge <login@usehygge.app>");
  assert.ok(trap.sent[0].text.includes(`${BASE}/auth/magic?token=`));
  const token = trap.tokenAt(0);
  const rows = [...db.magic.values()];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].email, "sam@example.com");
  assert.ok(!JSON.stringify(rows[0]).includes(token), "raw token never stored");
  assert.match(rows[0].tokenHash, /^[0-9a-f]{64}$/);
  assert.equal(Date.parse(rows[0].expiresAt) - T0, MAGIC_LINK_TTL_MS);
});

test("magic request: generic outcome for invalid and unknown emails alike", async () => {
  const db = new MemDb() as unknown as AuthDb & MemDb;
  const trap = mailTrap();
  // Invalid format: resolves quietly, nothing stored or sent.
  await requestMagicLink(db, "not an email", { nowMs: T0, baseUrl: BASE, send: trap.send });
  assert.equal(trap.sent.length, 0);
  assert.equal(db.magic.size, 0);
  // Unknown (no account yet) still gets a link: consume creates the account.
  await requestMagicLink(db, "new@example.com", { nowMs: T0, baseUrl: BASE, send: trap.send });
  assert.equal(trap.sent.length, 1);
  assert.equal(db.users.size, 0, "request alone creates no user");
});

test("magic request invalidates earlier unconsumed links for the email", async () => {
  const db = new MemDb() as unknown as AuthDb & MemDb;
  const first = await requestAndToken(db, "sam@example.com");
  const second = await requestAndToken(db, "sam@example.com", T0 + 1000);
  assert.equal((await problem(consumeMagicLink(db, first, { nowMs: T0 + 2000 }))).code, "invalid_magic_link");
  const outcome = await consumeMagicLink(db, second, { nowMs: T0 + 2000 });
  assert.equal(outcome.kind, "session");
});

test("magic request rate limit: beyond the hourly cap nothing more is sent", async () => {
  const db = new MemDb() as unknown as AuthDb & MemDb;
  const trap = mailTrap();
  for (let i = 0; i < MAGIC_LINK_MAX_SENDS_PER_HOUR; i++) {
    await requestMagicLink(db, "sam@example.com", { nowMs: T0 + i * 1000, baseUrl: BASE, send: trap.send });
  }
  assert.equal(trap.sent.length, MAGIC_LINK_MAX_SENDS_PER_HOUR);
  await requestMagicLink(db, "sam@example.com", { nowMs: T0 + 60_000, baseUrl: BASE, send: trap.send });
  assert.equal(trap.sent.length, MAGIC_LINK_MAX_SENDS_PER_HOUR, "capped send is silent");
  // An hour later the window opens again.
  await requestMagicLink(db, "sam@example.com", { nowMs: T0 + 61 * 60 * 1000, baseUrl: BASE, send: trap.send });
  assert.equal(trap.sent.length, MAGIC_LINK_MAX_SENDS_PER_HOUR + 1);
});

test("magic consume creates a verified account, then finds the same one", async () => {
  const db = new MemDb() as unknown as AuthDb & MemDb;
  const first = await consumeMagicLink(db, await requestAndToken(db, "Sam@Example.com"), { nowMs: T0 + 1000 });
  assert.equal(first.kind, "session");
  if (first.kind !== "session") assert.fail("expected session");
  assert.equal(first.result.isNewUser, true);
  assert.equal(first.result.methods[0].email, "sam@example.com");
  assert.equal(first.result.methods[0].emailVerified, true);
  assert.equal(await resolveSessionUserId(db, first.result.session.token, T0 + 2000), first.result.userId);
  // Case-insensitive: the next link lands on the same account.
  const second = await consumeMagicLink(db, await requestAndToken(db, "SAM@example.com", T0 + 3000), { nowMs: T0 + 4000 });
  assert.equal(second.kind, "session");
  if (second.kind !== "session") assert.fail("expected session");
  assert.equal(second.result.isNewUser, false);
  assert.equal(second.result.userId, first.result.userId);
});

test("magic consume clears a legacy password hash and verifies the email", async () => {
  const db = new MemDb() as unknown as AuthDb & MemDb;
  await db.createUser({ id: "u-legacy", contactEmail: "old@example.com", displayName: null });
  await db.addMethod({
    id: "m-legacy", userId: "u-legacy", method: "email", appleSub: null, appleEmail: null,
    email: "old@example.com", passwordHash: "legacy-hash", emailVerified: false,
  });
  const outcome = await consumeMagicLink(db, await requestAndToken(db, "old@example.com"), { nowMs: T0 + 1000 });
  assert.equal(outcome.kind, "session");
  const stored = db.methods.get("m-legacy");
  assert.equal(stored?.passwordHash, null);
  assert.equal(stored?.emailVerified, true);
});

test("magic consume: unknown, expired, and used links share one generic error", async () => {
  const db = new MemDb() as unknown as AuthDb & MemDb;
  const token = await requestAndToken(db, "sam@example.com");
  const unknown = await problem(consumeMagicLink(db, "never-issued", { nowMs: T0 + 1000 }));
  const expired = await problem(consumeMagicLink(db, token, { nowMs: T0 + MAGIC_LINK_TTL_MS + 1 }));
  await consumeMagicLink(db, token, { nowMs: T0 + 1000 });
  const used = await problem(consumeMagicLink(db, token, { nowMs: T0 + 1000 }));
  for (const p of [unknown, expired, used]) {
    assert.deepEqual(
      { status: p.status, code: p.code, message: p.publicMessage },
      { status: unknown.status, code: unknown.code, message: unknown.publicMessage },
    );
  }
});

test("magic consume is single-use even when two consumes race", async () => {
  const db = new MemDb() as unknown as AuthDb & MemDb;
  const token = await requestAndToken(db, "sam@example.com");
  const results = await Promise.allSettled([
    consumeMagicLink(db, token, { nowMs: T0 + 1000 }),
    consumeMagicLink(db, token, { nowMs: T0 + 1000 }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  assert.equal(db.users.size, 1);
});

test("magic link mode: a signed-in consume attaches the email; conflict errors", async () => {
  const db = new MemDb() as unknown as AuthDb & MemDb;
  const appleUser = await appleSignIn(db, { sub: "sub-a", email: null, isPrivateEmail: false });
  const token = await requestAndToken(db, "sam@example.com");
  const linked = await consumeMagicLink(db, token, { nowMs: T0 + 1000, sessionUserId: appleUser.userId });
  assert.equal(linked.kind, "linked");
  if (linked.kind !== "linked") assert.fail("expected linked");
  assert.deepEqual(linked.methods.map((m) => m.method).sort(), ["apple", "email"]);
  // Either way in now opens the same account.
  const viaEmail = await consumeMagicLink(db, await requestAndToken(db, "sam@example.com", T0 + 2000), { nowMs: T0 + 3000 });
  assert.equal(viaEmail.kind, "session");
  if (viaEmail.kind !== "session") assert.fail("expected session");
  assert.equal(viaEmail.result.userId, appleUser.userId);
  // Another account cannot take that email over.
  const other = await appleSignIn(db, { sub: "sub-b", email: null, isPrivateEmail: false });
  const conflictToken = await requestAndToken(db, "sam@example.com", T0 + 4000);
  const conflict = await problem(consumeMagicLink(db, conflictToken, { nowMs: T0 + 5000, sessionUserId: other.userId }));
  assert.equal(conflict.code, "already_linked");
  assert.equal((await db.listMethods(other.userId)).length, 1);
});

test("apple email claim (incl. private relay) never merges accounts", async () => {
  const db = new MemDb() as unknown as AuthDb & MemDb;
  const emailUser = await consumeMagicLink(db, await requestAndToken(db, "sam@example.com"), { nowMs: T0 + 1000 });
  assert.equal(emailUser.kind, "session");
  if (emailUser.kind !== "session") assert.fail("expected session");
  const appleUser = await appleSignIn(db, { sub: "sub-new", email: "sam@example.com", isPrivateEmail: false });
  assert.notEqual(appleUser.userId, emailUser.result.userId);
  const relayUser = await appleSignIn(db, { sub: "sub-relay", email: "abc@privaterelay.appleid.com", isPrivateEmail: true });
  assert.notEqual(relayUser.userId, emailUser.result.userId);
  assert.equal(db.users.get(relayUser.userId)?.contactEmail, null);
});

test("already-linked apple errors with no merge; last method stays; signout revokes", async () => {
  const db = new MemDb() as unknown as AuthDb & MemDb;
  const a = await appleSignIn(db, { sub: "sub-a", email: null, isPrivateEmail: false });
  const bOutcome = await consumeMagicLink(db, await requestAndToken(db, "other@example.com"), { nowMs: T0 + 1000 });
  assert.equal(bOutcome.kind, "session");
  if (bOutcome.kind !== "session") assert.fail("expected session");
  const b = bOutcome.result;
  assert.equal((await problem(linkApple(db, b.userId, { sub: "sub-a", email: null, isPrivateEmail: false }))).code, "already_linked");
  assert.equal((await db.listMethods(a.userId)).length, 1);
  assert.equal((await db.listMethods(b.userId)).length, 1);

  const only = b.methods[0];
  assert.equal((await problem(unlinkMethod(db, b.userId, only.id))).code, "last_method");
  const withApple = await linkApple(db, b.userId, { sub: "sub-b", email: null, isPrivateEmail: false });
  const appleMethod = withApple.find((m) => m.method === "apple")!;
  assert.deepEqual((await unlinkMethod(db, b.userId, appleMethod.id)).map((m) => m.method), ["email"]);

  assert.equal(await resolveSessionUserId(db, b.session.token, T0 + 2000), b.userId);
  await revokeSession(db, b.session.token, T0 + 3000);
  assert.equal(await resolveSessionUserId(db, b.session.token, T0 + 4000), null);
});

test("aasa points the app at /auth/magic", () => {
  const aasa = appleAppSiteAssociation();
  assert.deepEqual(aasa.applinks.details[0].appIDs, ["3KA38L8A4F.app.usehygge"]);
  assert.equal(aasa.applinks.details[0].components[0]["/"], "/auth/magic*");
});

// ---- HTTP surface ------------------------------------------------------------

function httpDb() {
  const db = new MemDb() as unknown as AuthDb & MemDb;
  const env = { HYGGE_ENV: "production", HYGGE_APPLE_BUNDLE_ID: BUNDLE, HYGGE_MAGIC_BASE_URL: BASE } as never;
  const trap = mailTrap();
  const post = (path: string, body: unknown, token = "", nowMs = T0) =>
    handleAuthRequest(
      new Request(`${BASE}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      }),
      env,
      db,
      { sendMagicEmail: trap.send, nowMs },
    );
  return { db, env, trap, post };
}

test("http: request answers identically for known, unknown, and invalid emails", async () => {
  const { trap, post } = httpDb();
  const answers: string[] = [];
  for (const email of ["sam@example.com", "ghost@example.com", "not an email"]) {
    const res = await post("/auth/email/request", { email });
    assert.equal(res.status, 200);
    answers.push(await res.text());
  }
  assert.equal(answers[0], answers[1]);
  assert.equal(answers[1], answers[2]);
  assert.equal(trap.sent.length, 2, "invalid format sends nothing but answers the same");
  assert.ok(!answers[0].includes("@"), "response echoes no email");
});

test("http: landing never consumes; consume signs in; signout revokes", async () => {
  const { db, env, trap, post } = httpDb();
  await post("/auth/email/request", { email: "sam@example.com" });
  const token = trap.tokenAt(0);
  const landing = await handleAuthRequest(
    new Request(`${BASE}/auth/magic?token=${encodeURIComponent(token)}`), env, db,
    { sendMagicEmail: trap.send, nowMs: T0 },
  );
  assert.equal(landing.status, 200);
  assert.equal(landing.headers.get("cache-control"), "no-store");
  assert.equal(landing.headers.get("referrer-policy"), "no-referrer");
  const html = await landing.text();
  assert.ok(html.includes("hygge://auth/magic?token="));
  assert.equal([...db.magic.values()][0].consumedAt, null, "GET never consumes");

  const consumed = await post("/auth/email/consume", { token }, "", T0 + 1000);
  assert.equal(consumed.status, 201);
  const session = (await consumed.json()) as { token: string };
  const mine = await handleAuthRequest(
    new Request(`${BASE}/auth/methods`, { headers: { authorization: `Bearer ${session.token}` } }), env, db,
  );
  assert.equal(mine.status, 200);
  const bad = await post("/auth/email/consume", { token: "nope" }, "", T0 + 1000);
  assert.equal(bad.status, 401);
  assert.equal((await post("/auth/signout", {}, session.token, T0 + 2000)).status, 200);
  const afterOut = await handleAuthRequest(
    new Request(`${BASE}/auth/methods`, { headers: { authorization: `Bearer ${session.token}` } }), env, db,
  );
  assert.equal(afterOut.status, 401);
});

test("http: password routes are gone", async () => {
  const { post } = httpDb();
  for (const path of ["/auth/email/signup", "/auth/email/signin", "/auth/password/change", "/auth/methods/link/email"]) {
    const res = await post(path, { email: "sam@example.com", password: "whatever whatever" });
    assert.equal(res.status, 404, path);
  }
});

test("magic link requests are capped per requester, not just per inbox", async () => {
  const { MAGIC_LINK_MAX_REQUESTS_PER_IP_PER_HOUR } = await import("../src/auth.ts");
  const db = new MemDb();
  const sent: unknown[] = [];
  const send = async (m: unknown) => { sent.push(m); };
  const baseUrl = "https://api-staging.usehygge.app";
  // One requester, many different inboxes: each is under the per-inbox
  // cap, so only the per-requester cap can stop the flood.
  for (let i = 0; i < MAGIC_LINK_MAX_REQUESTS_PER_IP_PER_HOUR; i++) {
    await requestMagicLink(db, `person${i}@example.com`, { send, baseUrl, requesterHash: "ip-a" });
  }
  assert.equal(sent.length, MAGIC_LINK_MAX_REQUESTS_PER_IP_PER_HOUR);
  await requestMagicLink(db, "one-more@example.com", { send, baseUrl, requesterHash: "ip-a" });
  assert.equal(sent.length, MAGIC_LINK_MAX_REQUESTS_PER_IP_PER_HOUR, "capped requester sends nothing more");
  await requestMagicLink(db, "one-more@example.com", { send, baseUrl, requesterHash: "ip-b" });
  assert.equal(sent.length, MAGIC_LINK_MAX_REQUESTS_PER_IP_PER_HOUR + 1, "a different requester is unaffected");
});
