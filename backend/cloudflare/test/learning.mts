// Brief 06 profile-learning tests: feedback taxonomy, the one
// ranker (before/after fixtures, determinism), rate-floor immunity,
// stated/inferred beliefs with decay, the probe-verified web gate
// (injected fake catalog/probe/missions only — no live browser),
// ignored derivation, and cross-user isolation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MemoryStateDb, StateStore } from "../src/state.ts";
import {
  SURFACING_THRESHOLD, beliefKind, deriveIgnoredEvents, effectiveBeliefConfidence,
  emptyLearningProfile, ensureLearningProfile, isBeliefExpired, listBeliefs, listFeedbackEvents,
  normalizeFeedbackReason, pruneExpiredInferredBeliefs, rankItem, rankSiteProposals,
  rateFloorPrompt, rebuildLearningProfile, recordFeedback, resolveBeliefs,
  type FeedbackEvent, type RankableItem,
} from "../src/learning.ts";
import {
  applyAppWallStrike, applyProbeOutcome, eligibilityOf, extractProbeChecks,
  parseProbeJudgeReply, probeJudgePrompt, unknownAccessRecord,
  type ProbeOutcome, type SiteAccessRecord,
} from "../src/web-access.ts";
import {
  MemoryScanDb, ScanStore, extractProfile, parseListings, runScheduledTick,
  type ScanDeps, type ScanMissionOutcome, type ScanSite,
} from "../src/scan.ts";

const D = (iso: string) => new Date(iso);
const NOW = D("2026-11-10T07:00:00.000Z");
const NOWISO = NOW.toISOString();

const PROFILE = {
  interests: ["petcare"], skills: ["Dog walking"], locationLabel: "Leeds",
  hourlyRateFloor: 25, radiusKm: 20, remoteOK: true,
};

const item = (patch: Partial<RankableItem> = {}): RankableItem => ({
  category: "petCare", requiredSkills: ["Dog walking"], estimatedHourly: 35,
  distanceKm: null, isRemote: true, postedAt: null, ...patch,
});

function declineMany(state: StateStore, n: number, reason: string, patch: Record<string, unknown> = {}) {
  for (let i = 0; i < n; i++) {
    recordFeedback(state, {
      subjectType: "opportunity", subjectId: `opp-${reason}-${i}`, action: "declined",
      reason, category: "petCare", requiredSkills: ["Dog walking"], ...patch,
    }, NOWISO);
  }
  return ensureLearningProfile(state, NOWISO);
}

// ---- taxonomy ----------------------------------------------------------------

test("reason normalization matches the exact strings the feed records", () => {
  assert.equal(normalizeFeedbackReason("too low"), "tooLow");
  assert.equal(normalizeFeedbackReason("too far"), "tooFar");
  assert.equal(normalizeFeedbackReason("not their thing"), "notMyThing");
  assert.equal(normalizeFeedbackReason("not my thing"), "notMyThing");
  assert.equal(normalizeFeedbackReason("just busy"), "justBusy");
  assert.equal(normalizeFeedbackReason("something else"), "other");
  assert.equal(normalizeFeedbackReason(""), null);
  assert.equal(normalizeFeedbackReason(null), null);
});

test("feedback events are stored structured and carried by /state/export", () => {
  const state = new StateStore(new MemoryStateDb());
  const { event } = recordFeedback(state, {
    userId: "user-a", subjectType: "opportunity", subjectId: "opp-1", action: "declined",
    reason: "too low", category: "petCare", requiredSkills: ["Dog walking"],
    estimatedHourly: 12, distanceKm: 5,
  }, NOWISO, () => "fb-fixed-1");
  assert.equal(event.id, "fb-fixed-1");
  assert.equal(event.userId, "user-a");
  assert.equal(event.reason, "tooLow");
  assert.equal(event.occurredAt, NOWISO);
  const exported = state.exportState() as any;
  assert.equal(exported.feedbackEvents.length, 1);
  assert.equal(exported.feedbackEvents[0].data.subjectId, "opp-1");
  assert.equal(exported.learningProfiles.length, 1);
  assert.equal(exported.counts.feedbackEvents, 1);
  assert.equal(exported.counts.learningProfiles, 1);
});

// ---- ranker fixtures ------------------------------------------------------------

