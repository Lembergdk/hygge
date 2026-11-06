import {imageReleaseEnabled} from './workspace-image-release.ts';
import { readEmailHistory } from "./email-history.ts";
import { EmailOwnerAddresses, normalizeOwnEmail } from "./email-owner-addresses.ts";
import { recordWorkspaceTaskOutcome } from './chat-task-outcomes.ts';
import { ChatAgent } from './chat-agent.ts';
import { ChatStore, sqlChatStorage, type ChatDocument } from './chat-store.ts';
import { chatServices } from './chat-services.ts';
import { latestMissionJob } from './jobs.ts';
import { classifyBrowserFailure } from "./browser-failure.ts";
import { help, helpRoutesToChat, decisionHelpMessageText, applyHelpReply, mobileTask, canResumeWithInboxCode, reconcileEndedSession, rejectTaskHelp } from "./task-help.ts";
import { bindWorkspaceOwner, workspaceMode } from './workspace-owner.ts';
import { migrateCredentialSchema } from './schema-migrations.ts';
import { createWorkspaceExecution, type WorkspaceExecution } from './workspace-execution.ts';
import type { WorkspaceBrowser } from './workspace-browser.ts';
import type { WorkspaceMissionHooks } from './workspace-task-runner.ts';
import { activeTier, d1SubscriptionDb } from "./subscriptions.ts";
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.ts";
import { json } from "./env.ts";
import { LLMClient, type LLMConfig } from "./llm.ts";
import { chatSiteCandidates, chatIntent, onboardingMessage, onboardingMessageStream } from "./onboarding.ts";
import { BrowserRunBrowser } from "./browser.ts";
import { handleProfilePhoto, profilePhotoAllowedForTask, type ProfilePhoto, type ProfilePhotoStore } from "./profile-photo.ts";
import { makeDecider, runMission, distillHints, emailCodeAllowedForTask } from "./agent.ts";
import * as vault from "./vault.ts";
import { PROFILE_ROW_ID, STATE_ROUTES, StateStore, createSqliteStateDb, ensureStateSchema, lastChatMessageId, normalizeId } from "./state.ts";
import {
  D1SkillRepository, applySkillOutcome, missionOutcomeVerified, outcomeForTaskKind, promoteCandidate,
  requiresApprovalForKind, shouldPromote, skillBodyHash, skillImplicatedByFailure,
  type SharedSkill, type SkillCandidate, type SkillOutcome,
} from "./skills.ts";
import {
  attachEmailToTasks, parseOwnerEmailCommand, takeFreshCode, accountEmailAddresses, senderEmailOf, addressForUser, d1EmailAddressDb,
  type InboundEmailDelivery,
} from "./email.ts";
import {
  sealSessionState,
  openSessionState,
  isEmptyState,
  nextTrustSupport,
  type SessionState,
  type TrustSupport,
} from "./session-profile.ts";
import {
  CRON_SLOTS_UTC, ScanStore, categoriesToReopen, clearStaleEpisode,
  createSqliteScanDb, domainOfUrl, effectiveTickNow, ensureScanSchema, extractProfile, isSiteApproved, runScheduledTick,
  scanSiteFromRow, type ProbeMissionInput, type ScanDeps, type ScanMissionInput, type ScanMissionOutcome,
  type ScanProfile, type ScanSite,
} from "./scan.ts";
import { ensureLearningProfile, rankSiteProposals } from "./learning.ts";
import {
  applyProbeOutcome, consumeUnknownCycle, eligibilityOf, extractProbeChecks,
  parseProbeJudgeReply, probeJudgePrompt, reprobeDue, snapshotEvidence,
  unknownAccessRecord, withdrawProposalsForSite, type Eligibility, type ProbeOutcome, type SiteAccessRecord,
} from "./web-access.ts";
import {
  apnsConfigFromEnv, d1PushDb, chatMessageEvent, messageWaitingEvent, needsHumanEvent, notifyUser, planTickNotifications,
  shouldNotifyDecisionHelp, type PushEvent,
} from "./push.ts";
import { createCardMessageComposer, recentChatContext, type CardMessageComposer } from "./chat-composer.ts";
import {
  claimMissionJob, enqueueMissionJob, finishMissionJob, getMissionJob,
  isTerminalJobState, type MissionJobMessage,
} from "./jobs.ts";

const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;
/// Expiry-notice retry (policy Nov 5, 2026): a failed expiry
/// composition is retried on later ticks, bounded — 5 attempts,
/// each at least 1h apart (growing: 1h, 2h, 3h, 4h, 5h). Ticks run
/// 3×/day (07:00/13:00/19:00 UTC), so the backoff is usually
/// already elapsed by the next tick and 5 attempts span roughly
/// 5 tick slots (~30h). The bound exists so a persistently
/// unconfigured model stops trying; the expired card stays
/// visible and dismissable in the feed, so the information is
/// never lost — only the push/message is.
const MAX_EXPIRY_NOTICE_ATTEMPTS = 5;
const EXPIRY_NOTICE_RETRY_BASE_MS = 60 * 60 * 1000;
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
type UserBrowser = BrowserRunBrowser | WorkspaceBrowser;

