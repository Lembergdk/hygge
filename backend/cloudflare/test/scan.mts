// Brief 05 scheduled-scanning tests: cadence tiers, server-side
// pause, relevance gate, dedupe, exhaustion + monthly re-check,
// login-failure episodes, daily cap, and "scans never write".
// Scheduling/pause logic is proven here with a fake mission runner —
// no live browser, no secrets, no deployed cron.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStateDb, StateStore } from "../src/state.ts";
import {
  CRON_SLOTS_UTC, MemoryScanDb, ScanStore, categoriesToReopen,
  checkExhaustion, clearStaleEpisode, dailyCap, evaluateGate,
  extractProfile, isTierDueAtSlot, needsYouItemId, parseListings,
  runScheduledTick, scanOpportunityId, scanSchemaSQL, slotForCron,
  sweepOrder, validCategory,
  type GateContext, type ScanDeps, type ScanMissionInput, type ScanMissionOutcome, type ScanSite,
} from "../src/scan.ts";

const D = (iso: string) => new Date(iso);
const DAY1 = "2026-11-02T07:00:00.000Z";

function seedUser(state: StateStore, opts: {
  isPaused?: boolean;
  floor?: number;
  sites?: { id: string; name: string; url: string; category: string; account: string }[];
} = {}) {
  state.upsert("profile", "profile", {
    profile: {
      displayName: "Sam", skills: ["Dog walking", "Pet sitting"], interests: ["petCare"],
      hourlyRateFloor: opts.floor ?? 25, locationLabel: "Leeds", remoteOK: true,
    },
    hasOnboarded: true, isPaused: opts.isPaused ?? false, lastVisitAt: null,
  }, DAY1);
  for (const s of opts.sites ?? []) {
    state.upsert("sites", s.id, {
      id: s.id, name: s.name, startURLString: s.url, category: s.category, goalTemplate: "Find work",
    }, DAY1);
    state.upsert("accountStates", s.id, { siteID: s.id, state: s.account }, DAY1);
  }
}

const ROVER = { id: "rover", name: "Rover", url: "https://www.rover.com", category: "petCare", account: "watching" };
const UPWORK = { id: "upwork", name: "Upwork", url: "https://www.upwork.com", category: "petCare", account: "watching" };
const FIVERR = { id: "fiverr", name: "Fiverr", url: "https://www.fiverr.com", category: "petCare", account: "proposed" };

function harness(mission: (input: ScanMissionInput, call: number) => ScanMissionOutcome,
                 credentials: Record<string, string> = { "rover.com": "cred-rover" }) {
  const state = new StateStore(new MemoryStateDb());
  const scansDb = new MemoryScanDb();
  const scans = new ScanStore(scansDb);
  const calls: ScanMissionInput[] = [];
  let seq = 0;
  const deps: ScanDeps = {
    state,
    scans,
    credentialIdForDomain: (domain) => credentials[domain] ?? null,
    sessionHealthForDomain: () => ({ domain: "rover.com", trustSupport: "supported", hasProfile: true }),
    runDiscoverMission: async (input) => { calls.push(input); return mission(input, calls.length); },
    idFactory: () => `run-${++seq}`,
  };
  return { state, scansDb, scans, deps, calls };
}

const ok = (items: string[]): ScanMissionOutcome => ({ status: "succeeded", items });

// ---- units ---------------------------------------------------------------

test("schedule: three UTC slots, logged due always, public first slot only, cap formula", () => {
  assert.deepEqual([...CRON_SLOTS_UTC], ["07:00", "13:00", "19:00"]);
  assert.equal(slotForCron("0 7 * * *"), 0);
  assert.equal(slotForCron("0 13 * * *"), 1);
  assert.equal(slotForCron("0 19 * * *"), 2);
  assert.equal(isTierDueAtSlot("logged", 2), true);
  assert.equal(isTierDueAtSlot("public", 0), true);
  assert.equal(isTierDueAtSlot("public", 1), false);
  assert.equal(dailyCap(2, 3), 9);
  assert.match(scanSchemaSQL(), /scan_runs/);
  assert.match(scanSchemaSQL(), /UNIQUE INDEX.*scan_runs\(site_id, run_date, slot\)/);
});

