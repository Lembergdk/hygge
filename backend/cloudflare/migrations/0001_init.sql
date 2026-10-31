-- Hygge shared control plane (D1). Per-user state lives in each
-- user's Durable Object SQLite; D1 holds only the fleet-wide view:
-- users, the site catalog, wrapped keys, and usage.

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,          -- Apple `sub` (durable identity)
  email         TEXT,
  display_name  TEXT,
  do_instance   TEXT NOT NULL,            -- UserSandbox instance name
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at  TEXT
);

CREATE TABLE IF NOT EXISTS device_tokens (
  user_id     TEXT NOT NULL REFERENCES users(id),
  token       TEXT NOT NULL,
  platform    TEXT NOT NULL DEFAULT 'ios',
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, token)
);

CREATE TABLE IF NOT EXISTS push_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  kind        TEXT NOT NULL,
  apns_status TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS site_catalog (
  host         TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  categories   TEXT NOT NULL DEFAULT '[]',  -- JSON array
  notes        TEXT,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Advisory, population-level hints only. Never secrets, never
-- user-specific data. Derived from per-user site memory at rest.
CREATE TABLE IF NOT EXISTS site_hints (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  host        TEXT NOT NULL REFERENCES site_catalog(host),
  hint        TEXT NOT NULL,
  confidence  REAL NOT NULL DEFAULT 0.5,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_site_hints_host ON site_hints(host);

-- Per-user data-encryption keys, wrapped by the environment master
-- key (a Worker secret). The raw DEK never touches storage.
CREATE TABLE IF NOT EXISTS user_keys (
  user_id    TEXT PRIMARY KEY REFERENCES users(id),
  wrapped    BLOB NOT NULL,                -- AES-KW ciphertext
  key_alg    TEXT NOT NULL DEFAULT 'A256KW',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  rotated_at TEXT
);

CREATE TABLE IF NOT EXISTS usage_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  kind        TEXT NOT NULL,               -- llm | browser | container
  units       REAL NOT NULL DEFAULT 0,     -- tokens / seconds
  cost_estimate REAL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_usage_user_time ON usage_events(user_id, created_at);
