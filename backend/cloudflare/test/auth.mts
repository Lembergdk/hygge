// Brief 00 identity tests. Run via npm test (node --test test/*.mts).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AuthProblem,
  appleSignIn,
  changePassword,
  emailSignIn,
  emailSignUp,
  handleAuthRequest,
  hashPassword,
  linkApple,
  linkEmail,
  resolveSessionUserId,
  revokeSession,
  unlinkMethod,
  verifyAppleIdentityToken,
  verifyPassword,
  type AuthDb,
  type AuthSessionRow,
  type LinkedMethodRow,
} from "../src/auth.ts";

const FAST = { iterations: 1000 };
const PASSWORD = "correct horse battery"; // test fixture, not a real credential

class MemDb {
  users = new Map<string, { id: string; contactEmail: string | null; displayName: string | null }>();
  methods = new Map<string, LinkedMethodRow>();
  sessions = new Map<string, AuthSessionRow>();
  attempts: { email: string; success: boolean; at: string }[] = [];

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
  async updateMethodPassword(id: string, passwordHash: string) {
    const m = this.methods.get(id);
    if (m) m.passwordHash = passwordHash;
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
  async recordAttempt(email: string, success: boolean, at: string) {
    this.attempts.push({ email, success, at });
  }
  async countRecentFailures(email: string, since: string) {
    return this.attempts.filter((a) => a.email === email && !a.success && a.at >= since).length;
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

// ---- password + email flows -----------------------------------------------

test("password hashing verifies, rejects wrong, never stores plaintext", async () => {
  const hash = await hashPassword(PASSWORD, FAST);
  assert.ok(hash.startsWith("pbkdf2-sha256$1000$"));
  assert.ok(!hash.includes(PASSWORD));
  assert.equal(await verifyPassword(PASSWORD, hash), true);
  assert.equal(await verifyPassword("wrong wrong wrong", hash), false);
  assert.equal(await verifyPassword(PASSWORD, "garbage"), false);
});

test("email signup then signin (case-insensitive) resolve to same user", async () => {
  const db = new MemDb() as unknown as AuthDb & MemDb;
  const up = await emailSignUp(db, "  Sam@Example.COM ", PASSWORD, { hash: FAST });
  assert.equal(up.isNewUser, true);
  const stored = [...db.methods.values()][0];
  assert.ok(stored?.passwordHash && !stored.passwordHash.includes(PASSWORD));
  assert.ok(!JSON.stringify(up).includes(PASSWORD));
  assert.ok(!("passwordHash" in up.methods[0]));
  const inside = await emailSignIn(db, "sam@example.com", PASSWORD);
  assert.equal(inside.userId, up.userId);
  assert.equal((await problem(emailSignUp(db, "SAM@example.com", PASSWORD, { hash: FAST }))).code, "email_in_use");
  assert.equal((await problem(emailSignUp(db, "new@example.com", "short", { hash: FAST }))).code, "password_too_short");
});

test("unknown email and wrong password are indistinguishable", async () => {
  const db = new MemDb() as unknown as AuthDb;
  await emailSignUp(db, "sam@example.com", PASSWORD, { hash: FAST });
  const unknown = await problem(emailSignIn(db, "ghost@example.com", PASSWORD));
  const wrong = await problem(emailSignIn(db, "sam@example.com", "not the password"));
  assert.deepEqual(
    { status: unknown.status, code: unknown.code, message: unknown.publicMessage },
    { status: wrong.status, code: wrong.code, message: wrong.publicMessage },
  );
});

test("rate limit: correct password is refused after too many failures", async () => {
  const db = new MemDb() as unknown as AuthDb;
  await emailSignUp(db, "sam@example.com", PASSWORD, { hash: FAST });
  for (let i = 0; i < 5; i++) await problem(emailSignIn(db, "sam@example.com", "bad bad bad bad"));
  const blocked = await problem(emailSignIn(db, "sam@example.com", PASSWORD));
  assert.equal(blocked.status, 429);
  assert.equal(blocked.code, "too_many_attempts");
});

// ---- linking, both directions ----------------------------------------------

test("linking both directions: either method signs into the same account", async () => {
  // Apple-first, then add email.
  const db1 = new MemDb() as unknown as AuthDb;
  const appleFirst = await appleSignIn(db1, { sub: "sub-a", email: null, isPrivateEmail: false });
  await linkEmail(db1, appleFirst.userId, "sam@example.com", PASSWORD, { hash: FAST });
  assert.equal((await emailSignIn(db1, "sam@example.com", PASSWORD)).userId, appleFirst.userId);
  assert.equal((await appleSignIn(db1, { sub: "sub-a", email: null, isPrivateEmail: false })).userId, appleFirst.userId);

  // Email-first, then add Apple.
  const db2 = new MemDb() as unknown as AuthDb;
  const emailFirst = await emailSignUp(db2, "sam@example.com", PASSWORD, { hash: FAST });
  await linkApple(db2, emailFirst.userId, { sub: "sub-b", email: "x@privaterelay.appleid.com", isPrivateEmail: true });
  assert.equal((await appleSignIn(db2, { sub: "sub-b", email: null, isPrivateEmail: false })).userId, emailFirst.userId);
  assert.equal((await emailSignIn(db2, "sam@example.com", PASSWORD)).userId, emailFirst.userId);
});

test("already-linked method errors with no merge or takeover", async () => {
  const db = new MemDb() as unknown as AuthDb;
  const a = await appleSignIn(db, { sub: "sub-a", email: null, isPrivateEmail: false });
  const b = await emailSignUp(db, "other@example.com", PASSWORD, { hash: FAST });
  assert.equal((await problem(linkApple(db, b.userId, { sub: "sub-a", email: null, isPrivateEmail: false }))).code, "already_linked");
  assert.equal((await problem(linkEmail(db, a.userId, "other@example.com", PASSWORD, { hash: FAST }))).code, "already_linked");
  // Both accounts untouched: A still Apple-only, B still email-only.
  assert.equal((await db.listMethods(a.userId)).length, 1);
  assert.equal((await db.listMethods(b.userId)).length, 1);
});

test("apple email claim (incl. private relay) never merges accounts", async () => {
  const db = new MemDb() as unknown as AuthDb & MemDb;
  const emailUser = await emailSignUp(db, "sam@example.com", PASSWORD, { hash: FAST });
  // A brand-new Apple sub whose email claim collides with the existing
  // login email still creates a SEPARATE account (explicit linking only).
  const appleUser = await appleSignIn(db, { sub: "sub-new", email: "sam@example.com", isPrivateEmail: false });
  assert.notEqual(appleUser.userId, emailUser.userId);
  const relayUser = await appleSignIn(db, { sub: "sub-relay", email: "abc@privaterelay.appleid.com", isPrivateEmail: true });
  assert.notEqual(relayUser.userId, emailUser.userId);
  // Relay is never promoted to the user's contact email.
  assert.equal(db.users.get(relayUser.userId)?.contactEmail, null);
});

test("last login method cannot be removed; sessions revoke on signout and password change", async () => {
  const db = new MemDb() as unknown as AuthDb;
  const up = await emailSignUp(db, "sam@example.com", PASSWORD, { hash: FAST });
  const only = up.methods[0];
  assert.equal((await problem(unlinkMethod(db, up.userId, only.id))).code, "last_method");
  const withApple = await linkApple(db, up.userId, { sub: "sub-a", email: null, isPrivateEmail: false });
  const appleMethod = withApple.find((m) => m.method === "apple")!;
  assert.deepEqual((await unlinkMethod(db, up.userId, appleMethod.id)).map((m) => m.method), ["email"]);

  const token = up.session.token;
  assert.equal(await resolveSessionUserId(db, token), up.userId);
  const fresh = await changePassword(db, up.userId, PASSWORD, "a brand new password", { hash: FAST });
  assert.equal(await resolveSessionUserId(db, token), null); // old session revoked
  assert.equal(await resolveSessionUserId(db, fresh.token), up.userId);
  assert.equal((await problem(emailSignIn(db, "sam@example.com", PASSWORD))).code, "invalid_credentials");
  const relogin = await emailSignIn(db, "sam@example.com", "a brand new password");
  await revokeSession(db, relogin.session.token);
  assert.equal(await resolveSessionUserId(db, relogin.session.token), null);
});

// ---- HTTP surface ------------------------------------------------------------

test("http: signup issues a session; methods need it; signout revokes it", async () => {
  const db = new MemDb() as unknown as AuthDb;
  const env = { HYGGE_ENV: "production", HYGGE_APPLE_BUNDLE_ID: BUNDLE } as never;
  const post = (path: string, body: unknown, token = "") =>
    handleAuthRequest(
      new Request(`https://api.test${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      }),
      env,
      db,
    );
  const signedUp = await post("/auth/email/signup", { email: "sam@example.com", password: PASSWORD });
  assert.equal(signedUp.status, 201);
  const bodyText = await signedUp.clone().text();
  assert.ok(!bodyText.includes(PASSWORD));
  const { token } = (await signedUp.json()) as { token: string };

  const anon = await handleAuthRequest(new Request("https://api.test/auth/methods"), env, db);
  assert.equal(anon.status, 401);
  const mine = await handleAuthRequest(
    new Request("https://api.test/auth/methods", { headers: { authorization: `Bearer ${token}` } }),
    env,
    db,
  );
  assert.equal(mine.status, 200);
  assert.equal(((await mine.json()) as { methods: unknown[] }).methods.length, 1);

  const unknown = await (await post("/auth/email/signin", { email: "ghost@example.com", password: PASSWORD })).text();
  const wrong = await (await post("/auth/email/signin", { email: "sam@example.com", password: "nope nope nope" })).text();
  assert.equal(unknown, wrong);

  assert.equal((await post("/auth/signout", {}, token)).status, 200);
  const afterOut = await handleAuthRequest(
    new Request("https://api.test/auth/methods", { headers: { authorization: `Bearer ${token}` } }),
    env,
    db,
  );
  assert.equal(afterOut.status, 401);
});
