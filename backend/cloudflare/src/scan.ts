/// Scheduled scanning (Brief 05): per-user scan planning, the
/// relevance gate, exhaustion memory, and the tick runner. This
/// module is pure planning/persistence logic so it can be
/// unit-tested in Node; UserSandbox supplies the real discover
/// mission runner (agent.ts runMission via runTask) and the Worker
/// cron sweeper (index.ts scheduled) fans ticks out to user objects.
///
/// Scheduler choice (decided in the brief): Worker cron triggers as
/// a fleet sweeper, NOT per-user Durable Object alarms. One cron
/// definition serves every user, cadence changes ship as config,
/// and per-user staggering is unnecessary at this scale. Slots are
/// UTC-fixed (CRON_SLOTS_UTC): 07:00 / 13:00 / 19:00 UTC — morning /
/// midday / evening for the current UK/EU user base; if users span
/// many time zones, per-user local slots become the follow-up (that
/// is what per-user alarms would buy, at the cost of N alarm states
/// to keep in sync with pause/approval changes).
///
/// Hard rules enforced here, never by the model:
/// - Paused users (server-side profile flag, Brief 01) get zero scans.
/// - Only user-approved sites are ever scanned (account state
///   watching/hasAccount/profileLive — the app's consent states).
/// - Scans are discover-only: the only outputs are feed items /
///   opportunities and one needs-you item per login-failure episode.
///   This module has no code path that creates a write task, so a
///   scan can never auto-apply, auto-sign-up, or auto-message. Any
///   write action from a surfaced listing still goes through the
///   existing user-approval flow in user-sandbox.ts.
/// - Secrets never appear here: credentials are referenced by id
///   only; the vault resolution stays inside runTask.
import { PROFILE_ROW_ID, normalizeId, type StateStore } from "./state.ts";
import {
  SURFACING_THRESHOLD, deriveIgnoredEvents, pruneExpiredInferredBeliefs,
  rankItem, sortByRank, type LearningProfile,
} from "./learning.ts";
import {
  applyAppWallStrike, applyProbeOutcome, consumeUnknownCycle, eligibilityOf,
  reprobeDue, unknownAccessRecord, withdrawProposalsForSite,
  type Eligibility, type ProbeOutcome, type SiteAccessRecord,
} from "./web-access.ts";

export type { ProbeOutcome, SiteAccessRecord } from "./web-access.ts";

/// Cron slots per day (UTC). Logged-in sites scan at every slot
/// (3x/day); public-only sites scan at the first slot only (1x/day).
export const CRON_SLOTS_UTC = ["07:00", "13:00", "19:00"] as const;
export const CRON_SCHEDULES = ["0 7 * * *", "0 13 * * *", "0 19 * * *"] as const;
export const PUBLIC_SCAN_SLOT = 0;

/// Exhaustion (decided): a category that surfaces nothing new for
/// EXHAUSTION_WINDOW_DAYS of scheduled scans (with at least
/// MIN_EMPTY_SCANS_BEFORE_EXHAUST successful empty scans — a couple
/// of quiet mornings are not exhaustion) is skipped until a monthly
/// re-check EXHAUSTION_COOLDOWN_DAYS later. One re-check scan runs
/// then; empty again restarts the cooldown.
export const EXHAUSTION_WINDOW_DAYS = 7;
export const MIN_EMPTY_SCANS_BEFORE_EXHAUST = 3;
export const EXHAUSTION_COOLDOWN_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export type ScanTier = "logged" | "public";

export interface ScanProfile {
  interests: string[];
  skills: string[];
  locationLabel: string;
  hourlyRateFloor: number;
  /// Travel radius from the earnings profile (Brief 06 ranker input).
  radiusKm: number;
  remoteOK: boolean;
}

export interface ScanSite {
  /// Normalized state-row id (dedupe/persistence key).
  id: string;
  /// The site's id as the app spells it (payload siteID).
  siteID: string;
  name: string;
  startURLString: string;
  domain: string;
  /// Raw category as stored (app enum spelling, e.g. "petCare").
  category: string;
}

export interface ScanListing {
  title: string;
  summary: string;
  category: string;
  payLabel: string;
  estimatedHourly: number | null;
  locationLabel: string;
  isRemote: boolean;
  requiredSkills: string[];
  urlString: string;
  siteId: string;
  /// Distance from the user when the listing states it. Null means
  /// unknown: the ranker treats it as neutral, never blocking.
  distanceKm: number | null;
  /// When the listing was posted (ISO-8601) when stated. Null means
  /// unknown freshness: neutral in the ranker, never blocking.
  postedAt: string | null;
  /// Per-listing web-access claim from extraction, kept only as a
  /// defense-in-depth signal. The authoritative verdict is site-level
  /// (catalog by domain; see web-access.ts and GateContext).
  webAccess: "yes" | "no" | "unknown" | null;
}

export interface SessionHealthInfo {
  domain: string;
  trustSupport: string; // supported | unsupported | unknown
  hasProfile: boolean;
}

export interface ScanCategoryState {
  category: string;
  /// First successful scan ever recorded for this category: the
  /// reference point for "no new item in N days" when nothing has
  /// ever surfaced.
  trackingSince: string | null;
  lastScanAt: string | null;
  lastNewFoundAt: string | null;
  consecutiveEmptyScans: number;
  exhaustedUntil: string | null;
}

export interface ScanSiteState {
  siteId: string;
  domain: string;
  /// Login/session failure episode in progress: scans for this site
  /// are skipped until the user re-saves the login (or a manual
  /// mission on the domain succeeds again).
  stale: boolean;
  staleReason: string | null;
  staleSince: string | null;
  needsYouItemId: string | null;
  /// A public-only scan found nothing readable without a login:
  /// stop public scans for this site until a login exists (brief).
  publicOnlyBlocked: boolean;
  lastScanAt: string | null;
}

export type ScanRunStatus = "succeeded" | "empty" | "failed" | "login_failed";

export interface ScanRunRecord {
  id: string;
  siteId: string;
  domain: string;
  category: string;
  tier: ScanTier;
  slot: number;
  runDate: string; // YYYY-MM-DD (UTC)
  startedAt: string; // ISO-8601
  status: ScanRunStatus;
  itemsFound: number;
  itemsSurfaced: number;
  itemsFiltered: number;
  /// Brief 02 routing taken ("active skill" / "Wonder authoring"),
  /// copied from the mission log for cost observability.
  skillPath: string | null;
  errorReason: string | null;
}