test("fixture: repeated 'too low' declines down-rank low-pay suggestions, floor untouched", () => {
  const state = new StateStore(new MemoryStateDb());
  const before = ensureLearningProfile(state, NOWISO);
  const lowBefore = rankItem(item({ estimatedHourly: 26 }), PROFILE, before, NOW).score;
  const highBefore = rankItem(item({ estimatedHourly: 60 }), PROFILE, before, NOW).score;

  const after = declineMany(state, 5, "too low");
  const lowAfter = rankItem(item({ estimatedHourly: 26 }), PROFILE, after, NOW).score;
  const highAfter = rankItem(item({ estimatedHourly: 60 }), PROFILE, after, NOW).score;

  assert.ok(lowAfter < lowBefore - 0.10, `low pay must drop materially (${lowBefore} -> ${lowAfter})`);
  assert.ok(Math.abs(highAfter - highBefore) < Math.abs(lowAfter - lowBefore),
    "well-paid work is barely touched by pay sensitivity");
  assert.equal(after.rateSensitivity, 1);
  // The floor is the user's stated bound: learning only prompts.
  assert.equal(PROFILE.hourlyRateFloor, 25);
  const prompt = rateFloorPrompt(after, PROFILE.hourlyRateFloor);
  assert.equal(prompt.shouldPrompt, true);
  assert.equal(prompt.currentFloor, 25);
});

test("fixture: 'too far' penalizes known distance; unknown distance never penalized or blocked", () => {
  const state = new StateStore(new MemoryStateDb());
  const after = declineMany(state, 5, "too far");
  const distant = rankItem(item({ isRemote: false, distanceKm: 60 }), PROFILE, after, NOW);
  const unknown = rankItem(item({ isRemote: false, distanceKm: null }), PROFILE, after, NOW);
  const baseline = rankItem(item({ isRemote: false, distanceKm: 60 }), PROFILE, emptyLearningProfile(), NOW);
  assert.ok(distant.components.tooFarPenalty > 0.14);
  assert.equal(unknown.components.tooFarPenalty, 0);
  assert.ok(distant.score < baseline.score - 0.10);
});

test("fixture: accepts boost the category; 'not my thing' hits category and skills", () => {
  const state = new StateStore(new MemoryStateDb());
  const before = rankItem(item(), PROFILE, ensureLearningProfile(state, NOWISO), NOW).score;
  for (let i = 0; i < 2; i++) {
    recordFeedback(state, {
      subjectType: "opportunity", subjectId: `acc-${i}`, action: "accepted",
      category: "petCare", requiredSkills: ["Dog walking"],
    }, NOWISO);
  }
  const boosted = ensureLearningProfile(state, NOWISO);
  const afterAccept = rankItem(item(), PROFILE, boosted, NOW).score;
  assert.ok(afterAccept > before, `${before} -> ${afterAccept}`);
  assert.equal(boosted.affinities["petcare"].score, 0.4);
  assert.equal(boosted.affinities["petcare"].accepts, 2);

  recordFeedback(state, {
    subjectType: "opportunity", subjectId: "nmt-1", action: "declined",
    reason: "not their thing", category: "petCare", requiredSkills: ["Dog walking"],
  }, NOWISO);
  const afterNmt = ensureLearningProfile(state, NOWISO);
  assert.ok(Math.abs(afterNmt.affinities["petcare"].score - 0.1) < 1e-9, "0.4 - 0.30");
  assert.ok(Math.abs(afterNmt.skillAffinities["dog walking"] - 0.05) < 1e-9, "+0.20 accepts, -0.15 not-my-thing");
});

test("fixture: ignored decays affinity slightly, far less than an explicit decline", () => {
  const ev = (action: FeedbackEvent["action"], reason: FeedbackEvent["reason"] = null): FeedbackEvent => ({
    id: `e-${action}`, userId: null, subjectType: "opportunity", subjectId: "o1",
    action, reason, category: "petCare", requiredSkills: [],
    estimatedHourly: null, distanceKm: null, occurredAt: NOWISO,
  });
  const ignored = rebuildLearningProfile([ev("ignored")]);
  const declined = rebuildLearningProfile([ev("declined", "other")]);
  assert.equal(ignored.affinities["petcare"].score, -0.05);
  assert.equal(declined.affinities["petcare"].score, -0.20);
  assert.ok(Math.abs(ignored.affinities["petcare"].score) < Math.abs(declined.affinities["petcare"].score));
});

