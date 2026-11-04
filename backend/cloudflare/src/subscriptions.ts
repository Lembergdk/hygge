/// Plus subscriptions: the record of what the App Store says,
/// and the one tier derivation everyone reads.
///
/// v1 verification honesty: transactions are DECODED and their
/// fields checked (bundle, product, environment, expiry), and
/// the signed payload is stored verbatim — but the x5c signature
/// chain to Apple Root CA is NOT yet verified in the Worker.
/// That is the named hardening follow-up before relying on this
/// at scale; the check below is shaped so swapping in chain
/// verification changes nothing else.

export const PLUS_PRODUCT_ID = "app.usehygge.plus.monthly";
export const APP_BUNDLE_ID = "app.usehygge";

export interface SubscriptionRow {
  userId: string;
  productId: string;
  originalTransactionId: string | null;
  environment: string | null;
  expiresAt: string;
  jws?: string | null;
}

export interface DecodedTransaction {
  productId: string;
  originalTransactionId: string | null;
  environment: string | null;
  expiresAt: string;
}

function base64UrlJson(part: string): Record<string, any> | null {
  try {
    const padded = part.replace(/-/g, "+").replace(/_/g, "/")
      .padEnd(Math.ceil(part.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/// Decode a StoreKit signed transaction (JWS) into the fields
/// the tier rests on. Wrong bundle/product/environment or an
/// already-expired transaction decodes to null.
export function decodeStoreKitTransaction(
  jws: unknown,
  opts: { now: Date; environment: "production" | "sandbox" },
): DecodedTransaction | null {
  const parts = String(jws ?? "").split(".");
  if (parts.length !== 3) return null;
  const payload = base64UrlJson(parts[1]);
  if (!payload) return null;
  if (String(payload.bundleId ?? "") !== APP_BUNDLE_ID) return null;
  if (String(payload.productId ?? "") !== PLUS_PRODUCT_ID) return null;
  const environment = String(payload.environment ?? "");
  if (opts.environment === "production" && environment !== "Production") return null;
  if (opts.environment === "sandbox" && !["Sandbox", "Xcode", "LocalTesting"].includes(environment)) return null;
  const expiresMs = Number(payload.expiresDate ?? 0);
  if (!Number.isFinite(expiresMs) || expiresMs <= opts.now.getTime()) return null;
  return {
    productId: PLUS_PRODUCT_ID,
    originalTransactionId: payload.originalTransactionId ? String(payload.originalTransactionId) : null,
    environment,
    expiresAt: new Date(expiresMs).toISOString(),
  };
}

export interface SubscriptionDb {
  findByUser(userId: string): Promise<SubscriptionRow | null>;
  upsert(row: SubscriptionRow): Promise<void>;
}

export class MemorySubscriptionDb implements SubscriptionDb {
  rows = new Map<string, SubscriptionRow>();
  async findByUser(userId: string) { return this.rows.get(userId) ?? null; }
  async upsert(row: SubscriptionRow) { this.rows.set(row.userId, row); }
}

export function d1SubscriptionDb(db: D1Database): SubscriptionDb {
  return {
    async findByUser(userId) {
      const r = await db.prepare(
        "SELECT user_id, product_id, original_transaction_id, environment, expires_at FROM subscriptions WHERE user_id = ?1",
      ).bind(userId).first() as Record<string, unknown> | null;
      if (!r) return null;
      return {
        userId: String(r.user_id), productId: String(r.product_id),
        originalTransactionId: r.original_transaction_id ? String(r.original_transaction_id) : null,
        environment: r.environment ? String(r.environment) : null,
        expiresAt: String(r.expires_at),
      };
    },
    async upsert(row) {
      await db.prepare(
        `INSERT INTO subscriptions (user_id, product_id, original_transaction_id, environment, expires_at, jws, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'))
         ON CONFLICT(user_id) DO UPDATE SET product_id = excluded.product_id,
           original_transaction_id = excluded.original_transaction_id,
           environment = excluded.environment, expires_at = excluded.expires_at,
           jws = excluded.jws, updated_at = datetime('now')`,
      ).bind(row.userId, row.productId, row.originalTransactionId, row.environment, row.expiresAt, row.jws ?? null).run();
    },
  };
}

/// The one tier rule: Plus while a recorded subscription is
/// unexpired, Free otherwise.
export async function activeTier(db: SubscriptionDb, userId: string, now: Date): Promise<"free" | "plus"> {
  try {
    const row = await db.findByUser(userId);
    if (row && new Date(row.expiresAt).getTime() > now.getTime()) return "plus";
  } catch { /* a lookup hiccup must never grant or deny loudly; Free is the safe read */ }
  return "free";
}