/// One UserSandbox (Durable Object + container) per verified user.
/// Holds that user's tasks, credentials (encrypted under their own
/// DEK), site memory, approvals, and sandbox snapshot. The container
/// is a workspace; this object is the system of record.
export class UserSandbox extends DurableObject<Env> {
  private queue: Promise<unknown> = Promise.resolve();
  private userId: string | null = null;
  private ownerRequests=0;
  private ownerChatWork=0;
  /// One browser for the life of this object: sessions must survive
  /// across requests, or human takeover and post-check resume have
  /// nothing to return to.
  private activeMissions = new Map<string, Promise<any>>();
  private browserResumes = new Set<string>();
  private browserInstance: UserBrowser | null = null;
  private workspaceExecution: WorkspaceExecution | null = null;
  private dekPromise: Promise<CryptoKey> | null = null;
  private schemaReady: Promise<unknown> | null = null;
  /// The one composer (and its one LLMClient) for this sandbox:
  /// mail, offer, help-upgrade, and draft messages all compose
  /// through it instead of constructing a fresh client per call.
  /// `undefined` means not built yet; null means built and the
  /// model is unconfigured. Callers treat null as "skip the
  /// message" (or, for a static help, the logged static fallback).
  private cardComposerInstance: CardMessageComposer | null | undefined;
  /// Message ids with a composed-chat job in flight (help upgrade
  /// or draft notice), so two concurrent saves of the same task
  /// cannot compose twice and push twice for one message.
  private composedChatPending = new Set<string>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const container = ctx.container;
    if (container?.running) {
      void ctx.blockConcurrencyWhile(() =>
        container.setInactivityTimeout(workspaceMode(env.HYGGE_WORKSPACE_MODE)==='retained-v2' ? 6*60*60*1000 : INACTIVITY_TIMEOUT_MS),
      );
    }
    // CREATE never replaces existing data. Verified schema/key preflight runs
    // before servicing a request; unknown historical schemas remain intact.
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS profile_photo (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL);
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
      CREATE TABLE IF NOT EXISTS mission_jobs (
        job_id TEXT PRIMARY KEY, task_id TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'queued',
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS mission_jobs_task ON mission_jobs(task_id, state);
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
      -- Brief 04 receive-only email. Codes are sealed with this
      -- user's DEK, expire in 30 minutes, and are deleted on first
      -- consumption; summaries hold no code. Ordinary original bodies
      -- are sealed separately and fetched only by the authenticated user.
      CREATE TABLE IF NOT EXISTS email_codes (
        id TEXT PRIMARY KEY, sender_domain TEXT NOT NULL,
        iv TEXT NOT NULL, ciphertext TEXT NOT NULL,
        received_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS email_summaries (
        id TEXT PRIMARY KEY, sender TEXT NOT NULL, sender_domain TEXT NOT NULL,
        subject TEXT NOT NULL, mail_date TEXT, kind TEXT NOT NULL,
        summary TEXT NOT NULL, actionable TEXT NOT NULL DEFAULT '[]',
        attachments TEXT NOT NULL DEFAULT '[]',
        relation TEXT NOT NULL DEFAULT 'unknown',
        decision TEXT NOT NULL DEFAULT 'none',
        highlights TEXT NOT NULL DEFAULT '[]',
        site_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      -- The user's remembered answer per sender domain, so unknown
      -- senders are only ever asked about once.
      CREATE TABLE IF NOT EXISTS email_originals (
        message_id TEXT PRIMARY KEY, iv TEXT NOT NULL, ciphertext TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS email_sender_rules (
        sender_domain TEXT PRIMARY KEY, choice TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS session_profiles (
        domain TEXT PRIMARY KEY,
        trust_support TEXT NOT NULL DEFAULT 'unknown',
        has_profile INTEGER NOT NULL DEFAULT 0,
        profile_iv TEXT, profile_ct TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    // Existing inboxes gain the triage columns in place; old rows
    // default to "unknown/none" so history is never re-flagged.
    const summaryColumns = new Set(
      ([...ctx.storage.sql.exec("PRAGMA table_info(email_summaries)")] as unknown as { name: unknown }[])
        .map((c) => String(c.name)));
    for (const [name, def] of [
      ["relation", "TEXT NOT NULL DEFAULT 'unknown'"],
      ["decision", "TEXT NOT NULL DEFAULT 'none'"],
      ["highlights", "TEXT NOT NULL DEFAULT '[]'"],
      ["site_id", "TEXT"],
      ["content_hash", "TEXT"],
      ["jobs", "TEXT NOT NULL DEFAULT '[]'"],
      ["title", "TEXT"], ["sender_email", "TEXT"], ["marked_me", "INTEGER NOT NULL DEFAULT 0"],
    ] as const) {
      if (!summaryColumns.has(name)) ctx.storage.sql.exec(`ALTER TABLE email_summaries ADD COLUMN ${name} ${def}`);
    }
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS idx_email_history ON email_summaries(created_at DESC, id DESC)");
    new EmailOwnerAddresses(ctx.storage.sql).ensure();
    // Brief 01: per-user state tables (feed items, messages, profile,
    // sites, opportunities, applications, proposals, account states,
    // journal events, beliefs, search evidence). tasks/credentials/
    // memories above are unchanged.
    ensureStateSchema((sql) => ctx.storage.sql.exec(sql));
    // Brief 05: scheduled-scan bookkeeping (category exhaustion
    // memory, per-site login-failure episodes, scan run log). All
    // per-user: this object only ever sees its own user's scans.
    ensureScanSchema((sql) => ctx.storage.sql.exec(sql));
  }

  private stateStore(): StateStore {
    return new StateStore(createSqliteStateDb(this.ctx.storage.sql),id=>!this.chatStore().db.get(`deleted-message:${id}`));
  }

  private scanStore(): ScanStore {
    return new ScanStore(createSqliteScanDb(this.ctx.storage.sql));
  }

  /// Snapshot of the facts that reopen exhausted categories
  /// (Brief 05 step 7): profile rate/location + site categories.
  private reopenSnapshot(store: StateStore): { profile: ScanProfile; siteCategories: Map<string, string> } {
    const siteCategories = new Map<string, string>();
    for (const row of store.list("sites")) {
      const site = scanSiteFromRow(row.id, row.data);
      if (site) siteCategories.set(site.id, site.category.toLowerCase());
    }
    return {
      profile: extractProfile(store.get("profile", PROFILE_ROW_ID)?.data).profile,
      siteCategories,
    };
  }

  private applyCategoryReopen(
    before: { profile: ScanProfile; siteCategories: Map<string, string> } | null,
    store: StateStore,
  ) {
    if (!before) return;
    try {
      const reopen = categoriesToReopen(before, this.reopenSnapshot(store));
      if (reopen === "*" || reopen.length) this.scanStore().clearExhaustion(reopen);
    } catch { /* scan bookkeeping must never fail a state write */ }
  }

  /// Brief 07: deliver this user's push events (at most one per
  /// caller by construction — see push.ts). Runs after the user's
  /// own work is saved, honors the server pause flag, and can never
  /// fail that work: every error is swallowed here and inside
  /// notifyUser, where attempts are counted in D1 push_log.
  private schedulePush(events: PushEvent[]) {
    if (!this.userId || !events.length) return;
    const userId = this.userId;
    const deliver = async () => {
      try {
        const { isPaused } = extractProfile(this.stateStore().get("profile", PROFILE_ROW_ID)?.data);
        const db = d1PushDb(this.env.DB);
        const config = apnsConfigFromEnv(this.env);
        for (const event of events) {
          await notifyUser(db, config, userId, event, { isPaused });
        }
      } catch { /* push delivery must never fail user work */ }
    };
    try {
      this.ctx.waitUntil(deliver());
    } catch {
      void deliver();
    }
  }

  /// A working sign-in on a domain ends any scan login-failure
  /// episode for it (re-saved login, or a mission that succeeded).
  private healScanEpisodes(domain: string) {
    try {
      clearStaleEpisode(this.scanStore(), this.stateStore(), domain);
    } catch { /* bookkeeping only; never fail the caller's work */ }
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
      const existing = this.loadTask(id);
      if (existing && !existing._fromSnapshot) continue; // live execution owns its state
      const stored = { ...t, id, _fromSnapshot: true };
      this.saveTask(stored);
    }
  }

  // ---- plumbing -------------------------------------------------

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }

  private llmConfig(agentName = "hygge-browser-agent"): LLMConfig {
    return {
      apiKey: this.env.HYGGE_LLM_API_KEY,
      baseUrl: this.env.HYGGE_LLM_BASE_URL,
      modelFast: this.env.HYGGE_LLM_MODEL_FAST,
      modelStrong: this.env.HYGGE_LLM_MODEL_STRONG,
      agentName,
      agentId: `hygge-${this.env.HYGGE_ENV}`,
      sessionId: this.ctx.id.toString(),
      sessionName: this.userId || undefined,
      conversationId: agentName === "hygge-onboarding" ? this.ctx.id.toString() : undefined,
      tracePayloads: this.env.HYGGE_TRACE_PAYLOADS === "1",
      gatewayToken: this.env.HYGGE_AIG_TOKEN,
      gatewayCollectPayload: this.env.HYGGE_AIG_COLLECT_PAYLOAD === "1",
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
    return this.dekPromise ??= this.loadDek().catch(error => { this.dekPromise = null; throw error; });
  }

  private async loadDek(): Promise<CryptoKey> {
    const master = await vault.masterKey(this.env);
    const wrapped = await this.ctx.storage.get<string>("wrappedDek");
    if (wrapped) return vault.unwrapDEK(wrapped, master);
    if (!this.userId) throw new Error('OWNER_REQUIRED');
    // Recover the original key before considering creation. A lookup failure
    // cannot be interpreted as absence and must never rotate a user's key.
    const backup = await this.env.DB.prepare('SELECT wrapped FROM user_keys WHERE user_id=?').bind(this.userId).first<{wrapped:string}>();
    if (backup?.wrapped) {
      const recovered = await vault.unwrapDEK(backup.wrapped, master);
      await this.ctx.storage.put('wrappedDek', backup.wrapped);
      return recovered;
    }
    const encrypted = ['credentials', 'email_codes', 'email_originals'].some(table => Number(([...this.ctx.storage.sql.exec(`SELECT COUNT(*) AS n FROM ${table}`)] as Row[])[0]?.n) > 0)
      || Number(([...this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM session_profiles WHERE has_profile=1')] as Row[])[0]?.n) > 0;
    if (encrypted) throw new Error('MISSING_ORIGINAL_ENCRYPTION_KEY');
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

  private workspace(): WorkspaceExecution {
    if (workspaceMode(this.env.HYGGE_WORKSPACE_MODE)!=='retained-v2' || !this.userId) throw new Error('WORKSPACE_MODE_REQUIRED');
    return this.workspaceExecution ??= createWorkspaceExecution({
      assertOwnerIdle:()=>{if(this.ownerRequests>1||this.ownerChatWork||this.cleanupTask||this.activeMissions.size||this.browserResumes.size)throw Error('WORKSPACE_OWNER_BUSY');},
      owner:bindWorkspaceOwner(this.ctx.storage,this.userId,this.env.HYGGE_ENV,this.ctx.id.toString()),
      env:this.env,storage:this.ctx.storage,container:this.ctx.container!,
      loadTask:id=>this.loadTask(id),projectTask:task=>{this.saveTask(task);recordWorkspaceTaskOutcome(this.chatStore(),task);},
      denyFetcher:(this.ctx as any).exports?.OutboundDeny?.({props:{}}) as Fetcher,
    });
  }

  private browser(): UserBrowser {
    if (workspaceMode(this.env.HYGGE_WORKSPACE_MODE)==='retained-v2') return this.workspace().browser;
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

  private executionView(task:any) {
    const job=latestMissionJob(this.ctx.storage,task.id);
    const progress=workspaceMode(this.env.HYGGE_WORKSPACE_MODE)==='retained-v2'?this.workspace().runner.progress(task.id):null;
    return {...task,execution:{jobId:job?.jobId??null,jobState:job?.state??null,attempts:job?.attempts??0,
      ...(progress??{}),...(job?.state==='queued'?{phase:'queued',updatedAt:job.updatedAt}:{})}};
  }

  private loadTask(id: string): any | null {
    const rows = [...this.ctx.storage.sql.exec("SELECT task FROM tasks WHERE id = ?", id)] as Row[];
    return rows.length ? JSON.parse(String(rows[0].task)) : null;
  }

  private saveTask(task: any) {
    // The previously stored status, read before this save: the
    // decision-help push below fires only on a FRESH entry into a
    // help-awaiting state, so a re-save of a task already waiting
    // never re-pushes. A snapshot import is not a fresh entry
    // either: an import replays a stored task and must never
    // message or push — the gates below AND `!isImport` into every
    // notify path, because shouldNotifyDecisionHelp(null,
    // "needsHuman") is true for a first-seen row and an imported
    // needsHuman task would otherwise push about a card the user
    // already has.
    const previousStatus = task.id ? (this.loadTask(task.id)?.status ?? null) : null;
    const isImport = task._fromSnapshot === true;
    // Feed/chat routing (policy Nov 5, 2026, as revised Nov 5,
    // 21:07 CST): EVERY decision card gets a chat message linking
    // to it. The mirror writes the help's own words verbatim
    // (decisionHelpMessageText) — for a model-composed help that
    // IS the message; for a help marked `staticText` it is only
    // the immediately-written text, upgraded to a composed
    // version by upgradeHelpMessage below. The mirror id and
    // fields are the app dedupe's contract (id == help.id, taskID,
    // helpID — no context field): do not rename them without
    // accounting for the app side.
    // A deleted message's tombstone (MESSAGE_DELETED) must never
    // fail the task save: the write is guarded, the task row below
    // is still saved, and the feed card remains the entry point.
    let mirrorText: string | null = null;
    let mirrorWrote = false;
    let mirrorCreatedAt: string | null = null;
    if (task.help && task.mobile_task && helpRoutesToChat(task.help)) {
      const now = new Date().toISOString();
      const store = this.stateStore();
      const text = decisionHelpMessageText(task);
      if (text && !store.get("messages", task.help.id)) {
        try {
          store.upsert("messages", task.help.id, {
            id: task.help.id, fromAgent: true, text,
            taskID: task.mobile_task.id, helpID: task.help.id, createdAt: now,
            // Strict previous_response_id policy (Nov 5, 2026):
            // this message chains to the previous last message in
            // the chat, resolved from the live transcript now.
            previousResponseId: lastChatMessageId(store.list("messages")),
          });
        } catch { /* a deleted message stays deleted; the feed card remains */ }
      }
      // The push below fires only when the message row actually
      // exists after the write attempt: a null relay text (empty
      // help.message) or a tombstoned id leaves no row, and a push
      // about a message that does not exist would fall back to a
      // generic body. A pre-existing row (a re-save) counts — the
      // message was written by an earlier save.
      mirrorText = text;
      const row = text ? store.get("messages", task.help.id) : null;
      mirrorWrote = Boolean(row);
      mirrorCreatedAt = row ? String((row.data as Record<string, unknown>).createdAt ?? now) : null;
    }
    if (task.mobile_task?.siteID && ["signup", "buildProfile"].includes(task.kind)) {
      const siteID = task.mobile_task.siteID;
      const state = task.status === "succeeded" ? (task.kind === "buildProfile" || task.drafted_payload?.setupMode === "connect" ? "watching" : "hasAccount")
        : ["needsHuman", "failed"].includes(task.status) ? "needsVerification" : null;
      if (state) this.stateStore().upsert("accountStates", siteID, { siteID, state });
      if (task.status === "succeeded" && !this.stateStore().get("journalEvents", task.id)) {
        const connecting = task.drafted_payload?.setupMode === "connect";
        this.stateStore().upsert("journalEvents", task.id, {
          id: task.id, occurredAt: new Date().toISOString(), kind: task.kind === "buildProfile" ? "profileLive" : "joinedSite",
          sentence: task.kind === "buildProfile" ? `Your profile on ${domainOf(task.target_url)} is live.`
            : connecting ? `Connected your account on ${domainOf(task.target_url)}.` : `Your account on ${domainOf(task.target_url)} is ready.`,
          detail: "", siteID, applicationID: null, grossAmount: null, currencyCode: "USD", listingsChecked: 0,
        });
      }
    }
    this.ctx.storage.sql.exec(
      "INSERT INTO tasks (id, task) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET task = excluded.task",
      task.id,
      JSON.stringify(task),
    );
    // Brief 07, trigger #1 — the ONE enforcement point for the
    // decision-help push (policy Nov 5, 2026): a fresh entry into
    // a help-awaiting state (needsHuman, or failed with a help)
    // with a chat-routed help pushes, as the chat message the
    // mirror above just wrote. Centralized here so it fires on
    // BOTH runners: legacy runTaskLegacy used to push from its own
    // block after the run, but retained-v2 returns from the
    // mission early and persists through this saveTask instead —
    // the legacy block could never fire there, so V2 decision
    // cards got a chat message and no push. Scan missions are
    // excluded — their episodes never notify (a tick's only push
    // is the new-work chat message). A help-less task never pushes:
    // helpRoutesToChat(null) is false, because there is no chat
    // message to push about. Snapshot imports never push (see
    // isImport above). And the push fires only when the mirror
    // actually wrote: if decisionHelpMessageText was null or the
    // write hit a tombstone, there is no message row to push
    // about, so no push goes out at all.
    // The body is the same words the chat message shows: for a
    // model-composed help, the site plus the ask and first
    // question, pushed at once. For a help marked `staticText`,
    // the push waits for the composer: upgradeHelpMessage replaces
    // the row's text with the composed version and pushes its
    // words, or — when composition fails — logs and pushes the
    // static relay instead (documented fallback). Either way the
    // push body is the message's own words, never a generic
    // fallback for a message that exists.
    if (shouldNotifyDecisionHelp(previousStatus, task.status, { scheduledScan: task.scheduled_scan === true })
        && helpRoutesToChat(task.help) && mirrorWrote && !isImport) {
      if (task.help.staticText) {
        this.runAfterSave(this.upgradeHelpMessage(task, mirrorText ?? "", mirrorCreatedAt ?? new Date().toISOString()));
      } else {
        const helpText = (task.help?.message as string | undefined)?.trim() ?? "";
        const firstQuestion = (task.help?.questions?.[0]?.text as string | undefined)?.trim() ?? "";
        const message = [helpText, firstQuestion].filter(Boolean).join(" ");
        this.schedulePush([needsHumanEvent(String(task.id), message ? `${this.helpSiteName(task)}: ${message}` : undefined)]);
      }
    }
    // Draft / awaitingApproval (policy Nov 5, 22:03 CST): a draft
    // entering review is a decision card too — it gets an
    // agent-composed chat message (deterministic id, idempotent)
    // with the task context so the app renders the embedded card,
    // plus a push. Same fresh-transition rule as the help push, and
    // snapshot imports are excluded. A draft inherits a deadline
    // only from an explicit deadline on the underlying
    // opportunity/action (task.deadline, when a producer sets one)
    // — never invented; neither current producer sets one.
    if (!isImport && task.status === "awaiting_approval" && previousStatus !== "awaiting_approval"
        && task.mobile_task) {
      this.runAfterSave(this.notifyDraftReady(task));
    }
  }

  /// The one composer (and its one LLMClient) for this sandbox.
  private cardComposer(): CardMessageComposer | null {
    if (this.cardComposerInstance === undefined) {
      this.cardComposerInstance = createCardMessageComposer(new LLMClient(this.llmConfig("hygge-browser-agent")));
    }
    return this.cardComposerInstance;
  }

  /// A composition failure must be detectable server-side, not
  /// just a log line: a model outage silently kills new-work, mail,
  /// help, draft, and expiry notifications (each fails closed with
  /// no message and no push). The repo has no metrics helper; the
  /// observable surface is a structured console.error plus a row
  /// in this object's `events` table (kind
  /// `chat-composer-failure`, payload {surface, reason}),
  /// queryable like the existing `scheduled-scan` event rows.
  /// Never throws: reporting must not fail the work it reports on.
  private reportComposerFailure(surface: string, reason: string): void {
    console.error(`chat-composer-failure surface=${surface} reason=${reason}`);
    try {
      this.ctx.storage.sql.exec(
        "INSERT INTO events (kind, payload) VALUES (?, ?)",
        "chat-composer-failure", JSON.stringify({ surface, reason }),
      );
    } catch { /* observability must never fail user work */ }
  }

  /// Run async chat work (help upgrade, draft notice, expiry
  /// notice) after the synchronous save returns, without failing
  /// the save: same waitUntil-with-floating-fallback shape as
  /// schedulePush. The work itself never throws (each method
  /// guards its own failures), and the catch here is the last net.
  private runAfterSave(work: Promise<unknown>): void {
    const guarded = work.catch(() => {});
    try {
      this.ctx.waitUntil(guarded);
    } catch {
      void guarded;
    }
  }

  /// The site name for a task's push bodies and composed facts:
  /// the known site's name when the task's domain matches one,
  /// else the bare domain. Shared by the saveTask push and the
  /// help upgrade so the two cannot drift apart.
  private helpSiteName(task: any): string {
    const domain = domainOf(task.target_url ?? "");
    const siteRow = this.stateStore().list("sites")
      .map((row) => scanSiteFromRow(String(row.id), row.data))
      .find((site) => site && domainOfUrl(site.startURLString) === domain);
    return siteRow?.name ?? domain;
  }

  /// Compose the chat message for a static-literal help and
  /// replace the mirror row's text with the composed version
  /// (same id, same createdAt — the app dedupes on the id, so the
  /// message upgrades in place rather than duplicating). The push
  /// waits for the composition, so the push body is the composed
  /// message's own words; the composer names the site from the
  /// facts, so no site prefix is added. On composition failure or
  /// an unconfigured model, the row keeps the literal relay and
  /// the push goes out with today's `${site}: ${relay}` body —
  /// that fallback is logged (reportComposerFailure + warn), not
  /// silent. If the message row is gone by then (deleted), there
  /// is no push at all: a push only ever comes from a chat
  /// message that exists.
  private async upgradeHelpMessage(task: any, mirrorText: string, mirrorCreatedAt: string): Promise<void> {
    const helpId = String(task.help?.id ?? "");
    if (!helpId || this.composedChatPending.has(helpId)) return;
    this.composedChatPending.add(helpId);
    try {
      const store = this.stateStore();
      if (!store.get("messages", helpId)) return;
      const composer = this.cardComposer();
      const firstQuestion = (task.help?.questions?.[0]?.text as string | undefined)?.trim() ?? "";
      let composed: string | null = null;
      let failureReason: string | null = null;
      if (!composer) {
        failureReason = "model_unconfigured";
      } else {
        composed = await composer({
          surface: "help",
          facts: {
            site: this.helpSiteName(task),
            kind: String(task.help?.kind ?? ""),
            ask: String(task.help?.message ?? "").trim(),
            ...(firstQuestion ? { question: firstQuestion } : {}),
          },
          recentChat: recentChatContext(store.list("messages")),
        }).catch(() => null);
        if (!composed) failureReason = "compose_failed";
      }
      if (composed) {
        try {
          // An in-place text upgrade is not a new message: it keeps
          // the row's original previousResponseId (and createdAt),
          // so the transcript chain never re-points.
          const existing = store.get("messages", helpId);
          store.upsert("messages", helpId, {
            id: helpId, fromAgent: true, text: composed,
            taskID: task.mobile_task.id, helpID: helpId, createdAt: mirrorCreatedAt,
            previousResponseId: (existing?.data as Record<string, unknown> | null)?.previousResponseId ?? null,
          }, new Date().toISOString());
        } catch { /* deleted meanwhile; the feed card remains */ }
        if (store.get("messages", helpId)) {
          this.schedulePush([needsHumanEvent(String(task.id), composed)]);
        }
        return;
      }
      this.reportComposerFailure("help", failureReason ?? "compose_failed");
      console.warn(`help chat: composition failed for ${task.help?.kind ?? "help"}; falling back to the static relay text`);
      if (store.get("messages", helpId)) {
        this.schedulePush([needsHumanEvent(String(task.id), `${this.helpSiteName(task)}: ${mirrorText}`)]);
      }
    } finally {
      this.composedChatPending.delete(helpId);
    }
  }

  /// The draft-ready chat message (policy Nov 5, 22:03 CST):
  /// "Ready for your review" as an agent-composed message with the
  /// task context, so the app renders the embedded card, plus a
  /// push. Deterministic id (`draft-chat-<taskId>`) and the
  /// row-exists check make it idempotent across re-saves and
  /// re-approvals; a draft inherits a deadline only from an
  /// explicit deadline on the underlying opportunity/action
  /// (task.deadline when a producer sets one — none does today),
  /// never an invented one. Composition failure or an
  /// unconfigured model means no message and no push (there is no
  /// pre-existing text to fall back to); the feed card remains
  /// the durable surface, and the failure is reported.
  private async notifyDraftReady(task: any): Promise<void> {
    const messageId = `draft-chat-${String(task.id).toLowerCase()}`;
    if (this.composedChatPending.has(messageId)) return;
    this.composedChatPending.add(messageId);
    try {
      const store = this.stateStore();
      if (store.get("messages", messageId)) return;
      const composer = this.cardComposer();
      if (!composer) {
        this.reportComposerFailure("draft", "model_unconfigured");
        console.warn(`draft chat: model not configured, skipping message for ${task.id}`);
        return;
      }
      const text = await composer({
        surface: "draft",
        facts: {
          site: this.helpSiteName(task),
          task: String(task.title ?? task.kind ?? "task"),
          ...(typeof task.deadline === "string" && task.deadline ? { deadline: task.deadline } : {}),
        },
        recentChat: recentChatContext(store.list("messages")),
      }).catch(() => null);
      if (!text) {
        this.reportComposerFailure("draft", "compose_failed");
        console.warn(`draft chat: composition failed for ${task.id}; no message, no push`);
        return;
      }
      try {
        store.upsert("messages", messageId, {
          id: messageId, fromAgent: true, text, createdAt: new Date().toISOString(),
          context: { kind: "task", taskId: String(task.id) },
          // Strict previous_response_id policy (Nov 5, 2026): chain
          // to the previous last message, resolved now.
          previousResponseId: lastChatMessageId(store.list("messages")),
        });
      } catch {
        console.warn(`draft chat: message write failed for ${task.id}; no message, no push`);
        return;
      }
      this.schedulePush([chatMessageEvent(messageId, text)]);
    } finally {
      this.composedChatPending.delete(messageId);
    }
  }

  /// Expiry lifecycle (policy Nov 5, 22:14 CST): when a decision
  /// card reaches its expiry, the agent is prompted to send a
  /// message about it — agent-composed, as a chat message with its
  /// card, + push — exactly once per card. This is a lifecycle
  /// notice, not an urgency treatment: expiry never affects
  /// routing (all decision cards go to chat anyway), and the
  /// expired display itself is derived lazily client-side from
  /// the expiry time — no server `expired` field.
  ///
  /// Trigger: the scheduled tick calls this (fire-and-forget, so
  /// the tick's response never waits on model composition). No
  /// new scheduler.
  ///
  /// Exactly-once with retry: the success flag (`expiryNotifiedAt` +
  /// `expiryNotifiedFor`, the deadline it fired for) is written
  /// ONLY after the message is written and its push scheduled —
  /// never before composition. A failed composition leaves the
  /// card eligible: the failure is recorded as retry state
  /// (`expiryNoticeAttempts` + `expiryNoticeNextRetryAt`, keyed
  /// to the deadline by `expiryNoticeFor`), bounded to
  /// MAX_EXPIRY_NOTICE_ATTEMPTS attempts at least
  /// EXPIRY_NOTICE_RETRY_BASE_MS apart (growing: 1h, 2h, ...),
  /// then it stops — a persistently unconfigured model must not
  /// retry forever. The in-memory pending set closes the race
  /// between two ticks that scanned before either flag landed,
  /// and a message row that already exists (a previous tick
  /// wrote it but crashed before flagging) is flagged rather
  /// than re-sent. Keying the flag and the retry state by the
  /// deadline value (not just the task) means a later re-asked
  /// help with a NEW deadline still gets its own notice.
  ///
  /// Scope: only still-pending cards — needsHuman / failed with a
  /// help, awaitingApproval drafts — carrying a deadline (the
  /// help's deadline, or a draft's explicit task.deadline). A card
  /// the user already acted on is gone from the feed (its status
  /// moved on), so it never reaches this path. Scheduled-scan
  /// episodes are excluded: scan missions never notify. Snapshot
  /// imports are excluded. A task whose card the app cannot render
  /// (mobileTask null) gets no notice and no push.
  private async notifyExpiredCards(now: Date = new Date()): Promise<void> {
    const rows = [...this.ctx.storage.sql.exec("SELECT task FROM tasks ORDER BY created_at")] as Row[];
    const store = this.stateStore();
    for (const row of rows) {
      let task: any;
      try { task = JSON.parse(String(row.task)); } catch { continue; }
      if (!task || typeof task.id !== "string" || task._fromSnapshot === true) continue;
      if (task.scheduled_scan === true) continue;
      if (!["needsHuman", "failed", "awaiting_approval"].includes(task.status)) continue;
      if (task.status === "failed" && !task.help) continue;
      const deadline = typeof task.help?.deadline === "string" && task.help.deadline
        ? task.help.deadline
        : typeof task.deadline === "string" && task.deadline ? task.deadline : null;
      if (!deadline) continue;
      const expiresMs = Date.parse(deadline);
      if (!Number.isFinite(expiresMs) || expiresMs > now.getTime()) continue;
      if (task.expiryNotifiedFor === deadline) continue;
      if (!mobileTask(task)) continue;
      const messageId = task.help?.id
        ? `expiry-chat-${String(task.help.id).toLowerCase()}`
        : `expiry-chat-${String(task.id).toLowerCase()}`;
      // Already written (a previous tick wrote it but crashed
      // before flagging): flag it rather than re-send.
      if (store.get("messages", messageId)) {
        task.expiryNotifiedAt = now.toISOString();
        task.expiryNotifiedFor = deadline;
        delete task.expiryNoticeAttempts;
        delete task.expiryNoticeNextRetryAt;
        delete task.expiryNoticeFor;
        this.saveTask(task);
        continue;
      }
      // Retry state is per deadline: a re-asked help with a new
      // deadline starts its own attempts — including a fresh
      // backoff (the old deadline's next-retry time must not gate
      // the new one).
      const sameDeadline = task.expiryNoticeFor === deadline;
      let attempts = 0;
      if (sameDeadline && Number.isFinite(task.expiryNoticeAttempts)) {
        attempts = Math.max(0, Math.trunc(task.expiryNoticeAttempts));
      }
      if (attempts >= MAX_EXPIRY_NOTICE_ATTEMPTS) continue;
      const nextRetryMs = sameDeadline ? Date.parse(task.expiryNoticeNextRetryAt ?? "") : NaN;
      if (Number.isFinite(nextRetryMs) && nextRetryMs > now.getTime()) continue;
      if (this.composedChatPending.has(messageId)) continue;
      this.composedChatPending.add(messageId);
      try {
        const composer = this.cardComposer();
        if (!composer) {
          this.recordExpiryNoticeAttempt(task, deadline, attempts, now);
          this.reportComposerFailure("expiry", "model_unconfigured");
          console.warn(`expiry chat: model not configured, will retry notice for ${task.id}`);
          continue;
        }
        const text = await composer({
          surface: "expiry",
          facts: {
            site: this.helpSiteName(task),
            item: String(task.title ?? task.kind ?? "task"),
            expiredAt: deadline,
          },
          recentChat: recentChatContext(store.list("messages")),
        }).catch(() => null);
        if (!text) {
          this.recordExpiryNoticeAttempt(task, deadline, attempts, now);
          this.reportComposerFailure("expiry", "compose_failed");
          console.warn(`expiry chat: composition failed for ${task.id}; will retry`);
          continue;
        }
        try {
          store.upsert("messages", messageId, {
            id: messageId, fromAgent: true, text, createdAt: now.toISOString(),
            context: { kind: "task", taskId: String(task.id) },
            previousResponseId: lastChatMessageId(store.list("messages")),
          });
        } catch {
          this.recordExpiryNoticeAttempt(task, deadline, attempts, now);
          console.warn(`expiry chat: message write failed for ${task.id}; will retry`);
          continue;
        }
        this.schedulePush([chatMessageEvent(messageId, text)]);
        // Mark notified only now: the message exists and its push
        // is scheduled. Clear the retry state with it.
        task.expiryNotifiedAt = now.toISOString();
        task.expiryNotifiedFor = deadline;
        delete task.expiryNoticeAttempts;
        delete task.expiryNoticeNextRetryAt;
        delete task.expiryNoticeFor;
        this.saveTask(task);
      } finally {
        this.composedChatPending.delete(messageId);
      }
    }
  }

  /// Record one failed expiry-notice attempt: increment the
  /// per-deadline counter and push the next retry at least
  /// EXPIRY_NOTICE_RETRY_BASE_MS × (attempts + 1) out (1h, 2h,
  /// 3h, ...). Persisted via saveTask — safe here because the
  /// task's status is unchanged, so no fresh-transition push,
  /// mirror re-fire, or draft notice can trigger (see saveTask).
  private recordExpiryNoticeAttempt(task: any, deadline: string, attempts: number, now: Date): void {
    task.expiryNoticeAttempts = attempts + 1;
    task.expiryNoticeFor = deadline;
    task.expiryNoticeNextRetryAt = new Date(now.getTime() + EXPIRY_NOTICE_RETRY_BASE_MS * (attempts + 1)).toISOString();
    this.saveTask(task);
  }

  // ---- Brief 04 inbox (receive only) ------------------------------
  // Deliveries arrive only from the Email Worker handler in
  // email.ts (x-hygge-email-delivery). The code, when present, is
  // sealed immediately with this user's DEK; plaintext exists only
  // while typing it into the site on the next run. This object logs
  // no code, sender, subject, or body anywhere.

  private emailCodeAAD(senderDomain: string): string {
    return `email-code\n${senderDomain}`;
  }

  private pendingEmailCodes(domain?: string) {
    const rows = [...this.ctx.storage.sql.exec(
      "SELECT id, sender_domain, iv, ciphertext, received_at FROM email_codes ORDER BY received_at DESC",
    )] as Row[];
    const records = rows.map((r) => ({
      id: String(r.id), senderDomain: String(r.sender_domain),
      iv: String(r.iv), ciphertext: String(r.ciphertext), receivedAt: String(r.received_at),
    }));
    if (domain) {
      const fresh = takeFreshCode(records, domain);
      return fresh ? [fresh] : [];
    }
    const now = Date.now();
    return records.filter((r) => now - Date.parse(r.receivedAt) <= 30 * 60 * 1000);
  }

  private hasEmailCode(domain: string): boolean {
    return this.pendingEmailCodes(domain).length > 0;
  }

  /// Consume = open + delete. The row is removed before the value
  /// is used, so a code can never be replayed or read twice.
  private async consumeEmailCode(domain: string): Promise<string | null> {
    const [record] = this.pendingEmailCodes(domain);
    if (!record) return null;
    this.ctx.storage.sql.exec("DELETE FROM email_codes WHERE id = ?", record.id);
    try {
      return await vault.open(await this.dek(),
        { iv: record.iv, ciphertext: record.ciphertext }, this.emailCodeAAD(record.senderDomain));
    } catch {
      return null; // deleted either way — a code that cannot open is dead
    }
  }

  private pruneExpiredEmailCodes() {
    const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    this.ctx.storage.sql.exec("DELETE FROM email_codes WHERE received_at < ?", cutoff);
  }

  /// Sender triage for one delivery: who is this to the user, and
  /// what happens without asking? Owner status was decided before
  /// delivery (email.ts); site matching and the user's remembered
  /// sender choices live here, beside the state they describe.
  private triageEmail(delivery: InboundEmailDelivery): {
    relation: "owner" | "site" | "unknown";
    decision: string;
    site: ScanSite | null;
    sites: ScanSite[];
    accountStates: Record<string, string>;
  } {
    const store = this.stateStore();
    const sites = store.list("sites")
      .map((row) => scanSiteFromRow(String(row.id), row.data))
      .filter((s): s is ScanSite => s !== null);
    const accountStates: Record<string, string> = {};
    for (const row of store.list("accountStates")) {
      const data = row.data as Record<string, unknown>;
      accountStates[String(data.siteID ?? row.id)] = String(data.state ?? "");
    }
    const senderDomain = delivery.summary.senderDomain.toLowerCase();
    const sameSite = (a: string, b: string) => Boolean(a && b) && (a === b || a.endsWith(`.${b}`));
    const site = sites.find((candidate) => sameSite(senderDomain, domainOfUrl(candidate.startURLString))) ?? null;
    const tracked = site !== null
      && ["watching", "profileLive", "hasAccount", "joining", "needsVerification"].includes(accountStates[site.siteID] ?? "");
    const ruleRows = [...this.ctx.storage.sql.exec(
      "SELECT choice FROM email_sender_rules WHERE sender_domain = ?", senderDomain)] as Row[];
    const rule = ruleRows.length ? String(ruleRows[0].choice) : null;

    const relation = delivery.triage?.ownerVerified ? "owner" : tracked ? "site" : "unknown";
    // Every tracked sender's mail is evaluated for action by
    // default (highlights, site proposals, chat asks, message
    // pushes) — there is no work/file question anymore. The one
    // remembered opt-out is "ignore"; legacy work/file rules
    // simply mean the default.
    let decision = "none";
    if (delivery.kind === "other") {
      decision = rule === "ignore" ? "ignore" : "work";
    }
    return { relation, decision, site, sites, accountStates };
  }

  /// One mail, one journal entry: the id derives from the mail's
  /// content identity, so even a raced re-delivery upserts the
  /// same entry instead of writing a second one.
  private static uuidFromSeed(seed: string): string {
    const hex = seed.replace(/[^a-f0-9]/gi, "").padEnd(32, "0").slice(0, 32);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  }

  private journalEmail(receivedAt: string, sentence: string, detail: string, siteID: string | null,
                       contentHash?: string) {
    const journalId = contentHash ? UserSandbox.uuidFromSeed(contentHash) : crypto.randomUUID();
    this.stateStore().upsert("journalEvents", journalId, {
      id: journalId,
      occurredAt: receivedAt,
      kind: "filedEmail",
      sentence,
      detail,
      siteID, applicationID: null, grossAmount: null,
      currencyCode: "USD", listingsChecked: 0,
    }, receivedAt);
  }

  /// Compose and write one agent chat message for mail (policy
  /// Nov 5, 2026): the text is composed by the model from the
  /// given facts plus recent chat — never a canned string — and
  /// the message is the push's backing row, so the caller
  /// schedules the push from the returned text. Returns the
  /// written message, or null when no message was written:
  /// already asked/told (the deterministic id dedupes, once per
  /// mail), composition failed or unavailable, or the write itself
  /// failed (e.g. a deleted message's tombstone). A null return
  /// means NO push for that mail: the journal entry still files
  /// and any feed card remains the durable surface.
  private async composeAndWriteMailChat(input: {
    surface: "mail-question" | "mail";
    facts: Record<string, string>;
    id: string;
    context?: Record<string, unknown>;
  }): Promise<{ id: string; text: string } | null> {
    const store = this.stateStore();
    if (store.get("messages", input.id)) return null;
    const composer = this.cardComposer();
    if (!composer) {
      this.reportComposerFailure(input.surface, "model_unconfigured");
      console.warn(`mail chat: model not configured, skipping ${input.surface} message`);
      return null;
    }
    const text = await composer({
      surface: input.surface,
      facts: input.facts,
      recentChat: recentChatContext(store.list("messages")),
    }).catch(() => null);
    if (!text) {
      this.reportComposerFailure(input.surface, "compose_failed");
      console.warn(`mail chat: composition failed for ${input.surface}; no message, no push`);
      return null;
    }
    try {
      // The question is written now: its createdAt is the write
      // time, NOT the mail's receivedAt. The transcript chain
      // (previous_response_id) resolves "the last message" by
      // createdAt, so a backdated stamp would let a later message
      // chain past this one — and display order follows the same
      // stamp, so the question would also appear above messages
      // written after it arrived. The mail's own arrival time
      // lives on the filed mail card and the journal entry.
      const writtenAt = new Date().toISOString();
      store.upsert("messages", input.id, {
        id: input.id, fromAgent: true, text, createdAt: writtenAt,
        ...(input.context ? { context: input.context } : {}),
        // Strict previous_response_id policy (Nov 5, 2026): chain
        // to the previous last message, resolved now.
        previousResponseId: lastChatMessageId(store.list("messages")),
      }, writtenAt);
    } catch {
      console.warn(`mail chat: message write failed for ${input.surface}; no message, no push`);
      return null;
    }
    return { id: input.id, text };
  }

  /// An email-triggered look for work runs the same guarded tick as
  /// the schedule (consent states, web-access checks, cadence caps),
  /// never a side channel around them.
  private scheduleEmailScanTick(after?: (scannedSiteIDs: string[]) => void) {
    const hour = new Date().getUTCHours();
    const slot = hour < 13 ? 0 : hour < 19 ? 1 : 2;
    this.ctx.waitUntil((async () => {
      try {
        const summary = await this.exclusive(() =>
          runScheduledTick(this.scanDeps(this.browser()), { slot, now: new Date() }));
        this.schedulePush(planTickNotifications(summary));
        after?.(summary.scanned.map((run: any) => String(run.siteId ?? run.siteID ?? "")));
      } catch { /* the next scheduled slot still runs */ }
    })());
  }

  /// Owner mail carrying an instruction, already sender-proven.
  /// Reads and pause/resume run at once; joining a job site restores
  /// its Home-screen suggestion (the app owns the signup itself:
  /// email choice and login asks live there). Returns the journal
  /// sentence, or null when the mail held no instruction.
  /// The ingest model's owner instruction, mapped onto the same
  /// command shape the strict parser produces. Site references
  /// resolve only against this user's real sites; anything else
  /// is dropped, never guessed.
  private commandFromModelReading(
    delivery: InboundEmailDelivery,
    triage: ReturnType<UserSandbox["triageEmail"]>,
  ): ReturnType<typeof parseOwnerEmailCommand> {
    const instruction = delivery.triage?.reading?.instruction;
    if (!instruction) return null;
    if (instruction.kind === "pause" || instruction.kind === "resume") {
      return { type: instruction.kind };
    }
    if (instruction.kind === "add") return { type: "add", domain: instruction.domain };
    const siteInstruction = instruction as { kind: "scan" | "readd"; site: string };
    const needle = siteInstruction.site.toLowerCase();
    const site = triage.sites.find((candidate) =>
      candidate.siteID.toLowerCase() === needle
      || candidate.name.toLowerCase() === needle
      || domainOfUrl(candidate.startURLString) === needle);
    return site ? { type: siteInstruction.kind, siteID: site.siteID } : null;
  }

  private runOwnerEmailCommand(
    delivery: InboundEmailDelivery,
    triage: ReturnType<UserSandbox["triageEmail"]>,
  ): string | null {
    const s = delivery.summary;
    const store = this.stateStore();
    const ownerSites = triage.sites.map((site) => ({ siteID: site.siteID, name: site.name, domain: domainOfUrl(site.startURLString) }));
    // The strict reading first (exact, free); the model's reading
    // of the same proven-owner mail second, its site reference
    // re-validated against the sites that actually exist here.
    const command = parseOwnerEmailCommand({ subject: s.subject, text: s.extractiveSummary ?? s.summary }, ownerSites)
      ?? this.commandFromModelReading(delivery, triage);
    if (!command) return null;
    const siteByID = (id: string) => triage.sites.find((site) => site.siteID === id) ?? null;
    const restoreSuggestion = (site: ScanSite) => {
      const proposals = store.list("proposals");
      const existing = proposals.find((row) => String((row.data as any).siteID ?? "") === site.siteID);
      if (existing) {
        const data = { ...(existing.data as Record<string, unknown>), status: "proposed" };
        store.upsert("proposals", String(existing.id), data);
      } else {
        const id = crypto.randomUUID();
        store.upsert("proposals", id, {
          id, siteID: site.siteID, rationale: "You asked me to add this job site.",
          payPattern: "Paid per job, rates vary by listing",
          dataShared: "Your name, photo and profile text",
          verification: "Email confirmation; a bot check may need you",
          status: "proposed",
        });
      }
      const state = triage.accountStates[site.siteID] ?? "";
      if (state === "stopped" || state === "disconnected" || state === "") {
        store.upsert("accountStates", site.siteID, { siteID: site.siteID, state: "proposed" });
      }
    };

    switch (command.type) {
      case "pause":
      case "resume": {
        const row = store.get("profile", PROFILE_ROW_ID);
        const data = { ...((row?.data ?? {}) as Record<string, unknown>), isPaused: command.type === "pause" };
        store.upsert("profile", PROFILE_ROW_ID, data);
        return command.type === "pause"
          ? "You asked by email, so I've paused. Nothing will be searched, sent, or booked until you resume."
          : "You asked by email, so I'm back on. I'll tell you in the morning — sooner if something needs you.";
      }
      case "scan": {
        const site = siteByID(command.siteID);
        if (!site) return null;
        if (!isSiteApproved(triage.accountStates[site.siteID] ?? "")) {
          return `You asked by email to check ${site.name}, but you're not set up there yet, so there's nothing to search.`;
        }
        const receivedAt = delivery.receivedAt;
        const detail = s.summary;
        this.scheduleEmailScanTick((scanned) => {
          this.journalEmail(receivedAt, scanned.includes(site.siteID) || scanned.includes(site.id)
            ? `You asked by email, so I checked ${site.name} for new work.`
            : `You asked by email to check ${site.name}; it had already been checked in this slot.`,
          detail, site.siteID, delivery.contentHash);
        });
        return "queued"; // journal written when the look actually happens
      }
      case "readd": {
        const site = siteByID(command.siteID);
        if (!site) return null;
        const state = triage.accountStates[site.siteID] ?? "";
        if (isSiteApproved(state)) return `You asked by email about ${site.name} — you're already set up there.`;
        restoreSuggestion(site);
        return `You asked by email to add ${site.name} — it's back on your Home screen to start.`;
      }
      case "add": {
        const existing = triage.sites.find((site) => domainOfUrl(site.startURLString) === command.domain);
        if (existing) {
          if (isSiteApproved(triage.accountStates[existing.siteID] ?? "")) {
            return `You asked by email about ${existing.name} — you're already set up there.`;
          }
          restoreSuggestion(existing);
          return `You asked by email to add ${existing.name} — it's on your Home screen to start.`;
        }
        const profileRow = store.get("profile", PROFILE_ROW_ID);
        const interests = (((profileRow?.data as any)?.profile?.interests ?? []) as unknown[]).map(String);
        const label = command.domain.split(".")[0] || command.domain;
        const name = label.charAt(0).toUpperCase() + label.slice(1);
        const site = {
          id: command.domain, name,
          startURLString: `https://${command.domain}`,
          category: interests[0] ?? "localGig",
          goalTemplate: "Find current opportunities on this site that match my earnings profile and extract their title, pay, location and link.",
        };
        store.upsert("sites", site.id, site);
        restoreSuggestion({ ...site, siteID: site.id } as unknown as ScanSite);
        return `You asked by email to add ${name} — it's on your Home screen to start.`;
      }
    }
  }

  /// A jobs-bearing mail can evidence a job site worth watching:
  /// the hosts it links to (or a service sender domain), minus
  /// generic mailboxes and job sites already known. Authenticated
  /// senders only — forged mail never earns a feed card.
  private candidateSiteFromMail(
    delivery: InboundEmailDelivery,
    triage: ReturnType<UserSandbox["triageEmail"]>,
  ): { domain: string; name: string } | null {
    // A proposal is a consent surface (nothing joins or scans
    // without the user's OK), so it needs no sender-authentication
    // gate — forwards, which routinely fail alignment, are
    // exactly the mail this exists for. Authentication still
    // gates pushes, owner commands, and code use elsewhere.
    const mentionsWork = (delivery.triage?.reading?.mentions ?? []).some((m) => m.kind === "job_alert")
      || (delivery.triage?.highlights ?? []).some((h) => h.kind === "job_alert")
      || (delivery.triage?.reading?.jobs ?? []).length > 0;
    if (!mentionsWork) return null;
    const genericMailboxes = new Set([
      "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com",
      "yahoo.com", "yahoo.co.uk", "icloud.com", "me.com", "proton.me", "protonmail.com", "aol.com",
      "usehygge.cc", "usehygge.app",
    ]);
    // The site the mail points at (its own links) outranks who
    // sent it — a forwarded LinkedIn alert is about LinkedIn,
    // not the forwarder's domain, so the sender domain is only
    // a fallback for unforwarded mail.
    const forwarded = /^\s*(fwd?|fw)\s*:/i.test(delivery.summary.subject);
    const hosts = [
      ...delivery.summary.actionableItems
        .filter((item) => item.startsWith("Link to "))
        .map((item) => item.slice("Link to ".length).trim().toLowerCase().replace(/^www\./, "")),
      ...(forwarded ? [] : [delivery.summary.senderDomain.toLowerCase()]),
    ];
    for (const domain of hosts) {
      if (!domain || genericMailboxes.has(domain)) continue;
      const known = triage.sites.some((site) => {
        const siteDomain = domainOfUrl(site.startURLString);
        return domain === siteDomain || domain.endsWith(`.${siteDomain}`) || siteDomain.endsWith(`.${domain}`);
      });
      if (known) continue;
      const label = domain.split(".")[0] || domain;
      return { domain, name: label.charAt(0).toUpperCase() + label.slice(1) };
    }
    return null;
  }

  /// Suggest a job site the mail evidenced, as an ordinary feed
  /// proposal carrying its origin (the app can then tie a
  /// dismissal back to this sender). The proposal IS the consent
  /// surface; nothing joins from here.
  private proposeSiteFromMail(
    candidate: { domain: string; name: string },
    delivery: InboundEmailDelivery,
    summaryId: string,
  ) {
    const store = this.stateStore();
    const profileRow = store.get("profile", PROFILE_ROW_ID);
    const interests = (((profileRow?.data as any)?.profile?.interests ?? []) as unknown[]).map(String);
    store.upsert("sites", candidate.domain, {
      id: candidate.domain, name: candidate.name,
      startURLString: `https://${candidate.domain}`,
      category: interests[0] ?? "localGig",
      goalTemplate: "Find current opportunities on this site that match my earnings profile and extract their title, pay, location and link.",
    });
    const id = crypto.randomUUID();
    const jobs = delivery.triage?.reading?.jobs ?? [];
    const forwarded = /^\s*(fwd?|fw)\s*:/i.test(delivery.summary.subject);
    const rationale = jobs.length > 1
      ? `${forwarded ? "Your forwarded job alert" : `A job alert from ${delivery.summary.senderDomain}`} mentioned ${jobs.length} roles there, including ${jobs[0].title}.`
      : jobs.length === 1
        ? `${forwarded ? "Your forwarded job alert" : `A job alert from ${delivery.summary.senderDomain}`} mentioned a role there: ${jobs[0].title}.`
        : `Mail from ${delivery.summary.senderDomain} mentioned work there.`;
    store.upsert("proposals", id, {
      id, siteID: candidate.domain,
      rationale,
      payPattern: "Paid per job, rates vary by listing",
      dataShared: "Your name, photo and profile text",
      verification: "Email confirmation; a bot check may need you",
      status: "proposed",
      sourceMailDomain: delivery.summary.senderDomain.toLowerCase(),
      sourceMailId: summaryId,
      sourceMailJobs: jobs,
    });
    store.upsert("accountStates", candidate.domain, { siteID: candidate.domain, state: "proposed" });
  }

  private async handleEmailInbound(delivery: InboundEmailDelivery) {
    this.pruneExpiredEmailCodes();
    const s = delivery.summary;
    const verifiedAddress = await new EmailOwnerAddresses(this.ctx.storage.sql).verify(
      delivery.triage?.senderEmail ?? "", delivery.triage?.senderAuthenticated === true, s.subject);
    if (verifiedAddress) return { filed: false, kind: delivery.kind, outcome: "address_verified" };
    // One mail, one event: a re-forward (or any re-delivery) of
    // content already filed changes nothing — no second summary,
    // journal entry, proposal, or push.
    if (delivery.kind === "other" && delivery.contentHash) {
      const existing = [...this.ctx.storage.sql.exec(
        "SELECT id FROM email_summaries WHERE content_hash = ? LIMIT 1", delivery.contentHash)] as Row[];
      if (existing.length) return { filed: true, kind: delivery.kind, outcome: "duplicate" };
    }
    const summaryId = delivery.contentHash
      ? UserSandbox.uuidFromSeed(`${delivery.contentHash}summary`)
      : crypto.randomUUID();
    const triage = this.triageEmail(delivery);
    // The model's concrete mentions read better than fixed
    // keyword labels ("4 maintenance jobs near Leeds"); keyword
    // labels remain the fallback when no model read the mail.
    const readingMentions = delivery.triage?.reading?.mentions ?? [];
    const highlightLabels = readingMentions.length
      ? readingMentions.map((m) => m.detail)
      : (delivery.triage?.highlights ?? []).map((h) => h.label);
    // Where does this mail's action live? A site the mail
    // evidences becomes a feed proposal; work-relevant mail with
    // no job site to attach becomes a chat question; the rest keeps
    // the triage decision. The journal only ever records facts.
    const readingJobs = delivery.triage?.reading?.jobs ?? [];
    const evaluated = triage.decision !== "ignore";
    const siteCandidate = evaluated && delivery.kind === "other" && triage.relation === "unknown"
      ? this.candidateSiteFromMail(delivery, triage) : null;
    const mentionsWorkOrMessage = readingMentions.some((m) => m.kind === "job_alert" || m.kind === "client_message");
    // Asking is a consent surface like the proposal card, so it
    // carries no authentication gate either; nothing acts on
    // the mail's say-so without the user's answer.
    const chatAsk = evaluated && !siteCandidate && triage.relation === "unknown" && delivery.kind === "other"
      && (mentionsWorkOrMessage || readingJobs.length > 0);
    const finalDecision = siteCandidate ? "proposed" : chatAsk ? "chat" : triage.decision;
    const original = delivery.kind === "other" && delivery.original
      ? await vault.seal(await this.dek(), JSON.stringify(delivery.original), `email-original:${summaryId}`) : null;
    this.ctx.storage.transactionSync(() => {
    this.ctx.storage.sql.exec(
      `INSERT INTO email_summaries (id, sender, sender_domain, subject, mail_date, kind, summary, actionable, attachments, relation, decision, highlights, site_id, content_hash, jobs, title, sender_email)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      summaryId, s.sender, s.senderDomain, s.subject, s.date, s.kind,
      s.summary, JSON.stringify(s.actionableItems), JSON.stringify(s.attachments),
      triage.relation, finalDecision, JSON.stringify(highlightLabels),
      triage.relation === "site" ? (triage.site?.siteID ?? null) : null,
      delivery.contentHash ?? null,
      JSON.stringify(readingJobs), s.title ?? null, delivery.triage?.senderEmail ?? null,
    );
      if (original) this.ctx.storage.sql.exec(
        "INSERT INTO email_originals (message_id, iv, ciphertext) VALUES (?, ?, ?)", summaryId, original.iv, original.ciphertext);
    });
    if (delivery.code) {
      const blob = await vault.seal(await this.dek(), delivery.code, this.emailCodeAAD(s.senderDomain));
      this.ctx.storage.sql.exec(
        "INSERT INTO email_codes (id, sender_domain, iv, ciphertext, received_at) VALUES (?, ?, ?, ?, ?)",
        crypto.randomUUID(), s.senderDomain, blob.iv, blob.ciphertext, delivery.receivedAt,
      );
    }
    // Attach verification/code outcomes to the pending signup task.
    const rows = [...this.ctx.storage.sql.exec("SELECT task FROM tasks ORDER BY created_at")] as Row[];
    const tasks = rows.map((r) => JSON.parse(String(r.task)));
    const eligible = tasks.filter((t: any) => t.interaction_version !== 1 || t.help?.kind === "verification");
    for (const task of attachEmailToTasks(eligible, delivery) as any[]) {
      if (task.status === "succeeded") task.help = null;
      this.saveTask(task);
      if (canResumeWithInboxCode(task)) {
        task.help = null;
        task.status = "running";
        this.saveTask(task);
        this.scheduleMission(task);
      }
    }
    // Other mail earns exactly ONE journal entry: a witnessed,
    // past-tense fact (what arrived, what it said, what Hygge
    // did) — never an ask. Anything needing the user lives where
    // it can be acted on: a feed card (proposal, sender decision)
    // or a chat question. "ignore" files silently, as chosen.
    let outcome: string | undefined;
    if (delivery.kind === "other" && triage.decision !== "ignore") {
      const detail = [...highlightLabels, s.summary].filter(Boolean).join(" ");
      const hash = delivery.contentHash;
      if (triage.relation === "owner") {
        const sentence = this.runOwnerEmailCommand(delivery, triage);
        if (sentence && sentence !== "queued") {
          this.journalEmail(delivery.receivedAt, sentence, detail, null, hash);
        } else if (!sentence) {
          const readingInstruction = delivery.triage?.reading?.instruction;
          if (readingInstruction && delivery.contentHash) {
            const named = readingInstruction.kind === "add"
              ? readingInstruction.domain : "site" in readingInstruction ? readingInstruction.site : null;
            // A mail question is a chat message, so it pushes —
            // once per mail (the deterministic id dedupes). The
            // question text is composed by the model from the
            // instruction facts, never a canned string.
            const asked = await this.composeAndWriteMailChat({
              surface: "mail-question",
              facts: {
                instruction: readingInstruction.kind,
                ...(named ? { site: named } : {}),
                sender: s.senderDomain,
                subject: s.subject || "(no subject)",
              },
              id: UserSandbox.uuidFromSeed(`${delivery.contentHash}chat`),
            });
            if (asked) {
              outcome = "chat_asked";
              this.schedulePush([chatMessageEvent(asked.id, asked.text)]);
            }
          }
          this.journalEmail(delivery.receivedAt,
            `Filed mail from your address: ${s.subject || "(no subject)"}`, detail, null, hash);
        }
      } else if (triage.relation === "site" && triage.site) {
        this.journalEmail(delivery.receivedAt,
          `Filed mail from ${triage.site.name}: ${s.subject || "(no subject)"}`,
          detail, triage.site.siteID, hash);
        if (triage.decision === "work" && highlightLabels.length > 0) {
          this.scheduleEmailScanTick();
        }
      } else if (siteCandidate) {
        this.proposeSiteFromMail(siteCandidate, delivery, summaryId);
        outcome = "proposed_site";
        this.journalEmail(delivery.receivedAt,
          `Filed mail from ${s.senderDomain || "a new sender"}: ${s.subject || "(no subject)"}. Suggested ${siteCandidate.name} as a new job site.`,
          detail, null, hash);
      } else if (chatAsk && delivery.contentHash) {
        const titles = readingJobs.map((j) => j.title);
        // A mail question is a chat message, so it pushes — once
        // per mail (the deterministic id dedupes). The question
        // text is composed by the model from the mail facts, never
        // a canned string. The journal says "asked you in chat"
        // only when the question was actually written.
        const asked = await this.composeAndWriteMailChat({
          surface: "mail-question",
          facts: {
            sender: s.senderDomain,
            subject: s.subject || "(no subject)",
            summary: s.summary,
            ...(titles.length ? { roles: titles.join(", "), roleCount: String(titles.length) } : {}),
          },
          id: UserSandbox.uuidFromSeed(`${delivery.contentHash}chat`),
        });
        if (asked) {
          outcome = "chat_asked";
          this.schedulePush([chatMessageEvent(asked.id, asked.text)]);
          this.journalEmail(delivery.receivedAt,
            `Filed mail from ${s.senderDomain || "a new sender"}: ${s.subject || "(no subject)"}. Asked you in chat what to do with mail like this.`,
            detail, null, hash);
        } else {
          this.journalEmail(delivery.receivedAt,
            `Filed mail from ${s.senderDomain || "a new sender"}: ${s.subject || "(no subject)"}`,
            detail, null, hash);
        }
      } else {
        this.journalEmail(delivery.receivedAt,
          `Filed mail from ${s.senderDomain || "a site"}: ${s.subject || "(no subject)"}`,
          detail, null, hash);
      }
      // A client message may be waiting: the one mail event worth
      // a push — but only backed by a chat message (policy Nov 5,
      // 2026). The message carries the embedded mail card
      // (context kind "mail", id = summaryId — the agreed contract
      // with the app-side card-tap fix) and the push opens that
      // message, never the filed mail directly and never without
      // a message. Authenticated tracked (or work-ruled) senders
      // only, at most one per sender per day — the rest stay in
      // the journal. One mail pushes once: when the mail already
      // produced a chat question above (outcome "chat_asked"), the
      // backing push is skipped — the question's push is the
      // mail's one push.
      const mentionsMessage = (delivery.triage?.highlights ?? []).some((h) => h.kind === "client_message")
        || readingMentions.some((m) => m.kind === "client_message");
      if (mentionsMessage && triage.decision === "work" && triage.relation !== "owner"
        && outcome !== "chat_asked"
        && delivery.triage?.senderAuthenticated === true) {
        const day = delivery.receivedAt.slice(0, 10);
        const capKey = `mailPush:${s.senderDomain.toLowerCase()}:${day}`;
        const already = [...this.ctx.storage.sql.exec("SELECT value FROM kv WHERE key = ?", capKey)] as Row[];
        if (!already.length) {
          const backing = await this.composeAndWriteMailChat({
            surface: "mail",
            facts: {
              site: triage.site?.name ?? s.senderDomain,
              subject: s.subject || "(no subject)",
              summary: s.summary,
            },
            id: summaryId,
            context: { kind: "mail", id: summaryId },
          });
          if (backing) {
            this.ctx.storage.sql.exec("INSERT OR REPLACE INTO kv (key, value) VALUES (?, '1')", capKey);
            this.schedulePush([messageWaitingEvent(backing.id, backing.text)]);
          }
        }
      }
    }
    return { filed: true, kind: delivery.kind, relation: triage.relation, decision: finalDecision, outcome };
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
        // Positive shared feedback needs observed evidence, not model "done".
        if (succeeded && !missionOutcomeVerified(task, result)) {
          task.log.push(`Shared skill ${activeSkill.id} v${activeSkill.version} feedback held (outcome not independently observed)`);
          return;
        }
        const updated = applySkillOutcome(activeSkill, succeeded,
          !succeeded && skillImplicatedByFailure(activeSkill, result.trace));
        await this.skillRepo().update(updated);
        task.log.push(updated.status !== activeSkill.status
          ? `Shared skill ${activeSkill.id} v${activeSkill.version} flagged for re-verification (failure implicated a skill step)`
          : `Shared skill ${activeSkill.id} v${activeSkill.version} confidence ${activeSkill.confidence.toFixed(2)} -> ${updated.confidence.toFixed(2)}`);
        return;
      }
      if (!succeeded || !result.skillDraft) return;
      if (!missionOutcomeVerified(task, result)) {
        task.log.push(`Skill candidate for ${domain}/${outcome} held (outcome not independently observed)`);
        return;
      }
      // Known user values are match needles for sanitization only —
      // never stored or logged. The vault secret is never loaded here.
      // Needles include this user's durable profile and credential
      // usernames, not only the promoting task's draft.
      const knownValues: string[] = Object.values(task.drafted_payload ?? {})
        .flatMap((v: any) => Array.isArray(v) ? v : [v]).map(String);
      try {
        for (const row of [...this.ctx.storage.sql.exec("SELECT username FROM credentials")] as Row[]) {
          if (row.username) knownValues.push(String(row.username));
        }
        for (const row of [...this.ctx.storage.sql.exec("SELECT payload FROM profile WHERE id = 'profile'")] as Row[]) {
          const collect = (v: unknown): void => {
            if (typeof v === "string" && v) knownValues.push(v);
            else if (v && typeof v === "object") Object.values(v).forEach(collect);
          };
          collect(JSON.parse(String(row.payload)));
        }
      } catch { /* draft needles still apply; sanitization stays fail-closed */ }
      if (task.credential_id) {
        const creds = [...this.ctx.storage.sql.exec(
          "SELECT username FROM credentials WHERE id = ?", task.credential_id)] as Row[];
        if (creds.length) knownValues.push(String(creds[0].username));
      }
      const existing = this.loadSkillCandidate(domain, outcome);
      // Corroboration is hash-bound to the FIRST authored body: the
      // authoring run stores it uncounted, and only later verified runs
      // whose distilled draft is identical may increment the count.
      if (existing && (await skillBodyHash(result.skillDraft)) !== (await skillBodyHash(existing.body))) {
        task.log.push(`Skill candidate for ${domain}/${outcome} held (run did not reproduce the authored procedure)`);
        return;
      }
      const candidate: SkillCandidate = {
        id: existing?.id ?? crypto.randomUUID(), site: domain, outcome,
        body: existing?.body ?? result.skillDraft,
        corroborationCount: existing ? existing.corroborationCount + 1 : 0,
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

  private runInteractiveTask(task: any, browser: UserBrowser): Promise<any> {
    const existing = this.activeMissions.get(task.id);
    if (existing) return existing;
    const run = this.runInteractiveTaskInner(task, browser).finally(() => this.activeMissions.delete(task.id));
    this.activeMissions.set(task.id, run);
    return run;
  }

  // ---- durable mission jobs (jobs.ts) ------------------------------
  // Submission paths record a job and hand it to the queue; the
  // consumer calls back into this object to run it. Without the
  // binding (local/unit environments) the previous inline
  // request-driven behavior is preserved exactly.

  /// Submit and (when queued) return the task at once; the mission
  /// itself runs on queue delivery. Inline fallback awaits the run.
  private async enqueueOrRunMission(task: any): Promise<any> {
    const queue = this.env.MISSION_QUEUE;
    if (!queue || !this.userId) {
      const result = await this.runInteractiveTask(task, this.browser());
      this.maybeAutoResume(result);
      return result;
    }
    const enqueuedAt = new Date().toISOString();
    const { job } = enqueueMissionJob(this.ctx.storage, String(task.id), enqueuedAt, crypto.randomUUID());
    if (job.state === "running" && this.activeMissions.has(task.id)) {
      // Already in flight in this isolate: join it rather than
      // queue a duplicate delivery behind it.
      return this.runInteractiveTask(task, this.browser());
    }
    const message: MissionJobMessage = {
      v: 1, jobId: job.jobId, userId: this.userId, taskId: String(task.id), enqueuedAt,
    };
    try {
      await queue.send(message);
    } catch (e) {
      // The user's approved work must not stall on a queue outage:
      // close the job visibly and run inline, exactly as before.
      finishMissionJob(this.ctx.storage, job.jobId, "failed", new Date().toISOString(),
        `queue send failed: ${String((e as Error)?.message ?? e)}`);
      task.log?.push("Background queue unavailable; running now instead.");
      this.saveTask(task);
      const inline = await this.runInteractiveTask(task, this.browser());
      this.maybeAutoResume(inline);
      return inline;
    }
    return task;
  }

  /// Fire-and-forget submission for continuations nobody awaits
  /// (inbox-code resume, browser handback). Inline fallback keeps
  /// today's waitUntil behavior.
  private scheduleMission(task: any) {
    if (!this.env.MISSION_QUEUE || !this.userId) {
      const run = this.runInteractiveTask(task, this.browser());
      try { this.ctx.waitUntil(run); } catch { void run; }
      return;
    }
    void this.enqueueOrRunMission(task).catch(() => {});
  }

  /// Auto-resume a silent pause (needsHuman, no help): the agent
  /// continues on its own, within a per-effect budget, so an
  /// interrupted mission never waits on a user tap. A help-bearing
  /// pause is a real stop (an approval, or an input only the user
  /// can give) and is never auto-resumed. The budget is keyed to
  /// the pending effect: a new effect resets it, and a pause with
  /// no pending effect shares the "none" key so the loop still
  /// terminates. Returns true when a resume was scheduled.
  private maybeAutoResume(task: any): boolean {
    if (!task || task.status !== "needsHuman" || task.help) return false;
    const key = task.workspace_pending_effect_id ?? "none";
    if (task.auto_resume_effect_id !== key) { task.auto_resume_effect_id = key; task.auto_resume_count = 0; }
    if ((task.auto_resume_count ?? 0) >= 3) return false;
    task.auto_resume_count = (task.auto_resume_count ?? 0) + 1;
    (task.log ??= []).push(`Auto-resume ${task.auto_resume_count}/3 for effect ${key}.`);
    this.saveTask(task);
    this.scheduleMission(task);
    return true;
  }

  /// Consumer delivery: run one claimed job to its resting state.
  /// Every non-retryable outcome answers 200 (ack); only a thrown
  /// run answers 500 so the queue retries and this object resumes
  /// the orphan through the existing checkpoint path.
  private async runMissionJob(body: any): Promise<Response> {
    const jobId = typeof body?.jobId === "string" ? body.jobId : "";
    const taskId = typeof body?.taskId === "string" ? body.taskId : "";
    if (!jobId || !taskId) return json({ error: "jobId and taskId required" }, 400);
    const existing = getMissionJob(this.ctx.storage, jobId);
    if (!existing || existing.taskId !== taskId) return json({ error: "unknown job" }, 404);
    if (isTerminalJobState(existing.state)) {
      return json({ ok: true, jobState: existing.state, duplicate: true });
    }
    const task = this.loadTask(taskId);
    if (!task) {
      finishMissionJob(this.ctx.storage, jobId, "failed", new Date().toISOString(), "task missing");
      return json({ ok: true, jobState: "failed" });
    }
    if (["succeeded", "failed", "rejected"].includes(String(task.status))) {
      finishMissionJob(this.ctx.storage, jobId, "done", new Date().toISOString());
      return json({ ok: true, jobState: "done", taskStatus: task.status });
    }
    claimMissionJob(this.ctx.storage, jobId, new Date().toISOString());
    let result: any;
    try {
      result = await this.runInteractiveTask(task, this.browser());
    } catch (e) {
      // Leave the job running: redelivery claims it again and the
      // mission resumes from its durable state. (Legacy failures
      // are already classified inside runInteractiveTaskInner and
      // return normally; a throw here is V2 or infrastructure.)
      const message = String((e as Error)?.message ?? e).slice(0, 300);
      // The queue consumer cancels the 500 body without reading it,
      // so without this line a failed start is invisible in
      // telemetry except for its status code.
      console.error(`MISSION_JOB_FAILED task=${taskId} job=${jobId} error=${message}`);
      return json({ error: message }, 500);
    }
    finishMissionJob(this.ctx.storage, jobId, "done", new Date().toISOString());
    // The job is finished, so a re-enqueue here mints a fresh job
    // (enqueueMissionJob returns the still-running job while this
    // one is open). A silent pause resumes on its own, within the
    // per-effect budget; any other resting state stays put.
    this.maybeAutoResume(result);
    return json({ ok: true, jobState: "done", taskStatus: result?.status ?? task.status });
  }

  /// Dead-letter arrival: the queue gave up. Close the job and, if
  /// the task is still stranded mid-run with nothing live, end it
  /// the way an interrupted run ends — visibly, with recovery help.
  private async deadMissionJob(body: any): Promise<Response> {
    const jobId = typeof body?.jobId === "string" ? body.jobId : "";
    const taskId = typeof body?.taskId === "string" ? body.taskId : "";
    if (!jobId || !taskId) return json({ error: "jobId and taskId required" }, 400);
    const existing = getMissionJob(this.ctx.storage, jobId);
    if (!existing || existing.taskId !== taskId) return json({ error: "unknown job" }, 404);
    if (existing.state === "done") return json({ ok:true,jobState:"done",duplicate:true });
    const latest=latestMissionJob(this.ctx.storage,taskId);
    if(latest&&latest.jobId!==jobId){
      finishMissionJob(this.ctx.storage,jobId,"failed",new Date().toISOString(),"superseded delivery exhausted");
      return json({ok:true,jobState:"failed",superseded:true});
    }
    const task = this.loadTask(taskId);
    if (task && workspaceMode(this.env.HYGGE_WORKSPACE_MODE) === "retained-v2") {
      // Canonical recovery is durable before the terminal queue acknowledgement.
      this.workspace().runner.deliveryFailed(task,jobId);
    }
    if (!isTerminalJobState(existing.state)) {
      finishMissionJob(this.ctx.storage, jobId, "failed", new Date().toISOString(), "delivery retries exhausted");
    }
    if (task && workspaceMode(this.env.HYGGE_WORKSPACE_MODE) === "legacy"
        && ["approved", "running"].includes(String(task.status))
        && !this.activeMissions.has(task.id)) {
      task.status = "failed";
      task.failure = { code: "job_delivery_exhausted" };
      task.help = help("recovery",
        "I couldn't get this started again after several tries. I can check where we left off in a new session, or you can stop here.",
        [], "Open new session", null, { staticText: true });
      const sessionID = task.session_id;
      task.session_id = null;
      task.pending_action = null;
      task.authorized_action = null; // uncertainty must never replay one-shot approval
      this.saveTask(task);
      if (sessionID) await this.browser().closeSession(sessionID).catch(() => {});
    }
    return json({ ok: true, jobState: "failed" });
  }

  private async resumeBrowser(sessionID: string) {
    const rows = [...this.ctx.storage.sql.exec("SELECT task FROM tasks")] as Row[];
    const task = rows.map(r => JSON.parse(String(r.task))).find(t => t.session_id === sessionID);
    if (!task) throw new Error("This session is not attached to active work.");
    if (task.help?.kind === "approval") throw new Error("Review this action in chat before continuing.");
    if (["succeeded", "rejected", "failed"].includes(task.status)) throw new Error("Return to chat to review this task.");
    if (this.browserResumes.has(task.id)) return;
    const previous = this.activeMissions.get(task.id);
    return () => {
      if (this.browserResumes.has(task.id)) return;
      this.browserResumes.add(task.id);
      this.ctx.waitUntil((async () => {
        // Called only after control release; wait out any stale model decision.
        await previous;
        const current = this.loadTask(task.id);
        if (!current || current.session_id !== sessionID || current.help?.kind === "approval"
            || !["needsHuman", "running", "approved"].includes(current.status)) return;
        if (this.browser().controlState(sessionID)?.human) return;
        current.help = null;
        current.pending_action = null;
        current.authorized_action = null;
        current.information_requests = [];
        current.status = "running";
        current.log.push("User handed back the browser; inspect the current page before continuing.");
        this.saveTask(current);
        // Durable submission from here: one active job per task
        // keeps a duplicate handback from double-dispatching.
        this.scheduleMission(current);
      })().finally(() => this.browserResumes.delete(task.id)));
    };
  }

  private async runInteractiveTaskInner(task: any, browser: UserBrowser) {
    try { return await this.runTask(task, browser); }
    catch(error) {
      // Canonical V2 recovery owns projection. A stale caller must never
      // replace a newer generation's result with an old failure response.
      if(workspaceMode(this.env.HYGGE_WORKSPACE_MODE)==='retained-v2')throw error;
      task.status = "failed";
      task.failure = classifyBrowserFailure(error);
      task.help = help("recovery", `${task.failure.userMessage} I can check where we left off in a new session, or you can stop here.`, [], "Open new session", null, { staticText: true });
      const sessionID = task.session_id;
      task.session_id = null;
      task.pending_action = null;
      if (sessionID) await browser.closeSession(sessionID).catch(() => {});
      task.authorized_action = null; // uncertainty must never replay one-shot approval
      this.saveTask(task);
      return task;
    }
  }

  private async runTask(task: any, browser: UserBrowser) {
    if (workspaceMode(this.env.HYGGE_WORKSPACE_MODE)==='retained-v2') {
      // A silent pause (needsHuman, no help) resumes exactly like a
      // running/approved task: the runner re-observes the pending
      // effect and continues. Without this the runner refuses the
      // resume and the task can never leave needsHuman.
      return this.workspace().run(task,(hooks,_runId,scopedTask)=>this.runTaskLegacy(scopedTask,browser,hooks),task.status==='running' || task.status==='approved' || (task.status==='needsHuman' && !task.help));
    }
    return this.runTaskLegacy(task,browser);
  }

  private async runTaskLegacy(task: any, browser: UserBrowser, workspaceHooks?: WorkspaceMissionHooks) {
    // The persisted running state claims the request; the runner receives its approved scope.
    task.status = "approved";
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
      const page = await browser.snapshot(sessionID);
      if (!page || domainOf(page.currentURLString) !== domain) throw new Error("credentials may only be entered on the approved site");
      if (!task.credential_id && task.kind === "signup" && task.drafted_payload?.setupMode !== "connect") {
        const username = task.drafted_payload?.email;
        if (!username) throw new Error("signup email is missing");
        // Reuse a concurrently saved credential; never overwrite an existing login.
        const existing = [...this.ctx.storage.sql.exec("SELECT id FROM credentials WHERE domain = ? LIMIT 1", domain)] as Row[];
        if (existing.length) task.credential_id = existing[0].id;
        else {
          const bytes = crypto.getRandomValues(new Uint8Array(24));
          const secret = "Hg9!" + Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
          const blob = await vault.seal(await this.dek(), secret, `${domain}\n${username}`);
          task.credential_id = crypto.randomUUID();
          this.ctx.storage.sql.exec("INSERT INTO credentials (id, domain, username, iv, ciphertext) VALUES (?, ?, ?, ?, ?)",
            task.credential_id, domain, username, blob.iv, blob.ciphertext);
        }
      }
      if (!task.credential_id) throw new Error("a saved login is required");
      const creds = [
        ...this.ctx.storage.sql.exec("SELECT * FROM credentials WHERE id = ?", task.credential_id),
      ] as Row[];
      if (!creds.length) throw new Error("unknown credential");
      const r = creds[0];
      if (r.domain !== domain) throw new Error("login belongs to a different site");
      const secret = await vault.open(
        await this.dek(),
        { iv: String(r.iv), ciphertext: String(r.ciphertext) },
        `${r.domain}\n${r.username}`,
      );
      await browser.act(sessionID, {
        action: "type",
        target,
        value: valueRef.endsWith("secret") ? secret : String(r.username),
        sensitive: valueRef.endsWith("secret"),
      });
    };

    // Brief 04: an emailed code for this domain is consumable
    // information for this run only. It is typed from the sealed
    // store and deleted by consumeEmailCode before use; the value
    // never enters prompts, logs, traces, or task JSON. Brief 05
    // seam: scheduled scans never see or spend a code — a check
    // during an unattended scan pauses for the person instead.
    this.pruneExpiredEmailCodes();
    const emailCodeAllowed = emailCodeAllowedForTask(task);
    const hasEmailCode = emailCodeAllowed && this.hasEmailCode(domain);
    const fillEmailCodeValue = async (target: string, sessionID: string) => {
      if (!emailCodeAllowed) throw new Error("emailed codes are not used during scheduled scans");
      const code = await this.consumeEmailCode(domain);
      if (!code) throw new Error("agent requested an emailed code but none is waiting");
      await browser.act(sessionID, { action: "type", target, value: code, sensitive: true });
      task.email_code_available = false;
    };

    const outcome = outcomeForTaskKind(task.kind);
    let activeSkill: SharedSkill | null = null;
    try { activeSkill = workspaceHooks ? task._workspace_skill ?? null : await this.skillRepo().loadActive(domain, outcome); }
    catch { task.log.push("Shared skill store unavailable — routing as no-skill (Wonder authoring)"); }
    const skillCandidate = workspaceHooks ? task._workspace_candidate ?? null : activeSkill ? null : this.loadSkillCandidate(domain, outcome);
    task.skill_id = activeSkill?.id ?? null;
    task.skill_version = activeSkill?.version ?? null;
    // Trusted sign-in: restore the saved profile for this domain when
    // trust is not known-unsupported ("unknown" means try and learn).
    const trust = this.trustSupport(domain);
    const restoreState = workspaceHooks || trust === "unsupported" ? null : await this.loadSessionState(domain);

    const photoStore = this.profilePhotoStore();
    const hasProfilePhoto = profilePhotoAllowedForTask(task) && photoStore.read() !== null;
    const uploadProfilePhoto = async (target: string, sessionID: string) => {
      if (!profilePhotoAllowedForTask(task)) throw new Error("profile photo requires an approved profile task");
      const photo = photoStore.read();
      if (!photo) throw new Error("profile photo is no longer available");
      await browser.uploadProfilePhoto(sessionID, target, photo.base64, task.target_url);
    };
    const decider = makeDecider(new LLMClient(this.llmConfig()));
    const result = await runMission({
      browser,
      task,
      workspaceHooks,
      traceAgentId: `hygge-${this.env.HYGGE_ENV}`,
      traceSessionId: this.ctx.id.toString(),
      traceSessionName: this.userId || undefined,
      tracePayloads: this.env.HYGGE_TRACE_PAYLOADS === "1",
      hints,
      decider,
      fillCredentialValue,
      fillEmailCodeValue,
      hasEmailCode,
      hasProfilePhoto,
      uploadProfilePhoto,
      hasCredential: Boolean(task.credential_id),
      skill: activeSkill,
      skillCandidate,
      onSession: (id: string) => {
        task.session_id = id;
        if(workspaceHooks){workspaceHooks.onSession?.(id);return;}
        const status = task.status;
        task.status = "running";
        this.saveTask(task);
        task.status = status;
      },
      existingSessionID: task.session_id ?? null,
      restoreState,
    });
    task.failure = result.failure ?? null;
    // Durable runner commits evidence, complete workspace/profile and task/UI
    // projection together. Legacy outcome/promotions never run on this path.
    if (workspaceHooks) return result;
    task.help = result.help ?? (result.status === "failed"
      ? help("recovery", "I couldn't finish this step after trying another route. We can check the site before trying again.", [], "Try again", null, { staticText: true }) : null);
    task.pending_action = result.pendingAction ?? null;
    task.checkpoint = result.checkpoint ?? null;
    task.information_requests = result.informationRequests ?? [];
    task.browser_trace = result.trace;
    task.extracted_items = result.extractedItems;
    task.session_id = result.sessionID;
    task.log.push(...result.log);
    task.status = result.status === "needs_human" || result.status === "needs_info" ? "needsHuman" : result.status;
    if (result.informationRequests?.length) {
      task.information_requests = result.informationRequests;
      task.log.push("The agent needs information only you can provide — reply in chat to continue.");
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
    if (browser.controlState(result.sessionID)?.human) {
      task.status = "needsHuman";
      if (task.help?.kind !== "approval") {
        task.help = help("verification", "You’re in control. Let me know when I can continue.", [], "Continue in browser", null, { staticText: true });
      }
    } else if (result.status !== "needs_human" && result.status !== "needs_info") {
      await browser.closeSession(result.sessionID).catch(() => {});
      task.session_id = null;
    }
    this.saveTask(task);
    // Brief 05: a mission that succeeded proves the sign-in works
    // again — end any scheduled-scan login-failure episode here.
    if (result.status === "succeeded") this.healScanEpisodes(domain);
    // Brief 07 trigger #1 (the decision-help push) lives in
    // saveTask above, not here: saveTask owns the fresh-transition
    // check against the stored row, so the push fires on both the
    // legacy path and retained-v2 (which persists through
    // saveTask). Scan missions never notify here either — their
    // episodes stay in the feed, and a tick's only push is the
    // new-work chat message.
    return task;
  }

  // ---- scheduled scanning (Brief 05) --------------------------------
  // A scan is an ordinary discover mission through runTask (same
  // skills routing, trusted sign-in restore + probe, checkpoint
  // guard, vault-only credential fill). It is created directly in
  // "approved" state because discover is not a write kind
  // (requiresApprovalForKind is false) — the scan can only read.
  // The mission text forbids write actions, and scan.ts has no
  // write-task path at all: surfacing a listing never applies.

  private async runScanMission(
    input: ScanMissionInput, browser: UserBrowser,
  ): Promise<ScanMissionOutcome> {
    const { site, tier, credentialId, profile } = input;
    const focus = [
      profile.skills.length ? `Skills: ${profile.skills.join(", ")}.` : "",
      profile.interests.length ? `Kinds of work: ${profile.interests.join(", ")}.` : "",
      profile.customInterests?.length ? `Also enjoys: ${profile.customInterests.join(", ")}.` : "",
      profile.locationLabel ? `Based in ${profile.locationLabel}.` : "",
    ].filter(Boolean).join(" ");
    const task = {
      id: crypto.randomUUID(),
      kind: "discover",
      target_url: site.startURLString,
      goal: `Find new paid work listings on ${site.name} that fit this person. ${focus} Read the listings and extract each one with its title, pay, and place. Only read: do not apply, do not sign up, do not send any message, and do not book anything.${tier === "public" ? " Browse only what is visible without signing in; do not try to sign in." : ""}`,
      title: `Scheduled look at ${site.name}`,
      drafted_payload: { searchTerms: [...profile.skills, ...(profile.customInterests ?? [])].join(", ") },
      credential_id: tier === "logged" ? credentialId : null,
      requires_approval: false,
      status: "approved",
      scheduled_scan: true,
      scan_tier: tier,
      memory_id: null,
      session_id: null,
      browser_trace: [] as any[],
      extracted_items: [] as string[],
      information_requests: [] as string[],
      log: [`Scheduled scan on ${site.name} (${tier === "logged" ? "signed-in look" : "public listings only"}). Reading only — nothing will be sent, booked, or applied for.`],
    };
    (task as any).interaction_version = 1;
    (task as any).mobile_task = {
      id: task.id, kind: task.kind, siteID: site.siteID, targetURLString: task.target_url,
      goal: task.goal, title: task.title, draftedPayload: task.drafted_payload,
      browserTrace: [], informationRequests: [], status: "approved", log: [],
      createdAt: Date.now() / 1000 - 978307200,
    };
    this.saveTask(task);
    const done = await this.runTask(task, browser);
    const traceText = [
      ...(done.log ?? []),
      ...(done.browser_trace ?? []).map((t: any) => String(t.summary ?? "")),
    ].join("\n");
    const needsHuman = done.status === "needsHuman";
    // Brief 06: a mobile-app wall is its own signal (not the generic
    // human-check path) and triggers a catalog re-probe in scan.ts.
    const appWall = /continue in (the )?app|open in the app|download (our|the) app|only in (the|our) app|app[- ]only|use our app to/i.test(traceText);
    // An expired trusted sign-in logs "had expired" and falls back
    // to the saved login inside the mission; if the mission still
    // fails on sign-in, the saved login itself is the problem.
    const loginFailure = tier === "logged" && !needsHuman && done.status !== "succeeded"
      && /had expired|incorrect|invalid|wrong password|login failed|sign[- ]in failed|could not sign in|not recognized/i.test(traceText);
    const skillLine = (done.log ?? []).find((l: string) => l.startsWith("skill_id=")) ?? null;
    return {
      status: done.status === "succeeded" ? "succeeded" : needsHuman ? "needs_human" : "failed",
      items: Array.isArray(done.extracted_items) ? done.extracted_items : [],
      loginFailure,
      needsHuman,
      appWall,
      skillPath: skillLine,
      taskId: done.id,
      errorReason: done.status === "succeeded" ? null
        : needsHuman ? "site asked for a human-only check"
        : loginFailure ? "saved login was rejected"
        : "scan did not finish",
    };
  }

  // ---- Brief 06 web-access catalog (D1, fleet-level, no user data) --

  // Catalog errors (e.g. migration 0005 not applied yet) throw on
  // purpose: callers fail closed (unknownBlocked) instead of
  // mistaking them for a fresh unknown site with a free cycle.
  private async siteAccessRecord(domain: string): Promise<SiteAccessRecord | null> {
    const row = await this.env.DB.prepare(
      "SELECT host, display_name, web_accessible, probed_at, probe_evidence, unknown_cycles_used, app_wall_strikes FROM site_catalog WHERE host = ?1",
    ).bind(domain).first<Row>();
    if (!row) return null;
    const v = String(row.web_accessible ?? "unknown");
    return {
      domain: String(row.host),
      displayName: row.display_name ? String(row.display_name) : null,
      webAccessible: v === "true" || v === "false" ? v : "unknown",
      probedAt: row.probed_at ? String(row.probed_at) : null,
      probeEvidence: row.probe_evidence ? String(row.probe_evidence) : null,
      unknownCyclesUsed: Number(row.unknown_cycles_used ?? 0),
      appWallStrikes: Number(row.app_wall_strikes ?? 0),
    };
  }

  private async saveSiteAccessRecord(rec: SiteAccessRecord): Promise<void> {
    // display_name is seeded from the domain, never a user-typed
    // site name: this catalog is fleet-level and holds no user data.
    await this.env.DB.prepare(
      `INSERT INTO site_catalog (host, display_name, web_accessible, probed_at, probe_evidence, unknown_cycles_used, app_wall_strikes, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now'))
       ON CONFLICT(host) DO UPDATE SET web_accessible = excluded.web_accessible,
         probed_at = excluded.probed_at, probe_evidence = excluded.probe_evidence,
         unknown_cycles_used = excluded.unknown_cycles_used,
         app_wall_strikes = excluded.app_wall_strikes, updated_at = datetime('now')`,
    ).bind(rec.domain, rec.displayName ?? rec.domain, rec.webAccessible,
      rec.probedAt, rec.probeEvidence, rec.unknownCyclesUsed, rec.appWallStrikes).run();
  }

  /// Withdraw open proposals whose site is proven web-ineligible.
  /// Runs on app state pushes: onboarding-generated suggestions are
  /// created on-device without catalog access, so this server-side
  /// sweep is where "ineligible is never proposed" is enforced for
  /// them. Verdicts are only read here — probing stays in the
  /// scheduled-scan and backend-proposal paths.
  private async sweepIneligibleProposals(store: StateStore): Promise<void> {
    const sites = new Map<string, ScanSite>();
    for (const row of store.list("sites")) {
      const site = scanSiteFromRow(row.id, row.data);
      if (site) sites.set(normalizeId(site.siteID), site);
    }
    if (!sites.size || !store.list("proposals").length) return;
    const checked = new Set<string>();
    const nowIso = new Date().toISOString();
    for (const row of store.list("proposals")) {
      const site = sites.get(normalizeId((row.data as Record<string, unknown>)?.siteID ?? (row.data as Record<string, unknown>)?.siteId));
      if (!site || checked.has(site.domain)) continue;
      checked.add(site.domain);
      let rec: SiteAccessRecord | null = null;
      try { rec = await this.siteAccessRecord(site.domain); } catch { continue; }
      if (rec?.webAccessible === "false") {
        withdrawProposalsForSite(store, { siteID: site.siteID, name: site.name },
          rec.probeEvidence ?? "This site can only be used in its phone app.",
          nowIso, () => crypto.randomUUID());
      }
    }
  }

  /// The probe reuses the ordinary discover mission path on desktop
  /// web and only reads: it checks that signup (page + form), profile
  /// editing, and starting an application are reachable without a
  /// phone app. It never submits, signs up, or applies.
  private async runWebProbe(input: ProbeMissionInput, browser: UserBrowser): Promise<ProbeOutcome> {
    const site: ScanSite = input.site;
    const task = {
      id: crypto.randomUUID(),
      kind: "discover",
      target_url: site.startURLString,
      goal: `Check whether ${site.name} fully works in a desktop web browser. Look for: (1) a signup page you can open, (2) a signup form on it, (3) a way to reach profile editing (a sign-in page on the way is fine), and (4) a way to start applying for work. If any step says to continue in a phone app with no web alternative, extract exactly that text. Extract one JSON object like {"signupReachable":true,"signupFormPresent":true,"profileEditReachable":true,"applyStartable":true,"appWallText":""}. Only look: do not sign up, do not submit any form, do not apply, do not send anything.`,
      title: `Web check for ${site.name}`,
      drafted_payload: {},
      credential_id: null,
      requires_approval: false,
      status: "approved",
      web_probe: true,
      memory_id: null,
      session_id: null,
      browser_trace: [] as any[],
      extracted_items: [] as string[],
      information_requests: [] as string[],
      log: [`Web check on ${site.name}: looking only — nothing will be sent or submitted.`],
    };
    this.saveTask(task);
    // Direct homepage snapshot first: judge evidence must include
    // what the page actually offers, not only the agent's step
    // intentions (missions can loop or pause before extracting).
    let homepageEvidence = "";
    // V2 browsing goes through the same anchored mission/effect queue.
    // The legacy preliminary probe must not create a second writer.
    if(workspaceMode(this.env.HYGGE_WORKSPACE_MODE)==='legacy') {
    try {
      const snap = await browser.createSession(site.startURLString);
      const parts = [snapshotEvidence(snap)];
      // One generic step deeper: follow a signup/join element so
      // the judge can see whether a real form exists. Label-based
      // and site-agnostic; anything found is evidence, and a failed
      // click simply leaves the homepage snapshot as the evidence.
      const signupEl = snap.elements.find(
        (e) => e.kind === "click" && /sign up|join|register|create account|get started|become a/i.test(e.label));
      if (signupEl) {
        try {
          await browser.act(snap.sessionID, { action: "click", target: signupEl.label });
          await new Promise((r) => setTimeout(r, 1500));
          const after = await browser.snapshot(snap.sessionID);
          if (after) parts.push(snapshotEvidence(after));
        } catch { /* homepage evidence only */ }
      }
      homepageEvidence = parts.filter(Boolean).join("\n");
      await browser.closeSession(snap.sessionID).catch(() => {});
    } catch { /* mission evidence only */ }
    }
    const done = await this.runTask(task, browser);
    const items: string[] = Array.isArray(done.extracted_items) ? done.extracted_items : [];
    let finalEvidence = "";
    if (done.session_id && browser.hasSession(done.session_id)) {
      try {
        finalEvidence = snapshotEvidence(await browser.snapshot(done.session_id));
      } catch { /* session gone: mission evidence only */ }
    }
    const text = [homepageEvidence, finalEvidence, ...(done.log ?? []), ...items,
      ...(done.browser_trace ?? []).map((t: any) => String(t.summary ?? ""))].filter(Boolean).join("\n");
    let appWall = /continue in (the )?app|open in the app|download (our|the) app|only in (the|our) app|app[- ]only|use our app to/i.test(text);
    let checks: ProbeOutcome["checks"] = extractProbeChecks(text);
    if (!checks && !appWall && text.trim()) {
      // The exploring mission rarely emits the checks JSON itself
      // (live probes stayed undecided 3/3 that way), so a judge
      // reads the collected evidence and answers the four checks.
      // A thin or failed visit yields "undecided", never a guess.
      try {
        const client = new LLMClient(this.llmConfig());
        if (client.configured) {
          const reply = await client.complete({
            model: client.cfg.modelFast,
            system: "Reply with ONLY a JSON object, no prose.",
            user: probeJudgePrompt(site.name, text),
          });
          const verdict = parseProbeJudgeReply(String(reply));
          if (verdict) {
            checks = verdict.checks;
            appWall = appWall || verdict.appWall;
            done.log.push(`Web check judging: signup=${checks.signupReachable} form=${checks.signupFormPresent} profile=${checks.profileEditReachable} apply=${checks.applyStartable} appWall=${appWall}`);
          } else {
            done.log.push("Web check judging: evidence too thin to decide");
          }
          this.saveTask(done);
        }
      } catch {
        done.log.push("Web check judging: judge unavailable");
        this.saveTask(done);
      }
    }
    const missionStatus = done.status === "succeeded" ? "succeeded" : done.status === "needsHuman" ? "needs_human" : "failed";
    return {
      // A judge verdict IS the probe result: a mission that looped
      // after gathering enough evidence must not void it, and a
      // CAPTCHA on the signup page does not make a site app-only —
      // the checks ask what the web offers (a person can finish
      // the check during the real signup), not what the agent can
      // complete unattended. Thin evidence still judges undecided.
      status: checks ? "succeeded" : missionStatus,
      appWall, checks,
      // With checks decided, let applyProbeOutcome phrase the
      // evidence (it names exactly which checks failed).
      evidence: appWall ? "A key step can only be done in the site's phone app."
        : checks ? null
        : "The web check could not finish, so nothing was decided yet.",
    };
  }

  private refreshLearning(store: StateStore) {
    try { ensureLearningProfile(store, new Date().toISOString()); }
    catch { /* learning upkeep must never fail a state write */ }
  }

  private scanDeps(browser: UserBrowser): ScanDeps {
    return {
      state: this.stateStore(),
      scans: this.scanStore(),
      credentialIdForDomain: (domain) => {
        const rows = [
          ...this.ctx.storage.sql.exec("SELECT id FROM credentials WHERE domain = ? LIMIT 1", domain),
        ] as Row[];
        return rows.length ? String(rows[0].id) : null;
      },
      sessionHealthForDomain: (domain) => {
        const row = this.profileRow(domain);
        if (!row) return null;
        return {
          domain,
          trustSupport: this.trustSupport(domain),
          hasProfile: Boolean(Number(row.has_profile ?? 0)),
        };
      },
      planTier: () => this.userId
        ? activeTier(d1SubscriptionDb(this.env.DB), this.userId, new Date())
        : ("free" as const),
      runDiscoverMission: (input) => this.runScanMission(input, browser),
      siteAccessForDomain: (domain) => this.siteAccessRecord(domain),
      saveSiteAccess: (record) => this.saveSiteAccessRecord(record),
      runProbeMission: (input) => this.runWebProbe(input, browser),
      idFactory: () => crypto.randomUUID(),
      // The tick's one chat message is composed by the model from
      // the listing facts (chat-composer.ts) — never a canned
      // string. No model configured means no message and no push.
      // A composition failure is reported (not just logged) so a
      // model outage silently killing new-work notifications is
      // detectable server-side.
      composeOfferMessage: async (input) => {
        const composer = this.cardComposer();
        if (!composer) {
          this.reportComposerFailure("offer", "model_unconfigured");
          return null;
        }
        const text = await composer({
          surface: "offer",
          facts: {
            site: input.siteName,
            listing: input.title,
            pay: input.payLabel,
            place: input.isRemote ? "Remote" : input.locationLabel,
            ...(input.moreCount > 0 ? { moreListings: String(input.moreCount) } : {}),
          },
          recentChat: input.recentChat,
        });
        if (!text) this.reportComposerFailure("offer", "compose_failed");
        return text;
      },
      log: (message) => {
        this.ctx.storage.sql.exec(
          "INSERT INTO events (kind, payload) VALUES (?, ?)",
          "scheduled-scan", JSON.stringify({ message }),
        );
      },
    };
  }

  /// Proposals call site of the one ranker (Brief 06): candidates are
  /// probe-checked for web eligibility by domain, ineligible and
  /// spent-unknown sites are never proposed, and the survivors are
  /// ordered by learning.ts rankItem — the same function scan
  /// surfacing uses. Proposing never signs anyone up.
  private async proposeSites(body: any) {
    const { category = "petCare", locationLabel = "", interests = [] } = body ?? {};
    const fallback = STATIC_PROPOSALS[String(category)] ?? [];
    let candidates = fallback;
    const client = new LLMClient(this.llmConfig());
    if (client.configured) {
      try {
        const text = await client.complete({
          model: client.cfg.modelFast,
          system: "Reply with ONLY a JSON array, no prose.",
          user: `List up to 6 real, currently operating websites where someone ${locationLabel ? `based in ${locationLabel} ` : ""}can sign up to earn money in category "${category}" (interests: ${(interests as string[]).join(", ") || category}). Each item: {"name":"...","url":"https://...","rationale":"one clause why this site suits them"}. Only real sites with correct URLs.`,
        });
        const match = String(text).match(/\[[\s\S]*\]/);
        const parsed = match ? JSON.parse(match[0]) : null;
        const valid = (parsed ?? []).filter((x: any) => x?.name && /^https:\/\//.test(x?.url ?? ""));
        if (valid.length) candidates = valid.slice(0, 6);
      } catch { /* fall through to the static candidates */ }
    }

    const store = this.stateStore();
    const { profile } = extractProfile(store.get("profile", PROFILE_ROW_ID)?.data);
    const learning = ensureLearningProfile(store, new Date().toISOString());
    const now = new Date();
    const eligibility = new Map<string, Eligibility>();
    for (const c of candidates) {
      const domain = domainOfUrl(c.url);
      // Fail closed per candidate: any catalog read/write failure
      // blocks this suggestion instead of minting a fresh unknown.
      let verdict: Eligibility = "unknownBlocked";
      try {
        let rec = (await this.siteAccessRecord(domain)) ?? unknownAccessRecord(domain);
        if (reprobeDue(rec, now)) {
          const site: ScanSite = {
            id: domain, siteID: domain, name: c.name,
            startURLString: c.url, domain, category: String(category),
          };
          let outcome: ProbeOutcome;
          try {
            outcome = await this.runWebProbe({ site, profile }, this.browser());
          } catch (e) {
            outcome = { status: "failed", evidence: String((e as Error)?.message ?? e).slice(0, 200) };
          }
          rec = applyProbeOutcome(rec, outcome, now.toISOString());
          await this.saveSiteAccessRecord(rec);
        }
        verdict = eligibilityOf(rec, domain);
        if (verdict === "unknownAllowed") {
          await this.saveSiteAccessRecord(consumeUnknownCycle(rec));
        }
      } catch { /* catalog unavailable: verdict stays unknownBlocked */ }
      eligibility.set(domain, verdict);
    }
    const ranked = rankSiteProposals(
      candidates.map((c) => ({ ...c, category: String(category) })),
      profile, learning, eligibility, domainOfUrl, now,
    );
    // The score rides along (as scan payloads stamp rankScore) so
    // the app's feed order survives state sync, whose lists order
    // by updated_at — response order alone would be lost.
    return ranked.map((r) => ({
      name: r.candidate.name, url: r.candidate.url, rationale: r.candidate.rationale,
      rankScore: r.rank.score,
    }));
  }

  // ---- routes ---------------------------------------------------

  private chatQueue: Promise<unknown> = Promise.resolve();
  private conversationStore?:ChatStore;
  private chatStore() { return this.conversationStore ??= new ChatStore(sqlChatStorage(this.ctx.storage)); }
  private chatAgent() {
    const store=this.chatStore(), state=this.stateStore();
    const services=chatServices({
      rows:entity=>state.list(entity), get:(entity,id)=>state.get(entity,id),
      put:(entity,id,data)=>{const before=entity==='profile'||entity==='sites'?this.reopenSnapshot(state):null;state.upsert(entity,id,data);if(before)this.applyCategoryReopen(before,state);},remove:(entity,id)=>{state.remove(entity,id);},
      tasks:()=>[...this.ctx.storage.sql.exec('SELECT task FROM tasks ORDER BY created_at')].map(r=>this.executionView(JSON.parse(String(r.task)))),
      saveTask:task=>this.saveTask(task),enqueue:task=>this.enqueueOrRunMission(task),
      hints:domain=>[...this.ctx.storage.sql.exec('SELECT kind,hints,success_count,failure_count FROM memories WHERE domain=?',domain)].map(r=>({...r,hints:JSON.parse(String(r.hints))})),
      inbox:()=>[...this.ctx.storage.sql.exec("SELECT id,sender_domain,subject,summary,kind,created_at FROM email_summaries WHERE kind='other' ORDER BY created_at DESC LIMIT 30")],
      signupContact:async()=>{const address=this.userId?await addressForUser(d1EmailAddressDb(this.env.DB),this.userId,this.env.HYGGE_EMAIL_DOMAIN):null;return address?{email:address.address,choice:'hygge'}:{email:String((state.get('profile','profile')?.data as any)?.profile?.email??''),choice:'own'};},
      credentialForDomain:domain=>{const r=[...this.ctx.storage.sql.exec('SELECT id FROM credentials WHERE domain=? LIMIT 1',domain)][0];return r?String(r.id):undefined;},
      plus:async()=>!!this.userId && (await activeTier(d1SubscriptionDb(this.env.DB),this.userId,new Date()))==='plus',
      mirror:async(doc:ChatDocument)=>{await this.workspace().saveDocument(`${doc.generation}/${doc.path}`,doc.revision,new TextEncoder().encode(doc.content));},
      erase:async(doc:ChatDocument)=>{await this.workspace().eraseDocument(`${doc.generation}/${doc.path}`,doc.revision);},
      deletedMessage:id=>Boolean(store.db.get(`deleted-message:${id}`)),
      // Every agent reply in the conversation pushes (policy Nov 5,
      // 2026: every chat message generates a push — no exceptions).
      // The body is the reply's own words; the tap opens the reply.
      // No foreground exception here: the app suppresses pushes
      // while open, so the server must not build a second one.
      notifyChatMessage:(event)=>{this.schedulePush([chatMessageEvent(event.id,String(event.value))]);},
    });
    return new ChatAgent(store,new LLMClient(this.llmConfig('hygge-conversation')),services);
  }
  private cleanupTask?:Promise<void>;
  private scheduleChatCleanup() {
    if(this.cleanupTask)return;
    if(this.workspaceExecution?.imageUpgrade.locked()){void this.ctx.storage.setAlarm(Date.now()+300_000);return;}
    this.cleanupTask=(async()=>{
      const agent=this.chatAgent();await agent.cleanup();
      if(agent.store.state().cleanupPending)await this.ctx.storage.setAlarm(Date.now()+300_000);
    })().finally(()=>{this.cleanupTask=undefined;});
    this.ctx.waitUntil(this.cleanupTask);
  }
  async alarm() {
    const row=[...this.ctx.storage.sql.exec('SELECT user_id FROM workspace_owner WHERE id=1')][0];
    if(!row)return;this.userId=String(row.user_id);
    if(workspaceMode(this.env.HYGGE_WORKSPACE_MODE)==='retained-v2'&&this.workspace().imageUpgrade.locked()){await this.ctx.storage.setAlarm(Date.now()+300_000);return;}
    if(this.cleanupTask)await this.cleanupTask;
    else await this.chatExclusive(()=>this.chatAgent().cleanup());
    if(this.chatStore().state().cleanupPending)await this.ctx.storage.setAlarm(Date.now()+3600_000);
  }
  private async chatExclusive<T>(work:()=>Promise<T>):Promise<T> {
    this.ownerChatWork++;
    const before=this.chatQueue;let release!:()=>void;this.chatQueue=new Promise<void>(r=>{release=r;});
    await before;try{return await work();}finally{release();this.ownerChatWork--;}
  }

  private profilePhotoStore(): ProfilePhotoStore {
    const sql = this.ctx.storage.sql;
    return {
      read: () => {
        const rows = [...sql.exec("SELECT value FROM profile_photo WHERE id = 1")];
        return rows.length ? JSON.parse(String(rows[0].value)) as ProfilePhoto : null;
      },
      write: (photo) => { sql.exec("INSERT INTO profile_photo (id, value) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value", JSON.stringify(photo)); },
      remove: () => { sql.exec("DELETE FROM profile_photo WHERE id = 1"); },
    };
  }

  async fetch(request:Request):Promise<Response>{
    this.ownerRequests++;try{return await this.handleOwnerRequest(request);}finally{this.ownerRequests--;}
  }
  private async handleOwnerRequest(request: Request): Promise<Response> {
    const verifiedUser = request.headers.get('x-hygge-user-id');
    if (!verifiedUser) return json({error:'Verified owner required'},403);
    // Account deletion runs before owner binding, schema migration, and
    // the image-upgrade lock: deleting must work even when the workspace
    // is broken or an upgrade is pending.
    if (request.method === 'POST' && new URL(request.url).pathname === '/internal/account/delete') {
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      return json({ ok: true });
    }
    try {
      const owner = bindWorkspaceOwner(this.ctx.storage, verifiedUser, this.env.HYGGE_ENV, this.ctx.id.toString());
      this.userId = owner.userId;
      workspaceMode(this.env.HYGGE_WORKSPACE_MODE);
      await (this.schemaReady ??= migrateCredentialSchema(this.ctx.storage, {
        verifyCurrentCiphertext: async row => {
          try { await vault.open(await this.dek(), row, `${row.domain}\n${row.username}`); return true; } catch { return false; }
        },
        // Historical site_id/AAD mappings need an explicit reviewed adapter.
        resolveLegacy: async () => null,
      }).catch(error => { this.schemaReady = null; throw error; }));
    } catch { return json({error:'Workspace identity, schema, or encryption key needs verified recovery'},409); }
    const url = new URL(request.url);
    const path = url.pathname;
    const parts = path.split("/").filter(Boolean);
    if(workspaceMode(this.env.HYGGE_WORKSPACE_MODE)==='retained-v2'&&path!=='/sandbox/image-upgrade'&&this.workspace().imageUpgrade.locked())return json({error:'Workspace image upgrade is pending'},409);
    // Handle the bounded binary body before the generic JSON parser.
    if (path === "/profile/photo") return handleProfilePhoto(request, this.profilePhotoStore());
    let body:any={};
    if(request.method!=='GET'&&request.method!=='DELETE'){
      if(parts[0]==='chat'){
        const raw=await request.text();if(raw.length>128000)return json({error:'Conversation request too large'},413);
        try{body=JSON.parse(raw);}catch{return json({error:'Invalid conversation request'},400);}
        if(!body||typeof body!=='object'||Array.isArray(body))return json({error:'Invalid conversation request'},400);
      }else body=await request.json().catch(()=>({}));
    }

    try {
      // New clients use one reasoning/tool loop. Legacy intent/onboarding routes remain isolated.
      if(parts[0]==='chat') {
        const agent=this.chatAgent();
        if(request.method==='GET'&&parts[1]==='state') {
          return json(await this.chatExclusive(async()=>{agent.importMessages();this.scheduleChatCleanup();return agent.store.state();}));
        }
        if(request.method==='POST'&&parts[1]==='reset'){const result=await this.chatExclusive(()=>agent.reset(String(body.generation??'')));this.scheduleChatCleanup();return json(result);}
        if(request.method==='POST'&&parts[1]==='device-claim')return json(await this.chatExclusive(async()=>agent.claimDevice({generation:String(body.generation??''),proposalId:String(body.proposalId??''),deviceID:String(body.deviceID??'')})));
        if(request.method==='POST'&&parts[1]==='device-result'){
          if(typeof body.success!=='boolean'||typeof body.id!=='string'||!/^[0-9a-f-]{36}$/i.test(body.id))return json({error:'Invalid device result'},400);
          return json(await this.chatExclusive(()=>agent.deviceResult({id:body.id,generation:String(body.generation??''),proposalId:String(body.proposalId??''),success:body.success,deviceID:String(body.deviceID??'')})));
        }
        if(request.method==='POST'&&parts[1]==='proposals'&&parts[2]){
          if(!['approve','reject'].includes(body.decision)||typeof body.id!=='string'||!/^[0-9a-f-]{36}$/i.test(body.id))return json({error:'Invalid decision'},400);
          return json(await this.chatExclusive(()=>agent.decide({id:body.id,generation:String(body.generation??''),proposalId:parts[2],decision:body.decision})));
        }
        if(request.method==='POST'&&parts[1]==='turn'){
          if(request.headers.get('Accept')?.includes('text/event-stream')){
            const {readable,writable}=new TransformStream();const writer=writable.getWriter(),encoder=new TextEncoder();
            let detached=false;const emit=(event:any)=>{if(!detached)void writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)).catch(()=>{detached=true;});};
            this.ctx.waitUntil(this.chatExclusive(async()=>{
              try{const result=await agent.turn(body,emit);emit({type:'final',data:result});}
              catch{emit({type:'error',message:'The turn was interrupted. Its progress is saved; retry the same message.'});}
              finally{await writer.close().catch(()=>{});this.scheduleChatCleanup();}
            }));
            return new Response(readable,{headers:{'content-type':'text/event-stream','cache-control':'no-cache'}});
          }
          return json(await this.chatExclusive(()=>agent.turn(body)));
        }
        return json({error:'Unknown conversation operation'},404);
      }

      // Explicit authenticated owner maintenance; never a model tool and never
      // accepts owner IDs, proof objects or scopes. Fixtures remain staging-only.
      if(path==='/sandbox/image-upgrade/fixture'){
        if(this.env.HYGGE_ENV!=='staging'||!this.env.HYGGE_WORKSPACE_IMAGE_TRANSITIONS)return json({error:'Not enabled'},404);
        if(request.method!=='POST'||body.reviewed!==true||typeof body.action!=='string'||typeof body.marker!=='string')return json({error:'Reviewed fixture required'},400);
        return json(await this.workspace().imageUpgradeFixture(body.action,body.marker));
      }
      if(path==='/sandbox/image-upgrade'){
        if(!imageReleaseEnabled(this.env)||!this.env.HYGGE_WORKSPACE_IMAGE_TRANSITIONS)return json({error:'Image upgrade is not enabled'},404);
        if(request.method==='GET')return json(await this.workspace().imageUpgrade.status());
        if(request.method==='POST'){
          if(body.reviewed!==true||typeof body.operationId!=='string')return json({error:'Explicit reviewed operation is required'},400);
          if(body.action==='abort')return json(await this.workspace().imageUpgrade.abort(body.operationId));
          if(typeof body.targetImage!=='string'||!Number.isSafeInteger(body.expectedGeneration))return json({error:'Exact target image and generation are required'},400);
          const work=this.workspace().imageUpgrade.run({operationId:body.operationId,expectedGeneration:body.expectedGeneration,targetImage:body.targetImage});
          this.ctx.waitUntil(work.catch(()=>{}));return json(await work);
        }
        return json({error:'Method not allowed'},405);
      }

      // Sandbox diagnostics
      if (path.endsWith("/sandbox/verify")) {
        if (workspaceMode(this.env.HYGGE_WORKSPACE_MODE)==='retained-v2') {
          await this.workspace().ensure();
          return json({ok:true,mode:'retained-v2'});
        }
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
        if (workspaceMode(this.env.HYGGE_WORKSPACE_MODE)==='retained-v2') {
          const receipt=await this.workspace().save();
          return json({ok:true,receiptId:receipt.receiptId,committedAt:receipt.committedAt});
        }
        return await this.exclusive(async () => {
          const container = await this.startSandbox();
          const snapshot = await container.snapshotContainer({ name: "workspace" });
          await this.ctx.storage.put("snapshotId", snapshot.id);
          await container.destroy();
          return json({ ok: true, snapshotId: snapshot.id, size: snapshot.size });
        });
      }
      // Read-only workspace diagnostics for the owner. No mutation, no
      // dispatch, no retry: it reports the live gate state (container
      // frozen/held, unresolved effects, admission, binding/lease) so a
      // wedged workspace can be seen instead of inferred from telemetry.
      if (path.endsWith("/sandbox/diagnostics")) {
        if (workspaceMode(this.env.HYGGE_WORKSPACE_MODE)!=='retained-v2') return json({error:'retained-v2 required'},409);
        if (request.method!=='GET') return json({error:'Method not allowed'},405);
        return json(await this.workspace().diagnostics());
      }
      // Workspace keepalive: starts the workspace when the app opens
      // (rebinding a dead container from its checkpoint) and renews the
      // container lease while the app is foregrounded. Best-effort: the app
      // calls it on becoming active and about every 60s; a failure never
      // blocks the UI, and the mission path retries the same start.
      if (path.endsWith("/sandbox/keepalive")) {
        if (workspaceMode(this.env.HYGGE_WORKSPACE_MODE)!=='retained-v2') return json({error:'retained-v2 required'},409);
        if (request.method!=='POST') return json({error:'Method not allowed'},405);
        return json(await this.workspace().keepalive());
      }

      // Brief 04 inbox (receive only). Inbound accepts only the
      // Email Worker delivery marker; reads are this user's filed
      // summaries and code METADATA — a code itself never leaves
      // through any API. There is no send/reply route.
      if (request.method === "POST" && parts.join("/") === "email/inbound") {
        if (request.headers.get("x-hygge-email-delivery") !== "1") {
          return json({ error: "not found", path }, 404);
        }
        if (!body?.summary || typeof body.receivedAt !== "string"
            || !["verification", "security_code", "other"].includes(String(body.kind))) {
          return json({ error: "malformed delivery" }, 400);
        }
        return json(await this.handleEmailInbound(body as InboundEmailDelivery), 201);
      }

      // Durable mission jobs: only the queue consumer may deliver
      // work here (server-side marker, stripped from outside
      // requests in index.ts — same trust pattern as mail delivery
      // and the scan sweep). The ids in the body were minted by
      // this object at submission time; nothing here trusts them
      // beyond looking up its own ledger and task rows.
      if (request.method === "POST" && parts.join("/") === "internal/jobs/run") {
        if (request.headers.get("x-hygge-job-consumer") !== "1") {
          return json({ error: "not found", path }, 404);
        }
        return this.runMissionJob(body);
      }
      if (request.method === "POST" && parts.join("/") === "internal/jobs/dead") {
        if (request.headers.get("x-hygge-job-consumer") !== "1") {
          return json({ error: "not found", path }, 404);
        }
        return this.deadMissionJob(body);
      }
      if (parts[0] === "email" && parts[1] === "addresses") {
        const addresses = new EmailOwnerAddresses(this.ctx.storage.sql);
        const account = await accountEmailAddresses(this.env.DB, this.userId!);
        if (request.method === "GET") {
          return json({ addresses: [...account.map(address => ({ address, verified: true, source: "account" })),
            ...addresses.list().filter(r => !account.includes(r.address))] });
        }
        if (request.method === "POST" && parts.length === 2) {
          const address = normalizeOwnEmail(body?.address);
          if (!address) return json({ error: "Enter a valid email address." }, 400);
          if (account.includes(address)) return json({ address, verified: true, source: "account" });
          try { return json(await addresses.add(address), 201); }
          catch (e) { return json({ error: (e as Error).message }, 400); }
        }
        if (request.method === "DELETE" && parts.length === 2) {
          const address = normalizeOwnEmail(url.searchParams.get("address"));
          if (!address || account.includes(address)) return json({ error: "Account addresses are managed in your login settings." }, 400);
          addresses.remove(address);
          return json({ removed: true });
        }
      }
      if (parts[0] === "email" && parts[1] === "messages" && parts.length === 4) {
        const id = decodeURIComponent(parts[2]);
        const mail = [...this.ctx.storage.sql.exec("SELECT id, sender, sender_email, kind FROM email_summaries WHERE id = ?", id)][0] as Row | undefined;
        if (!mail) return json({ error: "Email not found." }, 404);
        if (request.method === "GET" && parts[3] === "original") {
          const sealed = [...this.ctx.storage.sql.exec("SELECT iv, ciphertext FROM email_originals WHERE message_id = ?", id)][0] as { iv: string; ciphertext: string } | undefined;
          const response = json({ original: sealed ? JSON.parse(await vault.open(await this.dek(), sealed, `email-original:${id}`)) : null });
          response.headers.set("Cache-Control", "no-store");
          return response;
        }
        if (request.method === "POST" && parts[3] === "me") {
          const historical = String(mail.sender ?? "").includes("[code]") ? "" : senderEmailOf(String(mail.sender ?? ""));
          const address = normalizeOwnEmail(mail.sender_email ?? historical);
          if (body?.marked === false) {
            this.ctx.storage.sql.exec("UPDATE email_summaries SET marked_me = 0 WHERE id = ?", id);
            return json({ marked: false });
          }
          if (!address) {
            this.ctx.storage.sql.exec("UPDATE email_summaries SET marked_me = 1 WHERE id = ?", id);
            return json({ marked: true, ownerAddress: null });
          }
          const account = await accountEmailAddresses(this.env.DB, this.userId!);
          let ownerAddress;
          try { ownerAddress = account.includes(address) ? { address, verified: true, source: "account" } : await new EmailOwnerAddresses(this.ctx.storage.sql).add(address); }
          catch (e) { return json({ error: (e as Error).message }, 400); }
          this.ctx.storage.sql.exec("UPDATE email_summaries SET marked_me = 1 WHERE id = ?", id);
          return json({ marked: true, ownerAddress });
        }
      }
      if (request.method === "GET" && parts.join("/") === "email/messages") {
        let history;
        try { history = readEmailHistory(this.ctx.storage.sql, url.searchParams.get("cursor")); }
        catch { return json({ error: "Invalid history cursor." }, 400); }
        const ruleRows = [...this.ctx.storage.sql.exec(
          "SELECT sender_domain, choice FROM email_sender_rules")] as Row[];
        return json({
          senderRules: ruleRows.map((r) => ({ senderDomain: r.sender_domain, choice: r.choice })),
          nextCursor: history.nextCursor,
          messages: history.page.map((r) => ({
            title: r.title ?? null, senderEmail: r.sender_email ?? null, markedAsMe: !!r.marked_me, hasOriginal: !!r.has_original,
            id: r.id, sender: r.sender, senderDomain: r.sender_domain,
            subject: r.subject, date: r.mail_date, kind: r.kind,
            summary: r.summary,
            actionableItems: JSON.parse(String(r.actionable)),
            attachments: JSON.parse(String(r.attachments)),
            filedAt: r.created_at,
            relation: r.relation ?? "unknown",
            decision: r.decision ?? "none",
            highlights: JSON.parse(String(r.highlights ?? "[]")),
            jobs: JSON.parse(String(r.jobs ?? "[]")),
            siteID: r.site_id ?? null,
          })),
        });
      }
      // The one remembered sender call: "ignore" opts a sender
      // out of evaluation (silent filing); "work"/"file" remain
      // accepted for older clients and simply mean the default
      // (evaluate). Filed mail from that sender takes it now.
      if (request.method === "POST" && parts.join("/") === "email/decision") {
        const senderDomain = String(body?.senderDomain ?? "").trim().toLowerCase();
        const choice = String(body?.choice ?? "");
        if (!senderDomain || !["work", "file", "ignore"].includes(choice)) {
          return json({ error: "senderDomain and a choice of work, file, or ignore are required" }, 400);
        }
        this.ctx.storage.sql.exec(
          `INSERT INTO email_sender_rules (sender_domain, choice) VALUES (?, ?)
           ON CONFLICT(sender_domain) DO UPDATE SET choice = excluded.choice, updated_at = datetime('now')`,
          senderDomain, choice,
        );
        this.ctx.storage.sql.exec(
          "UPDATE email_summaries SET decision = ? WHERE sender_domain = ? AND decision = 'pending'",
          choice, senderDomain,
        );
        return json({ remembered: true });
      }
      if (request.method === "GET" && parts.join("/") === "email/codes/pending") {
        this.pruneExpiredEmailCodes();
        return json({
          pending: this.pendingEmailCodes().map((r) => ({
            senderDomain: r.senderDomain, receivedAt: r.receivedAt,
          })),
        });
      }

      // Credentials (metadata only leaves the vault API)
      if (request.method === "POST" && parts.join("/") === "credentials") {
        const { domain, username, secret } = body;
        if (!domain || !username || !secret) return json({ error: "domain, username, secret required" }, 400);
        const blob = await vault.seal(await this.dek(), String(secret), `${domain}\n${username}`);
        const id = crypto.randomUUID();
        this.ctx.storage.sql.exec("DELETE FROM credentials WHERE domain = ?", domain);
        this.ctx.storage.sql.exec(
          "INSERT INTO credentials (id, domain, username, iv, ciphertext) VALUES (?, ?, ?, ?, ?)",
          id,
          domain,
          username,
          blob.iv,
          blob.ciphertext,
        );
        // Brief 05: a re-saved login is the fix the needs-you item
        // asked for — end the episode so scheduled scans resume.
        this.healScanEpisodes(domainOf(String(domain)));
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
        const client = new LLMClient(this.llmConfig("hygge-onboarding"));
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const encoder = new TextEncoder();
        const emit = (event: unknown) => {
          void writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        };
        this.ctx.waitUntil(
          (async () => {
            try {
              await onboardingMessageStream({
                client,
                ...(body as object),
                sessionId: this.ctx.id.toString(),
                sessionName: this.userId || undefined,
              }, emit);
            } finally {
              await writer.close().catch(() => {});
            }
          })(),
        );
        return new Response(readable, {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        });
      }
      // Model-led understanding, app-validated: what does this
      // message want done? See onboarding.ts chatIntent.
      if (request.method === "POST" && parts.join("/") === "onboarding/intent") {
        const intentBody = (body ?? {}) as Record<string, any>;
        // Candidates the model may offer or the user may confirm:
        // open proposals first, then the catalog — minus anything
        // already tracked. The model still reasons freely; this
        // only grounds names to addresses.
        const store = this.stateStore();
        const inventory = store.list("sites").flatMap((row) => {
          const site = scanSiteFromRow(String(row.id), row.data);
          if (!site) return [];
          const state = store.get("accountStates", site.siteID)?.data as any;
          return [{ name: site.name, domain: site.domain, siteId: site.siteID,
            tracked: ["watching", "profileLive", "hasAccount", "joining", "needsVerification"].includes(state?.state ?? "") }];
        });
        const proposals = store.list("proposals").flatMap((row) => {
          const data = row.data as any;
          if (data?.status !== "proposed") return [];
          const siteId = String(data.siteID ?? "");
          const site = inventory.find((s) => s.siteId === siteId);
          return site ? [{ name: site.name, domain: site.domain, siteId }] : [];
        });
        const catalog = Object.values(STATIC_PROPOSALS).flat().map((entry) =>
          ({ name: entry.name, domain: domainOf(entry.url), siteId: null }));
        const candidates = chatSiteCandidates(inventory, proposals, catalog);
        return json(await chatIntent({
          client: new LLMClient(this.llmConfig("hygge-onboarding")),
          ...intentBody,
          context: { ...(intentBody.context ?? {}), candidates },
          conversationId: this.ctx.id.toString(),
        }));
      }
      if (request.method === "POST" && parts.join("/") === "onboarding/message") {
        return json(await onboardingMessage({
          client: new LLMClient(this.llmConfig("hygge-onboarding")),
          ...(body as object),
          sessionId: this.ctx.id.toString(),
          sessionName: this.userId || undefined,
        }));
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
      if (request.method === "GET" && parts[0] === "sessions" && parts[2] === "stream") {
        if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return json({ error: "WebSocket required" }, 426);
        return browser.stream(parts[1], () => this.resumeBrowser(parts[1]));
      }
      if (request.method === "GET" && parts[0] === "sessions" && parts.length === 2) {
        const snap = await browser.snapshot(parts[1]);
        return snap ? json(snap) : json({ error: "unknown session" }, 404);
      }
      if (request.method === "POST" && parts[0] === "sessions" && parts[2] === "act") {
        const snap = await browser.legacyAct(parts[1], body);
        return snap ? json(snap) : json({ error: "unknown session" }, 404);
      }
      if (request.method === "DELETE" && parts[0] === "sessions") {
        return json({ closed: await browser.closeSession(parts[1]) });
      }

      // Scheduled scanning (Brief 05). POST tick is both the cron
      // sweeper's entry point (index.ts adds x-hygge-scheduled-sweep)
      // and the manual trigger tests use to simulate a cron tick.
      // Auth is unchanged: the request reached this object only as
      // this verified user, and a tick can only scan this user.
      if (request.method === "POST" && parts.join("/") === "scheduled-scan/tick") {
        const slotRaw = Number(body.slot ?? 0);
        const slot = Number.isFinite(slotRaw) ? Math.min(Math.max(Math.trunc(slotRaw), 0), 2) : 0;
        // Only the sweeper may set the tick clock (its marker is
        // stripped from outside requests in index.ts). A manual
        // tick runs at server time, so client-chosen dates cannot
        // reset the daily cap or once-per-slot keys.
        const now = effectiveTickNow(body.now, request.headers.get("x-hygge-scheduled-sweep") === "1");
        const summary = await this.exclusive(() =>
          runScheduledTick(this.scanDeps(browser), { slot, now }));
        // Brief 07: push trigger #2 — at most one push per tick:
        // the new-work chat message only (see push.ts). Needs-you
        // episodes stay in the feed and never push.
        this.schedulePush(planTickNotifications(summary));
        // Expiry lifecycle (policy Nov 5, 22:14 CST): the tick is
        // the server-side trigger that notices newly-expired
        // still-pending cards and prompts the agent. Fire-and-
        // forget so the tick's response never waits on model
        // composition; the success flag is written only after the
        // message and its push, and a failed composition is
        // retried on later ticks (bounded), so overlaps cannot
        // double-send and failures are not dropped.
        this.runAfterSave(this.notifyExpiredCards());
        return json(summary);
      }
      if (request.method === "GET" && parts.join("/") === "scheduled-scan/status") {
        const scans = this.scanStore();
        return json({
          schedule: { slotsUtc: [...CRON_SLOTS_UTC], note: "signed-in sites every slot; public listings at the first slot only" },
          runs: scans.db.listRecentRuns(50),
          categories: scans.db.listCategories(),
          sites: scans.db.listSiteStates(),
        });
      }

      // Tasks (approval gate enforced here)
      if (request.method === "POST" && parts.join("/") === "tasks") {
        const clientID = typeof body.mobile_task?.id === "string" && /^[0-9a-f-]{36}$/i.test(body.mobile_task.id)
          ? body.mobile_task.id.toLowerCase() : null;
        const existing = clientID ? this.loadTask(clientID) : null;
        // Repeated network requests never create duplicate site accounts/tasks.
        if (existing && !existing._fromSnapshot) return json({ ...existing, mobile_task: mobileTask(existing) });
        const kind = body.kind ?? "discover";
        const domain = domainOf(body.target_url ?? "");
        const cred = [
          ...this.ctx.storage.sql.exec("SELECT id FROM credentials WHERE domain = ? LIMIT 1", domain),
        ] as Row[];
        const task = {
          id: clientID ?? crypto.randomUUID(),
          interaction_version: body.interaction_version === 1 ? 1 : 0,
          mobile_task: body.mobile_task ?? null,
          help: null,
          kind,
          target_url: body.target_url ?? "",
          goal: body.goal ?? "",
          title: body.title ?? kind,
          drafted_payload: body.drafted_payload ?? {},
          // Brief 04 site-signup email choice (approved draft keys
          // email/emailChoice, or explicit fields). The address is a
          // per-user draft value in this user's object only — skill
          // promotion redacts draft values before anything is shared.
          email_choice: body.email_choice ?? body.drafted_payload?.emailChoice ?? null,
          awaiting_email_verification:
            body.awaiting_email_verification === true
            || body.drafted_payload?.awaitingEmailVerification === "true",
          email_code_available: false,
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
        return json({ tasks: rows.map((r) => {
          const t = JSON.parse(String(r.task));
          // Retained-v2 runs keep their session id in the projected task
          // even after the session dies, so reconcile dead sessions there
          // too. A live runner run still counts as active, so a run that
          // has not opened its session yet is never flipped mid-start.
          const retainedV2 = workspaceMode(this.env.HYGGE_WORKSPACE_MODE)==='retained-v2';
          const runnerPhase = retainedV2 ? (this.workspace().runner.progress(t.id) as { phase?: string } | null)?.phase : null;
          const runnerActive = runnerPhase === 'waiting_for_workspace' || runnerPhase === 'browser_starting' || runnerPhase === 'running';
          if ((workspaceMode(this.env.HYGGE_WORKSPACE_MODE)==='legacy' || retainedV2)
              && reconcileEndedSession(t, Boolean(t.session_id && browser.hasSession(t.session_id)),
              this.activeMissions.has(t.id) || this.browserResumes.has(t.id) || runnerActive, retainedV2)) {
            this.saveTask(t);
            // A retained-v2 session end is now a silent pause (no
            // recovery prompt): resume it on its own. Legacy keeps
            // the recovery prompt, so there is nothing to resume
            // automatically there.
            this.maybeAutoResume(t);
          }
          return { ...this.executionView(t), mobile_task: mobileTask(t) };
        }) });
      }
      if (request.method === "POST" && parts.join("/") === "skills/quarantine") {
        // Maintainer kill switch for the shared library. The maintainer
        // secret is the authority; this owner DO is only the execution host.
        if (workspaceMode(this.env.HYGGE_WORKSPACE_MODE)!=='retained-v2') return json({error:'retained-v2 required'},409);
        const token=request.headers.get('x-hygge-maintainer-token')??'';
        if(typeof body.operationId!=='string'||typeof body.skillId!=='string'||!['privacy','unsafe_guidance','integrity'].includes(body.reason))return json({error:'operationId, skillId and a valid reason are required'},400);
        const ok=await this.workspace().quarantineSkill(token,{operationId:body.operationId,skillId:body.skillId,reason:body.reason});
        return ok?json({ok:true,skillId:body.skillId}):json({error:'quarantine not authorized or not applied'},403);
      }
      if (request.method === "POST" && parts[0] === "tasks") {
        const task = this.loadTask(parts[1]);
        if (!task) return json({ error: "unknown task" }, 404);
        if(parts[2]==='reconcile' && workspaceMode(this.env.HYGGE_WORKSPACE_MODE)==='retained-v2') {
          // The agent resolves the effect from its own page observation; the caller supplies no
          // outcome and no review. A client-supplied status is accepted for compatibility but ignored.
          if(typeof body.effectId!=='string')return json({error:'effectId is required'},400);
          return json(await this.workspace().reconcile(task.id,body.effectId));
        }
        if (parts[2] === "continue") {
          // A silent pause (needsHuman, no help) has no request to
          // reply to: resume it directly. A help-bearing pause still
          // goes through the reply (approval / answers) first, and a
          // help left standing after the reply returns as-is.
          if (!(task.status === "needsHuman" && !task.help)) {
            const error = applyHelpReply(task, body);
            if (error) return json({ error }, 409);
            if (task.help) { this.saveTask(task); return json(task); }
          }
          const refs = [...this.ctx.storage.sql.exec("SELECT id FROM credentials WHERE domain = ? LIMIT 1", domainOf(task.target_url))] as Row[];
          if (refs.length) task.credential_id = refs[0].id;
          task.status = "running";
          this.saveTask(task);
          return json(await this.enqueueOrRunMission(task));
        }
        if (parts[2] === "run" && task.requires_approval) {
          return json({ error: "approval required: POST /tasks/{id}/approve" }, 403);
        }
        if (parts[2] === "reject") {
          if (workspaceMode(this.env.HYGGE_WORKSPACE_MODE)==='retained-v2') return json(await this.workspace().runner.reject(task));
          const sessionID = task.session_id;
          const error = rejectTaskHelp(task, body.helpID);
          if (error) return json({ error }, 409);
          this.saveTask(task);
          if (sessionID) await browser.closeSession(sessionID).catch(() => {});
          return json(task);
        }
        if (parts[2] === "approve" || parts[2] === "run") {
          // needsHuman re-approve = resume after the user completed a
          // CAPTCHA/2FA/ID check in the kept-open session. If that
          // session died, runTask falls back to the trusted sign-in /
          // saved credential — the password is never re-asked here.
          // An interrupted run (client disconnect / DO eviction) leaves the
          // task approved/running with durable runner state. Re-running
          // joins the live mission in this isolate or resumes the orphan;
          // runInteractiveTask dedupes, so this cannot double-dispatch.
          if (!["awaiting_approval", "needsHuman", "approved", "running"].includes(task.status)) {
            return json({ error: `task is ${task.status}, not awaiting_approval` }, 409);
          }
          // A needsHuman task with a live request must be replied to
          // in chat. A silent pause (no help) has no request: it
          // resumes below like an approved/running task.
          if (task.interaction_version === 1 && task.status === "needsHuman" && task.help) return json({ error: "Reply to the current request in chat." }, 409);
          const resuming = task.status === "needsHuman" || task.status === "approved" || task.status === "running";
          const silentPause = task.status === "needsHuman" && !task.help;
          task.status = task.interaction_version === 1 ? "running" : "approved";
          task.log.push(silentPause ? "Resumed by user" : resuming ? "Resumed by user after completing the check" : "Approved by user");
          this.saveTask(task);
          return json(await this.enqueueOrRunMission(task));
        }
      }

      // Per-user server-side state (Brief 01). Auth is identical to
      // every other user route: index.ts resolved the user id from
      // the verified credential and routed into this user's object.
      // Conflict rule: server wins on newest updated_at (see state.ts).
      if (parts[0] === "state") {
        const store = this.stateStore();
        if (request.method === "POST" && parts[1] === "import") {
          // Brief 05: rate/location/site changes arriving through the
          // app's debounced push reopen exhausted categories.
          const reopenBefore = this.reopenSnapshot(store);
          const result = store.importSnapshot(body as Record<string, unknown>);
          this.importMemories(result.memories);
          this.importSnapshotTasks(result.tasks);
          this.applyCategoryReopen(reopenBefore, store);
          // Brief 06: feedback events in the push refresh the model.
          this.refreshLearning(store);
          // Brief 06: onboarding suggestions are created on-device;
          // withdraw any whose site is proven web-ineligible.
          try { await this.sweepIneligibleProposals(store); } catch { /* never fail a state push */ }
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
          // Brief 05: profile/site writes can reopen exhausted
          // categories (new site, new rate floor, new location).
          const reopenBefore = stateEntity === "profile" || stateEntity === "sites"
            ? this.reopenSnapshot(store) : null;
          try {
            const result = store.upsert(stateEntity, id, data, updatedAt);
            if (result.applied) this.applyCategoryReopen(reopenBefore, store);
            if (result.applied && stateEntity === "feedbackEvents") this.refreshLearning(store);
            if (result.applied && (stateEntity === "proposals" || stateEntity === "sites")) {
              try { await this.sweepIneligibleProposals(store); } catch { /* never fail a state write */ }
            }
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