test("ranking is deterministic: same inputs, same scores and same rebuild", () => {
  const state = new StateStore(new MemoryStateDb());
  const learned = declineMany(state, 3, "too low");
  const a = rankItem(item({ estimatedHourly: 28, postedAt: "2026-11-09T07:00:00.000Z" }), PROFILE, learned, NOW);
  const b = rankItem(item({ estimatedHourly: 28, postedAt: "2026-11-09T07:00:00.000Z" }), PROFILE, learned, NOW);
  assert.deepEqual(a, b);
  assert.deepEqual(rebuildLearningProfile(listFeedbackEvents(state)), learned);
  assert.ok(a.score >= 0 && a.score <= 1);
  assert.equal(SURFACING_THRESHOLD, 0.45);
});

test("proposals use the same ranker: ineligible and spent-unknown never proposed", () => {
  const candidates = [
    { name: "Rover", url: "https://www.rover.com", rationale: "pets", category: "petCare" },
    { name: "AppOnly", url: "https://apponly.example", rationale: "pets", category: "petCare" },
    { name: "UnknownSpent", url: "https://spent.example", rationale: "pets", category: "petCare" },
  ];
  const eligibility = new Map<string, "eligible" | "ineligible" | "unknownAllowed" | "unknownBlocked">([
    ["rover.com", "eligible"], ["apponly.example", "ineligible"], ["spent.example", "unknownBlocked"],
  ]);
  const domainOf = (u: string) => new URL(u).hostname.replace(/^www\./, "");
  const ranked = rankSiteProposals(candidates, PROFILE, emptyLearningProfile(), eligibility, domainOf, NOW);
  assert.deepEqual(ranked.map((r) => r.candidate.name), ["Rover"]);
  assert.ok(ranked[0].rank.score >= SURFACING_THRESHOLD);
});

// ---- beliefs ----------------------------------------------------------------------

test("beliefs: stated overrides conflicting inferred; inferred decays and expires; stated never decays", () => {
  const stated = {
    id: "s1", sentence: "Happy to travel for good work", source: "youSaidIt",
    confidence: 0.9, learnedAt: "2025-01-01T00:00:00.000Z", pending: false, topic: "distance preference",
  };
  const inferred = {
    id: "i1", sentence: "Prefers work close to home", source: "learnedFromWork",
    confidence: 0.95, learnedAt: NOWISO, pending: true, topic: "distance preference",
  };
  assert.equal(beliefKind(stated), "stated");
  assert.equal(beliefKind(inferred), "inferred");
  assert.equal(resolveBeliefs([inferred, stated], NOW)[0].id, "s1", "stated wins even at lower confidence");

  const oldInferred = { ...inferred, confidence: 0.8, learnedAt: "2026-10-11T07:00:00.000Z" }; // 30 days
  assert.ok(Math.abs(effectiveBeliefConfidence(oldInferred, NOW) - 0.4) < 1e-9, "30-day half-life");
  const ancientInferred = { ...inferred, confidence: 0.8, learnedAt: "2026-08-12T07:00:00.000Z" }; // 90 days
  assert.equal(isBeliefExpired(ancientInferred, NOW), true);
  const ancientStated = { ...stated, learnedAt: "2020-01-01T00:00:00.000Z" };
  assert.equal(effectiveBeliefConfidence(ancientStated, NOW), 0.9, "stated never decays");
  assert.equal(isBeliefExpired(ancientStated, NOW), false);

  const state = new StateStore(new MemoryStateDb());
  state.upsert("beliefs", "s1", { ...ancientStated }, NOWISO);
  state.upsert("beliefs", "i9", { ...ancientInferred, id: "i9" }, NOWISO);
  assert.deepEqual(pruneExpiredInferredBeliefs(state, NOW), ["i9"]);
  assert.equal(state.list("beliefs").length, 1);
});

test("inferred beliefs are proposed from patterns and suppressed by a stated belief on the topic", () => {
  const state = new StateStore(new MemoryStateDb());
  declineMany(state, 2, "too far");
  const rows = state.list("beliefs").map((r) => r.data as Record<string, unknown>);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sentence, "Prefers work close to home");
  assert.equal(rows[0].pending, true);
  assert.equal(rows[0].kind, "inferred");
  assert.match(String(rows[0].id), /^[0-9a-f-]{36}$/, "app decodes belief ids as UUIDs");

  const statedState = new StateStore(new MemoryStateDb());
  statedState.upsert("beliefs", "s1", {
    id: "s1", sentence: "Happy to travel", source: "youSaidIt", confidence: 1,
    learnedAt: NOWISO, pending: false, topic: "distance preference",
  }, NOWISO);
  declineMany(statedState, 2, "too far");
  assert.equal(statedState.list("beliefs").length, 1, "no inferred duplicate over a stated belief");
});

