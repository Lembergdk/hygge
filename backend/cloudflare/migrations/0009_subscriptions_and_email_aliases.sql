-- Pricing scheme (2026-11-04): Plus subscriptions + custom
-- @usehygge.cc names, and a repair for routing-count kinds.
--
-- subscriptions: one row per user, the latest StoreKit
-- transaction the app reported (decoded fields only in v1; the
-- signed payload is kept for audit and chain verification is the
-- hardening follow-up). Tier is always derived: plus while
-- expires_at is in the future, free otherwise.
CREATE TABLE IF NOT EXISTS subscriptions (
  user_id     TEXT PRIMARY KEY REFERENCES users(id),
  product_id  TEXT NOT NULL,
  original_transaction_id TEXT,
  environment TEXT,
  expires_at  TEXT NOT NULL,
  jws         TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Custom email names (Plus): an additional local part that
-- delivers exactly like the digits address, which never stops
-- working. Aliases can never be all-digits (the digits space is
-- collision-proof by shape) and are stored lowercased.
CREATE TABLE IF NOT EXISTS hygge_email_aliases (
  alias      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL UNIQUE REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_hygge_email_aliases_user ON hygge_email_aliases(user_id);

-- 0004's CHECK on routing-count kind predates the newer kinds
-- (owner_instruction, reasoned, duplicate, proposed_site,
-- chat_asked), whose counts were silently swallowed. Recreate
-- the table without the kind allowlist, preserving rows.
CREATE TABLE IF NOT EXISTS email_routing_counts_v2 (
  day   TEXT NOT NULL,
  kind  TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind)
);
INSERT OR IGNORE INTO email_routing_counts_v2 (day, kind, count)
  SELECT day, kind, count FROM email_routing_counts;
DROP TABLE IF EXISTS email_routing_counts;
ALTER TABLE email_routing_counts_v2 RENAME TO email_routing_counts;
