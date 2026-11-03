import { canonical, digest, fail, type WorkspaceStorage } from './workspace-persistence.ts';

const CURRENT = `CREATE TABLE credentials (id TEXT PRIMARY KEY, domain TEXT NOT NULL, username TEXT NOT NULL, iv TEXT NOT NULL, ciphertext TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))`;
const LEGACY = `CREATE TABLE credentials (site_id TEXT PRIMARY KEY, username TEXT, iv TEXT, ciphertext TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')))`;
const norm = (s: string) => s.replace(/IF NOT EXISTS/gi, '').replace(/\s+/g, '').toLowerCase();
export interface CredentialRow { id: string; domain: string; username: string; iv: string; ciphertext: string; created_at: string }
export interface CredentialMigrationPolicy {
  /** Trusted crypto/key verifier, never a caller-provided claim. No plaintext output. */
  verifyCurrentCiphertext(row: CredentialRow): Promise<boolean>;
  /** Historical site_id is not assumed to be a domain; unknown mapping or changed AAD blocks. */
  resolveLegacy(row: Record<string, unknown>): Promise<CredentialRow | null>;
}
export interface CredentialMigrationResult { version: 1; checksum: string; source: 'absent' | 'current' | 'legacy'; count: number; archived: boolean }
function snapshot(storage: WorkspaceStorage) {
  const info = [...storage.sql.exec("SELECT sql FROM sqlite_schema WHERE type='table' AND name='credentials'")][0];
  const sql = info ? String(info.sql) : null;
  const rows = sql ? [...storage.sql.exec('SELECT * FROM credentials')] : [];
  return { sql, rows };
}
/** Additive migration; never invokes DROP TABLE and keeps historical rows under their original shape. */
export async function migrateCredentialSchema(storage: WorkspaceStorage, policy: CredentialMigrationPolicy): Promise<CredentialMigrationResult> {
  const initial = snapshot(storage);
  const source = initial.sql === null ? 'absent' : norm(initial.sql) === norm(CURRENT) ? 'current' : norm(initial.sql) === norm(LEGACY) ? 'legacy' : fail('UNKNOWN_SCHEMA');
  const checksum = await digest({ version:1, name:'preserve-credentials-v1', current:CURRENT, legacy:LEGACY });
  const converted: CredentialRow[] = [];
  for (const row of initial.rows) {
    const resolved = source === 'legacy' ? await policy.resolveLegacy(row) : row as unknown as CredentialRow;
    if (!resolved) return fail('KEY_OR_LEGACY_MAPPING_UNVERIFIED');
    const value = resolved;
    if ( !['id','domain','username','iv','ciphertext','created_at'].every(k => typeof value[k as keyof CredentialRow] === 'string' && value[k as keyof CredentialRow].length > 0)) fail('KEY_OR_LEGACY_MAPPING_UNVERIFIED');
    // Legacy bytes remain exact; a trusted verifier must prove compatibility with current domain+username AAD.
    if (source === 'legacy' && (value.iv !== row.iv || value.ciphertext !== row.ciphertext || value.username !== row.username)) fail('LEGACY_CIPHERTEXT_CHANGED');
    if (!await policy.verifyCurrentCiphertext(value)) fail('KEY_MISMATCH');
    converted.push(value);
  }
  if (new Set(converted.map(r => r.id)).size !== converted.length) fail('LEGACY_ID_COLLISION');
  return storage.transactionSync(() => {
    // No async crypto inside transaction: compare canonical source exactly to the verified preflight.
    if (canonical(snapshot(storage)) !== canonical(initial)) fail('MIGRATION_SOURCE_ADVANCED');
    storage.sql.exec('CREATE TABLE IF NOT EXISTS hygge_schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, result TEXT NOT NULL)');
    const prior = [...storage.sql.exec('SELECT checksum, result FROM hygge_schema_migrations WHERE version=1')][0];
    if (prior) {
      if (prior.checksum !== checksum) fail('MIGRATION_CHECKSUM_MISMATCH');
      return JSON.parse(String(prior.result));
    }
    if (source === 'legacy') {
      if ([...storage.sql.exec("SELECT name FROM sqlite_schema WHERE name='credentials_legacy_v0'")].length) fail('LEGACY_ARCHIVE_COLLISION');
      storage.sql.exec('ALTER TABLE credentials RENAME TO credentials_legacy_v0');
      storage.sql.exec(CURRENT);
      for (const r of converted) storage.sql.exec('INSERT INTO credentials (id,domain,username,iv,ciphertext,created_at) VALUES (?,?,?,?,?,?)', r.id, r.domain, r.username, r.iv, r.ciphertext, r.created_at);
      const count = [...storage.sql.exec('SELECT COUNT(*) AS n FROM credentials')][0];
      if (Number(count?.n) !== initial.rows.length) fail('MIGRATION_COUNT_MISMATCH');
    } else if (source === 'absent') storage.sql.exec(CURRENT);
    const result: CredentialMigrationResult = { version:1, checksum, source, count:initial.rows.length, archived:source === 'legacy' };
    storage.sql.exec('INSERT INTO hygge_schema_migrations (version, checksum, result) VALUES (1,?,?)', checksum, canonical(result));
    return result;
  });
}