export function scanSchemaSQL(): string {
  return [
    `CREATE TABLE IF NOT EXISTS scan_category_state (
       category TEXT PRIMARY KEY,
       tracking_since TEXT, last_scan_at TEXT, last_new_found_at TEXT,
       consecutive_empty INTEGER NOT NULL DEFAULT 0, exhausted_until TEXT
     );`,
    `CREATE TABLE IF NOT EXISTS scan_site_state (
       site_id TEXT PRIMARY KEY, domain TEXT NOT NULL,
       stale INTEGER NOT NULL DEFAULT 0, stale_reason TEXT, stale_since TEXT,
       needs_you_item_id TEXT, public_only_blocked INTEGER NOT NULL DEFAULT 0,
       last_scan_at TEXT
     );`,
    `CREATE TABLE IF NOT EXISTS scan_runs (
       id TEXT PRIMARY KEY, site_id TEXT NOT NULL, domain TEXT NOT NULL,
       category TEXT NOT NULL, tier TEXT NOT NULL, slot INTEGER NOT NULL,
       run_date TEXT NOT NULL, started_at TEXT NOT NULL, status TEXT NOT NULL,
       items_found INTEGER NOT NULL DEFAULT 0, items_surfaced INTEGER NOT NULL DEFAULT 0,
       items_filtered INTEGER NOT NULL DEFAULT 0, skill_path TEXT, error_reason TEXT
     );`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_scan_runs_once ON scan_runs(site_id, run_date, slot);`,
    `CREATE INDEX IF NOT EXISTS idx_scan_runs_date ON scan_runs(run_date);`,
  ].join("\n");
}

export function ensureScanSchema(exec: (sql: string) => unknown): void {
  exec(scanSchemaSQL());
}

// ---- schedule helpers -------------------------------------------------

export function runDateOf(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/// Cron slot for a fired schedule; an unknown schedule is treated
/// as slot 0 (the most permissive single scan) rather than dropped.
export function slotForCron(cron: string): number {
  const index = (CRON_SCHEDULES as readonly string[]).indexOf(cron);
  return index >= 0 ? index : 0;
}

/// The HTTP tick's clock. Only the cron sweeper (server-side, it
/// presents the sweep marker that index.ts strips from outside
/// requests) may choose the tick time. A signed-in manual tick
/// always runs at server time, so future-dated requests cannot
/// reset the daily cap, the once-per-(site, date, slot) keys, or
/// exhaustion windows into unbounded paid missions. Tests that
/// simulate time call runScheduledTick directly.
export function effectiveTickNow(requested: unknown, isSweep: boolean, serverNow: Date = new Date()): Date {
  if (!isSweep) return serverNow;
  const parsed = typeof requested === "string" ? new Date(requested) : serverNow;
  return Number.isNaN(parsed.getTime()) ? serverNow : parsed;
}

export function isTierDueAtSlot(tier: ScanTier, slot: number): boolean {
  return tier === "logged" ? true : slot === PUBLIC_SCAN_SLOT;
}

/// Fleet-sweep visiting order: deterministic rotation seeded per
/// slot+day, so no user is permanently last if a sweep runs long.
export function sweepOrder(userIds: string[], seed: string): string[] {
  const sorted = [...userIds].sort();
  if (sorted.length < 2) return sorted;
  let h = 0;
  for (const ch of seed) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  const offset = h % sorted.length;
  return [...sorted.slice(offset), ...sorted.slice(0, offset)];
}

/// Per-user daily cap (brief): 3 x approved-logged-in sites +
/// 1 x approved-public sites. A runaway guardrail: even a bug that
/// re-fires ticks cannot exceed this many missions per user per day.
export function dailyCap(loggedSites: number, publicSites: number): number {
  return loggedSites * CRON_SLOTS_UTC.length + publicSites;
}

// ---- profile / site extraction from Brief 01 state rows ---------------

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter((s) => s.trim().length > 0) : [];
}

/// The profile row is the ProfileState singleton
/// ({profile, hasOnboarded, isPaused, lastVisitAt}); tolerate a raw
/// earnings profile written directly, defensively.
export function extractProfile(payload: unknown): { profile: ScanProfile; isPaused: boolean } {
  const row = asRecord(payload);
  const inner = asRecord(row.profile);
  const source = Object.keys(inner).length ? inner : row;
  const floor = Number(source.hourlyRateFloor ?? source.rateFloor ?? source.minimumRate);
  const radius = Number(source.radiusKm ?? source.radius_km);
  return {
    isPaused: row.isPaused === true || row.is_paused === true,
    profile: {
      interests: stringArray(source.interests).map((s) => s.toLowerCase()),
      skills: stringArray(source.skills),
      locationLabel: String(source.locationLabel ?? source.location ?? ""),
      hourlyRateFloor: Number.isFinite(floor) && floor > 0 ? floor : 0,
      radiusKm: Number.isFinite(radius) && radius > 0 ? radius : 20,
      remoteOK: source.remoteOK !== false,
    },
  };
}

export function domainOfUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return String(url ?? "").replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].toLowerCase();
  }
}

/// A TargetSite state row -> scan site. The row id wins for the site
/// id (state rows are keyed by it); url/category fall back across
/// the field spellings the app and backend have used.
export function scanSiteFromRow(rowId: string, payload: unknown): ScanSite | null {
  const data = asRecord(payload);
  const id = normalizeId(rowId || data.id);
  const startURLString = String(
    data.startURLString ?? data.urlString ?? data.url ?? data.target_url ?? data.href ?? "",
  );
  if (!id || !startURLString) return null;
  return {
    id,
    siteID: String(data.id ?? rowId),
    name: String(data.name ?? data.title ?? id),
    startURLString,
    domain: domainOfUrl(startURLString),
    category: String(data.category ?? ""),
  };
}

/// The app's OpportunityCategory raw values. A surfaced payload
/// must carry one of these exactly, or the app cannot read its own
/// feed — sanitize anything else to the app's fallback.
export const OPPORTUNITY_CATEGORIES = [
  "petCare", "freelance", "localGig", "delivery", "creative",
  "tutoring", "homeServices", "remoteJob", "community",
] as const;
export function validCategory(...candidates: (string | null | undefined)[]): string {
  for (const c of candidates) {
    const hit = OPPORTUNITY_CATEGORIES.find((v) => v.toLowerCase() === String(c ?? "").toLowerCase());
    if (hit) return hit;
  }
  return "localGig";
}

/// Account-state row -> raw lifecycle string. Rows arrive as
/// {siteID, state} (state may itself be wrapped once by import).
export function accountStateOf(payload: unknown): string {
  const data = asRecord(payload);
  const state = data.state;
  if (typeof state === "string") return state;
  if (state && typeof state === "object") {
    const inner = asRecord(state).state;
    if (typeof inner === "string") return inner;
  }
  if (typeof data.accountState === "string") return data.accountState;
  if (typeof data.status === "string") return data.status;
  return "";
}

/// The app's consent states that mean "the user approved this site
/// and Hygge may watch it" (SiteAccountState.isWatching plus
/// hasAccount). Proposed/joining/paused/stopped/disconnected sites
/// are never scanned.
const APPROVED_ACCOUNT_STATES = new Set(["watching", "profilelive", "hasaccount"]);
export function isSiteApproved(accountState: string): boolean {
  return APPROVED_ACCOUNT_STATES.has(accountState.toLowerCase());
}

// ---- listing parsing ---------------------------------------------------

export function normalizeTitle(title: string): string {
  return String(title ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

/// Dedupe key: title + site, the app's existing rule
/// (AppStore.addDiscoveredOpportunities). The server normalizes
/// case/whitespace on top — a strict superset, so a listing the app
/// would dedupe can never surface twice here either.
export function dedupeKey(siteId: string, title: string): string {
  return `${normalizeId(siteId)}|${normalizeTitle(title)}`;
}

function parseHourly(text: string): number | null {
  const match = String(text).match(
    /(?:[$£€]\s*)?(\d+(?:\.\d+)?)\s*(?:[$£€]?\s*(?:\/|per|an?)\s*(?:h|hr|hrs|hour|hours)\b)/i,
  );
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function firstUrl(text: string): string | null {
  const match = String(text).match(/https?:\/\/[^\s|]+/);
  return match ? match[0] : null;
}

/// Extracted items are free-form strings from the browser (see
/// agent.ts extract). Parse what is structured — JSON objects and
/// "Title | pay | location | skills | url" pipe strings — and fall
/// back to the raw text as the title, exactly like the app's own
/// ingestion. Unknown pay/location stay unknown (null/empty); the
/// gate only blocks on known-bad facts.
export function parseListings(items: string[], site: ScanSite): ScanListing[] {
  const out: ScanListing[] = [];
  for (const raw of items ?? []) {
    const text = String(raw ?? "").trim();
    if (!text) continue;
    let listing: ScanListing | null = null;
    if (text.startsWith("{")) {
      try {
        const obj = asRecord(JSON.parse(text));
        const title = String(obj.title ?? obj.name ?? "").trim();
        if (title) {
          const hourlyRaw = Number(obj.estimatedHourly ?? obj.hourlyRate);
          listing = {
            title,
            summary: String(obj.summary ?? obj.description ?? title),
            category: String(obj.category ?? site.category).toLowerCase(),
            payLabel: String(obj.payLabel ?? obj.pay ?? "See listing"),
            estimatedHourly: Number.isFinite(hourlyRaw) && hourlyRaw > 0
              ? hourlyRaw
              : parseHourly(String(obj.payLabel ?? obj.pay ?? "")),
            locationLabel: String(obj.locationLabel ?? obj.location ?? ""),
            isRemote: obj.isRemote === true,
            requiredSkills: stringArray(obj.requiredSkills ?? obj.skills),
            urlString: String(obj.urlString ?? obj.url ?? site.startURLString),
            siteId: site.id,
            distanceKm: Number.isFinite(Number(obj.distanceKm)) && Number(obj.distanceKm) >= 0
              ? Number(obj.distanceKm) : null,
            postedAt: typeof obj.postedAt === "string" && Number.isFinite(Date.parse(obj.postedAt))
              ? obj.postedAt : null,
            webAccess: obj.webAccess === "yes" || obj.webAccess === "no" ? obj.webAccess : null,
          };
        }
      } catch { /* fall through to text parsing */ }
    }
    if (!listing && text.includes("|")) {
      const parts = text.split("|").map((p) => p.trim()).filter(Boolean);
      const title = (parts[0] ?? "").replace(/https?:\/\/\S+/g, "").trim();
      if (title) {
        const rest = parts.slice(1);
        const payPart = rest.find((p) => parseHourly(p) != null || /[$£€]/.test(p)) ?? "";
        const url = firstUrl(text);
        const skillPart = rest.find((p) => /^(skills?|needs?|requires?)\s*:/i.test(p)) ?? "";
        const locationPart = rest.find(
          (p) => p !== payPart && p !== skillPart && !/^https?:\/\//.test(p),
        ) ?? "";
        listing = {
          title,
          summary: text,
          category: site.category,
          payLabel: payPart || "See listing",
          estimatedHourly: parseHourly(payPart) ?? parseHourly(text),
          locationLabel: locationPart,
          isRemote: /\bremote\b/i.test(text),
          requiredSkills: skillPart
            ? skillPart.replace(/^(skills?|needs?|requires?)\s*:/i, "").split(/[,;]/).map((s) => s.trim()).filter(Boolean)
            : [],
          urlString: url ?? site.startURLString,
          siteId: site.id,
          distanceKm: null, postedAt: null,
          webAccess: null,
        };
      }
    }
    if (!listing) {
      const url = firstUrl(text);
      const title = text.replace(/https?:\/\/\S+/g, "").trim();
      if (!title) continue;
      listing = {
        title,
        summary: text,
        category: site.category,
        payLabel: "See listing",
        estimatedHourly: parseHourly(text),
        locationLabel: "",
        isRemote: /\bremote\b/i.test(text),
        requiredSkills: [],
        urlString: url ?? site.startURLString,
        siteId: site.id,
        distanceKm: null, postedAt: null,
        webAccess: null,
      };
    }
    if (listing.title.length >= 4) out.push(listing);
  }
  return out;
}

// ---- relevance gate ------------------------------------------------------

export interface GateContext {
  profile: ScanProfile;
  existingKeys: Set<string>;
  existingIds: Set<string>;
  declinedKeys: Set<string>;
  appliedKeys: Set<string>;
  appliedIds: Set<string>;
  /// Site-level web verdict for the site being scanned (catalog by
  /// domain). Absent means "unknown with its fallback cycle spent" —
  /// there is no permissive default: the tick verifies eligibility
  /// (probe / one-cycle unknown) before any listing reaches the gate
  /// and passes that verdict here explicitly.
  siteWebEligibility?: Eligibility;
}

export type GateReason =
  | "duplicate"
  | "previouslyDeclined"
  | "alreadyApplied"
  | "belowRateFloor"
  | "noCategoryFit"
  | "noSkillFit"
  | "noLocationFit"
  | "notWebAccessible"
  | "belowRankThreshold";

export interface GateDecision {
  pass: boolean;
  reasons: GateReason[];
}

function overlaps(a: string, b: string): boolean {
  const x = a.toLowerCase().trim();
  const y = b.toLowerCase().trim();
  return x.length > 0 && y.length > 0 && (x.includes(y) || y.includes(x));
}

/// The mandatory pre-surfacing gate (brief step 4). A listing
/// surfaces only if EVERY check passes. Unknown listing facts (no
/// known pay, no category, no location) do not block — only
/// known-bad facts do — except the rate floor, which is a hard bound
/// the moment a rate is known.
///
/// Web accessibility is site-level and probe-verified (Brief 06):
/// the tick resolves the catalog verdict (probing unknown sites,
/// allowing at most one unknown cycle) BEFORE running a mission, and
/// passes it as `siteWebEligibility`. Ineligible and spent-unknown
/// block here; an absent verdict blocks too. A per-listing "no" from
/// extraction blocks as defense in depth. The ranker (learning.ts)
/// then orders/filters ABOVE this gate — no score resurrects a
/// gate-dropped (e.g. below-floor) listing.
export function evaluateGate(listing: ScanListing, ctx: GateContext): GateDecision {
  const reasons: GateReason[] = [];
  const key = dedupeKey(listing.siteId, listing.title);
  if (ctx.declinedKeys.has(key)) reasons.push("previouslyDeclined");
  if (ctx.appliedKeys.has(key)) reasons.push("alreadyApplied");
  if (ctx.existingKeys.has(key)) reasons.push("duplicate");
  // Hard bound: below-floor listings are dropped, never shown.
  if (
    listing.estimatedHourly != null &&
    ctx.profile.hourlyRateFloor > 0 &&
    listing.estimatedHourly < ctx.profile.hourlyRateFloor
  ) {
    reasons.push("belowRateFloor");
  }
  const category = (listing.category || "").toLowerCase();
  if (category && ctx.profile.interests.length && !ctx.profile.interests.includes(category)) {
    reasons.push("noCategoryFit");
  }
  if (listing.requiredSkills.length && ctx.profile.skills.length) {
    const fit = listing.requiredSkills.some((need) =>
      ctx.profile.skills.some((have) => overlaps(need, have)),
    );
    if (!fit) reasons.push("noSkillFit");
  }
  if (!listing.isRemote && listing.locationLabel.trim() && ctx.profile.locationLabel.trim()) {
    if (!overlaps(listing.locationLabel, ctx.profile.locationLabel)) {
      // A remote-friendly user still sees it only if the listing
      // itself can be done from home; isRemote false means on-site.
      reasons.push("noLocationFit");
    }
  }
  if (listing.webAccess === "no"
    || ctx.siteWebEligibility === "ineligible"
    || ctx.siteWebEligibility === "unknownBlocked"
    || ctx.siteWebEligibility === undefined) {
    reasons.push("notWebAccessible");
  }
  return { pass: reasons.length === 0, reasons };
}

/// Stable uuid-shaped id for a surfaced listing, derived from its
/// dedupe key: re-extracting the same listing always maps to the
/// same opportunity row, so the feed can never double-show it.
export function scanOpportunityId(siteId: string, title: string): string {
  const key = dedupeKey(siteId, title);
  let h1 = 0xcbf29ce484222325n;
  for (const ch of `scan|${key}`) {
    h1 ^= BigInt(ch.codePointAt(0) ?? 0);
    h1 = (h1 * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  let h2 = 0xcbf29ce484222325n;
  for (const ch of `hygge|${key}`) {
    h2 ^= BigInt(ch.codePointAt(0) ?? 0);
    h2 = (h2 * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  const hex = (h1.toString(16).padStart(16, "0") + h2.toString(16).padStart(16, "0")).slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/// Deterministic id for the single needs-you item of a login-failure
/// episode: one per site per site-state, like the opportunity id a
/// repeat failure maps to the same row and never stacks cards.
export function needsYouItemId(siteId: string): string {
  return scanOpportunityId(siteId, "__needs_you_login__");
}

// ---- gate context from stored state --------------------------------------

const DECLINED_STATUSES = new Set(["dismissed", "declined", "rejected", "hidden"]);
const APPLIED_STATUSES = new Set(["applied"]);

function opportunityKeyOf(data: Record<string, unknown>, rowId: string): { key: string; id: string } {
  const siteId = String(data.siteID ?? data.siteId ?? data.site ?? "");
  const title = String(data.title ?? "");
  const id = normalizeId(data.id ?? rowId);
  return { key: siteId && title ? dedupeKey(siteId, title) : "", id };
}

/// Build the dedupe/decline/applied sets from this user's stored
/// opportunities, feed items, and applications. Dismissed or
/// applied-to listings are remembered by title+site, so even a
/// re-extracted copy (different upstream id) stays hidden.
export function buildGateContext(state: StateStore, profile: ScanProfile): GateContext {
  const ctx: GateContext = {
    profile,
    existingKeys: new Set(),
    existingIds: new Set(),
    declinedKeys: new Set(),
    appliedKeys: new Set(),
    appliedIds: new Set(),
  };
  const consider = (row: { id: string; data: unknown }) => {
    const data = asRecord(row.data);
    const { key, id } = opportunityKeyOf(data, row.id);
    if (key) ctx.existingKeys.add(key);
    if (id) ctx.existingIds.add(id);
    const status = String(data.status ?? data.state ?? "").toLowerCase();
    if (key && DECLINED_STATUSES.has(status)) ctx.declinedKeys.add(key);
    if (key && APPLIED_STATUSES.has(status)) ctx.appliedKeys.add(key);
    if (id && APPLIED_STATUSES.has(status)) ctx.appliedIds.add(id);
  };
  state.list("opportunities").forEach(consider);
  state.list("feedItems").forEach(consider);
  for (const row of state.list("applications")) {
    const data = asRecord(row.data);
    const oppId = normalizeId(data.opportunityID ?? data.opportunityId);
    if (oppId) ctx.appliedIds.add(oppId);
    const siteId = String(data.siteID ?? data.siteId ?? "");
    const title = String(data.title ?? "");
    if (siteId && title) ctx.appliedKeys.add(dedupeKey(siteId, title));
  }
  return ctx;
}

// ---- exhaustion memory -----------------------------------------------------

export interface ExhaustionCheck {
  exhausted: boolean;
  recheckDue: boolean;
  reason: string | null;
}

/// Pure decision used by the scheduler at scan time. `recheckDue`
/// means the monthly cooldown has elapsed and exactly one re-check
/// scan may run.
export function checkExhaustion(state: ScanCategoryState | null, now: Date): ExhaustionCheck {
  if (!state?.exhaustedUntil) return { exhausted: false, recheckDue: false, reason: null };
  const until = Date.parse(state.exhaustedUntil);
  if (Number.isFinite(until) && now.getTime() >= until) {
    return { exhausted: false, recheckDue: true, reason: null };
  }
  return {
    exhausted: true,
    recheckDue: false,
    reason: `skipped: exhausted until ${state.exhaustedUntil.slice(0, 10)}`,
  };
}

/// Fold one successful scan's yield into the category memory.
/// Failures never reach this function (they count toward nothing —
/// only successful scans with zero new items count as empty).
export function updateExhaustionAfterScan(
  state: ScanCategoryState,
  surfacedCount: number,
  now: Date,
  wasRecheck: boolean,
): ScanCategoryState {
  const nowIso = now.toISOString();
  const next: ScanCategoryState = {
    ...state,
    trackingSince: state.trackingSince ?? nowIso,
    lastScanAt: nowIso,
  };
  if (surfacedCount > 0) {
    next.lastNewFoundAt = nowIso;
    next.consecutiveEmptyScans = 0;
    next.exhaustedUntil = null;
    return next;
  }
  next.consecutiveEmptyScans = state.consecutiveEmptyScans + 1;
  if (wasRecheck) {
    // The monthly re-check found nothing either: cool down again.
    next.exhaustedUntil = new Date(now.getTime() + EXHAUSTION_COOLDOWN_DAYS * DAY_MS).toISOString();
    return next;
  }
  const reference = Date.parse(state.lastNewFoundAt ?? next.trackingSince ?? nowIso);
  const quietForMs = now.getTime() - (Number.isFinite(reference) ? reference : now.getTime());
  if (
    next.consecutiveEmptyScans >= MIN_EMPTY_SCANS_BEFORE_EXHAUST &&
    quietForMs >= EXHAUSTION_WINDOW_DAYS * DAY_MS
  ) {
    next.exhaustedUntil = new Date(now.getTime() + EXHAUSTION_COOLDOWN_DAYS * DAY_MS).toISOString();
  }
  return next;
}

/// Which categories a user decision reopens (brief step 7): adding
/// a site in a category reopens that category; changing the rate
/// floor or location reopens every category (either can make old
/// listings newly relevant or newly reachable). Returns "*" for
/// all, a list of categories, or [] for no change.
export function categoriesToReopen(
  before: { profile: ScanProfile; siteCategories: Map<string, string> },
  after: { profile: ScanProfile; siteCategories: Map<string, string> },
): string[] | "*" {
  if (
    before.profile.hourlyRateFloor !== after.profile.hourlyRateFloor ||
    before.profile.locationLabel.trim().toLowerCase() !== after.profile.locationLabel.trim().toLowerCase()
  ) {
    return "*";
  }
  const reopened = new Set<string>();
  for (const [siteId, category] of after.siteCategories) {
    if (category && before.siteCategories.get(siteId) !== category) reopened.add(category);
  }
  return [...reopened];
}

// ---- scan persistence (per-user DO tables) ---------------------------------

export interface ScanDb {
  getCategory(category: string): ScanCategoryState | null;
  listCategories(): ScanCategoryState[];
  putCategory(state: ScanCategoryState): void;
  getSiteState(siteId: string): ScanSiteState | null;
  listSiteStates(): ScanSiteState[];
  putSiteState(state: ScanSiteState): void;
  addRun(run: ScanRunRecord): void;
  hasRun(siteId: string, runDate: string, slot: number): boolean;
  countRunsForDate(runDate: string): number;
  listRecentRuns(limit: number): ScanRunRecord[];
}

export class ScanStore {
  db: ScanDb;
  constructor(db: ScanDb) {
    this.db = db;
  }

  categoryState(category: string): ScanCategoryState {
    return this.db.getCategory(category) ?? {
      category,
      trackingSince: null,
      lastScanAt: null,
      lastNewFoundAt: null,
      consecutiveEmptyScans: 0,
      exhaustedUntil: null,
    };
  }

  siteState(site: ScanSite): ScanSiteState {
    return this.db.getSiteState(site.id) ?? {
      siteId: site.id,
      domain: site.domain,
      stale: false,
      staleReason: null,
      staleSince: null,
      needsYouItemId: null,
      publicOnlyBlocked: false,
      lastScanAt: null,
    };
  }

  /// A re-saved login (or any successful mission on the domain)
  /// ends the failure episode: the site scans again and a future
  /// failure may raise a fresh needs-you item.
  clearStaleForDomain(domain: string): number {
    const normalized = domain.toLowerCase();
    let cleared = 0;
    for (const state of this.db.listSiteStates()) {
      if (state.domain.toLowerCase() === normalized && (state.stale || state.publicOnlyBlocked)) {
        this.db.putSiteState({
          ...state, stale: false, staleReason: null, staleSince: null,
          needsYouItemId: null, publicOnlyBlocked: false,
        });
        cleared += 1;
      }
    }
    return cleared;
  }

  clearExhaustion(categories: string[] | "*"): number {
    let cleared = 0;
    for (const state of this.db.listCategories()) {
      if (categories !== "*" && !categories.includes(state.category)) continue;
      if (state.exhaustedUntil || state.consecutiveEmptyScans > 0) {
        this.db.putCategory({ ...state, exhaustedUntil: null, consecutiveEmptyScans: 0 });
        cleared += 1;
      }
    }
    return cleared;
  }
}

/// In-memory ScanDb for tests (mirrors MemoryStateDb in state.ts).
export class MemoryScanDb implements ScanDb {
  categories = new Map<string, ScanCategoryState>();
  sites = new Map<string, ScanSiteState>();
  runs: ScanRunRecord[] = [];
  getCategory(category: string) { return this.categories.get(category) ?? null; }
  listCategories() { return [...this.categories.values()]; }
  putCategory(state: ScanCategoryState) { this.categories.set(state.category, { ...state }); }
  getSiteState(siteId: string) { return this.sites.get(siteId) ?? null; }
  listSiteStates() { return [...this.sites.values()]; }
  putSiteState(state: ScanSiteState) { this.sites.set(state.siteId, { ...state }); }
  addRun(run: ScanRunRecord) {
    if (this.hasRun(run.siteId, run.runDate, run.slot)) {
      throw new Error(`scan run already recorded for ${run.siteId} ${run.runDate} slot ${run.slot}`);
    }
    this.runs.push({ ...run });
  }
  hasRun(siteId: string, runDate: string, slot: number) {
    return this.runs.some((r) => r.siteId === siteId && r.runDate === runDate && r.slot === slot);
  }
  countRunsForDate(runDate: string) {
    return this.runs.filter((r) => r.runDate === runDate).length;
  }
  listRecentRuns(limit: number) {
    return [...this.runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
  }
}

/// Adapt DO SQLite (`ctx.storage.sql`) to ScanDb, same pattern as
/// createSqliteStateDb in state.ts.
export function createSqliteScanDb(
  sql: { exec: (query: string, ...params: unknown[]) => Iterable<Record<string, unknown>> },
): ScanDb {
  const toCategory = (r: Record<string, unknown>): ScanCategoryState => ({
    category: String(r.category),
    trackingSince: r.tracking_since ? String(r.tracking_since) : null,
    lastScanAt: r.last_scan_at ? String(r.last_scan_at) : null,
    lastNewFoundAt: r.last_new_found_at ? String(r.last_new_found_at) : null,
    consecutiveEmptyScans: Number(r.consecutive_empty ?? 0),
    exhaustedUntil: r.exhausted_until ? String(r.exhausted_until) : null,
  });
  const toSite = (r: Record<string, unknown>): ScanSiteState => ({
    siteId: String(r.site_id),
    domain: String(r.domain),
    stale: Boolean(Number(r.stale ?? 0)),
    staleReason: r.stale_reason ? String(r.stale_reason) : null,
    staleSince: r.stale_since ? String(r.stale_since) : null,
    needsYouItemId: r.needs_you_item_id ? String(r.needs_you_item_id) : null,
    publicOnlyBlocked: Boolean(Number(r.public_only_blocked ?? 0)),
    lastScanAt: r.last_scan_at ? String(r.last_scan_at) : null,
  });
  const toRun = (r: Record<string, unknown>): ScanRunRecord => ({
    id: String(r.id), siteId: String(r.site_id), domain: String(r.domain),
    category: String(r.category), tier: r.tier === "public" ? "public" : "logged",
    slot: Number(r.slot), runDate: String(r.run_date), startedAt: String(r.started_at),
    status: String(r.status) as ScanRunStatus,
    itemsFound: Number(r.items_found), itemsSurfaced: Number(r.items_surfaced),
    itemsFiltered: Number(r.items_filtered),
    skillPath: r.skill_path ? String(r.skill_path) : null,
    errorReason: r.error_reason ? String(r.error_reason) : null,
  });
  return {
    getCategory(category) {
      const rows = [...sql.exec("SELECT * FROM scan_category_state WHERE category = ?", category)];
      return rows.length ? toCategory(rows[0]) : null;
    },
    listCategories() {
      return [...sql.exec("SELECT * FROM scan_category_state ORDER BY category")].map(toCategory);
    },
    putCategory(s) {
      sql.exec(
        `INSERT INTO scan_category_state (category, tracking_since, last_scan_at, last_new_found_at, consecutive_empty, exhausted_until)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(category) DO UPDATE SET
           tracking_since = excluded.tracking_since, last_scan_at = excluded.last_scan_at,
           last_new_found_at = excluded.last_new_found_at, consecutive_empty = excluded.consecutive_empty,
           exhausted_until = excluded.exhausted_until`,
        s.category, s.trackingSince, s.lastScanAt, s.lastNewFoundAt, s.consecutiveEmptyScans, s.exhaustedUntil,
      );
    },
    getSiteState(siteId) {
      const rows = [...sql.exec("SELECT * FROM scan_site_state WHERE site_id = ?", siteId)];
      return rows.length ? toSite(rows[0]) : null;
    },
    listSiteStates() {
      return [...sql.exec("SELECT * FROM scan_site_state ORDER BY site_id")].map(toSite);
    },
    putSiteState(s) {
      sql.exec(
        `INSERT INTO scan_site_state (site_id, domain, stale, stale_reason, stale_since, needs_you_item_id, public_only_blocked, last_scan_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(site_id) DO UPDATE SET
           domain = excluded.domain, stale = excluded.stale, stale_reason = excluded.stale_reason,
           stale_since = excluded.stale_since, needs_you_item_id = excluded.needs_you_item_id,
           public_only_blocked = excluded.public_only_blocked, last_scan_at = excluded.last_scan_at`,
        s.siteId, s.domain, s.stale ? 1 : 0, s.staleReason, s.staleSince,
        s.needsYouItemId, s.publicOnlyBlocked ? 1 : 0, s.lastScanAt,
      );
    },
    addRun(r) {
      sql.exec(
        `INSERT INTO scan_runs (id, site_id, domain, category, tier, slot, run_date, started_at, status, items_found, items_surfaced, items_filtered, skill_path, error_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        r.id, r.siteId, r.domain, r.category, r.tier, r.slot, r.runDate, r.startedAt,
        r.status, r.itemsFound, r.itemsSurfaced, r.itemsFiltered, r.skillPath, r.errorReason,
      );
    },
    hasRun(siteId, runDate, slot) {
      const rows = [...sql.exec(
        "SELECT COUNT(*) AS n FROM scan_runs WHERE site_id = ? AND run_date = ? AND slot = ?",
        siteId, runDate, slot,
      )];
      return Number(rows[0]?.n ?? 0) > 0;
    },
    countRunsForDate(runDate) {
      const rows = [...sql.exec("SELECT COUNT(*) AS n FROM scan_runs WHERE run_date = ?", runDate)];
      return Number(rows[0]?.n ?? 0);
    },
    listRecentRuns(limit) {
      return [...sql.exec("SELECT * FROM scan_runs ORDER BY started_at DESC LIMIT ?", limit)].map(toRun);
    },
  };
}