// ---- ignored derivation -------------------------------------------------------------

test("ignored: untouched after 7 days becomes one weak event, exactly once", () => {
  const state = new StateStore(new MemoryStateDb());
  state.upsert("opportunities", "opp-old", {
    id: "opp-old", siteID: "rover", title: "Old listing", status: "new",
    category: "petCare", foundAt: "2026-11-02T07:00:00.000Z",
  }, "2026-11-02T07:00:00.000Z");
  state.upsert("opportunities", "opp-fresh", {
    id: "opp-fresh", siteID: "rover", title: "Fresh listing", status: "new",
    category: "petCare", foundAt: "2026-11-09T07:00:00.000Z",
  }, "2026-11-09T07:00:00.000Z");
  const first = deriveIgnoredEvents(state, NOW);
  assert.equal(first.created.length, 1);
  assert.equal(first.created[0].subjectId, "opp-old");
  assert.equal(first.created[0].action, "ignored");
  assert.equal(first.profile.affinities["petcare"].score, -0.05);
  assert.equal(deriveIgnoredEvents(state, NOW).created.length, 0, "idempotent");
});

// ---- web-access pure logic --------------------------------------------------------------

test("probe verdicts: app wall disqualifies, full checks pass, undecided stays unknown", () => {
  const unknown = unknownAccessRecord("x.example");
  const allChecks = { signupReachable: true, signupFormPresent: true, profileEditReachable: true, applyStartable: true };
  assert.equal(applyProbeOutcome(unknown, { status: "succeeded", appWall: true }, NOWISO).webAccessible, "false");
  assert.equal(applyProbeOutcome(unknown, { status: "succeeded", checks: allChecks }, NOWISO).webAccessible, "true");
  assert.equal(applyProbeOutcome(unknown,
    { status: "succeeded", checks: { ...allChecks, applyStartable: false } }, NOWISO).webAccessible, "false");
  assert.equal(applyProbeOutcome(unknown, { status: "failed" }, NOWISO).webAccessible, "unknown");
  assert.equal(applyProbeOutcome(unknown, { status: "needs_human" }, NOWISO).webAccessible, "unknown",
    "a human-only check is not an app wall");
  // Strikes: one triggers reprobe, the second disqualifies.
  const struck = applyAppWallStrike({ ...unknown, webAccessible: "true", probedAt: NOWISO }, NOWISO);
  assert.equal(struck.webAccessible, "true");
  assert.equal(applyAppWallStrike(struck, NOWISO).webAccessible, "false");
  // Unknown one-cycle rule.
  assert.equal(eligibilityOf(unknown, "x.example"), "unknownAllowed");
  assert.equal(eligibilityOf({ ...unknown, unknownCyclesUsed: 1 }, "x.example"), "unknownBlocked");
  assert.equal(eligibilityOf(null, "x.example"), "unknownAllowed");
});

// ---- tick integration with fakes -----------------------------------------------------

const ROVER = { id: "rover", name: "Rover", url: "https://www.rover.com", category: "petCare", account: "watching" };

function seedUser(state: StateStore) {
  state.upsert("profile", "profile", {
    profile: {
      displayName: "Sam", skills: ["Dog walking", "Pet sitting"], interests: ["petCare"],
      hourlyRateFloor: 25, locationLabel: "Leeds", radiusKm: 20, remoteOK: true,
    },
    hasOnboarded: true, isPaused: false, lastVisitAt: null,
  }, NOWISO);
  state.upsert("sites", ROVER.id, {
    id: ROVER.id, name: ROVER.name, startURLString: ROVER.url, category: ROVER.category, goalTemplate: "Find work",
  }, NOWISO);
  state.upsert("accountStates", ROVER.id, { siteID: ROVER.id, state: ROVER.account }, NOWISO);
}

