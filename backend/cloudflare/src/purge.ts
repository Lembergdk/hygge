/// TEMPORARY one-shot fleet wipe (owner-requested fresh start,
/// 2026-11-03). Deletes every user from D1, every per-user
/// Durable Object's storage, and every object in the per-env R2
/// buckets. This module, its route, and its workflow are removed
/// in the follow-up change once both environments report zero.
///
/// Safety shape:
/// - Inert unless the HYGGE_PURGE_TOKEN secret is set (route
///   answers 404 like any unknown path).
/// - Requires that exact bearer token AND an explicit
///   {"confirm":"DELETE-ALL-USERS"} body.
/// - DO purge requires the server-side marker + token headers,
///   which index.ts strips from outside requests; the DO checks
///   the token itself as defense in depth.
/// - Response carries counts only — never user data.

import type { Env } from "./env.ts";
import { json, sandboxFor } from "./env.ts";

export const PURGE_CONFIRMATION = "DELETE-ALL-USERS";

/// D1 tables wiped, children before parents where foreign keys
/// declare an order. Any table not listed here (future drift)
/// is swept dynamically afterwards, except migration bookkeeping.
export const PURGE_TABLES_IN_ORDER = [
  "password_confirmations",
  "magic_link_tokens",
  "magic_link_requests",
  "auth_attempts",
  "auth_sessions",
  "linked_methods",
  "hygge_email_addresses",
  "device_tokens",
  "push_log",
  "usage_events",
  "user_keys",
  "skill_admissions_v2",
  "skill_quarantines_v2",
  "skill_usage_v2",
  "skill_publications_v2",
  "public_skills_v2",
  "skills",
  "site_hints",
  "site_catalog",
  "email_routing_counts",
  "users",
] as const;

export interface PurgeDeps {
  listUsers(): Promise<Array<{ id: string }>>;
  listTables(): Promise<string[]>;
  deleteFromTable(table: string): Promise<number>;
  purgeSandbox(userId: string): Promise<boolean>;
  emptyBucket(bucket: R2Bucket | undefined): Promise<number>;
}

export interface PurgeReport {
  users: number;
  durableObjectsPurged: number;
  durableObjectFailures: number;
  r2ObjectsDeleted: number;
  d1RowsDeleted: number;
  d1Tables: string[];
}

async function emptyBucket(bucket: R2Bucket | undefined): Promise<number> {
  if (!bucket) return 0;
  let deleted = 0;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ cursor, limit: 1000 });
    if (page.objects.length) {
      await bucket.delete(page.objects.map((o) => o.key));
      deleted += page.objects.length;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return deleted;
}

function realDeps(env: Env): PurgeDeps {
  const db = env.DB;
  return {
    async listUsers() {
      const { results } = await db.prepare("SELECT id FROM users").all();
      return (results as Array<Record<string, unknown>>).map((r) => ({ id: String(r.id) }));
    },
    async listTables() {
      const { results } = await db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations'",
        )
        .all();
      return (results as Array<Record<string, unknown>>).map((r) => String(r.name));
    },
    async deleteFromTable(table) {
      // Table names come only from sqlite_master / the constant
      // list above — never from request input.
      const result = await db.prepare(`DELETE FROM "${table}"`).run();
      return result.meta.changes ?? 0;
    },
    async purgeSandbox(userId) {
      const stub = sandboxFor(env, userId);
      const response = await stub.fetch(new Request("https://sandbox.internal/internal/purge", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hygge-purge": "1",
          "x-hygge-purge-token": env.HYGGE_PURGE_TOKEN ?? "",
          "x-hygge-user-id": userId,
        },
        body: "{}",
      }));
      return response.ok;
    },
    emptyBucket,
  };
}

export async function purgeAllUsers(env: Env, deps: PurgeDeps = realDeps(env)): Promise<PurgeReport> {
  const users = await deps.listUsers();
  let durableObjectsPurged = 0;
  let durableObjectFailures = 0;
  for (const user of users) {
    try {
      if (await deps.purgeSandbox(user.id)) durableObjectsPurged += 1;
      else durableObjectFailures += 1;
    } catch {
      durableObjectFailures += 1;
    }
  }
  const r2ObjectsDeleted =
    (await deps.emptyBucket(env.BROWSER_PROFILES)) +
    (await deps.emptyBucket(env.WORKSPACE_CHECKPOINTS));
  const known = new Set<string>(PURGE_TABLES_IN_ORDER);
  const existing = (await deps.listTables()).filter(
    (t) => !t.startsWith("sqlite_") && !t.startsWith("_cf_") && t !== "d1_migrations",
  );
  const ordered = [
    ...PURGE_TABLES_IN_ORDER.filter((t) => existing.includes(t)),
    ...existing.filter((t) => !known.has(t)),
  ];
  let d1RowsDeleted = 0;
  for (const table of ordered) d1RowsDeleted += await deps.deleteFromTable(table);
  return {
    users: users.length,
    durableObjectsPurged,
    durableObjectFailures,
    r2ObjectsDeleted,
    d1RowsDeleted,
    d1Tables: ordered,
  };
}

async function tokenMatches(provided: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(provided)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  const av = new Uint8Array(a);
  const bv = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < av.length; i++) diff |= av[i] ^ bv[i];
  return diff === 0;
}

export async function handlePurgeRequest(
  request: Request,
  env: Env,
  deps: PurgeDeps = realDeps(env),
): Promise<Response> {
  // Inert without the secret: indistinguishable from no route.
  if (!env.HYGGE_PURGE_TOKEN) return json({ error: "not found" }, 404);
  if (request.method !== "POST") return json({ error: "not found" }, 404);
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || !(await tokenMatches(token, env.HYGGE_PURGE_TOKEN))) {
    return json({ error: "not found" }, 404);
  }
  const body = (await request.json().catch(() => ({}))) as { confirm?: unknown };
  if (body.confirm !== PURGE_CONFIRMATION) {
    return json({ error: "confirmation required" }, 400);
  }
  const report = await purgeAllUsers(env, deps);
  return json({ ok: true, env: env.HYGGE_ENV, ...report });
}
