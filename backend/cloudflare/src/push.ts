/// Push notifications (Brief 07): device-token registration, the
/// APNs sender, and the trigger rules. Transactional only — a task
/// entering `needsHuman` and a scheduled-scan batch that surfaced
/// new work are the only two events that can ever notify. There is
/// no digest, no marketing path, and no other caller.
///
/// Payload minimalism is structural: `buildPushPayload` can only
/// emit a constant calm title plus a task/feed reference for
/// deep-linking. It has no parameter that could carry a code, an
/// amount, a message body, or profile data, so a future caller
/// cannot smuggle one in without changing this function's shape
/// (and its schema test).
///
/// Tokens are personal data: they live in D1 `device_tokens` keyed
/// to the owning user, are never logged, and prove nothing about
/// identity — every route here is reached only after index.ts has
/// resolved the user from the Brief 00 session.
///
/// Unconfigured sending (no APNs key yet) is a logged no-op: one
/// `push_log` row with status `unconfigured`, zero network calls,
/// and never a claimed success. See docs/push-notifications.md for
/// the full failure matrix and the remaining portal steps.
import type { Env } from "./env.ts";
import { json } from "./env.ts";
import type { ScanTickSummary } from "./scan.ts";

// ---- trigger vocabulary ------------------------------------------------

export type PushKind = "needs_you" | "new_work";
export type PushRefKind = "task" | "feed";

export interface PushEvent {
  kind: PushKind;
  refKind: PushRefKind;
  refId: string | null;
}

/// Final copy is Mikael's call at review time (brief open question);
/// these are the brief's proposed neutral titles. Titles only —
/// APNs `alert` is a bare string here, so no body can exist.
export const PUSH_TITLES: Record<PushKind, string> = {
  needs_you: "Hygge needs you",
  new_work: "New work found",
};

export function needsHumanEvent(taskId: string): PushEvent {
  return { kind: "needs_you", refKind: "task", refId: taskId };
}

/// A task run notifies only on a *fresh* entry into needsHuman, and
/// never for scheduled-scan missions: scan episodes notify once per
/// tick through `planTickNotifications`, so the same episode can
/// never produce two pushes.
export function shouldNotifyNeedsHuman(
  previousStatus: string | null | undefined,
  nextStatus: string | null | undefined,
  opts: { scheduledScan?: boolean } = {},
): boolean {
  if (opts.scheduledScan) return false;
  return nextStatus === "needsHuman" && previousStatus !== "needsHuman";
}

/// At most ONE push per scan tick, whatever the tick found. A
/// needs-you episode outranks new work (it blocks future scans);
/// the new items are still waiting in the feed when the user opens
/// the app from the needs-you push.
export function planTickNotifications(
  summary: Pick<ScanTickSummary, "paused" | "surfacedIds" | "needsYouItemIds">,
): PushEvent[] {
  if (summary.paused) return [];
  const needsYou = summary.needsYouItemIds?.[0];
  if (needsYou) return [{ kind: "needs_you", refKind: "feed", refId: needsYou }];
  const surfaced = summary.surfacedIds?.[0];
  if (surfaced) return [{ kind: "new_work", refKind: "feed", refId: surfaced }];
  return [];
}

// ---- payload -------------------------------------------------------------

export interface PushPayload {
  aps: { alert: string; sound: string };
  hyggeKind: PushKind;
  hyggeRef: string | null;
  hyggeRoute: string;
}

/// The ONLY payload shape this system can send: constant title +
/// reference. No badge: the server does not keep a badge count, and
/// inventing one would drift from what the feed actually shows.
export function buildPushPayload(event: PushEvent): PushPayload {
  const route = event.refId ? `${event.refKind}/${event.refId}` : "home";
  return {
    aps: { alert: PUSH_TITLES[event.kind], sound: "default" },
    hyggeKind: event.kind,
    hyggeRef: event.refId,
    hyggeRoute: route,
  };
}