function harness(opts: {
  catalog?: Map<string, SiteAccessRecord>;
  probe?: () => ProbeOutcome;
  mission?: () => ScanMissionOutcome;
  catalogError?: "read" | "save";
  noCredential?: boolean;
} = {}) {
  const state = new StateStore(new MemoryStateDb());
  const scans = new ScanStore(new MemoryScanDb());
  const catalog = opts.catalog ?? new Map<string, SiteAccessRecord>();
  const calls: string[] = [];
  const probeCalls: string[] = [];
  let seq = 0;
  const deps: ScanDeps = {
    state, scans,
    credentialIdForDomain: (d) => (!opts.noCredential && d === "rover.com" ? "cred-rover" : null),
    sessionHealthForDomain: () => null,
    runDiscoverMission: async (input) => {
      calls.push(input.site.id);
      return opts.mission?.() ?? { status: "succeeded", items: ["Weekend dog sitting | $35/hr | Leeds"] };
    },
    siteAccessForDomain: (d) => {
      if (opts.catalogError === "read") throw new Error("catalog unavailable (simulated)");
      return catalog.get(d) ?? null;
    },
    saveSiteAccess: (rec) => {
      if (opts.catalogError === "save") throw new Error("catalog write failed (simulated)");
      catalog.set(rec.domain, { ...rec });
    },
    runProbeMission: async (input) => {
      probeCalls.push(input.site.id);
      return opts.probe?.() ?? {
        status: "succeeded",
        checks: { signupReachable: true, signupFormPresent: true, profileEditReachable: true, applyStartable: true },
      };
    },
    idFactory: () => `id-${++seq}`,
  };
  return { state, scans, deps, calls, probeCalls, catalog };
}

const eligibleRecord = (probedAt = NOWISO): SiteAccessRecord => ({
  domain: "rover.com", displayName: "Rover", webAccessible: "true", probedAt,
  probeEvidence: "ok", unknownCyclesUsed: 0, appWallStrikes: 0,
});

test("probe judging: checks are found inside prose; strict judge parsing never guesses", () => {
  const wrapped = 'I opened the join page. Result: {"signupReachable":true,"signupFormPresent":true,"profileEditReachable":false,"applyStartable":true} — done.';
  assert.deepEqual(extractProbeChecks(wrapped), {
    signupReachable: true, signupFormPresent: true, profileEditReachable: false, applyStartable: true,
  });
  assert.equal(extractProbeChecks('{"signupReachable":true}'), null, "partial checks are not a verdict");
  assert.equal(extractProbeChecks("no json here"), null);
  assert.equal(extractProbeChecks('{"signupReachable":"yes","signupFormPresent":true,"profileEditReachable":true,"applyStartable":true}'),
    null, "non-boolean checks are not a verdict");

  assert.equal(parseProbeJudgeReply('{"undecided":true}'), null);
  assert.equal(parseProbeJudgeReply("the site looks fine"), null);
  assert.equal(parseProbeJudgeReply('{"signupReachable":true,"signupFormPresent":true,"profileEditReachable":true}'), null);
  const verdict = parseProbeJudgeReply('{"signupReachable":true,"signupFormPresent":false,"profileEditReachable":false,"applyStartable":false,"appWallText":"Continue in the app to finish signing up"}');
  assert.equal(verdict?.appWall, true, "quoted app-wall text counts as an app wall");
  assert.equal(verdict?.checks.signupFormPresent, false);
  assert.match(probeJudgePrompt("Rover", "evidence text"), /undecided/);
  assert.match(probeJudgePrompt("Rover", "evidence text"), /ONLY from this evidence/);
});

test("probe: app-walled site becomes ineligible — never scanned (zero mission calls)", async () => {
  const h = harness({ probe: () => ({ status: "succeeded", appWall: true, evidence: "continue in the app" }) });
  seedUser(h.state);
  const summary = await runScheduledTick(h.deps, { slot: 0, now: NOW });
  assert.equal(h.probeCalls.length, 1, "unknown sites are probed before first scan");
  assert.equal(h.calls.length, 0, "no discover mission may run");
  assert.equal(summary.surfacedIds.length, 0);
  assert.equal(summary.skipped[0].reason, "notWebAccessible");
  assert.equal(h.catalog.get("rover.com")?.webAccessible, "false");
  assert.equal(h.catalog.get("rover.com")?.probedAt, NOWISO);
  assert.ok(h.catalog.get("rover.com")?.probeEvidence);
});

test("probe: fully web-accessible site is eligible and scans", async () => {
  const h = harness({ catalog: new Map([["rover.com", eligibleRecord()]]) });
  seedUser(h.state);
  const summary = await runScheduledTick(h.deps, { slot: 0, now: NOW });
  assert.equal(h.probeCalls.length, 0, "fresh verdict needs no reprobe");
  assert.equal(summary.surfacedIds.length, 1);
  const feed = h.state.list("feedItems")[0].data as Record<string, unknown>;
  assert.equal(typeof feed.rankScore, "number", "surfaced payloads carry the server rank score");
});

