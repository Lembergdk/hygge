-- Brief 04: @usehygge.cc email identity (RECEIVE ONLY).
--
-- The digits -> user_id mapping lives server-side only in D1. It is
-- never logged, never placed in shared skills, and never exposed to
-- any other user: the only read path is "the address allocated to
-- the authenticated user" (see src/email.ts). No table here stores
-- mail content, codes, or sender/subject data — per-user mail
-- summaries and sealed codes live in each user's Durable Object.
--
-- There is deliberately no outbound/send table or queue: Hygge
-- never sends mail from a @usehygge.cc address.

CREATE TABLE IF NOT EXISTS hygge_email_addresses (
  digits     TEXT PRIMARY KEY CHECK (length(digits) = 10 AND digits NOT GLOB '*[^0-9]*'),
  user_id    TEXT NOT NULL UNIQUE REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_hygge_email_addresses_user ON hygge_email_addresses(user_id);

-- Routing observability: counts only, bucketed by day. No addresses,
-- no senders, no subjects, no bodies, no codes — ever.
CREATE TABLE IF NOT EXISTS email_routing_counts (
  day   TEXT NOT NULL,
  kind  TEXT NOT NULL CHECK (kind IN
          ('received','dropped_unknown','dropped_malformed',
           'verification','security_code','other',
           'link_follow_ok','link_follow_failed','delivery_failed')),
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind)
);
