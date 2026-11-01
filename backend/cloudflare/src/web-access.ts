/// Web-accessibility gate (Brief 06): probe-verified, site-level
/// eligibility. Fleet-level data only (D1 `site_catalog`, migration
/// 0005) — no user data ever lands here. A site that forces a mobile
/// app is never proposed and never scanned.
///
/// Final rules (documented in docs/profile-learning.md):
/// - Probe reuses the browser mission path (user-sandbox.ts builds the
///   mission; this module only judges its outcome). The probe checks,
///   on desktop web: signup reachable + form present, profile edit
///   reachable, apply flow startable.
/// - A probe that hits an app wall on any key outcome disqualifies
///   (web_accessible=false). Ordinary mission app-wall signals do NOT
///   disqualify by themselves: they strike once and trigger a probe
///   (the one retry). A second strike, or a confirming probe,
///   disqualifies.
/// - unknown is transient: probe before first proposal/scan. A failed
///   probe leaves unknown eligible for at most ONE proposal/scan
///   cycle; after that it blocks until a probe resolves it.
/// - Re-probe monthly (30 days), or immediately on an app-wall strike.
/// - Becoming ineligible withdraws open site proposals with a journal
///   reason and stops scans (the tick checks eligibility first).
import { normalizeId, type StateStore } from "./state.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
export const REPROBE_AFTER_DAYS = 30;
export const UNKNOWN_MAX_CYCLES = 1;
export const APP_WALL_STRIKES_TO_DISQUALIFY = 2;

export type WebAccessibleValue = "true" | "false" | "unknown";

export interface SiteAccessRecord {
  domain: string; // site_catalog.host
  displayName: string | null;
  webAccessible: WebAccessibleValue;
  probedAt: string | null;
  probeEvidence: string | null;
  unknownCyclesUsed: number;
  appWallStrikes: number;
}

export function unknownAccessRecord(domain: string): SiteAccessRecord {
  return {
    domain, displayName: null, webAccessible: "unknown", probedAt: null,
    probeEvidence: null, unknownCyclesUsed: 0, appWallStrikes: 0,
  };
}

export interface ProbeChecks {
  signupReachable: boolean;
  signupFormPresent: boolean;
  profileEditReachable: boolean;
  applyStartable: boolean;
}

export interface ProbeOutcome {
  status: "succeeded" | "failed" | "needs_human";
  appWall?: boolean;
  checks?: ProbeChecks | null;
  evidence?: string | null;
}

export type Eligibility = "eligible" | "ineligible" | "unknownAllowed" | "unknownBlocked";

export function reprobeDue(rec: SiteAccessRecord, now: Date): boolean {
  if (rec.webAccessible === "unknown") return true;
  if (!rec.probedAt) return true;
  const t = Date.parse(rec.probedAt);
  return !Number.isFinite(t) || now.getTime() - t >= REPROBE_AFTER_DAYS * DAY_MS;
}

/// What a catalog record means right now (before any fresh probe).
export function eligibilityOf(rec: SiteAccessRecord | null, domain: string): Eligibility {
  const r = rec ?? unknownAccessRecord(domain);
  if (r.webAccessible === "true") return "eligible";
  if (r.webAccessible === "false") return "ineligible";
  return r.unknownCyclesUsed < UNKNOWN_MAX_CYCLES ? "unknownAllowed" : "unknownBlocked";
}

/// Judge a finished probe. A human-only check during probing is not
/// an app wall and proves nothing either way: the site stays unknown.
export function applyProbeOutcome(
  prior: SiteAccessRecord, outcome: ProbeOutcome, nowIso: string,
): SiteAccessRecord {
  const evidence = (outcome.evidence ?? "").slice(0, 500) || null;
  if (outcome.appWall) {
    return {
      ...prior, webAccessible: "false", probedAt: nowIso,
      probeEvidence: evidence ?? "A key step can only be done in the site's phone app.",
      unknownCyclesUsed: 0, appWallStrikes: prior.appWallStrikes + 1,
    };
  }
  if (outcome.status === "succeeded" && outcome.checks) {
    const c = outcome.checks;
    const allOk = c.signupReachable && c.signupFormPresent && c.profileEditReachable && c.applyStartable;
    if (allOk) {
      return {
        ...prior, webAccessible: "true", probedAt: nowIso,
        probeEvidence: evidence ?? "Signup, profile editing, and starting an application all work on the web.",
        unknownCyclesUsed: 0, appWallStrikes: 0,
      };
    }
    const failed = [
      !c.signupReachable ? "signup page not reachable" : "",
      !c.signupFormPresent ? "no signup form on the web" : "",
      !c.profileEditReachable ? "profile editing not reachable" : "",
      !c.applyStartable ? "applying cannot be started on the web" : "",
    ].filter(Boolean).join("; ");
    return {
      ...prior, webAccessible: "false", probedAt: nowIso,
      probeEvidence: evidence ?? `Web check failed: ${failed}.`,
      unknownCyclesUsed: 0,
    };
  }
  // Probe could not decide (unreachable, error, human-only check).
  return {
    ...prior,
    webAccessible: prior.webAccessible === "true" || prior.webAccessible === "false"
      ? prior.webAccessible : "unknown",
    probedAt: nowIso,
    probeEvidence: evidence ?? "The web check could not finish, so nothing was decided yet.",
  };
}

/// A normal mission hit an app wall: strike, but only a confirming
/// probe (applyProbeOutcome) or a second strike disqualifies.
export function applyAppWallStrike(prior: SiteAccessRecord, nowIso: string): SiteAccessRecord {
  const strikes = prior.appWallStrikes + 1;
  if (strikes >= APP_WALL_STRIKES_TO_DISQUALIFY) {
    return {
      ...prior, webAccessible: "false", probedAt: nowIso, appWallStrikes: strikes,
      unknownCyclesUsed: 0,
      probeEvidence: "Work on this site repeatedly ran into a step that can only be done in its phone app.",
    };
  }
  return { ...prior, appWallStrikes: strikes };
}

export function consumeUnknownCycle(prior: SiteAccessRecord): SiteAccessRecord {
  if (prior.webAccessible !== "unknown") return prior;
  return { ...prior, unknownCyclesUsed: Math.min(UNKNOWN_MAX_CYCLES, prior.unknownCyclesUsed + 1) };
}

/// Withdraw open site proposals for a newly ineligible site and log
/// why in the journal (Brief 01 state rows the app already renders).
/// Proposal rows are removed because the app's ProposalStatus has no
/// "withdrawn" case; the journal sentence is the durable reason.
export function withdrawProposalsForSite(
  state: StateStore,
  site: { siteID: string; name: string },
  reason: string,
  nowIso: string,
  idFactory: () => string,
): string[] {
  const withdrawn: string[] = [];
  for (const row of state.list("proposals")) {
    const d = (row.data ?? {}) as Record<string, unknown>;
    const pid = normalizeId(d.siteID ?? d.siteId);
    const status = String(d.status ?? "proposed").toLowerCase();
    if (pid !== normalizeId(site.siteID)) continue;
    if (status !== "proposed" && status !== "") continue;
    state.remove("proposals", row.id);
    withdrawn.push(row.id);
    const journalId = idFactory();
    state.upsert("journalEvents", journalId, {
      id: journalId,
      occurredAt: nowIso,
      kind: "learnedAboutSite",
      sentence: `Stopped suggesting ${site.name} because it can only be used in its phone app.`,
      detail: reason,
      siteID: site.siteID,
      applicationID: null,
      grossAmount: null,
      currencyCode: "USD",
      listingsChecked: 0,
    }, nowIso);
  }
  return withdrawn;
}