test("probe: previously eligible site turned ineligible withdraws proposals with a journal reason, scans stop", async () => {
  const h = harness({
    catalog: new Map([["rover.com", eligibleRecord("2026-09-01T07:00:00.000Z")]]),
    probe: () => ({ status: "succeeded", appWall: true }),
  });
  seedUser(h.state);
  h.state.upsert("proposals", "p1", { id: "p1", siteID: "rover", rationale: "pets", status: "proposed" }, NOWISO);
  const summary = await runScheduledTick(h.deps, { slot: 0, now: NOW });
  assert.equal(h.probeCalls.length, 1, "monthly reprobe was due");
  assert.equal(h.calls.length, 0);
  assert.deepEqual(summary.withdrawnProposalIds, ["p1"]);
  assert.equal(h.state.list("proposals").length, 0);
  const journal = h.state.list("journalEvents").map((r) => r.data as Record<string, unknown>);
  assert.equal(journal.length, 1);
  assert.match(String(journal[0].sentence), /phone app/);
  assert.ok(String(journal[0].detail).length > 0, "withdrawal is logged with a reason");
  assert.equal(journal[0].currencyCode, "USD", "journal payload must decode as an app activity event");
});

test("probe: unknown gets exactly one scan cycle, then blocks until a probe resolves it", async () => {
  const h = harness({ probe: () => ({ status: "failed", evidence: "unreachable" }) });
  seedUser(h.state);
  const first = await runScheduledTick(h.deps, { slot: 0, now: NOW });
  assert.equal(h.calls.length, 1, "the single fallback cycle scans");
  assert.equal(first.surfacedIds.length, 1);
  assert.equal(h.catalog.get("rover.com")?.webAccessible, "unknown");
  assert.equal(h.catalog.get("rover.com")?.unknownCyclesUsed, 1);
  const second = await runScheduledTick(h.deps, { slot: 1, now: D("2026-11-10T13:00:00.000Z") });
  assert.equal(h.calls.length, 1, "no second unknown cycle");
  assert.equal(second.skipped[0].reason, "webAccessUnknown");
  assert.equal(h.probeCalls.length, 1, "undecided unknowns are not re-probed every tick");
});

test("app-wall mission signal triggers a reprobe; confirming probe disqualifies and withdraws", async () => {
  const h = harness({
    catalog: new Map([["rover.com", eligibleRecord()]]),
    mission: () => ({ status: "failed", items: [], appWall: true }),
    probe: () => ({ status: "succeeded", appWall: true }),
  });
  seedUser(h.state);
  h.state.upsert("proposals", "p1", { id: "p1", siteID: "rover", rationale: "pets", status: "proposed" }, NOWISO);
  const summary = await runScheduledTick(h.deps, { slot: 0, now: NOW });
  assert.equal(h.calls.length, 1);
  assert.equal(h.probeCalls.length, 1, "the strike is retried by probe");
  assert.equal(h.catalog.get("rover.com")?.webAccessible, "false");
  assert.deepEqual(summary.withdrawnProposalIds, ["p1"]);
  const next = await runScheduledTick(h.deps, { slot: 1, now: D("2026-11-10T13:00:00.000Z") });
  assert.equal(h.calls.length, 1, "ineligible sites stop scanning");
  assert.equal(next.skipped[0].reason, "notWebAccessible");
});

test("catalog read failure fails closed: no probe, no scan, allowance never re-arms", async () => {
  const h = harness({ catalogError: "read" });
  seedUser(h.state);
  const first = await runScheduledTick(h.deps, { slot: 0, now: NOW });
  assert.equal(h.probeCalls.length, 0);
  assert.equal(h.calls.length, 0);
  assert.equal(first.skipped[0].reason, "webAccessUnknown");
  const second = await runScheduledTick(h.deps, { slot: 1, now: D("2026-11-10T13:00:00.000Z") });
  assert.equal(h.calls.length, 0, "still blocked next slot");
  assert.equal(second.skipped[0].reason, "webAccessUnknown");
});