// ---- surfacing payloads ------------------------------------------------------

/// Server-side feed item for a surfaced listing (Brief 01
/// structures): an Opportunity payload the app can decode, with
/// source site + found-at stamp. isDemo is forced false again by
/// StateStore for feed items; set here so opportunities agree.
export function opportunityPayload(
  listing: ScanListing, site: ScanSite, id: string, foundAtIso: string,
  rankScore: number | null = null,
): Record<string, unknown> {
  return {
    id,
    siteID: site.siteID,
    title: listing.title,
    summary: listing.summary || `Found on ${site.name}. Open it to see the details.`,
    category: validCategory(site.category, listing.category),
    payLabel: listing.payLabel || "See listing",
    estimatedHourly: listing.estimatedHourly,
    estimatedGross: null,
    currencyCode: "USD",
    locationLabel: listing.locationLabel || (listing.isRemote ? "Work from home" : "See listing"),
    isRemote: listing.isRemote,
    requiredSkills: listing.requiredSkills,
    urlString: listing.urlString || site.startURLString,
    isDemo: false,
    is_demo: false,
    status: "new",
    sourceSite: site.name,
    sourceSiteId: site.siteID,
    foundAt: foundAtIso,
    foundVia: "scheduled-scan",
    // Brief 06: the server ranker is the one ordering truth; the app
    // orders by this score and uses its local match code for display
    // evidence only.
    rankScore,
    distanceKm: listing.distanceKm,
    postedAt: listing.postedAt,
  };
}

