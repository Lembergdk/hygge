import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.ts";
import { json } from "./env.ts";
import { LLMClient, type LLMConfig } from "./llm.ts";
import { onboardingMessage, onboardingMessageStream } from "./onboarding.ts";
import { BrowserRunBrowser } from "./browser.ts";
import { makeDecider, runMission, distillHints } from "./agent.ts";
import * as vault from "./vault.ts";
import { PROFILE_ROW_ID, STATE_ROUTES, StateStore, createSqliteStateDb, ensureStateSchema } from "./state.ts";
import {
  D1SkillRepository, applySkillOutcome, outcomeForTaskKind, promoteCandidate,
  requiresApprovalForKind, shouldPromote, skillImplicatedByFailure,
  type SharedSkill, type SkillCandidate, type SkillOutcome,
} from "./skills.ts";
import {
  sealSessionState,
  openSessionState,
  isEmptyState,
  nextTrustSupport,
  type SessionState,
  type TrustSupport,
} from "./session-profile.ts";

const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;
const CONTAINER_IMAGE = "cloudflare/debian-trixie";

const MEMORY_KIND: Record<string, string> = {
  discover: "searchOpportunities",
  signup: "signup",
  buildProfile: "buildProfile",
  apply: "apply",
  message: "apply",
  bookCalendar: "bookCalendar",
};
// Approval gate lives in skills.ts (requiresApprovalForKind) so a
// loaded skill can never alter it — same rule, one owner.

const STATIC_PROPOSALS: Record<string, { name: string; url: string; rationale: string }[]> = {
  petCare: [
    { name: "Rover", url: "https://www.rover.com", rationale: "Largest pet-sitting marketplace; sitters set their own rates" },
    { name: "TrustedHousesitters", url: "https://www.trustedhousesitters.com", rationale: "House/pet sits exchanged for accommodation worldwide" },
    { name: "Pawshake", url: "https://www.pawshake.com", rationale: "Local pet sitting and dog walking bookings" },
    { name: "Nextdoor", url: "https://www.nextdoor.com", rationale: "Neighbours frequently post pet-care requests" },
  ],
  freelance: [
    { name: "Upwork", url: "https://www.upwork.com", rationale: "Largest freelance marketplace across most skills" },
    { name: "Fiverr", url: "https://www.fiverr.com", rationale: "Package your skills as fixed-price gigs" },
    { name: "Contra", url: "https://contra.com", rationale: "Commission-free freelance projects" },
  ],
  localGig: [
    { name: "Taskrabbit", url: "https://www.taskrabbit.com", rationale: "Local tasks: assembly, moving, errands" },
    { name: "Airtasker", url: "https://www.airtasker.com", rationale: "Open local task board you bid on" },
  ],
};

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

type Row = Record<string, unknown>;

