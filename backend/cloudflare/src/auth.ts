/// Identity (Brief 00): Apple sign-in (server-verified), email/password,
/// explicit method linking, and server-issued sessions.
///
/// Invariants: one durable user id with N methods; linking happens only
/// while signed in; a private-relay address is opaque contact data and
/// never matches or merges accounts; passwords and session tokens are
/// never stored, returned, or logged in plaintext (this file logs
/// nothing). Hygge-account passwords never enter the site vault.
///
/// Password hashing: the brief prefers Argon2id, but Cloudflare Workers
/// WebCrypto has no Argon2id/bcrypt. We use versioned PBKDF2-SHA256
/// (format below) so verification stays workers-native; switching to an
/// Argon2id WASM hasher is a follow-up decision, not silently faked.
import type { Env } from "./env.ts";
import { json, userIdFromRequest } from "./env.ts";

export const PASSWORD_MIN_LENGTH = 10;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, then sign in again
export const RATE_LIMIT_MAX_FAILURES = 5;
export const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
// Workers WebCrypto caps PBKDF2 at 100_000 iterations (verified live on
// staging: 210_000 throws NotSupportedError). The versioned hash format lets
// this rise, or move to Argon2id WASM, without a migration.
export const PBKDF2_ITERATIONS = 100_000;
const APPLE_ISSUER = "https://appleid.apple.com";
const APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys";
const INVALID_CREDENTIALS = "That email and password don't match. Check both and try again.";

export class AuthProblem extends Error {
  status: number;
  code: string;
  publicMessage: string;
  constructor(status: number, code: string, publicMessage: string) {
    super(code);
    this.status = status;
    this.code = code;
    this.publicMessage = publicMessage;
  }
}

const invalidCredentials = () => new AuthProblem(401, "invalid_credentials", INVALID_CREDENTIALS);

// ---- encoding helpers -------------------------------------------------

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function b64url(bytes: Uint8Array): string {
  return b64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function b64urlDecode(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (text.length % 4)) % 4);
  const raw = atob(padded);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