test("sweepOrder rotates deterministically and loses nobody", () => {
  const ids = ["u3", "u1", "u2", "u4"];
  const a = sweepOrder(ids, "0 7 * * *|2026-11-02");
  assert.deepEqual([...a].sort(), ["u1", "u2", "u3", "u4"]);
  assert.deepEqual(sweepOrder(ids, "0 7 * * *|2026-11-02"), a);
});

test("extractProfile reads the ProfileState singleton incl. server pause flag", () => {
  const { profile, isPaused } = extractProfile({
    profile: { skills: ["Dog walking"], interests: ["petCare"], hourlyRateFloor: 30, locationLabel: "Leeds" },
    isPaused: true,
  });
  assert.equal(isPaused, true);
  assert.equal(profile.hourlyRateFloor, 30);
  assert.deepEqual(profile.interests, ["petcare"]);
});

test("parseListings: plain, pipe, and JSON extracted items", () => {
  const site: ScanSite = { id: "rover", siteID: "rover", name: "Rover", startURLString: "https://www.rover.com", domain: "rover.com", category: "petCare" };
  const [plain] = parseListings(["Weekend dog sitting for two spaniels"], site);
  assert.equal(plain.title, "Weekend dog sitting for two spaniels");
  assert.equal(plain.estimatedHourly, null);
  const [pipe] = parseListings(["Cat visits twice daily | $35/hr | Leeds | skills: Cat care"], site);
  assert.equal(pipe.title, "Cat visits twice daily");
  assert.equal(pipe.estimatedHourly, 35);
  assert.equal(pipe.locationLabel, "Leeds");
  assert.deepEqual(pipe.requiredSkills, ["Cat care"]);
  const [json] = parseListings([JSON.stringify({ title: "Puppy walks at lunch", estimatedHourly: 40 })], site);
  assert.equal(json.estimatedHourly, 40);
  assert.equal(validCategory("petcare"), "petCare");
  assert.equal(validCategory("nonsense"), "localGig");
});

test("stable opportunity ids: same listing, same row, every time", () => {
  assert.equal(scanOpportunityId("rover", "Dog Sit"), scanOpportunityId("ROVER", "dog  sit"));
  assert.notEqual(scanOpportunityId("rover", "Dog Sit"), scanOpportunityId("rover", "Cat Sit"));
  assert.match(scanOpportunityId("rover", "Dog Sit"), /^[0-9a-f-]{36}$/);
});

test("gate: each rule blocks on its own; unknown pay passes; web-access unknown eligible (TODO brief-06)", () => {
  const base: GateContext = {
    profile: { interests: ["petcare"], skills: ["Dog walking"], locationLabel: "Leeds", hourlyRateFloor: 25, remoteOK: true },
    existingKeys: new Set(), existingIds: new Set(), declinedKeys: new Set(), appliedKeys: new Set(), appliedIds: new Set(),
  };
  const listing = (patch: Partial<Parameters<typeof evaluateGate>[0]> = {}) => ({
    title: "Weekend dog sitting", summary: "", category: "petCare", payLabel: "", estimatedHourly: 35,
    locationLabel: "Leeds", isRemote: false, requiredSkills: ["Dog walking"], urlString: "",
    siteId: "rover", webAccess: null, ...patch,
  } as Parameters<typeof evaluateGate>[0]);
  assert.equal(evaluateGate(listing(), base).pass, true);
  assert.deepEqual(evaluateGate(listing({ estimatedHourly: 10 }), base).reasons, ["belowRateFloor"]);
  assert.equal(evaluateGate(listing({ estimatedHourly: null }), base).pass, true, "unknown pay is not below-floor");
  assert.deepEqual(evaluateGate(listing({ category: "delivery" }), base).reasons, ["noCategoryFit"]);
  assert.deepEqual(evaluateGate(listing({ requiredSkills: ["Plumbing"] }), base).reasons, ["noSkillFit"]);
  assert.deepEqual(evaluateGate(listing({ locationLabel: "Glasgow" }), base).reasons, ["noLocationFit"]);
  assert.equal(evaluateGate(listing({ locationLabel: "Glasgow", isRemote: true }), base).pass, true);
  assert.deepEqual(evaluateGate(listing({ webAccess: "no" }), base).reasons, ["notWebAccessible"]);
  assert.equal(evaluateGate(listing({ webAccess: "unknown" }), base).pass, true, "permissive default until Brief 06");
});

