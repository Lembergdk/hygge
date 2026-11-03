-- Additive foundation only; existing V1 skill rows/readers remain untouched.
CREATE TABLE IF NOT EXISTS public_skills_v2 (
  id TEXT PRIMARY KEY, site_id TEXT NOT NULL, outcome TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0), body TEXT NOT NULL,
  content_hash TEXT NOT NULL, policy_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','needs_reverification','quarantined','deprecated')),
  epoch INTEGER NOT NULL DEFAULT 1 CHECK(epoch > 0),
  confidence REAL NOT NULL DEFAULT 0.7 CHECK(confidence BETWEEN 0 AND 1),
  source_run_count INTEGER NOT NULL CHECK(source_run_count >= 3),
  UNIQUE(site_id,outcome,version), UNIQUE(content_hash,policy_version)
);
CREATE INDEX IF NOT EXISTS public_skills_v2_lookup ON public_skills_v2(site_id,outcome,status,version DESC);
CREATE TABLE IF NOT EXISTS skill_publications_v2 (
  request_key TEXT PRIMARY KEY, payload_hash TEXT NOT NULL,
  token_id TEXT NOT NULL UNIQUE, skill_id TEXT REFERENCES public_skills_v2(id)
);
CREATE TABLE IF NOT EXISTS skill_usage_v2 (
  usage_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL,
  skill_id TEXT NOT NULL REFERENCES public_skills_v2(id),
  succeeded INTEGER NOT NULL CHECK(succeeded IN (0,1)), implicated INTEGER NOT NULL CHECK(implicated IN (0,1)),
  applied INTEGER NOT NULL DEFAULT 0 CHECK(applied IN (0,1))
);
CREATE TABLE IF NOT EXISTS skill_quarantines_v2 (
  operation_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL,
  skill_id TEXT NOT NULL REFERENCES public_skills_v2(id),
  reason_code TEXT NOT NULL CHECK(reason_code IN ('privacy','unsafe_guidance','integrity')),
  applied INTEGER NOT NULL DEFAULT 0 CHECK(applied IN (0,1))
);
CREATE TABLE IF NOT EXISTS skill_admissions_v2 (
  admission_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL,
  skill_id TEXT NOT NULL REFERENCES public_skills_v2(id), version INTEGER NOT NULL,
  epoch INTEGER NOT NULL, expires_at TEXT NOT NULL,
  consumed_by TEXT, consumed_at TEXT
);
