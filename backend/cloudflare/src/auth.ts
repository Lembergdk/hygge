/// Identity: Apple sign-in (server-verified), email magic links,
/// explicit method linking, and server-issued sessions. Email and
/// password sign-in was replaced fully by magic links — there is no
/// Hygge-account password anywhere in this file.
///
/// Invariants: one durable user id with N methods; linking happens only
/// while signed in; a private-relay address is opaque contact data and
/// never matches or merges accounts; magic-link tokens and session
/// tokens exist only as SHA-256 hashes at rest, and raw tokens and raw
/// emails never reach a log line.
import type { Env, MagicEmailBinding } from "./env.ts";
import { json, userIdFromRequest } from "./env.ts";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, then sign in again
export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000; // 15 minutes
export const MAGIC_LINK_MAX_SENDS_PER_HOUR = 5;
export const MAGIC_LINK_MAX_REQUESTS_PER_IP_PER_HOUR = 20;
export const MAGIC_LINK_FROM = "Hygge <login@usehygge.app>";
const APPLE_ISSUER = "https://appleid.apple.com";
const APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys";
const MAGIC_REQUEST_OK = "If that email can sign in, a sign-in link is on its way. It works for 15 minutes.";
const MAGIC_LINK_PROBLEM = "That sign-in link doesn't work anymore. Ask for a new one and try again.";

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