/// The one needs-you item of a login-failure episode. Same feed
/// shape as a listing so it renders in the existing feed; flagged
/// needsYou so future app work can style it apart. Copy is plain
/// sentences only — no internal terms.
export function needsYouPayload(
  site: ScanSite, id: string, nowIso: string, needsCheck: boolean,
): Record<string, unknown> {
  return {
    id,
    siteID: site.siteID,
    title: needsCheck
      ? `${site.name} asked for a check only you can do`
      : `Your saved login for ${site.name} needs you`,
    summary: needsCheck
      ? `When I looked for new work on ${site.name}, it asked for a check only you can do, so I stopped there. I will not look again until you open the site and finish it. Nothing was sent or booked.`
      : `When I looked for new work on ${site.name}, your saved login did not work, so I stopped there. I will not look again until you save your login for ${site.name} again in the app. Nothing was sent or booked.`,
    category: validCategory(site.category),
    payLabel: "Needs you",
    estimatedHourly: null,
    estimatedGross: null,
    currencyCode: "USD",
    locationLabel: "See listing",
    isRemote: false,
    requiredSkills: [],
    urlString: site.startURLString,
    isDemo: false,
    is_demo: false,
    status: "new",
    sourceSite: site.name,
    sourceSiteId: site.siteID,
    foundAt: nowIso,
    foundVia: "scheduled-scan",
    needsYou: true,
    needsYouKind: needsCheck ? "humanCheck" : "login",
  };
}

