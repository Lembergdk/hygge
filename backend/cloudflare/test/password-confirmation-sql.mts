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