function b64Decode(text: string): Uint8Array<ArrayBuffer> {
  const raw = atob(text);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
function utf8(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text);
}
async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(text)));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ---- email / password policy ------------------------------------------

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isPlausibleEmail(email: string): boolean {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function isPrivateRelayEmail(email: string | null | undefined): boolean {
  return !!email && normalizeEmail(email).endsWith("@privaterelay.appleid.com");
}

export function assertPasswordPolicy(password: string): void {
  if (typeof password !== "string" || password.length < PASSWORD_MIN_LENGTH) {
    throw new AuthProblem(
      400,
      "password_too_short",
      `Use at least ${PASSWORD_MIN_LENGTH} characters for your password.`,
    );
  }
}

// ---- password hashing (PBKDF2-SHA256, versioned) -----------------------

export interface HashOptions {
  iterations?: number;
}

export async function hashPassword(password: string, opts: HashOptions = {}): Promise<string> {
  const iterations = opts.iterations ?? PBKDF2_ITERATIONS;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await derive(password, salt, iterations);
  return `pbkdf2-sha256$${iterations}$${b64(salt)}$${b64(bits)}`;
}

async function derive(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", utf8(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2-sha256") return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1) return false;
  try {
    const expected = b64Decode(parts[3]);
    const actual = await derive(password, b64Decode(parts[2]), iterations);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/// Well-formed hash of no real password, so unknown-email sign-ins do
/// the same work as wrong-password ones.
const DUMMY_HASH = `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${b64(new Uint8Array(16))}$${b64(new Uint8Array(32))}`;

// ---- Apple identity-token verification ---------------------------------

export interface AppleClaims {
  sub: string;
  email: string | null;
  isPrivateEmail: boolean;
}

export interface AppleVerifyOptions {
  bundleId?: string;
  nonce?: string;
  nowSeconds?: number;
  fetchJwks?: () => Promise<{ keys: JsonWebKey[] }>;
}

let jwksCache: { keys: JsonWebKey[]; fetchedAt: number } | null = null;

async function appleJwks(fetchJwks?: AppleVerifyOptions["fetchJwks"]): Promise<JsonWebKey[]> {
  if (fetchJwks) return (await fetchJwks()).keys;
  if (jwksCache && Date.now() - jwksCache.fetchedAt < 60 * 60 * 1000) return jwksCache.keys;
  const response = await fetch(APPLE_JWKS_URL);
  if (!response.ok) throw new AuthProblem(502, "apple_keys_unavailable", "Apple sign-in is unavailable just now. Try again in a moment.");
  const body = (await response.json()) as { keys: JsonWebKey[] };
  jwksCache = { keys: body.keys, fetchedAt: Date.now() };
  return body.keys;
}

function decodeJwtPart(part: string): Record<string, unknown> {
  try {
    return JSON.parse(new TextDecoder().decode(b64urlDecode(part))) as Record<string, unknown>;
  } catch {
    throw new AuthProblem(401, "invalid_apple_token", "That Apple sign-in didn't check out. Try again.");
  }
}

/// Verifies issuer, audience (bundle id), expiry, RS256 signature via
/// Apple's JWKS, and the nonce when one is supplied. Fails closed when
/// the bundle id is not configured.
export async function verifyAppleIdentityToken(
  identityToken: string,
  opts: AppleVerifyOptions,
): Promise<AppleClaims> {
  if (!opts.bundleId) {
    throw new AuthProblem(500, "apple_not_configured", "Apple sign-in isn't set up yet.");
  }
  const segments = identityToken.split(".");
  if (segments.length !== 3) throw new AuthProblem(401, "invalid_apple_token", "That Apple sign-in didn't check out. Try again.");
  const header = decodeJwtPart(segments[0]);
  const claims = decodeJwtPart(segments[1]);
  if (header.alg !== "RS256" || typeof header.kid !== "string") {
    throw new AuthProblem(401, "invalid_apple_token", "That Apple sign-in didn't check out. Try again.");
  }
  const keys = await appleJwks(opts.fetchJwks);
  const jwk = keys.find((k) => (k as { kid?: string }).kid === header.kid);
  if (!jwk) throw new AuthProblem(401, "invalid_apple_token", "That Apple sign-in didn't check out. Try again.");
  let valid = false;
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      b64urlDecode(segments[2]),
      utf8(`${segments[0]}.${segments[1]}`),
    );
  } catch {
    valid = false;
  }
  if (!valid) throw new AuthProblem(401, "invalid_apple_token", "That Apple sign-in didn't check out. Try again.");
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (claims.iss !== APPLE_ISSUER) throw new AuthProblem(401, "wrong_issuer", "That Apple sign-in didn't check out. Try again.");
  if (claims.aud !== opts.bundleId) throw new AuthProblem(401, "wrong_audience", "That Apple sign-in didn't check out. Try again.");
  if (typeof claims.exp !== "number" || claims.exp <= now) throw new AuthProblem(401, "apple_token_expired", "That Apple sign-in expired. Try again.");
  if (opts.nonce && claims.nonce !== opts.nonce) throw new AuthProblem(401, "nonce_mismatch", "That Apple sign-in didn't check out. Try again.");
  if (typeof claims.sub !== "string" || !claims.sub) throw new AuthProblem(401, "invalid_apple_token", "That Apple sign-in didn't check out. Try again.");
  const email = typeof claims.email === "string" ? normalizeEmail(claims.email) : null;
  const isPrivate = claims.is_private_email === true || claims.is_private_email === "true" || isPrivateRelayEmail(email);
  return { sub: claims.sub, email, isPrivateEmail: isPrivate };
}

// ---- storage seam (D1 in production, in-memory in tests) ---------------

