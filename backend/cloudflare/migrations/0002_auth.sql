-- Hygge identity (Brief 00): one durable user id, N login methods.
-- users.id is a generated durable id from this migration on; the Apple
-- `sub` and login emails live only in linked_methods. Hygge-account
-- passwords are never site-vault credentials and never plaintext.
-- Assumption (see brief): no production users rows exist yet. Verify
-- against production D1 before cutover; if legacy rows (id = Apple
-- sub) exist, backfill linked_methods from them in a follow-up
-- migration BEFORE enabling production auth.

ALTER TABLE users ADD COLUMN contact_email TEXT;

CREATE TABLE IF NOT EXISTS linked_methods (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  method        TEXT NOT NULL CHECK (method IN ('apple', 'email')),
  apple_sub     TEXT UNIQUE,           -- one Apple identity -> one user
  apple_email   TEXT,                  -- opaque contact data only; NEVER matched/merged on (private-relay hazard)
  email         TEXT UNIQUE,           -- normalized lowercase login email; one email -> one user
  password_hash TEXT,                  -- email method only; versioned PBKDF2 hash, never plaintext
  email_verified INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_linked_methods_user ON linked_methods(user_id);

-- Transferable server-issued app sessions. Only the SHA-256 of the
-- token is stored, so a D1 read never yields a usable credential.
CREATE TABLE IF NOT EXISTS auth_sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  revoked_at  TEXT,
  last_seen_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);

-- Password-attempt rate limiting. Stores the attempted login email
-- (normalized), never the password.
CREATE TABLE IF NOT EXISTS auth_attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL,
  success    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_attempts_email_time ON auth_attempts(email, created_at);