// ---- device tokens ---------------------------------------------------------

/// APNs device tokens arrive from the app as lowercase hex. Anything
/// else is rejected at registration so junk can never reach APNs.
export function normalizeDeviceToken(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const token = raw.trim().toLowerCase().replace(/[\s<>]/g, "");
  return /^[0-9a-f]{32,256}$/.test(token) ? token : null;
}

export interface DeviceTokenRow {
  token: string;
  platform: string;
  updatedAt: string;
}

export interface PushLogRow {
  kind: string;
  apnsStatus: string | null;
  createdAt: string;
}

export interface PushDb {
  upsertToken(userId: string, token: string, platform: string, updatedAt: string): Promise<void>;
  listTokens(userId: string): Promise<DeviceTokenRow[]>;
  deleteToken(userId: string, token: string): Promise<boolean>;
  logAttempt(userId: string, kind: string, apnsStatus: string): Promise<void>;
  recentLog(userId: string, limit: number): Promise<PushLogRow[]>;
}

/// Bound the fan-out: a user with very many stale registrations
/// still gets at most this many attempts per event (newest first).
export const MAX_TOKENS_PER_SEND = 10;

export function d1PushDb(db: D1Database): PushDb {
  return {
    async upsertToken(userId, token, platform, updatedAt) {
      // A physical device belongs to whoever is signed in on it now:
      // registering a token reassigns it, so a previous account on
      // this phone stops receiving pushes here.
      await db
        .prepare("DELETE FROM device_tokens WHERE token = ?2 AND user_id <> ?1")
        .bind(userId, token)
        .run();
      await db
        .prepare(
          `INSERT INTO device_tokens (user_id, token, platform, updated_at)
           VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT(user_id, token) DO UPDATE SET
             platform = excluded.platform, updated_at = excluded.updated_at`,
        )
        .bind(userId, token, platform, updatedAt)
        .run();
    },
    async listTokens(userId) {
      const { results } = await db
        .prepare(
          "SELECT token, platform, updated_at FROM device_tokens WHERE user_id = ?1 ORDER BY updated_at DESC, token",
        )
        .bind(userId)
        .all();
      return (results as Record<string, unknown>[]).map((r) => ({
        token: String(r.token),
        platform: String(r.platform),
        updatedAt: String(r.updated_at),
      }));
    },
    async deleteToken(userId, token) {
      const before = await db
        .prepare("SELECT COUNT(*) AS n FROM device_tokens WHERE user_id = ?1 AND token = ?2")
        .bind(userId, token)
        .first<{ n: number }>();
      await db
        .prepare("DELETE FROM device_tokens WHERE user_id = ?1 AND token = ?2")
        .bind(userId, token)
        .run();
      return Number(before?.n ?? 0) > 0;
    },
    async logAttempt(userId, kind, apnsStatus) {
      await db
        .prepare("INSERT INTO push_log (user_id, kind, apns_status) VALUES (?1, ?2, ?3)")
        .bind(userId, kind, apnsStatus)
        .run();
    },
    async recentLog(userId, limit) {
      const { results } = await db
        .prepare(
          "SELECT kind, apns_status, created_at FROM push_log WHERE user_id = ?1 ORDER BY id DESC LIMIT ?2",
        )
        .bind(userId, limit)
        .all();
      return (results as Record<string, unknown>[]).map((r) => ({
        kind: String(r.kind),
        apnsStatus: r.apns_status == null ? null : String(r.apns_status),
        createdAt: String(r.created_at),
      }));
    },
  };
}