/// End a login-failure episode for a domain: clear the stale flags
/// and remove the episode's needs-you item from the feed. Called
/// when the user re-saves the login and when any mission on the
/// domain succeeds again (proof the sign-in works).
export function clearStaleEpisode(scans: ScanStore, state: StateStore, domain: string): number {
  const normalized = domain.toLowerCase();
  const itemIds = scans.db.listSiteStates()
    .filter((s) => s.domain.toLowerCase() === normalized && s.needsYouItemId)
    .map((s) => s.needsYouItemId as string);
  const cleared = scans.clearStaleForDomain(domain);
  for (const id of itemIds) {
    state.remove("feedItems", id);
    state.remove("opportunities", id);
  }
  return cleared;
}

// ---- the tick ------------------------------------------------------------------

export interface ScanMissionInput {
  site: ScanSite;
  tier: ScanTier;
  credentialId: string | null;
  profile: ScanProfile;
  sessionHealth: SessionHealthInfo | null;
}

export interface ScanMissionOutcome {
  status: "succeeded" | "failed" | "needs_human";
  items: string[];
  /// The saved login / trusted sign-in was rejected (expired
  /// session that the vault login could not revive, wrong secret).
  loginFailure?: boolean;
  /// A human-only check (bot check, two-factor, identity) stopped
  /// the scan. Never bypassed; the user is asked once per episode.
  needsHuman?: boolean;
  /// The mission hit a mobile-app wall (Brief 06 re-probe trigger).
  /// Distinct from needsHuman, which is generic. One strike triggers
  /// a probe; a confirming probe or a second strike disqualifies.
  appWall?: boolean;
  errorReason?: string | null;
  skillPath?: string | null;
  taskId?: string | null;
}