export interface LinkedMethodRow {
  id: string;
  userId: string;
  method: "apple" | "email";
  appleSub: string | null;
  appleEmail: string | null;
  email: string | null;
  passwordHash: string | null;
  emailVerified: boolean;
}

export interface AuthSessionRow {
  id: string;
  userId: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface AuthDb {
  createUser(user: { id: string; contactEmail: string | null; displayName: string | null }): Promise<void>;
  findAppleMethod(appleSub: string): Promise<LinkedMethodRow | null>;
  findEmailMethod(email: string): Promise<LinkedMethodRow | null>;
  getMethodById(id: string): Promise<LinkedMethodRow | null>;
  listMethods(userId: string): Promise<LinkedMethodRow[]>;
  addMethod(row: LinkedMethodRow): Promise<void>;
  deleteMethod(id: string): Promise<void>;
  updateMethodPassword(id: string, passwordHash: string): Promise<void>;
  createSession(row: AuthSessionRow): Promise<void>;
  findSessionByHash(tokenHash: string): Promise<AuthSessionRow | null>;
  revokeSessionByHash(tokenHash: string, revokedAt: string): Promise<void>;
  revokeAllSessions(userId: string, revokedAt: string): Promise<void>;
  recordAttempt(email: string, success: boolean, at: string): Promise<void>;
  countRecentFailures(email: string, since: string): Promise<number>;
}

type D1Row = Record<string, unknown>;

function toMethod(r: D1Row): LinkedMethodRow {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    method: r.method === "apple" ? "apple" : "email",
    appleSub: r.apple_sub ? String(r.apple_sub) : null,
    appleEmail: r.apple_email ? String(r.apple_email) : null,
    email: r.email ? String(r.email) : null,
    passwordHash: r.password_hash ? String(r.password_hash) : null,
    emailVerified: Number(r.email_verified ?? 0) === 1,
  };
}

