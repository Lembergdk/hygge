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

// ---- probe judging -----------------------------------------------------
// The exploring mission rarely emits the checks JSON by itself, so a
// follow-up judge reads the mission's evidence (extracted text +
// step log) and answers the four checks. These parsers are strict:
// anything short of four explicit booleans is "undecided".

function jsonObjectAt(text: string, start: number): Record<string, unknown> | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const value = JSON.parse(text.slice(start, i + 1));
          return value && typeof value === "object" && !Array.isArray(value)
            ? value as Record<string, unknown> : null;
        } catch { return null; }
      }
    }
  }
  return null;
}

const CHECK_KEYS = ["signupReachable", "signupFormPresent", "profileEditReachable", "applyStartable"] as const;

function checksFromObject(obj: Record<string, unknown>): ProbeChecks | null {
  if (!CHECK_KEYS.every((k) => typeof obj[k] === "boolean")) return null;
  return {
    signupReachable: obj.signupReachable as boolean,
    signupFormPresent: obj.signupFormPresent as boolean,
    profileEditReachable: obj.profileEditReachable as boolean,
    applyStartable: obj.applyStartable as boolean,
  };
}

/// Find the first complete checks object anywhere in free text
/// (mission extractions often wrap JSON in prose).
export function extractProbeChecks(text: string): ProbeChecks | null {
  for (let i = text.indexOf("{"); i >= 0; i = text.indexOf("{", i + 1)) {
    const obj = jsonObjectAt(text, i);
    if (!obj) continue;
    const checks = checksFromObject(obj);
    if (checks) return checks;
  }
  return null;
}

export interface ProbeJudgeVerdict { checks: ProbeChecks; appWall: boolean }

/// Parse the judge's reply. `{"undecided":true}`, malformed JSON,
/// or missing/non-boolean checks all mean "still unknown" — never a
/// guessed eligibility.
export function parseProbeJudgeReply(reply: string): ProbeJudgeVerdict | null {
  for (let i = reply.indexOf("{"); i >= 0; i = reply.indexOf("{", i + 1)) {
    const obj = jsonObjectAt(reply, i);
    if (!obj) continue;
    if (obj.undecided === true) return null;
    const checks = checksFromObject(obj);
    if (!checks) continue;
    const appWall = obj.appWall === true
      || (typeof obj.appWallText === "string" && obj.appWallText.trim().length > 0);
    return { checks, appWall };
  }
  return null;
}

/// Format one browser snapshot as judge evidence. Interactive
/// element labels are what let the judge actually decide: mission
/// trace summaries alone are agent intentions, not observations.
export function snapshotEvidence(
  snap: { title?: string; currentURLString?: string; elements?: { label: string; kind: string }[] } | null,
): string {
  if (!snap) return "";
  const els = (snap.elements ?? []).slice(0, 80).map((e) => `${e.kind}:${e.label}`).join("; ");
  return `Page snapshot: title "${snap.title ?? ""}" at ${snap.currentURLString ?? ""}. Interactive elements: ${els}`;
}

export function probeJudgePrompt(siteName: string, evidence: string): string {
  return [
    `You are judging whether ${siteName} fully works in a desktop web browser, from evidence a browsing agent collected (page snapshots listing interactive elements, extracted page text, and its step log). If a snapshot lists a page's interactive elements and no signup/join element appears there, that is evidence signup is not reachable from that page.`,
    "Decide four checks ONLY from this evidence:",
    "- signupReachable: a signup or join page was opened.",
    "- signupFormPresent: a signup form with input fields was present.",
    "- profileEditReachable: a sign-in page or an account/profile settings path was reachable (needing to sign in first is fine).",
    "- applyStartable: a way to start applying for work was visible.",
    "Also set appWall to true only if the evidence shows a step that REQUIRES the phone app with no web alternative.",
    "If the evidence is too thin to decide (the visit failed, was blocked, or shows nothing about signup), reply with {\"undecided\":true}.",
    "Otherwise reply ONLY with JSON like {\"signupReachable\":true,\"signupFormPresent\":true,\"profileEditReachable\":true,\"applyStartable\":true,\"appWall\":false}.",
    "Evidence:",
    evidence.slice(0, 6000),
  ].join("\n");
}

export function reprobeDue(rec: SiteAccessRecord, now: Date): boolean {
  // Unknowns are throttled too: applyProbeOutcome stamps probedAt
  // even when undecided, so an undecidable site is re-probed at
  // most monthly instead of burning a browser mission every tick.
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
