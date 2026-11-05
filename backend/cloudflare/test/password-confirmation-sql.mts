import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { d1AuthDb, requestPasswordConfirmation, confirmEmailPassword, issueSession, resolveSessionUserId } from "../src/auth.ts";

// Exercise the actual D1 SQL and transaction boundaries against SQLite, rather
// than proving only the in-memory AuthDb fake agrees with the service functions.
function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  const migrations = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(migrations).filter(n => n.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(new URL(name, migrations), "utf8"));
  }
  function prepare(sql: string) {
    let values: any[] = [];
    // D1 accepts numbered placeholders positionally; node:sqlite uses named
    // bindings for ?1, ?2 etc. Normalize placeholders without changing SQL logic.
    const statement = () => {
      const ordered: any[] = [];
      const normalized = sql.replace(/\?(\d+)/g, (_, n) => { ordered.push(values[Number(n) - 1]); return "?"; });
      return { statement: sqlite.prepare(normalized), values: ordered };
    };
    return {
      bind(...args: any[]) { values = args; return this; },
      async first() { const s = statement(); return s.statement.get(...s.values) ?? null; },
      async all() { const s = statement(); return { results: s.statement.all(...s.values) }; },
      runSync() { const s = statement(); return { meta: { changes: Number(s.statement.run(...s.values).changes) } }; },
      async run() { return this.runSync(); },
    };
  }
  const adapter = { prepare, async batch(statements: ReturnType<typeof prepare>[]) {
    sqlite.exec("BEGIN");
    try { const results = statements.map(s => s.runSync()); sqlite.exec("COMMIT"); return results; }
    catch (e) { sqlite.exec("ROLLBACK"); throw e; }
  } };
  return { db: d1AuthDb(adapter as any), sqlite };
}

async function pending() {
  const f = fixture();
  await f.db.createUser({ id: "user", contactEmail: "test@example.com", displayName: null });
  await f.db.addMethod({ id: "email", userId: "user", method: "email", email: "test@example.com",
    appleSub: null, appleEmail: null, passwordHash: null, emailVerified: true });
  const session = await issueSession(f.db, "user");
  let token = "";
  const receipt = await requestPasswordConfirmation(f.db, "user", "email", "a long test password", {
    baseUrl: "https://api.usehygge.app", send: async mail => {
      token = new URL(mail.text.match(/https:\/\/[^\s]+/)![0]).searchParams.get("token")!;
    },
  });
  return { ...f, session, token, receipt };
}

