/// Profile learning (Brief 06): the structured feedback taxonomy,
/// the transparent per-user learning model (category/skill affinities
/// + reason sensitivities), stated-vs-inferred belief semantics, and
/// THE ranking function. The ranker here is the single ranking truth
/// for what surfaces first: scan.ts surfacing and site proposals both
/// call it. The Swift MatchEngine is display evidence only.
///
/// Final values (documented in docs/profile-learning.md):
/// - Base weights seeded from the former Swift MatchEngine:
///   category 0.35, skills 0.35, pay 0.20, location/remote 0.10.
/// - Surfacing threshold 0.45 (the old MatchEngine keepThreshold).
/// - Ignored: surfaced >= 7 days with no action (weak negative).
/// - Inferred-belief decay half-life: 30 days; stated never decays.
/// - The rate floor is a hard bound in scan.ts's gate and is NEVER
///   changed here; repeated "too low" declines only raise a prompt.
import { normalizeId, type StateStore } from "./state.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

// ---- named ranking weights & thresholds -------------------------------

export const RANK_WEIGHTS = {
  category: 0.35,
  skills: 0.35,
  pay: 0.20,
  location: 0.10,
} as const;
/// No required skills earned 0.15 of score under the old MatchEngine
/// (0.15 out of a 0.35 skills weight); preserved so seed scores match.
export const NO_SKILLS_REQUIRED_FIT = 0.15 / RANK_WEIGHTS.skills;
/// Bounded learning adjustments sit on top of the seeded base score.
export const AFFINITY_MAX_ADJUSTMENT = 0.15;
export const SKILL_AFFINITY_MAX_ADJUSTMENT = 0.05;
export const FRESHNESS_MAX_ADJUSTMENT = 0.05;
export const FRESHNESS_HALF_LIFE_DAYS = 7;
export const TOO_LOW_MAX_PENALTY = 0.15;
export const TOO_FAR_MAX_PENALTY = 0.15;
/// Below this score an item does not surface (scan) or is not proposed.
export const SURFACING_THRESHOLD = 0.45;
/// Surfaced this many days with no action => an "ignored" event.
export const IGNORED_AFTER_DAYS = 7;
export const INFERRED_BELIEF_HALF_LIFE_DAYS = 30;
export const INFERRED_BELIEF_EXPIRY_CONFIDENCE = 0.2;
/// This many "too low" declines raises the (prompt-only) floor review.
export const RATE_FLOOR_PROMPT_MIN_TOO_LOW = 3;
export const LEARNING_PROFILE_ROW_ID = "learning";

// ---- feedback taxonomy --------------------------------------------------

export type FeedbackSubjectType = "opportunity" | "siteProposal" | "signup" | "application";
export type FeedbackAction =
  | "accepted" | "declined" | "ignored"          // opportunity
  | "approved" | "dismissed"                     // site proposal
  | "signupApproved" | "profileConfirmed"        // signup
  | "sent" | "booked" | "completed";             // application outcome
export type FeedbackReason = "tooLow" | "tooFar" | "notMyThing" | "justBusy" | "other";

/// Canonicalize what the UI already records. HomeFeedView's "Not now"
/// menu passes "too low" / "too far" / "not their thing" (its button
/// reads "Not my thing") / "just busy" — those exact strings must map.
export function normalizeFeedbackReason(raw: unknown): FeedbackReason | null {
  const s = String(raw ?? "").trim().toLowerCase().replace(/[\s_-]+/g, " ");
  if (!s) return null;
  if (s === "too low" || s === "toolow") return "tooLow";
  if (s === "too far" || s === "toofar") return "tooFar";
  if (s === "not their thing" || s === "not my thing" || s === "notmything") return "notMyThing";
  if (s === "just busy" || s === "justbusy") return "justBusy";
  return "other";
}

export interface FeedbackEvent {
  id: string;
  /// The owning user when the caller knows it. Storage is inside that
  /// user's Durable Object either way; never shared across users.
  userId: string | null;
  subjectType: FeedbackSubjectType;
  subjectId: string;
  action: FeedbackAction;
  reason: FeedbackReason | null;
  category: string | null;
  requiredSkills: string[];
  estimatedHourly: number | null;
  distanceKm: number | null;
  occurredAt: string; // ISO-8601
}

