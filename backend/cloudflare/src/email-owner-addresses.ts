// Ownership labels are user assertions; only authenticated challenge mail
// verifies a manually added address. Verification never replays old mail.
export interface EmailSql { exec(query: string, ...bindings: any[]): Iterable<Record<string, any>>; }
export function normalizeOwnEmail(value: unknown): string | null {
  const email = String(value ?? "").trim().toLowerCase();
  return email.length <= 254 && /^[^\s<>@\x00-\x1f]+@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(email) ? email : null;
}
async function digest(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map(b => b.toString(16).padStart(2, "0")).join("");
}
export class EmailOwnerAddresses {
  private sql: EmailSql;
  constructor(sql: EmailSql) { this.sql = sql; }
  ensure() {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS email_owner_addresses (
      address TEXT PRIMARY KEY, verified_at TEXT, challenge_hash TEXT, expires_at TEXT)`);
  }
  list() {
    return [...this.sql.exec("SELECT address, verified_at FROM email_owner_addresses ORDER BY address")]
      .map(r => ({ address: String(r.address), verified: !!r.verified_at, source: "added" }));
  }
  async add(value: unknown, now = new Date()) {
    const address = normalizeOwnEmail(value);
    if (!address) throw new Error("Enter a valid email address.");
    const existing = this.list().find(r => r.address === address);
    if (existing?.verified) return existing;
    if (!existing && this.list().length >= 20) throw new Error("You can add up to 20 personal addresses.");
    const token = crypto.randomUUID().replaceAll("-", "");
    this.sql.exec(`INSERT INTO email_owner_addresses (address, challenge_hash, expires_at) VALUES (?, ?, ?)
      ON CONFLICT(address) DO UPDATE SET challenge_hash=excluded.challenge_hash, expires_at=excluded.expires_at`,
      address, await digest(token), new Date(now.getTime() + 86400_000).toISOString());
    return { address, verified: false, source: "added", verificationSubject: `Hygge verify ${token}` };
  }
  remove(address: string) { this.sql.exec("DELETE FROM email_owner_addresses WHERE address = ?", address); }
  async verify(sender: string, authenticated: boolean, subject: string, now = new Date()): Promise<boolean> {
    if (!authenticated) return false;
    const address = normalizeOwnEmail(sender);
    const token = subject.trim().match(/^Hygge verify ([a-f0-9]{32})$/i)?.[1];
    if (!address || !token) return false;
    const row = [...this.sql.exec("SELECT challenge_hash, expires_at FROM email_owner_addresses WHERE address = ?", address)][0];
    if (!row?.challenge_hash || !row.expires_at || String(row.expires_at) <= now.toISOString()) return false;
    if (await digest(token.toLowerCase()) !== row.challenge_hash) return false;
    this.sql.exec("UPDATE email_owner_addresses SET verified_at = ?, challenge_hash = NULL, expires_at = NULL WHERE address = ?", now.toISOString(), address);
    return true;
  }
}