test("a probe that spends the daily cap does not burn the one unknown cycle", async () => {
  // Single public site: cap is 1 mission/day and the probe counts.
  const h = harness({ noCredential: true, probe: () => ({ status: "failed", evidence: "unreachable" }) });
  seedUser(h.state);
  const day1 = await runScheduledTick(h.deps, { slot: 0, now: NOW });
  assert.equal(h.probeCalls.length, 1);
  assert.equal(h.calls.length, 0, "the probe was today's one mission");
  assert.equal(day1.skipped[0].reason, "dailyCap");
  assert.equal(h.catalog.get("rover.com")?.unknownCyclesUsed, 0, "cycle not consumed without a scan");
  const day2 = await runScheduledTick(h.deps, { slot: 0, now: D("2026-11-11T07:00:00.000Z") });
  assert.equal(h.probeCalls.length, 1, "no reprobe the next day");
  assert.equal(h.calls.length, 1, "the one allowed look happens on a fresh cap");
  assert.equal(day2.surfacedIds.length, 1);
  assert.equal(h.catalog.get("rover.com")?.unknownCyclesUsed, 1, "consumed by the scan that ran");
});

test("catalog write failure after a passing probe still blocks the scan", async () => {
  const h = harness({ catalogError: "save" });
  seedUser(h.state);
  const summary = await runScheduledTick(h.deps, { slot: 0, now: NOW });
  assert.equal(h.probeCalls.length, 1, "the probe ran");
  assert.equal(h.calls.length, 0, "but its unrecorded verdict buys no scan");
  assert.equal(summary.skipped[0].reason, "webAccessUnknown");
});

test("withdrawal reaches real .proposed suggestions without any probe or scan", async () => {
  const h = harness({
    catalog: new Map([["rover.com", { ...eligibleRecord(), webAccessible: "false" as const }]]),
  });
  seedUser(h.state);
  h.state.upsert("accountStates", ROVER.id, { siteID: ROVER.id, state: "proposed" }, NOWISO);
  h.state.upsert("proposals", "p1", { id: "p1", siteID: "rover", rationale: "pets", status: "proposed" }, NOWISO);
  const summary = await runScheduledTick(h.deps, { slot: 0, now: NOW });
  assert.deepEqual(summary.withdrawnProposalIds, ["p1"]);
  assert.equal(h.state.list("proposals").length, 0);
  assert.equal(h.calls.length, 0);
  assert.equal(h.probeCalls.length, 0, "proposals are never probed from the tick");
  assert.equal(summary.skipped[0].reason, "notApproved");
});

test("app-imported feedback proposes inferred beliefs via ensureLearningProfile (production ingress)", () => {
  const state = new StateStore(new MemoryStateDb());
  // Rows exactly as the app's state push delivers them — no recordFeedback.
  for (let i = 0; i < 2; i++) {
    state.upsert("feedbackEvents", `imp-${i}`, {
      id: `imp-${i}`, subjectType: "opportunity", subjectId: `o-${i}`, action: "declined",
      reason: "tooFar", category: "petCare", requiredSkills: [], occurredAt: NOWISO,
    }, NOWISO);
  }
  ensureLearningProfile(state, NOWISO);
  const inferred = listBeliefs(state).filter((b) => beliefKind(b) === "inferred");
  assert.equal(inferred.length, 1);
  assert.equal(inferred[0].pending, true);
  assert.match(inferred[0].sentence, /close to home/);
});

test("tick ranking: learned 'too low' sensitivity orders surfaced items; below-floor stays gate-dropped", async () => {
  const h = harness({
    catalog: new Map([["rover.com", eligibleRecord()]]),
    mission: () => ({
      status: "succeeded",
      items: [
        "Near floor dog walks | $26/hr | Leeds",
        "Well paid dog sitting | $60/hr | Leeds",
        "Below floor dog walks | $10/hr | Leeds",
        JSON.stringify({ title: "Tiny far job listing", category: "petCare", estimatedHourly: 26, locationLabel: "Leeds", distanceKm: 80, postedAt: "2026-09-01T00:00:00.000Z" }),
      ],
    }),
  });
  seedUser(h.state);
  declineMany(h.state, 5, "too low");
  const summary = await runScheduledTick(h.deps, { slot: 0, now: NOW });
  const titles = summary.surfacedIds.map((id) =>
    String((h.state.get("feedItems", id)?.data as Record<string, unknown>).title));
  assert.equal(titles[0], "Well paid dog sitting", "ranker orders the surfaced feed");
  assert.ok(!titles.includes("Below floor dog walks"), "no score resurrects a below-floor listing");
  const below = summary.filtered.find((f) => f.title === "Below floor dog walks");
  assert.deepEqual(below?.reasons, ["belowRateFloor"]);
  // Full surfaced order follows the learned scores exactly:
  // well-paid > near-floor > tiny/far/stale (threshold filtering of
  // sub-0.45 items is proven by the dedicated threshold test below).
  assert.deepEqual(titles,
    ["Well paid dog sitting", "Near floor dog walks", "Tiny far job listing"],
    "surfaced items arrive in rank order");
  // The stored profile floor never moved.
  const { profile } = extractProfile(h.state.get("profile", "profile")?.data);
  assert.equal(profile.hourlyRateFloor, 25);
  assert.equal(profile.radiusKm, 20, "extractProfile keeps radiusKm for the ranker");
});