export function d1AuthDb(db: D1Database): AuthDb {
  const one = async (sql: string, ...binds: unknown[]) =>
    (await db.prepare(sql).bind(...binds).first()) as D1Row | null;
  return {
    async createUser({ id, contactEmail, displayName }) {
      await db
        .prepare("INSERT INTO users (id, email, contact_email, display_name, do_instance) VALUES (?1, ?2, ?2, ?3, ?1)")
        .bind(id, contactEmail, displayName)
        .run();
    },
    async findAppleMethod(sub) {
      const r = await one("SELECT * FROM linked_methods WHERE apple_sub = ?1", sub);
      return r ? toMethod(r) : null;
    },
    async findEmailMethod(email) {
      const r = await one("SELECT * FROM linked_methods WHERE email = ?1", email);
      return r ? toMethod(r) : null;
    },
    async getMethodById(id) {
      const r = await one("SELECT * FROM linked_methods WHERE id = ?1", id);
      return r ? toMethod(r) : null;
    },
    async listMethods(userId) {
      const { results } = await db
        .prepare("SELECT * FROM linked_methods WHERE user_id = ?1 ORDER BY created_at")
        .bind(userId)
        .all();
      return (results as D1Row[]).map(toMethod);
    },
    async addMethod(row) {
      await db
        .prepare(
          "INSERT INTO linked_methods (id, user_id, method, apple_sub, apple_email, email, password_hash, email_verified) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        )
        .bind(row.id, row.userId, row.method, row.appleSub, row.appleEmail, row.email, row.passwordHash, row.emailVerified ? 1 : 0)
        .run();
    },
    async deleteMethod(id) {
      await db.prepare("DELETE FROM linked_methods WHERE id = ?1").bind(id).run();
    },
    async updateMethodPassword(id, passwordHash) {
      await db.prepare("UPDATE linked_methods SET password_hash = ?2 WHERE id = ?1").bind(id, passwordHash).run();
    },
    async createSession(row) {
      await db
        .prepare("INSERT INTO auth_sessions (id, user_id, token_hash, created_at, expires_at) VALUES (?1,?2,?3,?4,?5)")
        .bind(row.id, row.userId, row.tokenHash, row.createdAt, row.expiresAt)
        .run();
    },
    async findSessionByHash(tokenHash) {
      const r = await one("SELECT * FROM auth_sessions WHERE token_hash = ?1", tokenHash);
      if (!r) return null;
      return {
        id: String(r.id),
        userId: String(r.user_id),
        tokenHash: String(r.token_hash),
        createdAt: String(r.created_at),
        expiresAt: String(r.expires_at),
        revokedAt: r.revoked_at ? String(r.revoked_at) : null,
      };
    },
    async revokeSessionByHash(tokenHash, revokedAt) {
      await db.prepare("UPDATE auth_sessions SET revoked_at = ?2 WHERE token_hash = ?1").bind(tokenHash, revokedAt).run();
    },
    async revokeAllSessions(userId, revokedAt) {
      await db
        .prepare("UPDATE auth_sessions SET revoked_at = ?2 WHERE user_id = ?1 AND revoked_at IS NULL")
        .bind(userId, revokedAt)
        .run();
    },
    async recordAttempt(email, success, at) {
      await db.prepare("INSERT INTO auth_attempts (email, success, created_at) VALUES (?1,?2,?3)").bind(email, success ? 1 : 0, at).run();
    },
    async countRecentFailures(email, since) {
      const r = await one(
        "SELECT COUNT(*) AS n FROM auth_attempts WHERE email = ?1 AND success = 0 AND created_at >= ?2",
        email,
        since,
      );
      return Number(r?.n ?? 0);
    },
  };
}

// ---- sessions -----------------------------------------------------------

export interface IssuedSession {
  token: string;
  expiresAt: string;
  userId: string;
}

export async function issueSession(db: AuthDb, userId: string, nowMs = Date.now()): Promise<IssuedSession> {
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const createdAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + SESSION_TTL_MS).toISOString();
  await db.createSession({
    id: crypto.randomUUID(),
    userId,
    tokenHash: await sha256Hex(token),
    createdAt,
    expiresAt,
    revokedAt: null,
  });
  return { token, expiresAt, userId };
}

export async function resolveSessionUserId(db: AuthDb, token: string, nowMs = Date.now()): Promise<string | null> {
  if (!token) return null;
  const row = await db.findSessionByHash(await sha256Hex(token));
  if (!row || row.revokedAt) return null;
  if (Date.parse(row.expiresAt) <= nowMs) return null;
  return row.userId;
}

export async function revokeSession(db: AuthDb, token: string, nowMs = Date.now()): Promise<void> {
  if (!token) return;
  await db.revokeSessionByHash(await sha256Hex(token), new Date(nowMs).toISOString());
}

// ---- identity service ---------------------------------------------------

export interface PublicMethod {
  id: string;
  method: "apple" | "email";
  email: string | null;
  emailVerified: boolean;
}

/// Safe view only: never the password hash, never the Apple sub.
export function publicMethod(row: LinkedMethodRow): PublicMethod {
  return {
    id: row.id,
    method: row.method,
    email: row.method === "email" ? row.email : row.appleEmail,
    emailVerified: row.emailVerified,
  };
}

export interface AuthenticatedResult {
  userId: string;
  session: IssuedSession;
  isNewUser: boolean;
  methods: PublicMethod[];
}

async function authenticated(db: AuthDb, userId: string, isNewUser: boolean): Promise<AuthenticatedResult> {
  const session = await issueSession(db, userId);
  const methods = (await db.listMethods(userId)).map(publicMethod);
  return { userId, session, isNewUser, methods };
}