// ---- tick behaviour ---------------------------------------------------------

test("manual tick surfaces a new listing as a real server feed item without any app action", async () => {
  const h = harness(() => ok(["Weekend dog sitting | $35/hr | Leeds"]));
  seedUser(h.state, { sites: [ROVER] });
  const summary = await runScheduledTick(h.deps, { slot: 0, now: D(DAY1) });
  assert.equal(summary.paused, false);
  assert.equal(summary.surfacedIds.length, 1);
  const feed = h.state.list("feedItems");
  assert.equal(feed.length, 1);
  const data = feed[0].data as Record<string, unknown>;
  assert.equal(data.title, "Weekend dog sitting");
  assert.equal(data.isDemo, false);
  assert.equal(data.is_demo, false);
  assert.equal(data.foundVia, "scheduled-scan");
  assert.equal(data.sourceSite, "Rover");
  assert.equal(data.category, "petCare");
  assert.equal(h.state.list("opportunities").length, 1);
  assert.equal(h.scansDb.runs[0].itemsSurfaced, 1);
  assert.equal(h.calls[0].tier, "logged");
  assert.equal(h.calls[0].credentialId, "cred-rover");
});

test("cadence tiers: logged 3x/day, public 1x/day, proposed 0x", async () => {
  let n = 0;
  const h = harness((input) => ok([`${input.site.name} listing number ${++n} here | $35/hr | Leeds`]));
  seedUser(h.state, { sites: [ROVER, UPWORK, FIVERR] });
  for (const slot of [0, 1, 2]) {
    const hour = ["07", "13", "19"][slot];
    await runScheduledTick(h.deps, { slot, now: D(`2026-11-02T${hour}:00:00.000Z`) });
  }
  const bySite = (id: string) => h.calls.filter((c) => c.site.id === id).length;
  assert.equal(bySite("rover"), 3, "approved + valid login scans every slot");
  assert.equal(bySite("upwork"), 1, "approved without login scans once, public only");
  assert.equal(bySite("fiverr"), 0, "proposed but not approved is never scanned");
  assert.equal(h.calls.find((c) => c.site.id === "upwork")?.tier, "public");
  assert.equal(h.calls.find((c) => c.site.id === "upwork")?.credentialId, null, "public tier never touches a credential");
});

test("paused user: zero scans, zero mission calls, on every tick", async () => {
  const h = harness(() => ok(["Weekend dog sitting | $35/hr | Leeds"]));
  seedUser(h.state, { isPaused: true, sites: [ROVER] });
  for (const slot of [0, 1, 2]) {
    const summary = await runScheduledTick(h.deps, { slot, now: D(DAY1) });
    assert.equal(summary.paused, true);
    assert.equal(summary.scanned.length, 0);
  }
  assert.equal(h.calls.length, 0);
  assert.equal(h.scansDb.runs.length, 0);
});

test("dedupe: an already-known listing never surfaces twice (title + site)", async () => {
  const h = harness(() => ok(["Weekend dog sitting | $35/hr | Leeds"]));
  seedUser(h.state, { sites: [ROVER] });
  await runScheduledTick(h.deps, { slot: 0, now: D(DAY1) });
  const second = await runScheduledTick(h.deps, { slot: 1, now: D("2026-11-02T13:00:00.000Z") });
  assert.equal(second.surfacedIds.length, 0);
  assert.deepEqual(second.filtered[0].reasons, ["duplicate"]);
  assert.equal(h.state.list("feedItems").length, 1);
  const third = await runScheduledTick(h.deps, { slot: 1, now: D("2026-11-02T13:00:00.000Z") });
  assert.equal(third.skipped[0].reason, "alreadyRan", "same slot twice is a no-op");
});