export interface ProbeMissionInput {
  site: ScanSite;
  profile: ScanProfile;
}

export interface ScanDeps {
  state: StateStore;
  scans: ScanStore;
  credentialIdForDomain(domain: string): string | null;
  sessionHealthForDomain(domain: string): SessionHealthInfo | null;
  runDiscoverMission(input: ScanMissionInput): Promise<ScanMissionOutcome>;
  /// Brief 06 site catalog (D1) access + probe. Fail-closed: with no
  /// catalog injected, eligibility cannot be verified and nothing
  /// scans (production always injects D1; tests inject fakes). See
  /// web-access.ts for the unknown one-cycle rule.
  siteAccessForDomain?: (domain: string) => Promise<SiteAccessRecord | null> | SiteAccessRecord | null;
  saveSiteAccess?: (record: SiteAccessRecord) => Promise<void> | void;
  runProbeMission?: (input: ProbeMissionInput) => Promise<ProbeOutcome>;
  idFactory?: () => string;
  log?: (message: string) => void;
}

export interface ScanSkip {
  siteId: string;
  siteName: string;
  reason:
    | "notApproved" | "missingUrl" | "staleLogin" | "publicOnlyBlocked"
    | "notDueThisSlot" | "exhausted" | "alreadyRan" | "dailyCap"
    | "notWebAccessible" | "webAccessUnknown";
  detail: string;
}

export interface ScanTickSummary {
  slot: number;
  runDate: string;
  paused: boolean;
  scanned: ScanRunRecord[];
  skipped: ScanSkip[];
  surfacedIds: string[];
  needsYouItemIds: string[];
  /// Site proposals withdrawn because their site became ineligible.
  withdrawnProposalIds: string[];
  /// "Ignored" feedback events derived this tick (ids).
  ignoredEventIds: string[];
  filtered: { title: string; siteId: string; reasons: GateReason[] }[];
  /// Always zero by construction — asserted in tests. Scans create
  /// discover work and feed items only, never write tasks.
  writeTasksCreated: 0;
  log: string[];
}