/// Apple sign-in/up: an existing link resolves to that user; an unknown
/// sub creates a fresh durable user. The Apple email claim is stored as
/// opaque data on the method and NEVER used to match an account, so a
/// relay (or real) address can never merge or take over another user.
export async function appleSignIn(
  db: AuthDb,
  claims: AppleClaims,
  input: { displayName?: string | null } = {},
): Promise<AuthenticatedResult> {
  const existing = await db.findAppleMethod(claims.sub);
  if (existing) return authenticated(db, existing.userId, false);
  const userId = crypto.randomUUID();
  // A relay address is never the contact email; a real Apple address is
  // taken as contact data the user chose to share with this app.
  const contactEmail = claims.isPrivateEmail ? null : claims.email;
  await db.createUser({ id: userId, contactEmail, displayName: input.displayName ?? null });
  try {
    await db.addMethod({
      id: crypto.randomUUID(),
      userId,
      method: "apple",
      appleSub: claims.sub,
      appleEmail: claims.email,
      email: null,
      passwordHash: null,
      emailVerified: false,
    });
  } catch {
    // Lost a race with a concurrent first sign-in for the same sub.
    const raced = await db.findAppleMethod(claims.sub);
    if (raced) return authenticated(db, raced.userId, false);
    throw new AuthProblem(409, "already_linked", "That sign-in method is already linked to an account.");
  }
  return authenticated(db, userId, true);
}

export async function emailSignUp(
  db: AuthDb,
  rawEmail: string,
  password: string,
  input: { displayName?: string | null; hash?: HashOptions } = {},
): Promise<AuthenticatedResult> {
  const email = normalizeEmail(rawEmail ?? "");
  if (!isPlausibleEmail(email)) throw new AuthProblem(400, "invalid_email", "That email address doesn't look right.");
  assertPasswordPolicy(password);
  if (await db.findEmailMethod(email)) {
    throw new AuthProblem(409, "email_in_use", "That email already has an account. Sign in instead.");
  }
  const userId = crypto.randomUUID();
  const passwordHash = await hashPassword(password, input.hash);
  await db.createUser({ id: userId, contactEmail: email, displayName: input.displayName ?? null });
  try {
    await db.addMethod({
      id: crypto.randomUUID(),
      userId,
      method: "email",
      appleSub: null,
      appleEmail: null,
      email,
      passwordHash,
      // No verification sender exists yet (brief open question); stay
      // unverified rather than claiming otherwise.
      emailVerified: false,
    });
  } catch {
    throw new AuthProblem(409, "email_in_use", "That email already has an account. Sign in instead.");
  }
  return authenticated(db, userId, true);
}

/// Unknown email and wrong password return the identical problem, and
/// both paths run a password verification.
export async function emailSignIn(
  db: AuthDb,
  rawEmail: string,
  password: string,
  input: { nowMs?: number } = {},
): Promise<AuthenticatedResult> {
  const nowMs = input.nowMs ?? Date.now();
  const email = normalizeEmail(rawEmail ?? "");
  const since = new Date(nowMs - RATE_LIMIT_WINDOW_MS).toISOString();
  if ((await db.countRecentFailures(email, since)) >= RATE_LIMIT_MAX_FAILURES) {
    throw new AuthProblem(429, "too_many_attempts", "Too many tries just now. Wait a few minutes and try again.");
  }
  const row = isPlausibleEmail(email) ? await db.findEmailMethod(email) : null;
  const ok = await verifyPassword(password ?? "", row?.passwordHash ?? DUMMY_HASH);
  if (!row || !ok) {
    await db.recordAttempt(email, false, new Date(nowMs).toISOString());
    throw invalidCredentials();
  }
  await db.recordAttempt(email, true, new Date(nowMs).toISOString());
  return authenticated(db, row.userId, false);
}