test("gate in tick: below-floor and previously declined listings never surface", async () => {
  const h = harness(() => ok([
    "Cheap dog walks all week | $10/hr | Leeds",
    "Declined cat sitting job | $35/hr | Leeds",
    "Great weekend dog sitting | $35/hr | Leeds",
  ]));
  seedUser(h.state, { sites: [ROVER] });
  h.state.upsert("opportunities", "old-1", {
    id: "old-1", siteID: "rover", title: "Declined cat sitting job", status: "dismissed",
  }, DAY1);
  const summary = await runScheduledTick(h.deps, { slot: 0, now: D(DAY1) });
  assert.equal(summary.surfacedIds.length, 1);
  const reasons = Object.fromEntries(summary.filtered.map((f) => [f.title, f.reasons]));
  assert.deepEqual(reasons["Cheap dog walks all week"], ["belowRateFloor"]);
  assert.ok(reasons["Declined cat sitting job"].includes("previouslyDeclined"));
  assert.equal((h.state.list("feedItems")[0].data as Record<string, unknown>).title, "Great weekend dog sitting");
});

test("a scan run produces feed items only — zero write tasks, applications untouched", async () => {
  const h = harness(() => ok(["Weekend dog sitting | $35/hr | Leeds", "Cat visits daily | $30/hr | Leeds"]));
  seedUser(h.state, { sites: [ROVER] });
  const summary = await runScheduledTick(h.deps, { slot: 0, now: D(DAY1) });
  assert.equal(summary.writeTasksCreated, 0);
  assert.equal(summary.surfacedIds.length, 2);
  assert.equal(h.state.list("applications").length, 0);
  // The only mission surface a scan can reach is discover input.
  assert.ok(h.calls.every((c) => c.site && c.tier && !("kind" in c)));
});

test("exhaustion: 7 quiet days -> monthly cooldown, logged skip, one re-check, recovery on a find", async () => {
  let items: string[] = [];
  const h = harness(() => ok(items));
  seedUser(h.state, { sites: [ROVER] });
  const tick = (iso: string) => runScheduledTick(h.deps, { slot: 0, now: D(iso) });

  await tick("2026-11-02T07:00:00.000Z");
  await tick("2026-11-05T07:00:00.000Z");
  const third = await tick("2026-11-09T07:00:00.000Z"); // 7 quiet days, 3 empty scans
  assert.equal(third.scanned[0].status, "empty");
  const cat = h.scans.categoryState("petcare");
  assert.ok(cat.exhaustedUntil, "category cools down after the window");
  assert.equal(cat.exhaustedUntil!.slice(0, 10), "2026-12-09");
  assert.equal(cat.lastScanAt!.slice(0, 10), "2026-11-09");

  const callsBefore = h.calls.length;
  const skipped = await tick("2026-11-10T07:00:00.000Z");
  assert.equal(h.calls.length, callsBefore, "no scan, not even a light probe, during cooldown");
  assert.equal(skipped.skipped[0].reason, "exhausted");
  assert.match(skipped.skipped[0].detail, /^skipped: exhausted until 2026-12-09$/);
  assert.ok(skipped.log.some((l) => l.includes("skipped: exhausted until 2026-12-09")), "skip reason is logged every tick");
  assert.equal(checkExhaustion(cat, D("2026-12-09T07:00:00.000Z")).recheckDue, true);

  // Monthly re-check runs once; still empty -> cools down again.
  const recheck = await tick("2026-12-09T07:00:00.000Z");
  assert.equal(recheck.scanned.length, 1, "the re-check scan runs after the monthly window");
  assert.equal(h.scans.categoryState("petcare").exhaustedUntil!.slice(0, 10), "2027-01-08");
  const skippedAgain = await tick("2026-12-10T07:00:00.000Z");
  assert.equal(skippedAgain.skipped[0].reason, "exhausted");

  // Next re-check finds work -> category fully reopens.
  items = ["New year dog sitting | $35/hr | Leeds"];
  const recovered = await tick("2027-01-08T07:00:00.000Z");
  assert.equal(recovered.surfacedIds.length, 1);
  assert.equal(h.scans.categoryState("petcare").exhaustedUntil, null);
  assert.equal(h.scans.categoryState("petcare").consecutiveEmptyScans, 0);
});

