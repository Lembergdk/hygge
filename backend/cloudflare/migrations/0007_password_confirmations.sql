-- Additive only: pending password changes are separate from ordinary magic links.
-- Raw passwords/tokens never persist. Confirmation atomically consumes the row.
CREATE TABLE IF NOT EXISTS password_confirmations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method_id TEXT NOT NULL REFERENCES linked_methods(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  expected_hash TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_password_confirmations_method ON password_confirmations(method_id);