/// Explicit linking only, while signed in. An already-linked method is
/// a clear error: no merge, no takeover.
export async function linkApple(db: AuthDb, userId: string, claims: AppleClaims): Promise<PublicMethod[]> {
  const existing = await db.findAppleMethod(claims.sub);
  if (existing) {
    throw new AuthProblem(
      409,
      "already_linked",
      existing.userId === userId
        ? "That Apple account is already linked here."
        : "That Apple account is already linked to a different account.",
    );
  }
  const row: LinkedMethodRow = {
    id: crypto.randomUUID(),
    userId,
    method: "apple",
    appleSub: claims.sub,
    appleEmail: claims.email,
    email: null,
    passwordHash: null,
    emailVerified: false,
  };
  try {
    await db.addMethod(row);
  } catch {
    throw new AuthProblem(409, "already_linked", "That Apple account is already linked to a different account.");
  }
  return (await db.listMethods(userId)).map(publicMethod);
}

export async function linkEmail(
  db: AuthDb,
  userId: string,
  rawEmail: string,
  password: string,
  input: { hash?: HashOptions } = {},
): Promise<PublicMethod[]> {
  const email = normalizeEmail(rawEmail ?? "");
  if (!isPlausibleEmail(email)) throw new AuthProblem(400, "invalid_email", "That email address doesn't look right.");
  assertPasswordPolicy(password);
  const existing = await db.findEmailMethod(email);
  if (existing) {
    throw new AuthProblem(
      409,
      "already_linked",
      existing.userId === userId
        ? "That email is already linked here."
        : "That email is already linked to a different account.",
    );
  }
  const row: LinkedMethodRow = {
    id: crypto.randomUUID(),
    userId,
    method: "email",
    appleSub: null,
    appleEmail: null,
    email,
    passwordHash: await hashPassword(password, input.hash),
    emailVerified: false,
  };
  try {
    await db.addMethod(row);
  } catch {
    throw new AuthProblem(409, "already_linked", "That email is already linked to a different account.");
  }
  return (await db.listMethods(userId)).map(publicMethod);
}

/// Unlinking requires another method to remain: an account is never
/// orphaned by removing its last way in.
export async function unlinkMethod(db: AuthDb, userId: string, methodId: string): Promise<PublicMethod[]> {
  const row = await db.getMethodById(methodId);
  if (!row || row.userId !== userId) throw new AuthProblem(404, "method_not_found", "That login method wasn't found.");
  const methods = await db.listMethods(userId);
  if (methods.length <= 1) {
    throw new AuthProblem(409, "last_method", "Add another way to sign in first — you can't remove your only one.");
  }
  await db.deleteMethod(methodId);
  return (await db.listMethods(userId)).map(publicMethod);
}

/// Password change revokes every existing session, then issues a fresh
/// one for this device.
export async function changePassword(
  db: AuthDb,
  userId: string,
  currentPassword: string,
  newPassword: string,
  input: { hash?: HashOptions; nowMs?: number } = {},
): Promise<IssuedSession> {
  const methods = await db.listMethods(userId);
  const emailMethod = methods.find((m) => m.method === "email" && m.passwordHash);
  if (!emailMethod?.passwordHash) throw new AuthProblem(400, "no_password_method", "This account has no email password to change.");
  if (!(await verifyPassword(currentPassword ?? "", emailMethod.passwordHash))) throw invalidCredentials();
  assertPasswordPolicy(newPassword);
  await db.updateMethodPassword(emailMethod.id, await hashPassword(newPassword, input.hash));
  const nowMs = input.nowMs ?? Date.now();
  await db.revokeAllSessions(userId, new Date(nowMs).toISOString());
  return issueSession(db, userId, nowMs);
}

// ---- request resolution + HTTP routes ------------------------------------

function bearerToken(request: Request): string {
  const auth = request.headers.get("authorization") ?? "";
  return auth.startsWith("Bearer ") ? auth.slice(7) : "";
}

