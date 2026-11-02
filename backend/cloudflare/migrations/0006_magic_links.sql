-- Magic-link sign-in: email/password is replaced fully. Only the
-- SHA-256 of each token is stored, so a D1 read never yields a usable
-- sign-in link. Tokens are single-use (consumed_at), short-lived
-- (expires_at, 15 minutes), and a fresh request invalidates earlier
-- unconsumed tokens for the same email.
CREATE TABLE IF NOT EXISTS magic_link_tokens (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TEXT NOT NULL,
  consumed_at TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_magic_link_tokens_email_created
  ON magic_link_tokens(email, created_at);
