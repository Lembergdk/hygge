/// Per-user server-side state (Brief 01): the Durable Object SQLite is
/// the source of truth for everything the user sees; the app snapshot
/// is only a cache. This module is the pure store logic so it can be
/// unit-tested in Node with an in-memory database; UserSandbox wires
/// it to real DO SQLite.
///
/// Conflict rule (documented per brief): server wins on newest
/// `updated_at`. Simultaneous multi-device edits to the same row are
/// last-write-wins by timestamp; there is deliberately no merge UI.
///
/// Secrets never belong here: passwords live only in the vault
/// (credentials table, per-user DEK). Import/upsert strip secret-shaped
/// keys so state payloads can never smuggle one into logs or prompts.

export interface StateRow {
  id: string;
  payload: string; // JSON
  updatedAt: string; // ISO-8601
}

/// Minimal synchronous storage contract. DO SQLite `storage.sql.exec`
/// is synchronous, so the store stays synchronous too.
export interface StateDb {
  getRow(table: string, id: string): StateRow | null;
  listRows(table: string): StateRow[];
  putRow(table: string, id: string, payloadJson: string, updatedAt: string): void;
  deleteRow(table: string, id: string): boolean;
  countRows(table: string): number;
}

/// Entity key -> DO table. Route segments use kebab-case (see ROUTES).
export const STATE_TABLES: Record<string, string> = {
  feedItems: "feed_items",
  messages: "messages",
  profile: "profile",
  sites: "sites",
  opportunities: "opportunities",
  applications: "applications",
  proposals: "proposals",
  accountStates: "account_states",
  journalEvents: "journal_events",
  beliefs: "beliefs",
  searchEvidence: "search_evidence",
};

/// URL path segment -> entity key. `/site-proposals` (LLM generation)
/// is a different endpoint and is not state CRUD; `/proposals` is.
export const STATE_ROUTES: Record<string, string> = {
  "feed-items": "feedItems",
  messages: "messages",
  profile: "profile",
  sites: "sites",
  opportunities: "opportunities",
  applications: "applications",
  proposals: "proposals",
  "account-states": "accountStates",
  "journal-events": "journalEvents",
  beliefs: "beliefs",
  "search-evidence": "searchEvidence",
};

export const PROFILE_ROW_ID = "profile";

// Fail-closed secret stripping: any key whose normalized name
// contains a secret-ish term is dropped (a 4-key denylist was
// fail-open). Reference ids (…refId / credentialRefs) are not secrets
// and are kept so state rows can still point at vault metadata.
const SECRET_KEY_PARTS = [
  "secret", "password", "passwd", "passphrase", "token", "apikey",
  "credential", "cookie", "privatekey", "plaintext", "authorization", "bearer",
];

export function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (normalized.endsWith("refid") || normalized === "credentialrefs") return false;
  return SECRET_KEY_PARTS.some((part) => normalized.includes(part));
}

export function stateSchemaSQL(): string {
  return Object.values(STATE_TABLES)
    .map(
      (table) =>
        `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL);`,
    )
    .join("\n");
}

/// Create state tables through any `exec(sql)`-shaped function.
export function ensureStateSchema(exec: (sql: string) => unknown): void {
  exec(stateSchemaSQL());
}

export function normalizeId(id: unknown): string {
  return String(id ?? "").trim().toLowerCase();
}

/// True when an incoming write should replace what is stored:
/// newest `updated_at` wins; equal timestamps let the later write
/// win (last-write-wins); a missing stored row always applies.
export function shouldApplyUpdate(
  existingUpdatedAt: string | null | undefined,
  incomingUpdatedAt: string,
): boolean {
  if (!existingUpdatedAt) return true;
  return incomingUpdatedAt >= existingUpdatedAt;
}

/// Remove secret-shaped keys at any depth. Credential payloads must
/// never carry a secret; only vault references (id/domain/username)
/// may travel through state.
export function stripSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretKey(key)) continue;
      out[key] = stripSecrets(child);
    }
    return out;
  }
  return value;
}

export function isDemoPayload(payload: Record<string, unknown>): boolean {
  return payload.isDemo === true || payload.is_demo === true;
}

function publicRow(row: StateRow): { id: string; updatedAt: string; data: unknown } {
  return { id: row.id, updatedAt: row.updatedAt, data: JSON.parse(row.payload) };
}

export interface UpsertResult {
  applied: boolean;
  id: string;
  updatedAt: string;
  data: unknown;
}

export class StateStore {
  db: StateDb;
  constructor(db: StateDb) {
    this.db = db;
  }

  private table(entity: string): string {
    const table = STATE_TABLES[entity];
    if (!table) throw new Error(`unknown state entity: ${entity}`);
    return table;
  }