/// Staging dev tokens stay a staging-only bridge; everywhere else the
/// bearer must be a live server-issued session.
export async function resolveRequestUserId(request: Request, env: Env, db?: AuthDb): Promise<string | null> {
  const dev = userIdFromRequest(request, env);
  if (dev) return dev;
  return resolveSessionUserId(db ?? d1AuthDb(env.DB), bearerToken(request));
}

function sessionBody(result: AuthenticatedResult) {
  return {
    token: result.session.token,
    expiresAt: result.session.expiresAt,
    userId: result.userId,
    isNewUser: result.isNewUser,
    methods: result.methods,
  };
}

async function requireUser(request: Request, env: Env, db: AuthDb): Promise<string> {
  const userId = await resolveRequestUserId(request, env, db);
  if (!userId) throw new AuthProblem(401, "unauthorized", "Sign in first.");
  return userId;
}

export async function handleAuthRequest(request: Request, env: Env, db: AuthDb = d1AuthDb(env.DB)): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  try {
    const body = request.method === "GET" || request.method === "DELETE"
      ? ({} as Record<string, unknown>)
      : ((await request.json().catch(() => ({}))) as Record<string, unknown>);
    const str = (v: unknown) => (typeof v === "string" ? v : "");

    if (request.method === "POST" && parts.join("/") === "auth/apple") {
      const claims = await verifyAppleIdentityToken(str(body.identityToken), {
        bundleId: env.HYGGE_APPLE_BUNDLE_ID,
        nonce: str(body.nonce) || undefined,
      });
      const result = await appleSignIn(db, claims, { displayName: str(body.displayName) || null });
      return json(sessionBody(result), result.isNewUser ? 201 : 200);
    }
    if (request.method === "POST" && parts.join("/") === "auth/email/signup") {
      const result = await emailSignUp(db, str(body.email), str(body.password), {
        displayName: str(body.displayName) || null,
      });
      return json(sessionBody(result), 201);
    }
    if (request.method === "POST" && parts.join("/") === "auth/email/signin") {
      return json(sessionBody(await emailSignIn(db, str(body.email), str(body.password))));
    }
    if (request.method === "POST" && parts.join("/") === "auth/signout") {
      await revokeSession(db, bearerToken(request));
      return json({ ok: true });
    }
    if (request.method === "GET" && parts.join("/") === "auth/methods") {
      const userId = await requireUser(request, env, db);
      return json({ methods: (await db.listMethods(userId)).map(publicMethod) });
    }
    if (request.method === "POST" && parts.join("/") === "auth/methods/link/apple") {
      const userId = await requireUser(request, env, db);
      const claims = await verifyAppleIdentityToken(str(body.identityToken), {
        bundleId: env.HYGGE_APPLE_BUNDLE_ID,
        nonce: str(body.nonce) || undefined,
      });
      return json({ methods: await linkApple(db, userId, claims) });
    }
    if (request.method === "POST" && parts.join("/") === "auth/methods/link/email") {
      const userId = await requireUser(request, env, db);
      return json({ methods: await linkEmail(db, userId, str(body.email), str(body.password)) });
    }
    if (request.method === "DELETE" && parts[0] === "auth" && parts[1] === "methods" && parts[2]) {
      const userId = await requireUser(request, env, db);
      return json({ methods: await unlinkMethod(db, userId, parts[2]) });
    }
    if (request.method === "POST" && parts.join("/") === "auth/password/change") {
      const userId = await requireUser(request, env, db);
      const session = await changePassword(db, userId, str(body.currentPassword), str(body.newPassword));
      return json({ token: session.token, expiresAt: session.expiresAt, userId });
    }
    return json({ error: "not_found", message: "That auth route doesn't exist." }, 404);
  } catch (e) {
    if (e instanceof AuthProblem) return json({ error: e.code, message: e.publicMessage }, e.status);
    // Internal detail stays in worker logs only (no user data, no secrets).
    console.error("auth request failed:", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    return json({ error: "auth_unavailable", message: "Sign-in is unavailable just now. Try again in a moment." }, 500);
  }
}