test("exhaustion reopens immediately on a user decision (new site in category, rate/location change)", () => {
  const profile = { interests: ["petcare"], skills: [], locationLabel: "Leeds", hourlyRateFloor: 25, remoteOK: true };
  const before = { profile, siteCategories: new Map([["rover", "petcare"]]) };
  assert.deepEqual(
    categoriesToReopen(before, { profile, siteCategories: new Map([["rover", "petcare"], ["pawshake", "petcare"]]) }),
    ["petcare"],
  );
  assert.equal(categoriesToReopen(before, { profile: { ...profile, hourlyRateFloor: 20 }, siteCategories: before.siteCategories }), "*");
  assert.equal(categoriesToReopen(before, { profile: { ...profile, locationLabel: "York" }, siteCategories: before.siteCategories }), "*");
  assert.deepEqual(categoriesToReopen(before, before), []);

  const scans = new ScanStore(new MemoryScanDb());
  scans.db.putCategory({ category: "petcare", trackingSince: DAY1, lastScanAt: DAY1, lastNewFoundAt: null, consecutiveEmptyScans: 5, exhaustedUntil: "2026-12-09T00:00:00.000Z" });
  assert.equal(scans.clearExhaustion(["petcare"]), 1);
  assert.equal(scans.categoryState("petcare").exhaustedUntil, null);
});

test("scan failures count toward nothing: no exhaustion progress, retry next slot", async () => {
  const h = harness(() => ({ status: "failed", items: [], errorReason: "site error" }));
  seedUser(h.state, { sites: [ROVER] });
  await runScheduledTick(h.deps, { slot: 0, now: D(DAY1) });
  await runScheduledTick(h.deps, { slot: 1, now: D("2026-11-02T13:00:00.000Z") });
  assert.equal(h.calls.length, 2, "a failed scan retries at the next slot");
  assert.equal(h.scans.categoryState("petcare").consecutiveEmptyScans, 0);
  assert.equal(h.scans.categoryState("petcare").trackingSince, null);
  assert.deepEqual(h.scansDb.runs.map((r) => r.status), ["failed", "failed"]);
});

test("login failure: stale flag, exactly one needs-you item per episode, scans stop until fixed", async () => {
  let broken = true;
  const h = harness(() => broken
    ? { status: "failed", items: [], loginFailure: true }
    : ok(["Weekend dog sitting | $35/hr | Leeds"]));
  seedUser(h.state, { sites: [ROVER] });

  const first = await runScheduledTick(h.deps, { slot: 0, now: D(DAY1) });
  assert.deepEqual(first.needsYouItemIds, [needsYouItemId("rover")]);
  assert.equal(first.scanned[0].status, "login_failed");
  const siteState = h.scans.siteState(h.calls[0].site);
  assert.equal(siteState.stale, true);
  const feed = h.state.list("feedItems");
  assert.equal(feed.length, 1);
  const card = feed[0].data as Record<string, unknown>;
  assert.equal(card.needsYou, true);
  assert.match(String(card.title), /saved login for Rover/);
  assert.match(String(card.summary), /Nothing was sent or booked/);

  // Further ticks: no mission, no second card.
  const second = await runScheduledTick(h.deps, { slot: 1, now: D("2026-11-02T13:00:00.000Z") });
  assert.equal(second.skipped[0].reason, "staleLogin");
  assert.equal(h.calls.length, 1);
  assert.equal(h.state.list("feedItems").length, 1);

  // The user re-saves the login (endpoint calls clearStaleEpisode):
  // the card goes away and scans resume.
  assert.equal(clearStaleEpisode(h.scans, h.state, "rover.com"), 1);
  assert.equal(h.state.list("feedItems").length, 0);
  broken = false;
  const third = await runScheduledTick(h.deps, { slot: 2, now: D("2026-11-02T19:00:00.000Z") });
  assert.equal(h.calls.length, 2);
  assert.equal(third.surfacedIds.length, 1);
});

