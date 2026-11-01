-- Brief 02: shared skill repository.
--
-- A NEW table, coexisting with site_hints: site_hints holds short
-- advisory strings (currently unread by missions); skills holds
-- versioned, structured, population-level procedures. Existing tables
-- are untouched.
--
-- Body storage: JSON in D1, capped at MAX_SKILL_BODY_BYTES (16 KiB) in
-- src/skills.ts. If bodies outgrow a comfortable D1 row, move `body`
-- to R2 and keep this table as the index.
--
-- Skills NEVER contain credentials, tokens, or any user-specific
-- value — enforced by the sanitization pass before promotion
-- (src/skills.ts sanitizeSkillBody), not by this schema alone.

CREATE TABLE IF NOT EXISTS skills (
  id               TEXT PRIMARY KEY,
  site             TEXT NOT NULL,             -- host, e.g. rover.com
  outcome          TEXT NOT NULL CHECK (outcome IN
                     ('signup','update_profile','apply','message','book','discover')),
  version          INTEGER NOT NULL DEFAULT 1,
  body             TEXT NOT NULL,             -- JSON {summary, steps[], pitfalls[], notes}
  confidence       REAL NOT NULL DEFAULT 0.7 CHECK (confidence >= 0 AND confidence <= 1),
  source_run_count INTEGER NOT NULL DEFAULT 0,
  last_verified_at TEXT,
  status           TEXT NOT NULL DEFAULT 'candidate'
                     CHECK (status IN ('candidate','active','deprecated')),
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(site, outcome, version)
);
CREATE INDEX IF NOT EXISTS idx_skills_lookup ON skills(site, outcome, status, version DESC);