/// One scheduled tick for ONE user (this user's Durable Object).
/// The fleet sweeper calls this per user; nothing here can see or
/// touch another user's state.
export async function runScheduledTick(
  deps: ScanDeps, opts: { slot: number; now: Date },
): Promise<ScanTickSummary> {
  const nowIso = opts.now.toISOString();
  const runDate = runDateOf(opts.now);
  const log: string[] = [];
  const say = (m: string) => { log.push(m); deps.log?.(m); };
  const summary: ScanTickSummary = {
    slot: opts.slot, runDate, paused: false, scanned: [], skipped: [],
    surfacedIds: [], needsYouItemIds: [], withdrawnProposalIds: [],
    ignoredEventIds: [], filtered: [], writeTasksCreated: 0, log,
  };

  const profileRow = deps.state.get("profile", PROFILE_ROW_ID);
  const { profile, isPaused } = extractProfile(profileRow?.data);
  // Paused means paused: the server-side flag (Brief 01 profile
  // singleton, written by the app's pause switch through state
  // import) is honored before any site is even considered.
  if (isPaused) {
    summary.paused = true;
    say("scheduled scan skipped: user is paused");
    return summary;
  }

  const accountStates = new Map<string, string>();
  for (const row of deps.state.list("accountStates")) {
    const data = asRecord(row.data);
    accountStates.set(row.id, accountStateOf(data));
    const siteId = normalizeId(data.siteID ?? data.siteId);
    if (siteId) accountStates.set(siteId, accountStateOf(data));
  }
  const sites: ScanSite[] = [];
  for (const row of deps.state.list("sites")) {
    const site = scanSiteFromRow(row.id, row.data);
    if (site) sites.push(site);
    else summary.skipped.push({ siteId: row.id, siteName: row.id, reason: "missingUrl", detail: "site row has no usable address" });
  }
  sites.sort((a, b) => a.id.localeCompare(b.id));

  const gate = buildGateContext(deps.state, profile);

  // Brief 06 learning upkeep for this user only: derive "ignored"
  // feedback for untouched listings, drop decayed inferred beliefs,
  // and load the (possibly rebuilt) learning model the ranker reads.
  const ignored = deriveIgnoredEvents(deps.state, opts.now);
  summary.ignoredEventIds.push(...ignored.created.map((e) => e.id));
  pruneExpiredInferredBeliefs(deps.state, opts.now);
  const learning: LearningProfile = ignored.profile;

  // Web-access resolution (Brief 06): catalog verdict by domain,
  // probing first-contact/stale sites before any scan mission.
  let journalSeq = 0;
  const withdrawIfIneligible = (site: ScanSite, rec: SiteAccessRecord) => {
    if (rec.webAccessible !== "false") return;
    const withdrawn = withdrawProposalsForSite(
      deps.state, { siteID: site.siteID, name: site.name },
      rec.probeEvidence ?? "This site can only be used in its phone app.",
      nowIso, () => deps.idFactory?.() ?? `withdrawn-${site.id}-${++journalSeq}`,
    );
    if (withdrawn.length) {
      summary.withdrawnProposalIds.push(...withdrawn);
      say(`${site.name}: withdrawn ${withdrawn.length} suggestion(s) — it can only be used in its phone app`);
    }
  };
  const resolveAccess = async (site: ScanSite): Promise<{ eligibility: Eligibility; record: SiteAccessRecord; probed: boolean }> => {
    // Fail closed on catalog trouble: a read/write failure (e.g. the
    // 0005 migration not applied yet) is NOT a fresh unknown — it
    // must never re-arm the one-cycle allowance or an unthrottled
    // probe on every tick.
    if (!deps.siteAccessForDomain) {
      return { eligibility: "unknownBlocked", record: unknownAccessRecord(site.domain), probed: false };
    }
    let rec: SiteAccessRecord;
    try {
      rec = (await deps.siteAccessForDomain(site.domain)) ?? unknownAccessRecord(site.domain);
    } catch {
      say(`${site.name}: web check catalog unavailable; not scanned`);
      return { eligibility: "unknownBlocked", record: unknownAccessRecord(site.domain), probed: false };
    }
    const trySave = async (r: SiteAccessRecord): Promise<boolean> => {
      try { await deps.saveSiteAccess?.(r); return true; } catch { return false; }
    };
    let probed = false;
    if (reprobeDue(rec, opts.now) && deps.runProbeMission) {
      probed = true;
      let outcome: ProbeOutcome;
      try {
        outcome = await deps.runProbeMission({ site, profile });
      } catch (e) {
        outcome = { status: "failed", evidence: String((e as Error)?.message ?? e).slice(0, 200) };
      }
      rec = applyProbeOutcome(rec, outcome, nowIso);
      if (!(await trySave(rec))) {
        say(`${site.name}: web check result could not be recorded; not scanned`);
        return { eligibility: "unknownBlocked", record: rec, probed };
      }
      say(`${site.name}: web check finished (web_accessible=${rec.webAccessible})`);
    }
    withdrawIfIneligible(site, rec);
    // The one unknown cycle is consumed by the tick only at the
    // point a scan actually runs (see below): a probe that spends
    // the day's cap must not also burn the allowance.
    return { eligibility: eligibilityOf(rec, site.domain), record: rec, probed };
  };

  // Cap from the approved mix; runs already recorded today count.
  let loggedCount = 0;
  let publicCount = 0;
  const tiers = new Map<string, { tier: ScanTier; credentialId: string | null }>();
  for (const site of sites) {
    if (!isSiteApproved(accountStates.get(site.id) ?? "")) continue;
    const credentialId = deps.credentialIdForDomain(site.domain);
    const tier: ScanTier = credentialId ? "logged" : "public";
    tiers.set(site.id, { tier, credentialId });
    if (tier === "logged") loggedCount += 1; else publicCount += 1;
  }
  const cap = dailyCap(loggedCount, publicCount);
  let capRemaining = Math.max(0, cap - deps.scans.db.countRunsForDate(runDate));

  for (const site of sites) {
    const accountState = accountStates.get(site.id) ?? "";
    if (!isSiteApproved(accountState)) {
      // Proposed but not approved: never scanned and never probed
      // (brief), but a proven-ineligible verdict still withdraws
      // the open suggestion — most proposals live exactly here, in
      // the .proposed state (onboarding/backend generated alike).
      if (deps.siteAccessForDomain) {
        try {
          const rec = await deps.siteAccessForDomain(site.domain);
          if (rec) withdrawIfIneligible(site, rec);
        } catch { /* catalog error: proposals stay until a verdict can be read */ }
      }
      summary.skipped.push({ siteId: site.id, siteName: site.name, reason: "notApproved", detail: `account state "${accountState || "none"}" has no user approval to watch` });
      continue;
    }
    const { tier, credentialId } = tiers.get(site.id)!;
    const siteState = deps.scans.siteState(site);
    if (siteState.stale) {
      // Expired/rejected login episode: no further scans (not even
      // public ones) until the user fixes it (brief step 8).
      summary.skipped.push({ siteId: site.id, siteName: site.name, reason: "staleLogin", detail: `skipped: saved login needs the user (${siteState.staleReason ?? "login failed"})` });
      continue;
    }
    if (tier === "public" && siteState.publicOnlyBlocked) {
      summary.skipped.push({ siteId: site.id, siteName: site.name, reason: "publicOnlyBlocked", detail: "skipped: nothing readable on this site without a login" });
      continue;
    }
    if (!isTierDueAtSlot(tier, opts.slot)) {
      summary.skipped.push({ siteId: site.id, siteName: site.name, reason: "notDueThisSlot", detail: `public listings are checked once a day (slot ${PUBLIC_SCAN_SLOT})` });
      continue;
    }
    const categoryKey = (site.category || site.domain).toLowerCase();
    const categoryBefore = deps.scans.categoryState(categoryKey);
    const exhaustion = checkExhaustion(categoryBefore, opts.now);
    if (exhaustion.exhausted) {
      say(`${site.name}: ${exhaustion.reason}`);
      summary.skipped.push({ siteId: site.id, siteName: site.name, reason: "exhausted", detail: exhaustion.reason ?? "skipped: exhausted" });
      continue;
    }
    if (deps.scans.db.hasRun(site.id, runDate, opts.slot)) {
      summary.skipped.push({ siteId: site.id, siteName: site.name, reason: "alreadyRan", detail: "this slot already ran for this site today" });
      continue;
    }
    if (capRemaining <= 0) {
      say(`daily scan cap reached (${cap}); ${site.name} waits until tomorrow`);
      summary.skipped.push({ siteId: site.id, siteName: site.name, reason: "dailyCap", detail: `daily cap of ${cap} scan(s) reached` });
      continue;
    }

    // Web-access gate: resolved (with a probe on first contact or a
    // stale verdict) before any mission runs. Ineligible and
    // spent-unknown sites are never scanned.
    const access = await resolveAccess(site);
    if (access.probed) capRemaining -= 1; // probes are missions too: debited from the daily cap
    gate.siteWebEligibility = access.eligibility;
    if (access.eligibility === "ineligible" || access.eligibility === "unknownBlocked") {
      const ineligible = access.eligibility === "ineligible";
      say(`${site.name}: ${ineligible ? "not usable on the web; not scanned" : "web check still unknown after its one allowed look; not scanned"}`);
      summary.skipped.push({
        siteId: site.id, siteName: site.name,
        reason: ineligible ? "notWebAccessible" : "webAccessUnknown",
        detail: ineligible
          ? "skipped: this site can only be used in its phone app"
          : "skipped: web check has not passed yet",
      });
      continue;
    }
    if (access.probed && capRemaining <= 0) {
      say(`daily scan cap reached (${cap}); ${site.name} waits until tomorrow`);
      summary.skipped.push({ siteId: site.id, siteName: site.name, reason: "dailyCap", detail: `daily cap of ${cap} mission(s) reached (web check included)` });
      continue;
    }
    let accessRecord = access.record;
    if (access.eligibility === "unknownAllowed") {
      accessRecord = consumeUnknownCycle(access.record);
      try {
        await deps.saveSiteAccess?.(accessRecord);
      } catch {
        say(`${site.name}: web check allowance could not be recorded; not scanned`);
        summary.skipped.push({ siteId: site.id, siteName: site.name, reason: "webAccessUnknown", detail: "skipped: web check has not passed yet" });
        continue;
      }
      say(`${site.name}: web check still unknown; this is its one allowed look before a check must pass`);
    }

    // Expired trusted sign-ins do not change the tier: the mission
    // probes the restored session and falls back to the saved login
    // (agent.ts); only a login that then fails ends the episode
    // below. "unsupported" trust just means a fresh login each scan.
    const sessionHealth = deps.sessionHealthForDomain(site.domain);
    let outcome: ScanMissionOutcome;
    try {
      outcome = await deps.runDiscoverMission({ site, tier, credentialId, profile, sessionHealth });
    } catch (e) {
      outcome = { status: "failed", items: [], errorReason: String((e as Error)?.message ?? e).slice(0, 200) };
    }
    capRemaining -= 1;
    deps.scans.db.putSiteState({ ...siteState, lastScanAt: nowIso });

    if (outcome.appWall) {
      // Re-probe trigger: strike once, then let a fresh probe decide
      // (the one retry). A confirming probe or a second strike
      // disqualifies and withdraws any open suggestions.
      let rec = applyAppWallStrike(accessRecord, nowIso);
      if (rec.webAccessible !== "false" && deps.runProbeMission) {
        try {
          rec = applyProbeOutcome(rec, await deps.runProbeMission({ site, profile }), nowIso);
          capRemaining -= 1; // the retry probe is a mission too
        } catch { /* an inconclusive probe leaves the strike in place */ }
      }
      await deps.saveSiteAccess?.(rec);
      say(`${site.name}: a step could only be done in its phone app (web_accessible=${rec.webAccessible})`);
      withdrawIfIneligible(site, rec);
      gate.siteWebEligibility = eligibilityOf(rec, site.domain);
    }

    const baseRun: ScanRunRecord = {
      id: deps.idFactory?.() ?? `scan-${site.id}-${runDate}-${opts.slot}`,
      siteId: site.id, domain: site.domain, category: categoryKey, tier,
      slot: opts.slot, runDate, startedAt: nowIso,
      status: "failed", itemsFound: 0, itemsSurfaced: 0, itemsFiltered: 0,
      skillPath: outcome.skillPath ?? null, errorReason: outcome.errorReason ?? null,
    };

    if (outcome.status !== "succeeded") {
      const episode = tier === "logged" && (outcome.loginFailure || outcome.needsHuman || outcome.status === "needs_human");
      const run: ScanRunRecord = {
        ...baseRun,
        status: episode ? "login_failed" : "failed",
        errorReason: outcome.errorReason
          ?? (outcome.loginFailure ? "saved login was rejected"
            : outcome.needsHuman || outcome.status === "needs_human" ? "site asked for a human-only check"
            : "scan did not finish"),
      };
      deps.scans.db.addRun(run);
      summary.scanned.push(run);
      say(`${site.name}: scan ${run.status} (${run.errorReason})`);
      if (tier === "public" && (outcome.needsHuman || outcome.status === "needs_human")) {
        // A public page behind a human-only check is not readable
        // without the user: stop public scans until a login exists
        // rather than hitting the same check every day.
        const fresh = deps.scans.siteState(site);
        deps.scans.db.putSiteState({ ...fresh, publicOnlyBlocked: true, lastScanAt: nowIso });
      }
      if (episode) {
        // Exactly one needs-you item per episode: the deterministic
        // id + the stale flag mean repeats update the same card and
        // then stop entirely until the user acts.
        const itemId = needsYouItemId(site.id);
        const fresh = deps.scans.siteState(site);
        deps.scans.db.putSiteState({
          ...fresh, stale: true,
          staleReason: outcome.needsHuman || outcome.status === "needs_human" ? "humanCheck" : "loginFailed",
          staleSince: nowIso, needsYouItemId: itemId, lastScanAt: nowIso,
        });
        const payload = needsYouPayload(site, itemId, nowIso, !(outcome.loginFailure));
        deps.state.upsert("opportunities", itemId, payload, nowIso);
        deps.state.upsert("feedItems", itemId, payload, nowIso);
        gate.existingKeys.add(dedupeKey(site.id, String(payload.title)));
        gate.existingIds.add(normalizeId(itemId));
        summary.needsYouItemIds.push(itemId);
      }
      // Failures count toward nothing: no exhaustion update, retry
      // at the next scheduled slot (unless an episode blocks it).
      continue;
    }

    const listings = parseListings(outcome.items ?? [], site);
    let surfaced = 0;
    // Gate first, then the one ranker orders what passed and drops
    // anything below the surfacing threshold. No score can resurrect
    // a gate-dropped listing (below-floor stays dropped).
    const passed: { item: ScanListing; rank: ReturnType<typeof rankItem>; key: string }[] = [];
    for (const listing of listings) {
      const decision = evaluateGate(listing, gate);
      if (!decision.pass) {
        summary.filtered.push({ title: listing.title, siteId: site.id, reasons: decision.reasons });
        continue;
      }
      const rank = rankItem({
        category: listing.category || site.category,
        requiredSkills: listing.requiredSkills,
        estimatedHourly: listing.estimatedHourly,
        distanceKm: listing.distanceKm ?? null,
        isRemote: listing.isRemote,
        postedAt: listing.postedAt ?? null,
      }, profile, learning, opts.now);
      if (rank.score < SURFACING_THRESHOLD) {
        summary.filtered.push({ title: listing.title, siteId: site.id, reasons: ["belowRankThreshold"] });
        continue;
      }
      passed.push({ item: listing, rank, key: dedupeKey(site.id, listing.title) });
    }
    for (const { item: listing, rank } of sortByRank(passed)) {
      const id = scanOpportunityId(site.id, listing.title);
      const payload = opportunityPayload(listing, site, id, nowIso, rank.score);
      deps.state.upsert("opportunities", id, payload, nowIso);
      deps.state.upsert("feedItems", id, payload, nowIso);
      gate.existingKeys.add(dedupeKey(site.id, listing.title));
      gate.existingIds.add(normalizeId(id));
      summary.surfacedIds.push(id);
      surfaced += 1;
    }

    if (tier === "public" && listings.length === 0) {
      // Nothing readable without a login: stop public scans for
      // this site until a login exists (brief step 6). A successful
      // login later clears this via clearStaleEpisode.
      const fresh = deps.scans.siteState(site);
      deps.scans.db.putSiteState({ ...fresh, publicOnlyBlocked: true, lastScanAt: nowIso });
      say(`${site.name}: no public listings readable; public scans paused until a login is saved`);
    }

    const run: ScanRunRecord = {
      ...baseRun,
      status: surfaced > 0 ? "succeeded" : "empty",
      itemsFound: listings.length,
      itemsSurfaced: surfaced,
      itemsFiltered: listings.length - surfaced,
    };
    deps.scans.db.addRun(run);
    summary.scanned.push(run);
    say(`${site.name}: ${listings.length} listing(s) read, ${surfaced} new in the feed`);

    const updated = updateExhaustionAfterScan(
      deps.scans.categoryState(categoryKey), surfaced, opts.now, exhaustion.recheckDue,
    );
    deps.scans.db.putCategory(updated);
    if (updated.exhaustedUntil && !categoryBefore.exhaustedUntil) {
      say(`${site.name}: nothing new for a while in this kind of work; I will check again around ${updated.exhaustedUntil.slice(0, 10)}`);
    }
  }

  return summary;
}