  upsert(
    entity: string,
    id: string,
    payload: Record<string, unknown>,
    updatedAt: string = new Date().toISOString(),
  ): UpsertResult {
    const table = this.table(entity);
    const rowId = entity === "profile" ? PROFILE_ROW_ID : normalizeId(id);
    if (!rowId) throw new Error(`${entity} requires an id`);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error(`${entity} payload must be a JSON object`);
    }
    const clean = stripSecrets(payload) as Record<string, unknown>;
    // Server feed items are always real; labelled demo items stay
    // local-only and must never become server state.
    if (entity === "feedItems") {
      clean.isDemo = false;
      clean.is_demo = false;
    }
    const existing = this.db.getRow(table, rowId);
    if (!shouldApplyUpdate(existing?.updatedAt, updatedAt)) {
      return { applied: false, ...publicRow(existing!) };
    }
    this.db.putRow(table, rowId, JSON.stringify(clean), updatedAt);
    return { applied: true, id: rowId, updatedAt, data: clean };
  }

  get(entity: string, id: string) {
    const rowId = entity === "profile" ? PROFILE_ROW_ID : normalizeId(id);
    const row = this.db.getRow(this.table(entity), rowId);
    return row ? publicRow(row) : null;
  }

  list(entity: string) {
    return this.db.listRows(this.table(entity)).map(publicRow);
  }

  remove(entity: string, id: string): boolean {
    const rowId = entity === "profile" ? PROFILE_ROW_ID : normalizeId(id);
    return this.db.deleteRow(this.table(entity), rowId);
  }

  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [entity, table] of Object.entries(STATE_TABLES)) {
      out[entity] = this.db.countRows(table);
    }
    return out;
  }

  /// True once at least one real (non-demo) server feed item exists;
  /// the app hides its local demo items from that moment on.
  hasRealFeedItem(): boolean {
    if (this.db.countRows(STATE_TABLES.feedItems) > 0) return true;
    return this.list("opportunities").some(
      (row) => !isDemoPayload(row.data as Record<string, unknown>),
    );
  }

  /// Idempotent one-time migration from the app's local snapshot JSON.
  /// Rows are keyed by id, so re-running never duplicates. Accepts the
  /// Swift snapshot keys (chatTranscript, activityEvents, ...) and the
  /// server-export keys (messages, journalEvents, ...) so an export
  /// can round-trip through import.
  ///
  /// Demo opportunities are skipped (local-only). Credential refs are
  /// counted but never stored — the vault `credentials` table is
  /// already authoritative and refs are re-derived from it. Snapshot
  /// site memories and tasks are returned for the caller to fold into
  /// the existing `memories`/`tasks` tables; they are not state rows.
  importSnapshot(snapshot: Record<string, unknown>, now = new Date().toISOString()) {
    const asArray = (v: unknown): Record<string, unknown>[] =>
      Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as Record<string, unknown>[]) : [];
    const idOf = (item: Record<string, unknown>) => normalizeId(item.id);
    let skippedDemo = 0;

    // Profile singleton carries the profile plus the small app-level
    // facts that must follow the user across devices.
    const profileData = (snapshot.profileData ?? null) as Record<string, unknown> | null;
    const profilePayload: Record<string, unknown> = profileData ?? {
      profile: snapshot.profile ?? {},
      hasOnboarded: snapshot.hasOnboarded ?? false,
      isPaused: snapshot.isPaused ?? false,
      lastVisitAt: snapshot.lastVisitAt ?? null,
    };
    this.upsert("profile", PROFILE_ROW_ID, profilePayload, now);

    for (const site of asArray(snapshot.sites)) {
      const id = normalizeId(site.id);
      if (id) this.upsert("sites", id, site, now);
    }

    const opportunities = asArray(snapshot.opportunities);
    const feedItems = asArray(snapshot.feedItems);
    for (const opp of [...opportunities, ...feedItems]) {
      const id = idOf(opp);
      if (!id) continue;
      if (isDemoPayload(opp)) {
        skippedDemo += 1;
        continue;
      }
      this.upsert("opportunities", id, opp, now);
      this.upsert("feedItems", id, opp, now);
    }

    for (const msg of [...asArray(snapshot.chatTranscript), ...asArray(snapshot.messages)]) {
      const id = idOf(msg);
      if (id) this.upsert("messages", id, msg, now);
    }
    for (const app of asArray(snapshot.applications)) {
      const id = idOf(app);
      if (id) this.upsert("applications", id, app, now);
    }
    for (const proposal of asArray(snapshot.proposals)) {
      const id = idOf(proposal);
      if (id) this.upsert("proposals", id, proposal, now);
    }

    const accountStates = snapshot.accountStates;
    if (accountStates && typeof accountStates === "object" && !Array.isArray(accountStates)) {
      for (const [siteID, state] of Object.entries(accountStates as Record<string, unknown>)) {
        // Rows may arrive either as a raw state string (Swift snapshot
        // [String: SiteAccountState]) or as an exported {siteID, state}.
        if (state && typeof state === "object") {
          this.upsert("accountStates", siteID, state as Record<string, unknown>, now);
        } else {
          this.upsert("accountStates", siteID, { siteID, state: String(state) }, now);
        }
      }
    }
    for (const row of asArray(snapshot.accountStateRows)) {
      const siteID = normalizeId(row.siteID ?? row.siteId ?? row.id);
      if (siteID) this.upsert("accountStates", siteID, row, now);
    }

    for (const event of [...asArray(snapshot.activityEvents), ...asArray(snapshot.journalEvents)]) {
      const id = idOf(event);
      if (id) this.upsert("journalEvents", id, event, now);
    }

    const beliefBook = (snapshot.beliefs ?? {}) as Record<string, unknown>;
    const beliefRows = Array.isArray(beliefBook)
      ? asArray(beliefBook)
      : [
          ...asArray(beliefBook.beliefs).map((b) => ({ ...b, pending: b.pending ?? false })),
          ...asArray(beliefBook.pending).map((b) => ({ ...b, pending: true })),
        ];
    for (const belief of beliefRows) {
      const id = idOf(belief);
      if (id) this.upsert("beliefs", id, belief, now);
    }

    for (const evidence of asArray(snapshot.searchEvidence)) {
      const id = idOf(evidence);
      if (id) this.upsert("searchEvidence", id, evidence, now);
    }

    const siteMemory = (snapshot.siteMemory ?? {}) as Record<string, unknown>;
    const memories = Array.isArray(siteMemory) ? asArray(siteMemory) : asArray(siteMemory.memories);
    const tasks = asArray(snapshot.tasks);
    const credentialRefs = asArray(snapshot.credentialRefs);

    return {
      counts: this.counts(),
      hasRealFeedItem: this.hasRealFeedItem(),
      skippedDemo,
      memories,
      tasks,
      credentialRefsSkipped: credentialRefs.length,
    };
  }

  /// Full server state for a fresh install / second device signed in
  /// as the same user: same feed, messages, and profile.
  exportState() {
    const accountStates: Record<string, unknown> = {};
    for (const row of this.list("accountStates")) {
      const data = row.data as Record<string, unknown>;
      accountStates[String(data.siteID ?? row.id)] = data.state ?? data;
    }
    const beliefs = this.list("beliefs").map((r) => r.data as Record<string, unknown>);
    return {
      profile: this.get("profile", PROFILE_ROW_ID),
      feedItems: this.list("feedItems"),
      messages: this.list("messages"),
      sites: this.list("sites"),
      opportunities: this.list("opportunities"),
      applications: this.list("applications"),
      proposals: this.list("proposals"),
      accountStates,
      journalEvents: this.list("journalEvents"),
      beliefs: {
        beliefs: beliefs.filter((b) => b.pending !== true),
        pending: beliefs.filter((b) => b.pending === true),
      },
      beliefRows: this.list("beliefs"),
      searchEvidence: this.list("searchEvidence"),
      counts: this.counts(),
      hasRealFeedItem: this.hasRealFeedItem(),
    };
  }
}