export interface FeedbackInput {
  userId?: string | null;
  subjectType: FeedbackSubjectType;
  subjectId: string;
  action: FeedbackAction;
  reason?: FeedbackReason | string | null;
  category?: string | null;
  requiredSkills?: string[];
  estimatedHourly?: number | null;
  distanceKm?: number | null;
  occurredAt?: string;
  id?: string;
}

// ---- the learning model ---------------------------------------------------

export interface CategoryAffinity {
  score: number; // -1..1
  accepts: number;
  declines: number;
  ignores: number;
  updatedAt: string | null;
}

export interface LearningProfile {
  id: string;
  affinities: Record<string, CategoryAffinity>;
  skillAffinities: Record<string, number>; // skill (lowercased) -> -1..1
  rateSensitivity: number; // 0..1, from "too low" declines
  distanceSensitivity: number; // 0..1, from "too far" declines
  reasonCounts: Record<string, number>;
  tooLowDeclines: number;
  eventCount: number;
  updatedAt: string | null;
}

export function emptyLearningProfile(): LearningProfile {
  return {
    id: LEARNING_PROFILE_ROW_ID, affinities: {}, skillAffinities: {},
    rateSensitivity: 0, distanceSensitivity: 0, reasonCounts: {},
    tooLowDeclines: 0, eventCount: 0, updatedAt: null,
  };
}

/// Per-event deltas. Ignored (-0.05) is deliberately far weaker than an
/// explicit decline (-0.20 plain / -0.30 "not my thing"); "too low" and
/// "too far" barely touch the category (the complaint is pay/distance)
/// and instead raise the matching sensitivity (+0.20 each, capped at 1).
export const FEEDBACK_DELTAS = {
  acceptCategory: 0.20, acceptSkill: 0.10,
  declineCategory: -0.20, notMyThingCategory: -0.30, notMyThingSkill: -0.15,
  tooLowCategory: -0.05, tooFarCategory: -0.05, justBusyCategory: -0.02,
  ignoredCategory: -0.05,
  sensitivityStep: 0.20,
  proposalApprovedCategory: 0.10, proposalDismissedCategory: -0.10,
  signupCategory: 0.10,
  applicationSentCategory: 0.15, applicationBookedCategory: 0.20,
  applicationCompletedCategory: 0.25,
} as const;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function affinityFor(p: LearningProfile, category: string): CategoryAffinity {
  const key = category.toLowerCase();
  return (p.affinities[key] ??= { score: 0, accepts: 0, declines: 0, ignores: 0, updatedAt: null });
}

function bumpSkill(p: LearningProfile, skills: string[], delta: number) {
  for (const s of skills) {
    const key = s.trim().toLowerCase();
    if (key) p.skillAffinities[key] = clamp((p.skillAffinities[key] ?? 0) + delta, -1, 1);
  }
}