/// One UserSandbox (Durable Object + container) per verified user.
/// Holds that user's tasks, credentials (encrypted under their own
/// DEK), site memory, approvals, and sandbox snapshot. The container
/// is a workspace; this object is the system of record.
export class UserSandbox extends DurableObject<Env> {
  private queue: Promise<unknown> = Promise.resolve();
  private userId: string | null = null;
  /// One browser for the life of this object: sessions must survive
  /// across requests, or human takeover and post-check resume have
  /// nothing to return to.
  private browserInstance: BrowserRunBrowser | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const container = ctx.container;
    if (container?.running) {
      void ctx.blockConcurrencyWhile(() =>
        container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS),
      );
    }
    // Schema migration guard: CREATE IF NOT EXISTS never migrates,
    // and PRAGMA is unauthorized in DO SQLite — so detect the old
    // scaffold schema via sqlite_schema and rebuild. (Production
    // needs real migrations before any user has data worth keeping.)
    const credSql = [
      ...ctx.storage.sql.exec(
        "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'credentials'",
      ),
    ] as Row[];
    if (credSql.length && !String(credSql[0].sql).includes("(id TEXT PRIMARY KEY")) {
      ctx.storage.sql.exec(`
        DROP TABLE IF EXISTS credentials;
        DROP TABLE IF EXISTS memories;
        DROP TABLE IF EXISTS tasks;
        DROP TABLE IF EXISTS site_memory;
        DROP TABLE IF EXISTS approvals;
      `);
    }
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS credentials (
        id TEXT PRIMARY KEY, domain TEXT NOT NULL, username TEXT NOT NULL,
        iv TEXT NOT NULL, ciphertext TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY, domain TEXT NOT NULL, kind TEXT NOT NULL,
        hints TEXT NOT NULL DEFAULT '[]', success_count INTEGER NOT NULL DEFAULT 0,
        failure_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(domain, kind)
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, task TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS skill_candidates (
        id TEXT PRIMARY KEY, site TEXT NOT NULL, outcome TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '{}', corroboration_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'candidate', rejection_reason TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(site, outcome)
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      -- Trusted sign-in profiles: metadata + DO fallback blob. The
      -- primary blob store is R2 (BROWSER_PROFILES); the blob is
      -- always sealed with the user's DEK. Deleting a credential
      -- never touches this table, and vice versa.
      CREATE TABLE IF NOT EXISTS session_profiles (
        domain TEXT PRIMARY KEY,
        trust_support TEXT NOT NULL DEFAULT 'unknown',
        has_profile INTEGER NOT NULL DEFAULT 0,
        profile_iv TEXT, profile_ct TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    // Brief 01: per-user state tables (feed items, messages, profile,
    // sites, opportunities, applications, proposals, account states,
    // journal events, beliefs, search evidence). tasks/credentials/
    // memories above are unchanged.
    ensureStateSchema((sql) => ctx.storage.sql.exec(sql));
  }

  private stateStore(): StateStore {
    return new StateStore(createSqliteStateDb(this.ctx.storage.sql));
  }

  /// Fold snapshot site memories into the existing `memories` table
  /// (advisory hints only; never a script). Idempotent by (domain, kind).
  private importMemories(memories: Record<string, unknown>[]) {
    for (const m of memories) {
      const domain = String(m.domain ?? "");
      const kind = String(m.kind ?? "");
      if (!domain || !kind) continue;
      const hints = JSON.stringify(Array.isArray(m.hints) ? m.hints : []);
      const id = String(m.id ?? crypto.randomUUID()).toLowerCase();
      this.ctx.storage.sql.exec(
        `INSERT INTO memories (id, domain, kind, hints, success_count, failure_count, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(domain, kind) DO UPDATE SET hints = excluded.hints,
           success_count = excluded.success_count, failure_count = excluded.failure_count,
           updated_at = datetime('now')`,
        id,
        domain,
        kind,
        hints,
        Number(m.successCount ?? m.success_count ?? 0),
        Number(m.failureCount ?? m.failure_count ?? 0),
      );
    }
  }

  /// Preserve snapshot tasks server-side without making them runnable:
  /// they keep their Swift status strings (e.g. "awaitingApproval"),
  /// which the approve/run routes reject, so the approval gate is
  /// unchanged. Live tasks keep flowing through POST /tasks as before.
  private importSnapshotTasks(tasks: Record<string, unknown>[]) {
    for (const t of tasks) {
      const id = String(t.id ?? "").toLowerCase();
      if (!id) continue;
      const stored = { ...t, _fromSnapshot: true };
      this.ctx.storage.sql.exec(
        "INSERT INTO tasks (id, task) VALUES (?, ?) ON CONFLICT(id) DO NOTHING",
        id,
        JSON.stringify(stored),
      );
    }
  }

  // ---- plumbing -------------------------------------------------

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }

  private llmConfig(): LLMConfig {
    return {
      apiKey: this.env.HYGGE_LLM_API_KEY,
      baseUrl: this.env.HYGGE_LLM_BASE_URL,
      modelFast: this.env.HYGGE_LLM_MODEL_FAST,
      modelStrong: this.env.HYGGE_LLM_MODEL_STRONG,
    };
  }

  private async startSandbox() {
    const container = this.ctx.container;
    if (!container) throw new Error("No container is configured");
    if (!container.running) {
      const snapshotId = await this.ctx.storage.get<string>("snapshotId");
      container.start({
        ...(snapshotId
          ? { containerSnapshot: { id: snapshotId } }
          : { image: CONTAINER_IMAGE }),
        entrypoint: ["sleep", "infinity"],
        enableInternet: true,
      });
      await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
    }
    return container;
  }

  // ---- vault ----------------------------------------------------

  /// The user's DEK, created once, stored wrapped (AES-KW) under the
  /// environment master key in both this object and D1 `user_keys`.
  private async dek(): Promise<CryptoKey> {
    const master = await vault.masterKey(this.env);
    const wrapped = await this.ctx.storage.get<string>("wrappedDek");
    if (wrapped) return vault.unwrapDEK(wrapped, master);
    const dek = await vault.generateDEK();
    const wrappedNew = await vault.wrapDEK(dek, master);
    await this.ctx.storage.put("wrappedDek", wrappedNew);
    if (this.userId) {
      await this.env.DB.prepare(
        "INSERT INTO users (id, do_instance) VALUES (?1, ?1) ON CONFLICT(id) DO UPDATE SET last_seen_at = datetime('now')",
      )
        .bind(this.userId)
        .run()
        .catch(() => {});
      await this.env.DB.prepare(
        "INSERT INTO user_keys (user_id, wrapped) VALUES (?1, ?2) ON CONFLICT(user_id) DO NOTHING",
      )
        .bind(this.userId, wrappedNew)
        .run()
        .catch(() => {});
    }
    return dek;
  }

  private browser(): BrowserRunBrowser {
    return (this.browserInstance ??= new BrowserRunBrowser(this.env.BROWSER));
  }

  // ---- trusted sign-in profiles -----------------------------------
  // Sealed browser state per domain. Preferred store: R2
  // BROWSER_PROFILES; DO columns are the fallback when no bucket is
  // bound. Only metadata ever leaves via the API.

  private profileKey(domain: string): string {
    return `session-profiles/${this.ctx.id.toString()}/${encodeURIComponent(domain)}.json`;
  }

  private profileRow(domain: string): Row | null {
    const rows = [
      ...this.ctx.storage.sql.exec("SELECT * FROM session_profiles WHERE domain = ?", domain),
    ] as Row[];
    return rows[0] ?? null;
  }

  private trustSupport(domain: string): TrustSupport {
    const value = String(this.profileRow(domain)?.trust_support ?? "unknown");
    return value === "supported" || value === "unsupported" ? value : "unknown";
  }

  private recordTrust(domain: string, event: Parameters<typeof nextTrustSupport>[1]) {
    const next = nextTrustSupport(this.trustSupport(domain), event);
    this.ctx.storage.sql.exec(
      "INSERT INTO session_profiles (domain, trust_support) VALUES (?, ?) ON CONFLICT(domain) DO UPDATE SET trust_support = excluded.trust_support, updated_at = datetime('now')",
      domain,
      next,
    );
  }

  private async loadSessionState(domain: string): Promise<SessionState | null> {
    const row = this.profileRow(domain);
    if (!row || !Number(row.has_profile)) return null;
    try {
      const dek = await this.dek();
      if (this.env.BROWSER_PROFILES) {
        const obj = await this.env.BROWSER_PROFILES.get(this.profileKey(domain));
        if (obj) return await openSessionState(dek, domain, await obj.json());
      }
      if (row.profile_iv && row.profile_ct) {
        return await openSessionState(dek, domain, {
          iv: String(row.profile_iv),
          ciphertext: String(row.profile_ct),
        });
      }
    } catch {
      // A profile that no longer opens is treated as no profile:
      // the mission re-logs in via the vault and re-saves.
    }
    return null;
  }

  private async saveSessionState(domain: string, state: SessionState) {
    const blob = await sealSessionState(await this.dek(), domain, state);
    // Fallback copy first, so a failed R2 write still leaves a copy.
    this.ctx.storage.sql.exec(
      "INSERT INTO session_profiles (domain, has_profile, profile_iv, profile_ct) VALUES (?, 1, ?, ?) ON CONFLICT(domain) DO UPDATE SET has_profile = 1, profile_iv = excluded.profile_iv, profile_ct = excluded.profile_ct, updated_at = datetime('now')",
      domain,
      blob.iv,
      blob.ciphertext,
    );
    if (this.env.BROWSER_PROFILES) {
      await this.env.BROWSER_PROFILES.put(this.profileKey(domain), JSON.stringify(blob), {
        httpMetadata: { contentType: "application/json" },
      }).catch(() => {});
    }
  }

  private async deleteSessionState(domain: string): Promise<boolean> {
    const before = [...this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM session_profiles WHERE domain = ?", domain)] as Row[];
    this.ctx.storage.sql.exec("DELETE FROM session_profiles WHERE domain = ?", domain);
    if (this.env.BROWSER_PROFILES) {
      await this.env.BROWSER_PROFILES.delete(this.profileKey(domain)).catch(() => {});
    }
    return Number(before[0].n) > 0;
  }

  // ---- tasks ----------------------------------------------------

  private loadTask(id: string): any | null {
    const rows = [...this.ctx.storage.sql.exec("SELECT task FROM tasks WHERE id = ?", id)] as Row[];
    return rows.length ? JSON.parse(String(rows[0].task)) : null;
  }

  private saveTask(task: any) {
    this.ctx.storage.sql.exec(
      "INSERT INTO tasks (id, task) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET task = excluded.task",
      task.id,
      JSON.stringify(task),
    );
  }

  private recordOutcome(domain: string, kind: string, trace: any[], extractedItems: string[], success: boolean) {
    const rows = [
      ...this.ctx.storage.sql.exec("SELECT * FROM memories WHERE domain = ? AND kind = ?", domain, kind),
    ] as Row[];
    let memory = rows[0] ?? null;
    if (!memory) {
      if (!success) return null; // learn only from runs that achieved something
      memory = {
        id: crypto.randomUUID(),
        domain,
        kind,
        hints: "[]",
        success_count: 0,
        failure_count: 0,
      };
      this.ctx.storage.sql.exec(
        "INSERT INTO memories (id, domain, kind, hints) VALUES (?, ?, ?, '[]')",
        memory.id,
        domain,
        kind,
      );
    }
    if (success) {
      const hints = distillHints({
        domain,
        trace,
        extractedItems,
        existing: JSON.parse(String(memory.hints)),
      });
      this.ctx.storage.sql.exec(
        "UPDATE memories SET hints = ?, success_count = success_count + 1, updated_at = datetime('now') WHERE id = ?",
        JSON.stringify(hints),
        memory.id,
      );
      return { id: memory.id, hints, successCount: Number(memory.success_count) + 1 };
    }
    this.ctx.storage.sql.exec(
      "UPDATE memories SET failure_count = failure_count + 1, updated_at = datetime('now') WHERE id = ?",
      memory.id,
    );
    return { id: memory.id, hints: JSON.parse(String(memory.hints)), successCount: Number(memory.success_count) };
  }

  // ---- shared skills (Brief 02) -----------------------------------
  // Candidates stay in THIS user's DO until corroborated + sanitized;
  // only promoted skills cross into shared D1. D1 failures degrade to
  // "no skill" routing — a mission must never fail on the skill store.

  private skillRepo() { return new D1SkillRepository(this.env.DB); }

  private loadSkillCandidate(site: string, outcome: SkillOutcome): SkillCandidate | null {
    const rows = [...this.ctx.storage.sql.exec(
      "SELECT * FROM skill_candidates WHERE site = ? AND outcome = ? AND status = 'candidate'", site, outcome)] as Row[];
    if (!rows.length) return null;
    const r = rows[0];
    return { id: String(r.id), site, outcome, body: JSON.parse(String(r.body)),
             corroborationCount: Number(r.corroboration_count), status: "candidate" };
  }

  private async recordSkillOutcome(task: any, domain: string, outcome: SkillOutcome,
                                   result: any, activeSkill: SharedSkill | null) {
    const succeeded = result.status === "succeeded";
    try {
      if (activeSkill) {
        const updated = applySkillOutcome(activeSkill, succeeded,
          !succeeded && skillImplicatedByFailure(activeSkill, result.trace));
        await this.skillRepo().update(updated);
        task.log.push(updated.status !== activeSkill.status
          ? `Shared skill ${activeSkill.id} v${activeSkill.version} flagged for re-verification (failure implicated a skill step)`
          : `Shared skill ${activeSkill.id} v${activeSkill.version} confidence ${activeSkill.confidence.toFixed(2)} -> ${updated.confidence.toFixed(2)}`);
        return;
      }
      if (!succeeded || !result.skillDraft) return;
      // Known user values are match needles for sanitization only —
      // never stored or logged. The vault secret is never loaded here.
      const knownValues: string[] = Object.values(task.drafted_payload ?? {})
        .flatMap((v: any) => Array.isArray(v) ? v : [v]).map(String);
      if (task.credential_id) {
        const creds = [...this.ctx.storage.sql.exec(
          "SELECT username FROM credentials WHERE id = ?", task.credential_id)] as Row[];
        if (creds.length) knownValues.push(String(creds[0].username));
      }
      const existing = this.loadSkillCandidate(domain, outcome);
      // Corroboration counts missions that succeeded with the FIRST
      // authored body; later drafts never overwrite it, so a promoted
      // body is always the one that actually accumulated the count.
      const candidate: SkillCandidate = {
        id: existing?.id ?? crypto.randomUUID(), site: domain, outcome,
        body: existing?.body ?? result.skillDraft,
        corroborationCount: (existing?.corroborationCount ?? 0) + 1, // one per distinct successful mission
        status: "candidate",
      };
      this.ctx.storage.sql.exec(
        `INSERT INTO skill_candidates (id, site, outcome, body, corroboration_count, status)
         VALUES (?, ?, ?, ?, ?, 'candidate')
         ON CONFLICT(site, outcome) DO UPDATE SET
           corroboration_count = excluded.corroboration_count, status = 'candidate',
           rejection_reason = NULL, updated_at = datetime('now')`,
        candidate.id, domain, outcome, JSON.stringify(candidate.body), candidate.corroborationCount);
      task.log.push(`Skill candidate for ${domain}/${outcome}: ${candidate.corroborationCount} corroborating run(s) (per-user until promoted)`);
      if (!shouldPromote(candidate)) return;
      const outcome2 = await promoteCandidate(this.skillRepo(), candidate, knownValues);
      if (outcome2.promoted) {
        this.ctx.storage.sql.exec(
          "UPDATE skill_candidates SET status = 'promoted', updated_at = datetime('now') WHERE id = ?", candidate.id);
        task.skill_id = outcome2.promoted.id; task.skill_version = outcome2.promoted.version;
        task.log.push(`Skill promoted to shared repository: skill_id=${outcome2.promoted.id} skill_version=${outcome2.promoted.version} (sanitized, user values stripped)`);
      } else {
        const reasons = (outcome2.rejected ?? ["sanitization failed"]).join("; ");
        this.ctx.storage.sql.exec(
          "UPDATE skill_candidates SET status = 'rejected', rejection_reason = ?, updated_at = datetime('now') WHERE id = ?",
          reasons, candidate.id);
        task.log.push(`Skill candidate REJECTED at promotion (${reasons}) — never shared`);
      }
    } catch (e: any) {
      task.log.push(`Shared skill store unavailable (${String(e?.message ?? e).slice(0, 120)}) — candidate kept per-user`);
    }
  }

  private async runTask(task: any, browser: BrowserRunBrowser) {
    const kind = MEMORY_KIND[task.kind] ?? "searchOpportunities";
    const domain = domainOf(task.target_url);
    const rows = [
      ...this.ctx.storage.sql.exec("SELECT hints FROM memories WHERE domain = ? AND kind = ?", domain, kind),
    ] as Row[];
    const hints: string[] = rows.length ? JSON.parse(String(rows[0].hints)) : [];
    task.log.push(
      hints.length
        ? `Mission on ${domain} with ${hints.length} advisory memory hint(s) from past runs (agent still decides from the live page)`
        : `Mission on ${domain} — new site, no memory yet. Agent explores from the goal alone.`,
    );

    const fillCredentialValue = async (valueRef: string, target: string, sessionID: string) => {
      if (!task.credential_id) throw new Error("agent requested a credential but none is stored for this domain");
      const creds = [
        ...this.ctx.storage.sql.exec("SELECT * FROM credentials WHERE id = ?", task.credential_id),
      ] as Row[];
      if (!creds.length) throw new Error("unknown credential");
      const r = creds[0];
      const secret = await vault.open(
        await this.dek(),
        { iv: String(r.iv), ciphertext: String(r.ciphertext) },
        `${r.domain}\n${r.username}`,
      );
      await browser.act(sessionID, {
        action: "type",
        target,
        value: valueRef.endsWith("secret") ? secret : String(r.username),
      });
    };

    const outcome = outcomeForTaskKind(task.kind);
    let activeSkill: SharedSkill | null = null;
    try { activeSkill = await this.skillRepo().loadActive(domain, outcome); }
    catch { task.log.push("Shared skill store unavailable — routing as no-skill (Wonder authoring)"); }
    const skillCandidate = activeSkill ? null : this.loadSkillCandidate(domain, outcome);
    task.skill_id = activeSkill?.id ?? null;
    task.skill_version = activeSkill?.version ?? null;
    // Trusted sign-in: restore the saved profile for this domain when
    // trust is not known-unsupported ("unknown" means try and learn).
    const trust = this.trustSupport(domain);
    const restoreState = trust === "unsupported" ? null : await this.loadSessionState(domain);

    const decider = makeDecider(new LLMClient(this.llmConfig()));
    const result = await runMission({
      browser,
      task,
      hints,
      decider,
      fillCredentialValue,
      hasCredential: Boolean(task.credential_id),
      skill: activeSkill,
      skillCandidate,
      existingSessionID: task.session_id ?? null,
      restoreState,
    });
    task.browser_trace = result.trace;
    task.extracted_items = result.extractedItems;
    task.session_id = result.sessionID;
    task.log.push(...result.log);
    task.status = result.status === "needs_human" || result.status === "needs_info" ? "needsHuman" : result.status;
    if (result.informationRequests?.length) {
      task.information_requests = result.informationRequests;
      task.log.push("The agent needs information only you can provide — answer in the app and re-approve to resume.");
    }
    await this.recordSkillOutcome(task, domain, outcome, result, activeSkill);
    // Learn trust support from what actually happened, and refresh
    // the saved sign-in after a successful run so the next visit can
    // skip the login form where the site permits.
    if (restoreState && result.sessionProbe === "authenticated") {
      this.recordTrust(domain, "probePassed");
    } else if (restoreState && result.sessionProbe === "unauthenticated") {
      this.recordTrust(domain, "probeFailed");
    }
    if (result.status === "succeeded") {
      const usedCredential = result.trace.some((t: any) => /vault/i.test(String(t.summary ?? "")));
      const signedIn = usedCredential || result.sessionProbe === "authenticated" || result.resumedSession;
      if (signedIn) {
        const state = await browser.exportState(result.sessionID).catch(() => null);
        if (state && !isEmptyState(state)) {
          await this.saveSessionState(domain, state).catch(() => {});
          this.recordTrust(domain, "loginSavedState");
          task.log.push(`Trusted sign-in for ${domain} saved — later visits can skip the login form where the site allows.`);
        } else if (usedCredential) {
          this.recordTrust(domain, "loginSavedNothing");
        }
      }
    }
    const recorded = this.recordOutcome(domain, kind, result.trace, result.extractedItems, result.status === "succeeded");
    if (recorded) {
      task.memory_id = recorded.id;
      if (result.status === "succeeded") {
        task.log.push(
          `Site memory for ${domain} updated (${recorded.hints.length} hint(s), ${recorded.successCount} successful run(s)) — advice for next time, not a script`,
        );
      }
    }
    // Checkpoints (and questions only the user can answer) keep the
    // session open: the user finishes in the browser and re-approve
    // resumes in the same session. Never close it under them.
    if (result.status !== "needs_human" && result.status !== "needs_info") {
      await browser.closeSession(result.sessionID).catch(() => {});
      task.session_id = null;
    }
    this.saveTask(task);
    return task;
  }

  private async proposeSites(body: any) {
    const { category = "petCare", locationLabel = "", interests = [] } = body ?? {};
    const fallback = STATIC_PROPOSALS[String(category)] ?? [];
    const client = new LLMClient(this.llmConfig());
    if (!client.configured) return fallback;
    try {
      const text = await client.complete({
        model: client.cfg.modelFast,
        system: "Reply with ONLY a JSON array, no prose.",
        user: `List up to 6 real, currently operating websites where someone ${locationLabel ? `based in ${locationLabel} ` : ""}can sign up to earn money in category "${category}" (interests: ${(interests as string[]).join(", ") || category}). Each item: {"name":"...","url":"https://...","rationale":"one clause why this site suits them"}. Only real sites with correct URLs.`,
      });
      const match = String(text).match(/\[[\s\S]*\]/);
      const parsed = match ? JSON.parse(match[0]) : null;
      const valid = (parsed ?? []).filter((x: any) => x?.name && /^https:\/\//.test(x?.url ?? ""));
      return valid.length ? valid.slice(0, 6) : fallback;
    } catch {
      return fallback;
    }
  }

  // ---- routes ---------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    this.userId = request.headers.get("x-hygge-user-id") ?? this.userId;
    const url = new URL(request.url);
    const path = url.pathname;
    const parts = path.split("/").filter(Boolean);
    const body = request.method === "GET" || request.method === "DELETE"
      ? {}
      : ((await request.json().catch(() => ({}))) as any);

    try {
      // Sandbox diagnostics
      if (path.endsWith("/sandbox/verify")) {
        return await this.exclusive(async () => {
          const container = await this.startSandbox();
          const proc = await container.exec(["bash", "-lc", "uname -s; node --version"]);
          const out = await proc.output();
          return json({
            ok: true,
            stdout: new TextDecoder().decode(out.stdout).trim(),
            exitCode: out.exitCode,
          });
        });
      }
      if (path.endsWith("/sandbox/save")) {
        return await this.exclusive(async () => {
          const container = await this.startSandbox();
          const snapshot = await container.snapshotContainer({ name: "workspace" });
          await this.ctx.storage.put("snapshotId", snapshot.id);
          await container.destroy();
          return json({ ok: true, snapshotId: snapshot.id, size: snapshot.size });
        });
      }

      // Credentials (metadata only leaves the vault API)
      if (request.method === "POST" && parts.join("/") === "credentials") {
        const { domain, username, secret } = body;
        if (!domain || !username || !secret) return json({ error: "domain, username, secret required" }, 400);
        const blob = await vault.seal(await this.dek(), String(secret), `${domain}\n${username}`);
        const id = crypto.randomUUID();
        this.ctx.storage.sql.exec(
          "INSERT INTO credentials (id, domain, username, iv, ciphertext) VALUES (?, ?, ?, ?, ?)",
          id,
          domain,
          username,
          blob.iv,
          blob.ciphertext,
        );
        return json({ id, domain, username, createdAt: new Date().toISOString() }, 201);
      }
      if (request.method === "GET" && parts.join("/") === "credentials") {
        const rows = [...this.ctx.storage.sql.exec("SELECT id, domain, username, created_at FROM credentials")] as Row[];
        return json({
          credentials: rows.map((r) => ({ id: r.id, domain: r.domain, username: r.username, createdAt: r.created_at })),
        });
      }
      if (request.method === "DELETE" && parts[0] === "credentials") {
        const id = parts[1];
        const before = [...this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM credentials")] as Row[];
        this.ctx.storage.sql.exec("DELETE FROM credentials WHERE id = ?", id);
        const after = [...this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM credentials")] as Row[];
        // Deliberately does NOT delete the trusted sign-in profile:
        // credential and session profile are separate controls.
        return json({ removed: Number(after[0].n) < Number(before[0].n) });
      }

      // Site memory (+ this user's skill candidates on /skills)
      // Trusted sign-in profiles (metadata only; state never leaves)
      if (request.method === "GET" && parts.join("/") === "session-profiles") {
        const rows = [
          ...this.ctx.storage.sql.exec("SELECT domain, trust_support, has_profile, updated_at FROM session_profiles ORDER BY domain"),
        ] as Row[];
        return json({
          profiles: rows.map((r) => ({
            domain: r.domain,
            trustSupport: r.trust_support,
            hasProfile: Boolean(Number(r.has_profile)),
            updatedAt: r.updated_at,
          })),
        });
      }
      if (request.method === "DELETE" && parts[0] === "session-profiles") {
        const domain = decodeURIComponent(parts.slice(1).join("/"));
        if (!domain) return json({ error: "domain required" }, 400);
        // Deliberately does NOT delete the saved credential.
        return json({ removed: await this.deleteSessionState(domain) });
      }

      // Site memory
      if (request.method === "GET" && (parts.join("/") === "memory" || parts.join("/") === "skills")) {
        const rows = [...this.ctx.storage.sql.exec("SELECT * FROM memories")] as Row[];
        const candRows = parts.join("/") === "skills"
          ? [...this.ctx.storage.sql.exec("SELECT * FROM skill_candidates")] as Row[] : [];
        return json({
          skillCandidates: candRows.map((r) => ({
            id: r.id, site: r.site, outcome: r.outcome, status: r.status,
            corroborationCount: r.corroboration_count, rejectionReason: r.rejection_reason,
            updatedAt: r.updated_at,
          })),
          memories: rows.map((r) => ({
            id: r.id,
            domain: r.domain,
            kind: r.kind,
            hints: JSON.parse(String(r.hints)),
            successCount: r.success_count,
            failureCount: r.failure_count,
            updatedAt: r.updated_at,
          })),
        });
      }

      // Onboarding conversation
      if (request.method === "POST" && parts.join("/") === "onboarding/stream") {
        const client = new LLMClient(this.llmConfig());
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const encoder = new TextEncoder();
        const emit = (event: unknown) => {
          void writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        };
        this.ctx.waitUntil(
          (async () => {
            try {
              await onboardingMessageStream({ client, ...(body as object) }, emit);
            } finally {
              await writer.close().catch(() => {});
            }
          })(),
        );
        return new Response(readable, {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        });
      }
      if (request.method === "POST" && parts.join("/") === "onboarding/message") {
        return json(await onboardingMessage({ client: new LLMClient(this.llmConfig()), ...(body as object) }));
      }
      if (request.method === "POST" && parts.join("/") === "site-proposals") {
        return json({ proposals: await this.proposeSites(body) });
      }

      // Browser sessions (shared instance: sessions outlive one request)
      const browser = this.browser();
      if (request.method === "POST" && parts.join("/") === "sessions") {
        if (!body.url) return json({ error: "url required" }, 400);
        return json(await browser.createSession(body.url), 201);
      }
      if (request.method === "GET" && parts[0] === "sessions") {
        const snap = await browser.snapshot(parts[1]);
        return snap ? json(snap) : json({ error: "unknown session" }, 404);
      }
      if (request.method === "POST" && parts[0] === "sessions" && parts[2] === "act") {
        const snap = await browser.act(parts[1], body);
        return snap ? json(snap) : json({ error: "unknown session" }, 404);
      }
      if (request.method === "DELETE" && parts[0] === "sessions") {
        return json({ closed: await browser.closeSession(parts[1]) });
      }

      // Tasks (approval gate enforced here)
      if (request.method === "POST" && parts.join("/") === "tasks") {
        const kind = body.kind ?? "discover";
        const domain = domainOf(body.target_url ?? "");
        const cred = [
          ...this.ctx.storage.sql.exec("SELECT id FROM credentials WHERE domain = ? LIMIT 1", domain),
        ] as Row[];
        const task = {
          id: crypto.randomUUID(),
          kind,
          target_url: body.target_url ?? "",
          goal: body.goal ?? "",
          title: body.title ?? kind,
          drafted_payload: body.drafted_payload ?? {},
          credential_id: body.credential_id ?? (cred.length ? cred[0].id : null),
          requires_approval: requiresApprovalForKind(kind),
          status: "awaiting_approval",
          memory_id: null,
          // Resume after a human check: the app carries the kept-open
          // session id so the mission continues where the user left it.
          session_id: body.resume_session_id ?? null,
          browser_trace: [] as any[],
          extracted_items: [] as string[],
          information_requests: [] as string[],
          log: ["Drafted. Waiting for user approval."],
        };
        this.saveTask(task);
        return json(task, 201);
      }
      if (request.method === "GET" && parts.join("/") === "tasks") {
        const rows = [...this.ctx.storage.sql.exec("SELECT task FROM tasks ORDER BY created_at")] as Row[];
        return json({ tasks: rows.map((r) => JSON.parse(String(r.task))) });
      }
      if (request.method === "POST" && parts[0] === "tasks") {
        const task = this.loadTask(parts[1]);
        if (!task) return json({ error: "unknown task" }, 404);
        if (parts[2] === "run" && task.requires_approval) {
          return json({ error: "approval required: POST /tasks/{id}/approve" }, 403);
        }
        if (parts[2] === "reject") {
          if (!["awaiting_approval", "needsHuman"].includes(task.status)) {
            return json({ error: `cannot reject from ${task.status}` }, 409);
          }
          task.status = "rejected";
          task.log.push("Rejected by user");
          if (task.session_id) {
            await browser.closeSession(task.session_id).catch(() => {});
            task.session_id = null;
          }
          this.saveTask(task);
          return json(task);
        }
        if (parts[2] === "approve" || parts[2] === "run") {
          // needsHuman re-approve = resume after the user completed a
          // CAPTCHA/2FA/ID check in the kept-open session. If that
          // session died, runTask falls back to the trusted sign-in /
          // saved credential — the password is never re-asked here.
          if (!["awaiting_approval", "needsHuman"].includes(task.status)) {
            return json({ error: `task is ${task.status}, not awaiting_approval` }, 409);
          }
          const resuming = task.status === "needsHuman";
          task.status = "approved";
          task.log.push(resuming ? "Resumed by user after completing the check" : "Approved by user");
          this.saveTask(task);
          return json(await this.runTask(task, browser));
        }
      }

      // Per-user server-side state (Brief 01). Auth is identical to
      // every other user route: index.ts resolved the user id from
      // the verified credential and routed into this user's object.
      // Conflict rule: server wins on newest updated_at (see state.ts).
      if (parts[0] === "state") {
        const store = this.stateStore();
        if (request.method === "POST" && parts[1] === "import") {
          const result = store.importSnapshot(body as Record<string, unknown>);
          this.importMemories(result.memories);
          this.importSnapshotTasks(result.tasks);
          return json({
            ok: true,
            counts: result.counts,
            hasRealFeedItem: result.hasRealFeedItem,
            skippedDemo: result.skippedDemo,
            credentialRefsSkipped: result.credentialRefsSkipped,
          });
        }
        if (request.method === "GET" && parts[1] === "export") {
          return json(store.exportState());
        }
        if (request.method === "GET" && parts[1] === "counts") {
          return json({ counts: store.counts(), hasRealFeedItem: store.hasRealFeedItem() });
        }
        return json({ error: "not found", path }, 404);
      }
      const stateEntity = STATE_ROUTES[parts[0] ?? ""];
      if (stateEntity) {
        const store = this.stateStore();
        const rowId = stateEntity === "profile" ? PROFILE_ROW_ID : (parts[1] ?? "");
        if (request.method === "GET" && parts.length === 1 && stateEntity !== "profile") {
          return json({ items: store.list(stateEntity) });
        }
        if (request.method === "GET") {
          const row = store.get(stateEntity, rowId);
          return row ? json(row) : json({ error: "not found", path }, 404);
        }
        if (request.method === "POST" || request.method === "PUT") {
          const data = (body.data ?? body) as Record<string, unknown>;
          const id = stateEntity === "profile"
            ? PROFILE_ROW_ID
            : String(parts[1] ?? body.id ?? data.id ?? crypto.randomUUID());
          const updatedAt = typeof body.updatedAt === "string" ? body.updatedAt : undefined;
          try {
            const result = store.upsert(stateEntity, id, data, updatedAt);
            return json(result, result.applied ? 200 : 409);
          } catch (e: any) {
            return json({ error: String(e?.message ?? e) }, 400);
          }
        }
        if (request.method === "DELETE") {
          return json({ removed: store.remove(stateEntity, rowId) });
        }
        return json({ error: "not found", path }, 404);
      }

      return json({ error: "not found", path }, 404);
    } catch (e: any) {
      return json({ error: String(e?.message ?? e) }, 500);
    }
  }
}