/// In-memory PushDb for tests (same per-user keying as D1).
export class MemoryPushDb implements PushDb {
  tokens = new Map<string, DeviceTokenRow & { userId: string }>();
  log: (PushLogRow & { userId: string })[] = [];
  async upsertToken(userId: string, token: string, platform: string, updatedAt: string) {
    for (const [key, row] of this.tokens) {
      if (row.token === token && row.userId !== userId) this.tokens.delete(key);
    }
    this.tokens.set(`${userId}\n${token}`, { userId, token, platform, updatedAt });
  }
  async listTokens(userId: string) {
    return [...this.tokens.values()]
      .filter((t) => t.userId === userId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.token.localeCompare(b.token))
      .map(({ token, platform, updatedAt }) => ({ token, platform, updatedAt }));
  }
  async deleteToken(userId: string, token: string) {
    return this.tokens.delete(`${userId}\n${token}`);
  }
  async logAttempt(userId: string, kind: string, apnsStatus: string) {
    this.log.push({ userId, kind, apnsStatus, createdAt: new Date().toISOString() });
  }
  async recentLog(userId: string, limit: number) {
    return this.log.filter((r) => r.userId === userId).slice(-limit).reverse()
      .map(({ kind, apnsStatus, createdAt }) => ({ kind, apnsStatus, createdAt }));
  }
}

// ---- APNs configuration ----------------------------------------------------

export interface ApnsConfig {
  keyP8: string;
  keyId: string;
  teamId: string;
  bundleId: string;
  host: string;
}

export function apnsHostFor(environment: string | undefined): string {
  return environment === "sandbox" ? "api.sandbox.push.apple.com" : "api.push.apple.com";
}

/// Config comes from env only (names already reserved in env.ts):
/// HYGGE_APNS_KEY_P8 is a wrangler secret, never config; key/team
/// ids may be vars or secrets. Anything missing or blank means
/// "not configured" — sending then logs and stops (see notifyUser).
export function apnsConfigFromEnv(
  env: Pick<Env, "HYGGE_APNS_KEY_P8" | "HYGGE_APNS_KEY_ID" | "HYGGE_APNS_TEAM_ID" | "HYGGE_APNS_ENVIRONMENT" | "HYGGE_APPLE_BUNDLE_ID">,
): ApnsConfig | null {
  const keyP8 = (env.HYGGE_APNS_KEY_P8 ?? "").trim();
  const keyId = (env.HYGGE_APNS_KEY_ID ?? "").trim();
  const teamId = (env.HYGGE_APNS_TEAM_ID ?? "").trim();
  if (!keyP8 || !keyId || !teamId) return null;
  return {
    keyP8,
    keyId,
    teamId,
    bundleId: (env.HYGGE_APPLE_BUNDLE_ID ?? "").trim() || "app.usehygge",
    host: apnsHostFor(env.HYGGE_APNS_ENVIRONMENT),
  };
}

// ---- APNs provider JWT (ES256, WebCrypto) ----------------------------------

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function utf8(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text);
}