/// Fold one event into the model. Pure and deterministic: rebuilding
/// from the stored events always reproduces the same profile, which
/// is what makes the model auditable rather than a black box.
export function applyFeedback(profile: LearningProfile, ev: FeedbackEvent): LearningProfile {
  const p: LearningProfile = {
    ...profile,
    affinities: Object.fromEntries(Object.entries(profile.affinities).map(([k, v]) => [k, { ...v }])),
    skillAffinities: { ...profile.skillAffinities },
    reasonCounts: { ...profile.reasonCounts },
  };
  const cat = ev.category ? affinityFor(p, ev.category) : null;
  const touch = (delta: number) => {
    if (cat) { cat.score = clamp(cat.score + delta, -1, 1); cat.updatedAt = ev.occurredAt; }
  };
  switch (ev.action) {
    case "accepted":
      touch(FEEDBACK_DELTAS.acceptCategory);
      if (cat) cat.accepts += 1;
      bumpSkill(p, ev.requiredSkills, FEEDBACK_DELTAS.acceptSkill);
      break;
    case "declined": {
      if (cat) cat.declines += 1;
      if (ev.reason) p.reasonCounts[ev.reason] = (p.reasonCounts[ev.reason] ?? 0) + 1;
      switch (ev.reason) {
        case "tooLow":
          touch(FEEDBACK_DELTAS.tooLowCategory);
          p.rateSensitivity = clamp(p.rateSensitivity + FEEDBACK_DELTAS.sensitivityStep, 0, 1);
          p.tooLowDeclines += 1;
          break;
        case "tooFar":
          touch(FEEDBACK_DELTAS.tooFarCategory);
          p.distanceSensitivity = clamp(p.distanceSensitivity + FEEDBACK_DELTAS.sensitivityStep, 0, 1);
          break;
        case "notMyThing":
          touch(FEEDBACK_DELTAS.notMyThingCategory);
          bumpSkill(p, ev.requiredSkills, FEEDBACK_DELTAS.notMyThingSkill);
          break;
        case "justBusy":
          touch(FEEDBACK_DELTAS.justBusyCategory);
          break;
        default:
          touch(FEEDBACK_DELTAS.declineCategory);
      }
      break;
    }
    case "ignored":
      touch(FEEDBACK_DELTAS.ignoredCategory);
      if (cat) cat.ignores += 1;
      break;
    case "approved": touch(FEEDBACK_DELTAS.proposalApprovedCategory); break;
    case "dismissed": touch(FEEDBACK_DELTAS.proposalDismissedCategory); break;
    case "signupApproved": case "profileConfirmed": touch(FEEDBACK_DELTAS.signupCategory); break;
    case "sent": touch(FEEDBACK_DELTAS.applicationSentCategory); break;
    case "booked": touch(FEEDBACK_DELTAS.applicationBookedCategory); break;
    case "completed": touch(FEEDBACK_DELTAS.applicationCompletedCategory); break;
  }
  p.eventCount += 1;
  p.updatedAt = ev.occurredAt;
  return p;
}

/// Prompt affordance ONLY: the floor never changes here. The app may
/// show this; the floor moves solely on explicit user confirmation.
export function rateFloorPrompt(p: LearningProfile, hourlyRateFloor: number):
  { shouldPrompt: boolean; tooLowDeclines: number; currentFloor: number } {
  return {
    shouldPrompt: p.tooLowDeclines >= RATE_FLOOR_PROMPT_MIN_TOO_LOW,
    tooLowDeclines: p.tooLowDeclines,
    currentFloor: hourlyRateFloor,
  };
}

// ---- storage (per-user DO state) -----------------------------------------

function asFeedbackEvent(data: unknown): FeedbackEvent | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  const id = String(d.id ?? "");
  const subjectId = String(d.subjectId ?? d.subjectID ?? "");
  const action = String(d.action ?? "") as FeedbackAction;
  const subjectType = String(d.subjectType ?? "") as FeedbackSubjectType;
  if (!id || !subjectId || !action || !subjectType) return null;
  const hourly = Number(d.estimatedHourly);
  const dist = Number(d.distanceKm);
  return {
    id, userId: d.userId ? String(d.userId) : null, subjectType, subjectId, action,
    reason: normalizeFeedbackReason(d.reason),
    category: d.category ? String(d.category) : null,
    requiredSkills: Array.isArray(d.requiredSkills) ? d.requiredSkills.map(String) : [],
    estimatedHourly: Number.isFinite(hourly) && hourly > 0 ? hourly : null,
    distanceKm: Number.isFinite(dist) && dist >= 0 ? dist : null,
    occurredAt: String(d.occurredAt ?? d.createdAt ?? new Date(0).toISOString()),
  };
}

export function listFeedbackEvents(state: StateStore): FeedbackEvent[] {
  const out: FeedbackEvent[] = [];
  for (const row of state.list("feedbackEvents")) {
    const ev = asFeedbackEvent(row.data);
    if (ev) out.push(ev);
  }
  return out.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
}