/// In-memory StateDb for tests (and any non-DO host).
export class MemoryStateDb implements StateDb {
  tables = new Map<string, Map<string, StateRow>>();
  table(name: string) {
    let t = this.tables.get(name);
    if (!t) {
      t = new Map();
      this.tables.set(name, t);
    }
    return t;
  }
  getRow(table: string, id: string): StateRow | null {
    return this.table(table).get(id) ?? null;
  }
  listRows(table: string): StateRow[] {
    return [...this.table(table).values()].sort(
      (a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id),
    );
  }
  putRow(table: string, id: string, payloadJson: string, updatedAt: string): void {
    this.table(table).set(id, { id, payload: payloadJson, updatedAt });
  }
  deleteRow(table: string, id: string): boolean {
    return this.table(table).delete(id);
  }
  countRows(table: string): number {
    return this.table(table).size;
  }
}

/// Adapt DO SQLite (`ctx.storage.sql`) to StateDb. Table names come
/// only from STATE_TABLES (never request input), so interpolating
/// them is safe; every value stays bound.
export function createSqliteStateDb(
  sql: { exec: (query: string, ...params: unknown[]) => Iterable<Record<string, unknown>> },
): StateDb {
  const toRow = (r: Record<string, unknown>): StateRow => ({
    id: String(r.id),
    payload: String(r.payload),
    updatedAt: String(r.updated_at),
  });
  return {
    getRow(table, id) {
      const rows = [...sql.exec(`SELECT id, payload, updated_at FROM ${table} WHERE id = ?`, id)];
      return rows.length ? toRow(rows[0]) : null;
    },
    listRows(table) {
      return [...sql.exec(`SELECT id, payload, updated_at FROM ${table} ORDER BY updated_at, id`)].map(toRow);
    },
    putRow(table, id, payloadJson, updatedAt) {
      sql.exec(
        `INSERT INTO ${table} (id, payload, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
        id,
        payloadJson,
        updatedAt,
      );
    },
    deleteRow(table, id) {
      const before = [...sql.exec(`SELECT COUNT(*) AS n FROM ${table} WHERE id = ?`, id)];
      sql.exec(`DELETE FROM ${table} WHERE id = ?`, id);
      return Number(before[0]?.n ?? 0) > 0;
    },
    countRows(table) {
      const rows = [...sql.exec(`SELECT COUNT(*) AS n FROM ${table}`)];
      return Number(rows[0]?.n ?? 0);
    },
  };
}