/// Accept the .p8 exactly as downloaded (PEM armor), as pasted into
/// a wrangler secret with literal `\n`s, or as bare base64.
export function pemToPkcs8(pem: string): Uint8Array<ArrayBuffer> {
  const body = pem
    .replaceAll("\\n", "\n")
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  if (!body) throw new Error("APNs key is empty");
  const raw = atob(body);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export async function importApnsKey(keyP8: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(keyP8),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

/// One provider token: header {alg: ES256, kid}, claims {iss, iat}.
/// WebCrypto's ECDSA signature is already the raw r||s JWS wants.
export async function signApnsJwt(
  key: CryptoKey,
  claims: { keyId: string; teamId: string },
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const header = b64url(utf8(JSON.stringify({ alg: "ES256", kid: claims.keyId })));
  const payload = b64url(utf8(JSON.stringify({ iss: claims.teamId, iat: nowSeconds })));
  const signingInput = `${header}.${payload}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8(signingInput)),
  );
  return `${signingInput}.${b64url(signature)}`;
}

/// APNs rejects provider tokens older than one hour and forbids
/// minting more often than every 20 minutes, so cache for 50.
export const APNS_JWT_TTL_MS = 50 * 60 * 1000;

export class ApnsJwtCache {
  private entries = new Map<string, { jwt: string; mintedAtMs: number }>();
  async token(config: ApnsConfig, nowMs: number = Date.now()): Promise<string> {
    const cacheKey = `${config.teamId}|${config.keyId}`;
    const hit = this.entries.get(cacheKey);
    if (hit && nowMs - hit.mintedAtMs < APNS_JWT_TTL_MS) return hit.jwt;
    const jwt = await signApnsJwt(
      await importApnsKey(config.keyP8),
      { keyId: config.keyId, teamId: config.teamId },
      Math.floor(nowMs / 1000),
    );
    this.entries.set(cacheKey, { jwt, mintedAtMs: nowMs });
    return jwt;
  }
  clear() {
    this.entries.clear();
  }
}

export const apnsJwtCache = new ApnsJwtCache();

// ---- sending ---------------------------------------------------------------

export type PushFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ApnsSendResult {
  ok: boolean;
  status: number;
  reason: string | null;
}

/// Bad/expired-token verdicts: the token is deleted immediately and
/// never sent to again. Everything else is counted, not retried.
export function isBadTokenResult(result: ApnsSendResult): boolean {
  return result.status === 410 || result.reason === "BadDeviceToken" || result.reason === "Unregistered";
}

export async function sendToToken(
  config: ApnsConfig,
  jwt: string,
  token: string,
  payload: PushPayload,
  fetchFn: PushFetch = fetch,
): Promise<ApnsSendResult> {
  const response = await fetchFn(`https://${config.host}/3/device/${token}`, {
    method: "POST",
    headers: {
      authorization: `bearer ${jwt}`,
      "apns-topic": config.bundleId,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  let reason: string | null = null;
  if (!response.ok) {
    try {
      const body = (await response.clone().json()) as { reason?: unknown };
      reason = typeof body.reason === "string" ? body.reason : null;
    } catch { /* status alone is enough to log */ }
  }
  return { ok: response.ok, status: response.status, reason };
}

/// After this many consecutive failed EVENTS a user's sends pause
/// (logged as `suppressed`) — never a retry storm. Failure is
/// counted once per event via the `event_failed` summary row
/// notifyUser writes, NOT per token attempt: one bad event fanning
/// out to many stale tokens must not suppress the next event.
/// Suppression lifts on the next success or when a fresh device
/// token registers (a `registered` row), which is the usual way
/// back from a broken setup.
export const MAX_CONSECUTIVE_FAILURES = 5;

export function consecutiveFailures(recent: PushLogRow[]): number {
  let count = 0;
  for (const row of recent) {
    const status = row.apnsStatus ?? "";
    if (status === "ok" || status === "registered") break;
    if (status === "event_failed") count += 1;
  }
  return count;
}

export type NotifyOutcome =
  | "sent" | "partial" | "failed" | "paused" | "no_tokens" | "unconfigured" | "suppressed";

export interface NotifyResult {
  outcome: NotifyOutcome;
  attempted: number;
  delivered: number;
  removedTokens: number;
}

/// The one send path. Gating order: paused → no tokens →
/// unconfigured → repeated-failure suppression → one attempt per
/// token, each logged to push_log (status only, never payload or
/// token). This function never throws for delivery problems; a
/// caller wraps it so push can never fail user work.
export async function notifyUser(
  db: PushDb,
  config: ApnsConfig | null,
  userId: string,
  event: PushEvent,
  opts: { isPaused?: boolean; fetchFn?: PushFetch; jwtCache?: ApnsJwtCache; nowMs?: number } = {},
): Promise<NotifyResult> {
  const zero = { attempted: 0, delivered: 0, removedTokens: 0 };
  if (opts.isPaused) return { outcome: "paused", ...zero };
  const tokens = (await db.listTokens(userId)).slice(0, MAX_TOKENS_PER_SEND);
  if (!tokens.length) return { outcome: "no_tokens", ...zero };
  if (!config) {
    await db.logAttempt(userId, event.kind, "unconfigured").catch(() => {});
    // Counts only — tokens and payloads are never logged anywhere.
    console.log(`push ${event.kind}: APNs not configured; skipped ${tokens.length} token(s)`);
    return { outcome: "unconfigured", ...zero };
  }
  const recent = await db.recentLog(userId, 50).catch(() => [] as PushLogRow[]);
  if (consecutiveFailures(recent) >= MAX_CONSECUTIVE_FAILURES) {
    await db.logAttempt(userId, event.kind, "suppressed").catch(() => {});
    return { outcome: "suppressed", ...zero };
  }

  const fetchFn = opts.fetchFn ?? fetch;
  const payload = buildPushPayload(event);
  let jwt: string;
  try {
    jwt = await (opts.jwtCache ?? apnsJwtCache).token(config, opts.nowMs);
  } catch {
    await db.logAttempt(userId, event.kind, "key_error").catch(() => {});
    return { outcome: "failed", ...zero };
  }

  let delivered = 0;
  let removedTokens = 0;
  for (const row of tokens) {
    let result: ApnsSendResult;
    try {
      result = await sendToToken(config, jwt, row.token, payload, fetchFn);
    } catch {
      await db.logAttempt(userId, event.kind, "network_error").catch(() => {});
      continue;
    }
    if (result.ok) {
      delivered += 1;
      await db.logAttempt(userId, event.kind, "ok").catch(() => {});
      continue;
    }
    await db.logAttempt(
      userId, event.kind,
      result.reason ? `${result.status}:${result.reason}` : String(result.status),
    ).catch(() => {});
    if (isBadTokenResult(result)) {
      if (await db.deleteToken(userId, row.token).catch(() => false)) removedTokens += 1;
    }
  }
  const attempted = tokens.length;
  if (attempted > 0 && delivered === 0) {
    // One summary row per failed event: this is what suppression
    // counts, so fan-out size cannot inflate the failure streak.
    await db.logAttempt(userId, event.kind, "event_failed").catch(() => {});
  }
  const outcome: NotifyOutcome = delivered === attempted ? "sent" : delivered > 0 ? "partial" : "failed";
  return { outcome, attempted, delivered, removedTokens };
}

// ---- HTTP: /device-tokens (own tokens only) --------------------------------

/// Registration for the authenticated caller. index.ts resolves the
/// user id from the session first; there is deliberately no user-id
/// or digits-style parameter anywhere, so another user's tokens
/// cannot be read, overwritten, or deleted through this handler.
export async function handleDeviceTokenRequest(
  request: Request,
  userId: string,
  db: PushDb,
  now: Date = new Date(),
): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean); // ["device-tokens", token?]

  if (request.method === "POST" && parts.length === 1) {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const token = normalizeDeviceToken(body.token);
    if (!token) return json({ error: "token required" }, 400);
    const platform = typeof body.platform === "string" && body.platform ? body.platform : "ios";
    if (platform !== "ios") return json({ error: "unsupported platform" }, 400);
    const isNewToken = !(await db.listTokens(userId)).some((t) => t.token === token);
    await db.upsertToken(userId, token, platform, now.toISOString());
    // A fresh token is the way back from failure suppression: the
    // marker row (status only, never the token) resets the streak.
    // Routine foreground re-registration of the same token does not
    // write a row.
    if (isNewToken) await db.logAttempt(userId, "registration", "registered").catch(() => {});
    return json({ registered: true, platform }, 201);
  }

  if (request.method === "DELETE" && parts.length === 1) {
    // Body only: device tokens never travel in URL paths (logs).
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const token = normalizeDeviceToken(body.token);
    if (!token) return json({ error: "token required" }, 400);
    return json({ removed: await db.deleteToken(userId, token) });
  }

  return json({ error: "method not allowed" }, 405);
}