/// Rebuild the model from the event log (the audit path). Sorted by
/// (occurredAt, id) so the result is deterministic for a given log.
export function rebuildLearningProfile(events: FeedbackEvent[]): LearningProfile {
  const sorted = [...events].sort(
    (a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
  let p = emptyLearningProfile();
  for (const ev of sorted) p = applyFeedback(p, ev);
  return p;
}

export function loadLearningProfile(state: StateStore): LearningProfile {
  const row = state.get("learningProfiles", LEARNING_PROFILE_ROW_ID);
  if (row) {
    const d = row.data as Partial<LearningProfile>;
    return { ...emptyLearningProfile(), ...d, id: LEARNING_PROFILE_ROW_ID };
  }
  return emptyLearningProfile();
}

export function saveLearningProfile(state: StateStore, p: LearningProfile, nowIso: string): void {
  state.upsert("learningProfiles", LEARNING_PROFILE_ROW_ID,
    { ...p, id: LEARNING_PROFILE_ROW_ID } as unknown as Record<string, unknown>, nowIso);
}

/// The profile used for ranking: the stored cache while it covers the
/// whole event log, otherwise a deterministic rebuild (events may have
/// arrived through the app's state import since the cache was written).
export function ensureLearningProfile(state: StateStore, nowIso: string): LearningProfile {
  const events = listFeedbackEvents(state);
  const cached = loadLearningProfile(state);
  if (cached.eventCount === events.length) return cached;
  const rebuilt = rebuildLearningProfile(events);
  saveLearningProfile(state, rebuilt, nowIso);
  // Every rebuild path (app import via refreshLearning included)
  // re-proposes inferred beliefs from the new pattern — this is
  // the production ingress, not just recordFeedback.
  proposeInferredBeliefs(state, rebuilt, nowIso);
  return rebuilt;
}

let fallbackSeq = 0;
export function makeFeedbackEvent(input: FeedbackInput, nowIso: string, id?: string): FeedbackEvent {
  return {
    id: id ?? input.id ?? `fb-${nowIso}-${++fallbackSeq}`,
    userId: input.userId ?? null,
    subjectType: input.subjectType, subjectId: String(input.subjectId),
    action: input.action, reason: normalizeFeedbackReason(input.reason),
    category: input.category ? String(input.category) : null,
    requiredSkills: input.requiredSkills ?? [],
    estimatedHourly: input.estimatedHourly ?? null,
    distanceKm: input.distanceKm ?? null,
    occurredAt: input.occurredAt ?? nowIso,
  };
}

/// Record one decision: append the event, fold it into the model, and
/// let inferred beliefs be (re)proposed from the new pattern. Returns
/// the stored event and the updated profile. Never touches any rate
/// floor — there is no profile-floor parameter here by construction.
export function recordFeedback(
  state: StateStore, input: FeedbackInput, nowIso: string, idFactory?: () => string,
): { event: FeedbackEvent; profile: LearningProfile } {
  const event = makeFeedbackEvent(input, nowIso, idFactory?.());
  state.upsert("feedbackEvents", event.id, { ...event }, nowIso);
  // Rebuild-from-log is the final word: incremental application could
  // double-count if the cache was stale, the rebuild cannot.
  const rebuilt = rebuildLearningProfile(listFeedbackEvents(state));
  saveLearningProfile(state, rebuilt, nowIso);
  proposeInferredBeliefs(state, rebuilt, nowIso);
  return { event, profile: rebuilt };
}

/// Derive "ignored" events: surfaced opportunities still untouched
/// after IGNORED_AFTER_DAYS. Deterministic ids make re-derivation a
/// no-op; an opportunity with any feedback event is never ignored.
export function deriveIgnoredEvents(
  state: StateStore, now: Date,
): { created: FeedbackEvent[]; profile: LearningProfile } {
  const nowIso = now.toISOString();
  const seen = new Set(listFeedbackEvents(state).map((e) => `${e.subjectType}:${normalizeId(e.subjectId)}`));
  const appliedTo = new Set<string>();
  for (const row of state.list("applications")) {
    const d = (row.data ?? {}) as Record<string, unknown>;
    const oid = normalizeId(d.opportunityID ?? d.opportunityId);
    if (oid) appliedTo.add(oid);
  }
  const created: FeedbackEvent[] = [];
  const consider = (row: { id: string; updatedAt: string; data: unknown }) => {
    const d = (row.data ?? {}) as Record<string, unknown>;
    if (d.needsYou === true) return;
    const status = String(d.status ?? "new").toLowerCase();
    if (status !== "new") return;
    const id = normalizeId(d.id ?? row.id);
    if (!id || appliedTo.has(id) || seen.has(`opportunity:${id}`)) return;
    const surfacedAt = String(d.foundAt ?? d.surfacedAt ?? row.updatedAt ?? "");
    const t = Date.parse(surfacedAt);
    if (!Number.isFinite(t) || now.getTime() - t < IGNORED_AFTER_DAYS * DAY_MS) return;
    const ev = makeFeedbackEvent({
      subjectType: "opportunity", subjectId: id, action: "ignored",
      category: d.category ? String(d.category) : null,
      requiredSkills: Array.isArray(d.requiredSkills) ? d.requiredSkills.map(String) : [],
      estimatedHourly: typeof d.estimatedHourly === "number" ? d.estimatedHourly : null,
      distanceKm: typeof d.distanceKm === "number" ? d.distanceKm : null,
    }, nowIso, `ignored:${id}`);
    state.upsert("feedbackEvents", ev.id, { ...ev }, nowIso);
    seen.add(`opportunity:${id}`);
    created.push(ev);
  };
  state.list("opportunities").forEach(consider);
  state.list("feedItems").forEach(consider);
  const profile = created.length
    ? (() => {
        const p = rebuildLearningProfile(listFeedbackEvents(state));
        saveLearningProfile(state, p, nowIso);
        proposeInferredBeliefs(state, p, nowIso);
        return p;
      })()
    : ensureLearningProfile(state, nowIso);
  return { created, profile };
}

// ---- beliefs: stated vs inferred -------------------------------------------

export interface BeliefLike {
  id: string;
  sentence: string;
  source?: string; // youSaidIt | learnedFromWork | guessedFromChat (Swift)
  confidence: number;
  learnedAt?: string;
  pending?: boolean;
  kind?: string; // stated | inferred when written server-side
  topic?: string | null;
}

export type BeliefKind = "stated" | "inferred";

/// Mapping (final): an explicit server `kind` wins; `youSaidIt` is
/// stated (the user said it, or edited a belief — edits rewrite the
/// source to youSaidIt in Swift); a non-pending belief was confirmed
/// in the profile hub, so it is stated; anything else (pending
/// proposals, learned/guessed unconfirmed) is inferred.
export function beliefKind(b: BeliefLike): BeliefKind {
  if (b.kind === "stated" || b.kind === "inferred") return b.kind;
  if (b.source === "youSaidIt") return "stated";
  if (b.pending === false) return "stated";
  return "inferred";
}

export function effectiveBeliefConfidence(b: BeliefLike, now: Date): number {
  if (beliefKind(b) === "stated") return clamp(b.confidence, 0, 1); // never decays
  const learned = Date.parse(b.learnedAt ?? "");
  if (!Number.isFinite(learned)) return clamp(b.confidence, 0, 1);
  const ageDays = Math.max(0, (now.getTime() - learned) / DAY_MS);
  return clamp(b.confidence * Math.pow(0.5, ageDays / INFERRED_BELIEF_HALF_LIFE_DAYS), 0, 1);
}

export function isBeliefExpired(b: BeliefLike, now: Date): boolean {
  return beliefKind(b) === "inferred"
    && effectiveBeliefConfidence(b, now) < INFERRED_BELIEF_EXPIRY_CONFIDENCE;
}

function beliefTopic(b: BeliefLike): string {
  return (b.topic ?? b.sentence).trim().toLowerCase().replace(/\s+/g, " ");
}

/// Conflict resolution per topic: stated always beats inferred; within
/// one kind, higher effective confidence wins, then the newest.
export function resolveBeliefs(beliefs: BeliefLike[], now: Date): BeliefLike[] {
  const winners = new Map<string, BeliefLike>();
  for (const b of beliefs) {
    if (isBeliefExpired(b, now)) continue;
    const key = beliefTopic(b);
    const cur = winners.get(key);
    if (!cur) { winners.set(key, b); continue; }
    const kb = beliefKind(b), kc = beliefKind(cur);
    if (kb !== kc) { if (kb === "stated") winners.set(key, b); continue; }
    const eb = effectiveBeliefConfidence(b, now), ec = effectiveBeliefConfidence(cur, now);
    if (eb > ec || (eb === ec && String(b.learnedAt ?? "") > String(cur.learnedAt ?? ""))) {
      winners.set(key, b);
    }
  }
  return [...winners.values()];
}

function beliefFromRow(data: unknown): BeliefLike | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (!d.id || !d.sentence) return null;
  return {
    id: String(d.id), sentence: String(d.sentence), source: d.source ? String(d.source) : undefined,
    confidence: Number(d.confidence ?? 0.5), learnedAt: d.learnedAt ? String(d.learnedAt) : undefined,
    pending: d.pending === true, kind: d.kind ? String(d.kind) : undefined,
    topic: d.topic ? String(d.topic) : null,
  };
}

export function listBeliefs(state: StateStore): BeliefLike[] {
  return state.list("beliefs").map((r) => beliefFromRow(r.data)).filter((b): b is BeliefLike => b !== null);
}

/// Remove decayed-out inferred beliefs. Stated beliefs are never removed.
export function pruneExpiredInferredBeliefs(state: StateStore, now: Date): string[] {
  const removed: string[] = [];
  for (const b of listBeliefs(state)) {
    if (isBeliefExpired(b, now) && state.remove("beliefs", b.id)) removed.push(b.id);
  }
  return removed;
}

/// Deterministic UUID-shaped id (the app decodes belief ids as UUIDs).
function deterministicUuid(seed: string): string {
  const hash = (salt: string) => {
    let h = 0xcbf29ce484222325n;
    for (const ch of `${salt}|${seed}`) {
      h ^= BigInt(ch.codePointAt(0) ?? 0);
      h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
    }
    return h.toString(16).padStart(16, "0");
  };
  const hex = (hash("belief") + hash("hygge")).slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/// Inferred beliefs proposed from feedback patterns (pending, shown as
/// inferred, decaying until confirmed). Deterministic ids by topic;
/// a stated belief on the same topic suppresses the proposal.
export function proposeInferredBeliefs(state: StateStore, p: LearningProfile, nowIso: string): BeliefLike[] {
  const existing = listBeliefs(state);
  const statedTopics = new Set(existing.filter((b) => beliefKind(b) === "stated").map(beliefTopic));
  const existingIds = new Set(existing.map((b) => normalizeId(b.id)));
  const proposed: BeliefLike[] = [];
  const add = (topic: string, sentence: string, confidence: number) => {
    const id = deterministicUuid(`inferred|${topic}`);
    if (statedTopics.has(topic) || existingIds.has(normalizeId(id))) return;
    const b: BeliefLike = {
      id, sentence, source: "learnedFromWork", confidence,
      learnedAt: nowIso, pending: true, kind: "inferred", topic,
    };
    state.upsert("beliefs", id, { ...b }, nowIso);
    proposed.push(b);
  };
  if ((p.reasonCounts["tooFar"] ?? 0) >= 2) add("distance preference", "Prefers work close to home", 0.6);
  if ((p.reasonCounts["tooLow"] ?? 0) >= RATE_FLOOR_PROMPT_MIN_TOO_LOW) {
    add("pay preference", "Turns down work that pays too little", 0.6);
  }
  const categoryLabels: Record<string, string> = {
    petcare: "pet care", localgig: "local gig", homeservices: "home services",
    remotejob: "remote job",
  };
  for (const [cat, a] of Object.entries(p.affinities)) {
    if (a.score <= -0.5 && a.declines >= 2) {
      add(`category ${cat}`, `Turns down ${categoryLabels[cat] ?? cat} work that is not their thing`, 0.55);
    }
  }
  return proposed;
}

// ---- THE ranker --------------------------------------------------------------

export interface RankProfile {
  interests: string[];
  skills: string[];
  hourlyRateFloor: number;
  radiusKm: number;
  remoteOK: boolean;
}

export interface RankableItem {
  category: string;
  requiredSkills: string[];
  estimatedHourly: number | null;
  distanceKm: number | null; // null = unknown, never blocks
  isRemote: boolean;
  postedAt: string | null; // null = unknown freshness
}

export interface RankComponents {
  categoryFit: number; skillsFit: number; payFit: number; locationFit: number;
  base: number; affinityAdjustment: number; skillAffinityAdjustment: number;
  freshnessAdjustment: number; tooLowPenalty: number; tooFarPenalty: number;
}

export interface RankResult { score: number; components: RankComponents }

function overlaps(a: string, b: string): boolean {
  const x = a.toLowerCase().trim(), y = b.toLowerCase().trim();
  return x.length > 0 && y.length > 0 && (x.includes(y) || y.includes(x));
}

/// score = 0.35*categoryFit + 0.35*skillsFit + 0.20*payFit
///       + 0.10*locationFit + affinityAdj (+-0.15) + skillAffinityAdj
///       (+-0.05) + freshnessAdj (+-0.05) - tooLowPenalty (0..0.15)
///       - tooFarPenalty (0..0.15), clamped to 0..1.
/// Unknown distance/postedAt/pay are neutral, never blocking (the
/// scan gate separately hard-drops KNOWN below-floor pay before this
/// function is ever consulted for surfacing). Pure & deterministic.
export function rankItem(item: RankableItem, profile: RankProfile,
                         learning: LearningProfile, now: Date): RankResult {
  const category = (item.category ?? "").toLowerCase();
  const interests = profile.interests.map((s) => s.toLowerCase());
  const categoryFit = !category || interests.length === 0 ? 0.5 : interests.includes(category) ? 1 : 0;

  let skillsFit: number;
  if (item.requiredSkills.length === 0) skillsFit = NO_SKILLS_REQUIRED_FIT;
  else if (profile.skills.length === 0) skillsFit = 0;
  else {
    const hits = item.requiredSkills.filter((need) =>
      profile.skills.some((have) => overlaps(need, have))).length;
    skillsFit = hits / item.requiredSkills.length;
  }

  let payFit: number;
  if (item.estimatedHourly == null) payFit = 0.5;
  else if (profile.hourlyRateFloor <= 0) payFit = 1;
  else if (item.estimatedHourly >= profile.hourlyRateFloor) payFit = 1;
  else if (item.estimatedHourly >= profile.hourlyRateFloor * 0.8) payFit = 0.4;
  else payFit = 0;

  let locationFit: number;
  if (item.isRemote) locationFit = profile.remoteOK ? 1 : 0;
  else if (item.distanceKm == null) locationFit = 0.5; // in-person, distance unknown
  else {
    const r = profile.radiusKm > 0 ? profile.radiusKm : 20;
    locationFit = item.distanceKm <= r
      ? 1 - 0.5 * (item.distanceKm / r)
      : Math.max(0, 0.5 - 0.5 * ((item.distanceKm - r) / r));
  }

  const base = RANK_WEIGHTS.category * categoryFit + RANK_WEIGHTS.skills * skillsFit
    + RANK_WEIGHTS.pay * payFit + RANK_WEIGHTS.location * locationFit;

  const affinity = category ? (learning.affinities[category]?.score ?? 0) : 0;
  const affinityAdjustment = affinity * AFFINITY_MAX_ADJUSTMENT;

  let skillAffinityAdjustment = 0;
  if (item.requiredSkills.length) {
    const vals = item.requiredSkills.map((s) => learning.skillAffinities[s.trim().toLowerCase()] ?? 0);
    skillAffinityAdjustment = (vals.reduce((a, b) => a + b, 0) / vals.length) * SKILL_AFFINITY_MAX_ADJUSTMENT;
  }

  let freshnessAdjustment = 0;
  if (item.postedAt) {
    const t = Date.parse(item.postedAt);
    if (Number.isFinite(t)) {
      const ageDays = Math.max(0, (now.getTime() - t) / DAY_MS);
      const fresh = Math.pow(0.5, ageDays / FRESHNESS_HALF_LIFE_DAYS);
      freshnessAdjustment = (fresh - 0.5) * 2 * FRESHNESS_MAX_ADJUSTMENT;
    }
  }

  // "Too low" sensitivity bites hardest just above the floor and fades
  // by 125% of it; genuinely well-paid work is untouched.
  let tooLowPenalty = 0;
  if (item.estimatedHourly != null && profile.hourlyRateFloor > 0 && learning.rateSensitivity > 0) {
    const band = profile.hourlyRateFloor * 0.25;
    const closeness = item.estimatedHourly <= profile.hourlyRateFloor ? 1
      : Math.max(0, 1 - (item.estimatedHourly - profile.hourlyRateFloor) / band);
    tooLowPenalty = learning.rateSensitivity * TOO_LOW_MAX_PENALTY * closeness;
  }

  let tooFarPenalty = 0;
  if (!item.isRemote && item.distanceKm != null && learning.distanceSensitivity > 0) {
    const r = profile.radiusKm > 0 ? profile.radiusKm : 20;
    tooFarPenalty = learning.distanceSensitivity * TOO_FAR_MAX_PENALTY * Math.min(1, item.distanceKm / (2 * r));
  }

  const score = clamp(base + affinityAdjustment + skillAffinityAdjustment
    + freshnessAdjustment - tooLowPenalty - tooFarPenalty, 0, 1);
  return {
    score,
    components: {
      categoryFit, skillsFit, payFit, locationFit, base,
      affinityAdjustment, skillAffinityAdjustment, freshnessAdjustment,
      tooLowPenalty, tooFarPenalty,
    },
  };
}

/// Deterministic ordering: score desc, then caller key asc as tiebreak.
export function sortByRank<T>(items: { item: T; rank: RankResult; key: string }[]): { item: T; rank: RankResult; key: string }[] {
  return [...items].sort((a, b) => (b.rank.score - a.rank.score) || a.key.localeCompare(b.key));
}

export interface SiteProposalCandidate {
  name: string;
  url: string;
  rationale: string;
  category: string;
}

/// Proposals call site of the one ranker: score each candidate as an
/// item (no known pay/distance => neutral), drop ineligible sites and
/// anything below the surfacing threshold, order best first. Web
/// eligibility itself is decided in web-access.ts; `eligible` here is
/// that module's verdict per domain ("unknown" included only while
/// its single fallback cycle remains — see web-access.ts).
export function rankSiteProposals(
  candidates: SiteProposalCandidate[],
  profile: RankProfile,
  learning: LearningProfile,
  eligibilityByDomain: Map<string, "eligible" | "ineligible" | "unknownAllowed" | "unknownBlocked">,
  domainOf: (url: string) => string,
  now: Date,
): { candidate: SiteProposalCandidate; rank: RankResult }[] {
  const scored: { item: SiteProposalCandidate; rank: RankResult; key: string }[] = [];
  for (const c of candidates) {
    const verdict = eligibilityByDomain.get(domainOf(c.url)) ?? "unknownBlocked";
    if (verdict === "ineligible" || verdict === "unknownBlocked") continue;
    const rank = rankItem({
      category: c.category, requiredSkills: [], estimatedHourly: null,
      distanceKm: null, isRemote: true, postedAt: null,
    }, profile, learning, now);
    if (rank.score < SURFACING_THRESHOLD) continue;
    scored.push({ item: c, rank, key: `${domainOf(c.url)}|${c.name.toLowerCase()}` });
  }
  return sortByRank(scored).map((s) => ({ candidate: s.item, rank: s.rank }));
}