test("D1 SQL commits password + revocation + single-use consumption atomically", async () => {
  const f = await pending();
  try {
    assert.equal((await f.db.getMethodById("email"))!.passwordHash, null);
    const results = await Promise.allSettled([confirmEmailPassword(f.db, f.token), confirmEmailPassword(f.db, f.token)]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(await resolveSessionUserId(f.db, f.session.token), null);
    assert.match((await f.db.getMethodById("email"))!.passwordHash!, /^scrypt-v1\$/);
    assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM password_confirmations").get()!.n, 0);
  } finally { f.sqlite.close(); }
});

test("D1 SQL cancels pending changes and cannot overwrite a concurrently changed hash", async () => {
  for (const mode of ["cancel", "replace", "expire"]) {
    const f = await pending();
    try {
      if (mode === "cancel") await f.db.cancelPasswordConfirmation(f.receipt.id, "user");
      if (mode === "replace") f.sqlite.exec("UPDATE linked_methods SET password_hash = 'newer-hash'");
      if (mode === "expire") f.sqlite.exec("UPDATE password_confirmations SET expires_at = '2000-01-01T00:00:00.000Z'");
      await assert.rejects(confirmEmailPassword(f.db, f.token));
      assert.equal((await f.db.getMethodById("email"))!.passwordHash, mode === "replace" ? "newer-hash" : null);
      assert.equal(await resolveSessionUserId(f.db, f.session.token), "user");
    } finally { f.sqlite.close(); }
  }
});

test("D1 SQL deletes every user row on account deletion and keeps other users", async () => {
  const f = fixture();
  try {
    const seed = (id: string, email: string, digits: string) => {
      f.sqlite.exec(`INSERT INTO users (id, email, do_instance) VALUES ('${id}', '${email}', 'do-${id}')`);
      f.sqlite.exec(`INSERT INTO linked_methods (id, user_id, method, email, email_verified) VALUES ('m-${id}', '${id}', 'email', '${email}', 1)`);
      f.sqlite.exec(`INSERT INTO auth_sessions (id, user_id, token_hash, created_at, expires_at) VALUES ('s-${id}', '${id}', 'hash-${id}', '2026-01-01T00:00:00.000Z', NULL)`);
      f.sqlite.exec(`INSERT INTO device_tokens (user_id, token) VALUES ('${id}', 'tok-${id}')`);
      f.sqlite.exec(`INSERT INTO push_log (user_id, kind) VALUES ('${id}', 'test')`);
      f.sqlite.exec(`INSERT INTO usage_events (user_id, kind, units) VALUES ('${id}', 'llm', 1)`);
      f.sqlite.exec(`INSERT INTO subscriptions (user_id, product_id, expires_at) VALUES ('${id}', 'plus', '2030-01-01T00:00:00.000Z')`);
      f.sqlite.exec(`INSERT INTO hygge_email_addresses (digits, user_id) VALUES ('${digits}', '${id}')`);
      f.sqlite.exec(`INSERT INTO hygge_email_aliases (alias, user_id) VALUES ('${id}@usehygge.cc', '${id}')`);
      f.sqlite.exec(`INSERT INTO user_keys (user_id, wrapped) VALUES ('${id}', x'00')`);
      f.sqlite.exec(`INSERT INTO magic_link_tokens (id, email, token_hash, expires_at, created_at) VALUES ('ml-${id}', '${email}', 'mlhash-${id}', '2030-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`);
      f.sqlite.exec(`INSERT INTO password_confirmations (id, user_id, method_id, email, token_hash, password_hash, expires_at, created_at) VALUES ('pc-${id}', '${id}', 'm-${id}', '${email}', 'pchash-${id}', 'hash', '2030-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`);
    };
    seed("user", "user@example.com", "1111111111");
    seed("other", "other@example.com", "2222222222");
    // Abuse-ledger rows keyed by hashes of the user's id and email; the
    // IP-keyed row is not user data and must survive.
    const { createHash } = await import("node:crypto");
    const hex = (s: string) => createHash("sha256").update(s).digest("hex");
    f.sqlite.exec(`INSERT INTO magic_link_requests (id, ip_hash, created_at) VALUES ('lr-user', 'password:confirmation:${hex("user")}', '2026-01-01T00:00:00.000Z')`);
    f.sqlite.exec(`INSERT INTO magic_link_requests (id, ip_hash, created_at) VALUES ('lr-user-email', 'password:email:${hex("user@example.com")}', '2026-01-01T00:00:00.000Z')`);
    f.sqlite.exec(`INSERT INTO magic_link_requests (id, ip_hash, created_at) VALUES ('lr-other', 'password:confirmation:${hex("other")}', '2026-01-01T00:00:00.000Z')`);
    f.sqlite.exec(`INSERT INTO magic_link_requests (id, ip_hash, created_at) VALUES ('lr-ip', 'password:ip:deadbeef', '2026-01-01T00:00:00.000Z')`);
    await f.db.deleteAccount("user");
    const count = (table: string, where: string) => (f.sqlite.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get() as any).n;
    for (const [table, where] of [
      ["users", "id = 'user'"], ["linked_methods", "user_id = 'user'"], ["auth_sessions", "user_id = 'user'"],
      ["device_tokens", "user_id = 'user'"], ["push_log", "user_id = 'user'"], ["usage_events", "user_id = 'user'"],
      ["subscriptions", "user_id = 'user'"], ["hygge_email_addresses", "user_id = 'user'"], ["hygge_email_aliases", "user_id = 'user'"],
      ["user_keys", "user_id = 'user'"], ["magic_link_tokens", "email = 'user@example.com'"],
      ["password_confirmations", "user_id = 'user'"],
    ] as const) assert.equal(count(table, where), 0, table);
    assert.equal(count("magic_link_requests", "id = 'lr-user'"), 0);
    assert.equal(count("magic_link_requests", "id = 'lr-user-email'"), 0);
    assert.equal(count("magic_link_requests", "id = 'lr-other'"), 1);
    assert.equal(count("magic_link_requests", "id = 'lr-ip'"), 1);
    assert.equal(count("users", "id = 'other'"), 1);
    assert.equal(count("linked_methods", "user_id = 'other'"), 1);
    assert.equal(count("auth_sessions", "user_id = 'other'"), 1);
  } finally { f.sqlite.close(); }
});
