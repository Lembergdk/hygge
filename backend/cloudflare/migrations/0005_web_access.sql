-- Brief 06: probe-verified web accessibility on the fleet site
-- catalog. Site-level only; holds no user data. web_accessible is
-- 'true' | 'false' | 'unknown' (unknown is transient: at most one
-- proposal/scan cycle, enforced in src/web-access.ts).
ALTER TABLE site_catalog ADD COLUMN web_accessible TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE site_catalog ADD COLUMN probed_at TEXT;
ALTER TABLE site_catalog ADD COLUMN probe_evidence TEXT;
ALTER TABLE site_catalog ADD COLUMN unknown_cycles_used INTEGER NOT NULL DEFAULT 0;
ALTER TABLE site_catalog ADD COLUMN app_wall_strikes INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_site_catalog_web_accessible ON site_catalog(web_accessible);