const magicLinkProblem = () => new AuthProblem(401, "invalid_magic_link", MAGIC_LINK_PROBLEM);

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
function utf8(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text);
}
async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(text)));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- email policy ------------------------------------------------------

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isPlausibleEmail(email: string): boolean {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function isPrivateRelayEmail(email: string | null | undefined): boolean {
  return !!email && normalizeEmail(email).endsWith("@privaterelay.appleid.com");
}

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

export interface MagicLinkRow {
  id: string;
  email: string;
  tokenHash: string;
  expiresAt: string;
  consumedAt: string | null;
  createdAt: string;
}

export interface AuthDb {
  createUser(user: { id: string; contactEmail: string | null; displayName: string | null }): Promise<void>;
  findAppleMethod(appleSub: string): Promise<LinkedMethodRow | null>;
  findEmailMethod(email: string): Promise<LinkedMethodRow | null>;
  getMethodById(id: string): Promise<LinkedMethodRow | null>;
  listMethods(userId: string): Promise<LinkedMethodRow[]>;
  addMethod(row: LinkedMethodRow): Promise<void>;
  deleteMethod(id: string): Promise<void>;
  /// A clicked magic link proves inbox control: the email method
  /// becomes verified and any legacy password hash is dropped.
  markEmailVerifiedAndClearPassword(id: string): Promise<void>;
  createSession(row: AuthSessionRow): Promise<void>;
  findSessionByHash(tokenHash: string): Promise<AuthSessionRow | null>;
  revokeSessionByHash(tokenHash: string, revokedAt: string): Promise<void>;
  revokeAllSessions(userId: string, revokedAt: string): Promise<void>;
  createMagicLink(row: MagicLinkRow): Promise<void>;
  findMagicLinkByHash(tokenHash: string): Promise<MagicLinkRow | null>;
  invalidateMagicLinks(email: string, at: string): Promise<void>;
  countMagicLinksSince(email: string, since: string): Promise<number>;
  /// Per-requester abuse cap: requests are counted by a SHA-256 of
  /// the client address (the raw address is never stored).
  countMagicRequestsByIpSince(ipHash: string, since: string): Promise<number>;
  recordMagicRequest(ipHash: string, at: string): Promise<void>;
  /// Atomic single-use: true exactly once per token.
  consumeMagicLink(tokenHash: string, at: string): Promise<boolean>;
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
    async markEmailVerifiedAndClearPassword(id) {
      await db
        .prepare("UPDATE linked_methods SET email_verified = 1, password_hash = NULL WHERE id = ?1")
        .bind(id)
        .run();
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
    async createMagicLink(row) {
      await db
        .prepare(
          "INSERT INTO magic_link_tokens (id, email, token_hash, expires_at, consumed_at, created_at) VALUES (?1,?2,?3,?4,?5,?6)",
        )
        .bind(row.id, row.email, row.tokenHash, row.expiresAt, row.consumedAt, row.createdAt)
        .run();
    },
    async findMagicLinkByHash(tokenHash) {
      const r = await one("SELECT * FROM magic_link_tokens WHERE token_hash = ?1", tokenHash);
      if (!r) return null;
      return {
        id: String(r.id),
        email: String(r.email),
        tokenHash: String(r.token_hash),
        expiresAt: String(r.expires_at),
        consumedAt: r.consumed_at ? String(r.consumed_at) : null,
        createdAt: String(r.created_at),
      };
    },
    async invalidateMagicLinks(email, at) {
      await db
        .prepare("UPDATE magic_link_tokens SET consumed_at = ?2 WHERE email = ?1 AND consumed_at IS NULL")
        .bind(email, at)
        .run();
    },
    async countMagicLinksSince(email, since) {
      const r = await one(
        "SELECT COUNT(*) AS n FROM magic_link_tokens WHERE email = ?1 AND created_at >= ?2",
        email,
        since,
      );
      return Number(r?.n ?? 0);
    },
    async countMagicRequestsByIpSince(ipHash, since) {
      const r = await one(
        "SELECT COUNT(*) AS n FROM magic_link_requests WHERE ip_hash = ?1 AND created_at >= ?2",
        ipHash,
        since,
      );
      return Number(r?.n ?? 0);
    },
    async recordMagicRequest(ipHash, at) {
      await db
        .prepare("INSERT INTO magic_link_requests (id, ip_hash, created_at) VALUES (?1,?2,?3)")
        .bind(crypto.randomUUID(), ipHash, at)
        .run();
    },
    async consumeMagicLink(tokenHash, at) {
      const result = await db
        .prepare("UPDATE magic_link_tokens SET consumed_at = ?2 WHERE token_hash = ?1 AND consumed_at IS NULL")
        .bind(tokenHash, at)
        .run();
      return (result.meta?.changes ?? 0) === 1;
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

// ---- magic links --------------------------------------------------------

export type MagicEmailSender = (message: {
  to: string;
  from: string;
  subject: string;
  text: string;
  html: string;
}) => Promise<void>;

export interface RequestMagicLinkOptions {
  nowMs?: number;
  baseUrl?: string;
  send?: MagicEmailSender;
  /// SHA-256 of the requesting client address, for the per-IP cap.
  requesterHash?: string | null;
}

/// The requester key for rate limits: a hash of the client address
/// Cloudflare saw. The raw address itself is never stored or logged.
export async function requesterHashFrom(request: Request): Promise<string | null> {
  const ip = request.headers.get("CF-Connecting-IP") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return ip ? sha256Hex(ip) : null;
}

/// The whole message: one calm link, no other user data. The raw token
/// exists only here and in the recipient's inbox.
export function magicLinkMessage(email: string, link: string) {
  const text = [
    "Here is your Hygge sign-in link:",
    "",
    link,
    "",
    "It works for 15 minutes, and only once.",
    "If you did not ask for this, you can ignore this email.",
  ].join("\n");
  const html = [
    "<p>Here is your Hygge sign-in link:</p>",
    `<p><a href="${link}">Sign in to Hygge</a></p>`,
    "<p>It works for 15 minutes, and only once.<br>",
    "If you did not ask for this, you can ignore this email.</p>",
  ].join("\n");
  return { to: email, from: MAGIC_LINK_FROM, subject: "Your Hygge sign-in link", text, html };
}

/// Always resolves: the HTTP response is identical for known, unknown,
/// malformed, and rate-limited addresses, so nothing can be enumerated.
/// Send failures are logged without the token or the raw email.
export async function requestMagicLink(
  db: AuthDb,
  rawEmail: string,
  opts: RequestMagicLinkOptions = {},
): Promise<void> {
  const nowMs = opts.nowMs ?? Date.now();
  const email = normalizeEmail(rawEmail ?? "");
  if (!isPlausibleEmail(email)) return;
  const since = new Date(nowMs - 60 * 60 * 1000).toISOString();
  // Per-requester cap first: without it this endpoint could send
  // five mails an hour to unlimited inboxes from our sender domain.
  // Every plausible request counts, sent or not; the generic answer
  // never reveals which cap (if any) stopped a send.
  if (opts.requesterHash) {
    if ((await db.countMagicRequestsByIpSince(opts.requesterHash, since)) >= MAGIC_LINK_MAX_REQUESTS_PER_IP_PER_HOUR) return;
    await db.recordMagicRequest(opts.requesterHash, new Date(nowMs).toISOString());
  }
  if ((await db.countMagicLinksSince(email, since)) >= MAGIC_LINK_MAX_SENDS_PER_HOUR) return;
  const now = new Date(nowMs).toISOString();
  await db.invalidateMagicLinks(email, now);
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  await db.createMagicLink({
    id: crypto.randomUUID(),
    email,
    tokenHash: await sha256Hex(token),
    expiresAt: new Date(nowMs + MAGIC_LINK_TTL_MS).toISOString(),
    consumedAt: null,
    createdAt: now,
  });
  if (!opts.send || !opts.baseUrl) return;
  const link = `${opts.baseUrl.replace(/\/$/, "")}/auth/magic?token=${encodeURIComponent(token)}`;
  try {
    await opts.send(magicLinkMessage(email, link));
  } catch (e) {
    console.error("magic link send failed:", e instanceof Error ? e.name : "unknown error");
  }
}

export type ConsumeMagicLinkResult =
  | { kind: "session"; result: AuthenticatedResult }
  | { kind: "linked"; userId: string; methods: PublicMethod[] };

/// One generic problem covers unknown, expired, and already-used links.
/// With a live session the link attaches its email to that account
/// (link mode); without one it finds or creates the account for the
/// email, marks it verified, drops any legacy password hash, and
/// issues the standard session.
export async function consumeMagicLink(
  db: AuthDb,
  rawToken: string,
  input: { nowMs?: number; sessionUserId?: string | null } = {},
): Promise<ConsumeMagicLinkResult> {
  const nowMs = input.nowMs ?? Date.now();
  const token = (rawToken ?? "").trim();
  if (!token) throw magicLinkProblem();
  const tokenHash = await sha256Hex(token);
  const row = await db.findMagicLinkByHash(tokenHash);
  if (!row || row.consumedAt || Date.parse(row.expiresAt) <= nowMs) throw magicLinkProblem();
  const email = row.email;

  if (input.sessionUserId) {
    const owner = await db.findEmailMethod(email);
    if (owner && owner.userId !== input.sessionUserId) {
      throw new AuthProblem(409, "already_linked", "That email is already linked to a different account.");
    }
    if (!(await db.consumeMagicLink(tokenHash, new Date(nowMs).toISOString()))) throw magicLinkProblem();
    if (owner) {
      await db.markEmailVerifiedAndClearPassword(owner.id);
    } else {
      try {
        await db.addMethod({
          id: crypto.randomUUID(),
          userId: input.sessionUserId,
          method: "email",
          appleSub: null,
          appleEmail: null,
          email,
          passwordHash: null,
          emailVerified: true,
        });
      } catch {
        throw new AuthProblem(409, "already_linked", "That email is already linked to a different account.");
      }
    }
    return {
      kind: "linked",
      userId: input.sessionUserId,
      methods: (await db.listMethods(input.sessionUserId)).map(publicMethod),
    };
  }

  if (!(await db.consumeMagicLink(tokenHash, new Date(nowMs).toISOString()))) throw magicLinkProblem();
  const existing = await db.findEmailMethod(email);
  if (existing) {
    await db.markEmailVerifiedAndClearPassword(existing.id);
    return { kind: "session", result: await authenticated(db, existing.userId, false) };
  }
  const userId = crypto.randomUUID();
  await db.createUser({ id: userId, contactEmail: email, displayName: null });
  try {
    await db.addMethod({
      id: crypto.randomUUID(),
      userId,
      method: "email",
      appleSub: null,
      appleEmail: null,
      email,
      passwordHash: null,
      emailVerified: true,
    });
  } catch {
    // Lost a race with a concurrent first sign-in for the same email.
    const raced = await db.findEmailMethod(email);
    if (raced) {
      await db.markEmailVerifiedAndClearPassword(raced.id);
      return { kind: "session", result: await authenticated(db, raced.userId, false) };
    }
    throw new AuthProblem(409, "already_linked", "That sign-in method is already linked to an account.");
  }
  return { kind: "session", result: await authenticated(db, userId, true) };
}

/// Mail scanners prefetch links, so the landing page never consumes:
/// it only offers the app link, which the app POSTs to consume.
export function magicLandingHtml(rawToken: string): string {
  const appLink = `hygge://auth/magic?token=${encodeURIComponent(rawToken ?? "")}`;
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    "<title>Sign in to Hygge</title></head>",
    "<body style=\"font-family:system-ui,sans-serif;text-align:center;padding:48px 24px\">",
    "<h1>Almost there</h1>",
    "<p>Tap below to finish signing in to Hygge on this phone.</p>",
    `<p><a href="${appLink}" style="display:inline-block;padding:14px 28px;border-radius:999px;background:#2b211c;color:#fff;text-decoration:none">Open Hygge</a></p>`,
    "<p>The link works for 15 minutes, and only once.</p>",
    "</body></html>",
  ].join("\n");
}

/// Universal-link association for the worker host. The team id and
/// bundle id are public identifiers, not secrets.
export function appleAppSiteAssociation() {
  return {
    applinks: {
      details: [
        {
          appIDs: ["3KA38L8A4F.app.usehygge"],
          components: [{ "/": "/auth/magic*", comment: "Magic-link sign-in" }],
        },
      ],
    },
  };
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

export interface AuthHandlerOptions {
  /// Injectable so tests never send real mail; defaults to env.EMAIL.
  sendMagicEmail?: MagicEmailSender;
  nowMs?: number;
}

export async function handleAuthRequest(
  request: Request,
  env: Env,
  db: AuthDb = d1AuthDb(env.DB),
  opts: AuthHandlerOptions = {},
): Promise<Response> {
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
    if (request.method === "POST" && parts.join("/") === "auth/email/request") {
      // One generic answer, always — see requestMagicLink.
      const bindingSend: MagicEmailSender | undefined = env.EMAIL
        ? async (m) => { await (env.EMAIL as MagicEmailBinding).send(m); }
        : undefined;
      await requestMagicLink(db, str(body.email), {
        nowMs: opts.nowMs,
        baseUrl: env.HYGGE_MAGIC_BASE_URL,
        send: opts.sendMagicEmail ?? bindingSend,
        requesterHash: await requesterHashFrom(request),
      });
      return json({ ok: true, message: MAGIC_REQUEST_OK });
    }
    if (request.method === "GET" && parts.join("/") === "auth/magic") {
      // Landing only: never consumes, so mail prefetchers are harmless.
      return new Response(magicLandingHtml(url.searchParams.get("token") ?? ""), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
        },
      });
    }
    if (request.method === "POST" && parts.join("/") === "auth/email/consume") {
      const sessionUserId = await resolveRequestUserId(request, env, db);
      const outcome = await consumeMagicLink(db, str(body.token), { nowMs: opts.nowMs, sessionUserId });
      if (outcome.kind === "linked") return json({ methods: outcome.methods });
      return json(sessionBody(outcome.result), outcome.result.isNewUser ? 201 : 200);
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
    if (request.method === "DELETE" && parts[0] === "auth" && parts[1] === "methods" && parts[2]) {
      const userId = await requireUser(request, env, db);
      return json({ methods: await unlinkMethod(db, userId, parts[2]) });
    }
    return json({ error: "not_found", message: "That auth route doesn't exist." }, 404);
  } catch (e) {
    if (e instanceof AuthProblem) return json({ error: e.code, message: e.publicMessage }, e.status);
    // Internal detail stays in worker logs only (no user data, no secrets).
    console.error("auth request failed:", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    return json({ error: "auth_unavailable", message: "Sign-in is unavailable just now. Try again in a moment." }, 500);
  }
}