test("tick: a gate-passing listing below the rank threshold does not surface", async () => {
  const h = harness({
    catalog: new Map([["rover.com", eligibleRecord()]]),
    mission: () => ({
      status: "succeeded",
      items: [JSON.stringify({
        title: "Far old unknown-pay listing", category: "petCare",
        locationLabel: "Leeds", isRemote: false, distanceKm: 200,
        postedAt: "2026-08-01T00:00:00.000Z",
      })],
    }),
  });
  seedUser(h.state);
  declineMany(h.state, 4, "not their thing");
  const summary = await runScheduledTick(h.deps, { slot: 0, now: NOW });
  assert.equal(summary.surfacedIds.length, 0);
  assert.deepEqual(summary.filtered[0].reasons, ["belowRankThreshold"]);
});

test("tick derives ignored feedback for stale untouched listings", async () => {
  const h = harness({ catalog: new Map([["rover.com", eligibleRecord()]]) });
  seedUser(h.state);
  h.state.upsert("opportunities", "stale-opp", {
    id: "stale-opp", siteID: "rover", title: "Stale listing", status: "new",
    category: "petCare", foundAt: "2026-11-01T07:00:00.000Z",
  }, "2026-11-01T07:00:00.000Z");
  const summary = await runScheduledTick(h.deps, { slot: 0, now: NOW });
  assert.deepEqual(summary.ignoredEventIds, ["ignored:stale-opp"]);
  assert.equal(listFeedbackEvents(h.state)[0].action, "ignored");
});

test("parseListings carries optional distanceKm/postedAt; absence stays null", () => {
  const site: ScanSite = {
    id: "rover", siteID: "rover", name: "Rover", startURLString: "https://www.rover.com",
    domain: "rover.com", category: "petCare",
  };
  const [rich] = parseListings([JSON.stringify({
    title: "Distant dog sitting job", distanceKm: 42, postedAt: "2026-11-09T00:00:00.000Z",
  })], site);
  assert.equal(rich.distanceKm, 42);
  assert.equal(rich.postedAt, "2026-11-09T00:00:00.000Z");
  const [plain] = parseListings(["Plain dog sitting job here"], site);
  assert.equal(plain.distanceKm, null);
  assert.equal(plain.postedAt, null);
});

// ---- isolation + marker ------------------------------------------------------------------

test("cross-user isolation: one user's feedback, beliefs, and affinities never touch another's", () => {
  const a = new StateStore(new MemoryStateDb());
  const b = new StateStore(new MemoryStateDb());
  declineMany(a, 5, "too low");
  a.upsert("beliefs", "b1", { id: "b1", sentence: "A only", source: "youSaidIt", confidence: 1, pending: false }, NOWISO);
  assert.equal(listFeedbackEvents(b).length, 0);
  assert.equal(b.list("beliefs").length, 0);
  const learnedB = ensureLearningProfile(b, NOWISO);
  assert.deepEqual(learnedB.affinities, {});
  assert.equal(learnedB.rateSensitivity, 0);
  assert.equal(
    rankItem(item(), PROFILE, learnedB, NOW).score,
    rankItem(item(), PROFILE, emptyLearningProfile(), NOW).score,
    "B ranks exactly as if A never acted",
  );
  const exportedB = b.exportState() as any;
  assert.equal(exportedB.feedbackEvents.length, 0);
});

test("Brief 05's permissive web-access default is gone from the scan source", () => {
  const src = readFileSync(new URL("../src/scan.ts", import.meta.url), "utf8");
  assert.ok(!src.includes("TODO(" + "brief-06)"), "the brief-06 TODO marker must be removed");
  assert.ok(!src.includes("permissive default — only a proven"));
});
