-- Sessions never expire (2026-11-04): sign-ins persist until sign-out
-- or account closure. auth_sessions.expires_at becomes nullable, and
-- existing sessions are made persistent too (revoked sessions stay
-- revoked; only their expiry column is cleared, which never resolves).
-- Rebuild is required: SQLite cannot drop a NOT NULL constraint in place.
CREATE TABLE auth_sessions_new (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL,
  expires_at  TEXT,
  revoked_at  TEXT,
  last_seen_at TEXT
);
INSERT INTO auth_sessions_new (id, user_id, token_hash, created_at, expires_at, revoked_at, last_seen_at)
  SELECT id, user_id, token_hash, created_at, NULL, revoked_at, last_seen_at FROM auth_sessions;
DROP TABLE auth_sessions;
ALTER TABLE auth_sessions_new RENAME TO auth_sessions;
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