test("human-only check on a scan: needs-you once, never bypassed, site waits for the user", async () => {
  const h = harness(() => ({ status: "needs_human", items: [], needsHuman: true }));
  seedUser(h.state, { sites: [ROVER] });
  const first = await runScheduledTick(h.deps, { slot: 0, now: D(DAY1) });
  assert.equal(first.needsYouItemIds.length, 1);
  assert.equal(h.scans.siteState(h.calls[0].site).staleReason, "humanCheck");
  const card = h.state.list("feedItems")[0].data as Record<string, unknown>;
  assert.match(String(card.title), /check only you can do/);
  const second = await runScheduledTick(h.deps, { slot: 1, now: D("2026-11-02T13:00:00.000Z") });
  assert.equal(second.skipped[0].reason, "staleLogin");
  assert.equal(h.calls.length, 1);
});

test("public scan that reads nothing stops public scans until a login exists", async () => {
  const h = harness(() => ok([]), {});
  seedUser(h.state, { sites: [UPWORK] });
  await runScheduledTick(h.deps, { slot: 0, now: D(DAY1) });
  assert.equal(h.calls.length, 1);
  const next = await runScheduledTick(h.deps, { slot: 0, now: D("2026-11-03T07:00:00.000Z") });
  assert.equal(next.skipped[0].reason, "publicOnlyBlocked");
  assert.equal(h.calls.length, 1, "logged and skipped, not retried daily forever");
  // Saving a login later clears the block.
  clearStaleEpisode(h.scans, h.state, "upwork.com");
  assert.equal(h.scans.db.getSiteState("upwork")?.publicOnlyBlocked, false);
});

test("per-user daily cap blocks runaway ticks and is logged", async () => {
  const h = harness(() => ok(["Weekend dog sitting | $35/hr | Leeds"]));
  seedUser(h.state, { sites: [ROVER] });
  // Cap for one logged-in site is 3/day; pre-fill today's budget.
  for (const slot of [0, 1, 2]) {
    h.scansDb.addRun({
      id: `pre-${slot}`, siteId: "elsewhere", domain: "elsewhere.com", category: "petcare",
      tier: "logged", slot, runDate: "2026-11-02", startedAt: DAY1, status: "empty",
      itemsFound: 0, itemsSurfaced: 0, itemsFiltered: 0, skillPath: null, errorReason: null,
    });
  }
  const summary = await runScheduledTick(h.deps, { slot: 0, now: D(DAY1) });
  assert.equal(summary.skipped[0].reason, "dailyCap");
  assert.ok(summary.log.some((l) => l.includes("daily scan cap reached (3)")));
  assert.equal(h.calls.length, 0);
});

test("per-user isolation: one user's tick cannot see or touch another user's state", async () => {
  const a = harness(() => ok(["Alice dog sitting | $35/hr | Leeds"]));
  const b = harness(() => ok(["Bob cat sitting | $35/hr | Leeds"]));
  seedUser(a.state, { sites: [ROVER] });
  seedUser(b.state, { sites: [ROVER] });
  await runScheduledTick(a.deps, { slot: 0, now: D(DAY1) });
  assert.equal(b.state.list("feedItems").length, 0);
  assert.equal(b.scansDb.runs.length, 0);
  await runScheduledTick(b.deps, { slot: 0, now: D(DAY1) });
  assert.equal((a.state.list("feedItems")[0].data as Record<string, unknown>).title, "Alice dog sitting");
  assert.equal((b.state.list("feedItems")[0].data as Record<string, unknown>).title, "Bob cat sitting");
});
