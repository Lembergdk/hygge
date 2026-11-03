/// Shared skill repository (Brief 02).
///
/// Skills are ADVISORY, versioned, population-level guidance for achieving
/// one outcome on one site — never scripts, never personalized, never
/// user-sensitive. Candidates live per-user (DO) until corroborated,
/// sanitized, and auto-promoted to the shared D1 `skills` table.
///
/// Schema choice: a NEW `skills` table coexists with `site_hints`
/// (verified unread by missions; short advisory strings) — skills are
/// versioned structured procedures, a different shape. Bodies are stored
/// as JSON in D1 (capped below); if bodies outgrow a comfortable D1 row,
/// move the body to R2 and keep the index in D1.
///
/// Corroboration counts DISTINCT successful missions that followed the
/// candidate (the brief's proposed choice): two successes in one hour
/// count as two. Promotion threshold is PROMOTION_THRESHOLD total.

export const SKILL_OUTCOMES = ["signup", "update_profile", "apply", "message", "book", "discover"] as const;
export type SkillOutcome = (typeof SKILL_OUTCOMES)[number];
export type SkillStatus = "candidate" | "active" | "deprecated";
export type SkillCoverage = "active" | "candidate" | "none";

export const PROMOTION_THRESHOLD = 3; // confirming runs after authoring; the authoring run never counts
export const MAX_SKILL_BODY_BYTES = 16_384;

export interface SkillBody {
  summary: string;
  steps: string[];
  pitfalls: string[];
  notes: string;
}

export interface SharedSkill {
  id: string;
  site: string;
  outcome: SkillOutcome;
  version: number;
  body: SkillBody;
  confidence: number;
  sourceRunCount: number;
  lastVerifiedAt: string | null;
  status: SkillStatus;
}

export interface SkillCandidate {
  id: string;
  site: string;
  outcome: SkillOutcome;
  body: SkillBody;
  corroborationCount: number;
  status: "candidate" | "promoted" | "rejected";
  rejectionReason?: string | null;
}

export function outcomeForTaskKind(kind: string): SkillOutcome {
  switch (kind) {
    case "signup": return "signup";
    case "buildProfile": return "update_profile";
    case "apply": return "apply";
    case "message": return "message";
    case "bookCalendar": return "book";
    default: return "discover";
  }
}

/// Write kinds always require human approval. A loaded skill NEVER
/// changes this — skills are advice, not authority.
export const WRITE_TASK_KINDS = new Set(["signup", "buildProfile", "apply", "message", "bookCalendar"]);
export function requiresApprovalForKind(kind: string, _hasSkill = false): boolean {
  return WRITE_TASK_KINDS.has(kind);
}

// ---- sanitization (fail closed) --------------------------------------
// The pass redacts recognised user-specific values to placeholders, then
// RE-SCANS. Anything still detected, or any guardrail-bypass language,
// rejects the candidate outright — it is never promoted.

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const JWT_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const SECRET_KEY_RE = /\b(?:sk-[A-Za-z0-9]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]+|AKIA[A-Z0-9]{16})\b/g;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._-]+/gi;
const LONG_TOKEN_RE = /\b[A-Za-z0-9_-]{32,}\b/g;
const PHONE_RE = /(?:\+?\d[\d\s().-]{7,}\d)/g;
const ISO_DATE_RE = /\b(?:19|20)\d{2}-\d{2}-\d{2}\b/g;
const SLASH_DATE_RE = /\b\d{1,2}[/.]\d{1,2}[/.](?:19|20)\d{2}\b/g;
const STREET_RE = /\b\d{1,6}\s+[A-Z][A-Za-z0-9 .'-]*\b(?:Street|St|Avenue|Ave|Road|Rd|Lane|Ln|Drive|Dr|Boulevard|Blvd|Way|Court|Ct|Place|Pl)\b/g;
const POSTCODE_RE = /\b(?:[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}|\d{5}(?:-\d{4})?)\b/g;
const LABELED_SECRET_RE = /\b(?:password|passwd|pwd|secret|token|api[_ -]?key|credential)\s*(?:is|:|=)\s*\S+/gi;
const LABELED_NAME_RE = /\b(?:full name|name)\s*(?:is|:|=)\s*[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+/g;

const DETECTORS: { name: string; re: RegExp; placeholder: string }[] = [
  { name: "jwt", re: JWT_RE, placeholder: "<token>" },
  { name: "secret-key", re: SECRET_KEY_RE, placeholder: "<token>" },
  { name: "bearer", re: BEARER_RE, placeholder: "Bearer <token>" },
  { name: "labeled-secret", re: LABELED_SECRET_RE, placeholder: "credential: <credential>" },
  { name: "email", re: EMAIL_RE, placeholder: "<email>" },
  { name: "labeled-name", re: LABELED_NAME_RE, placeholder: "name: <name>" },
  { name: "street-address", re: STREET_RE, placeholder: "<address>" },
  { name: "date", re: ISO_DATE_RE, placeholder: "<date>" },
  { name: "date", re: SLASH_DATE_RE, placeholder: "<date>" },
  { name: "phone", re: PHONE_RE, placeholder: "<phone>" },
  { name: "postcode", re: POSTCODE_RE, placeholder: "<postcode>" },
  { name: "long-token", re: LONG_TOKEN_RE, placeholder: "<token>" },
];

/// Language that would make a skill an authority/checkpoint bypass.
/// Presence anywhere in the body rejects promotion.
const GUARDRAIL_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "approval-bypass", re: /\b(?:skip|bypass|avoid|ignore|pre-?approv\w*|without)\b[^.]{0,40}\b(?:approva[l1i]|user (?:consent|confirmation)|confirmation)\b/i },
  { name: "approval-bypass", re: /\bno (?:approval|confirmation) (?:is )?(?:needed|required)\b/i },
  { name: "approval-bypass", re: /\b(?:already|previously|earlier)\b[^.]{0,30}\b(?:approved|granted|consented)\b/i },
  { name: "approval-bypass", re: /\b(?:approval|consent)\b[^.]{0,30}\b(?:already|previously|earlier|was granted|has been granted)\b/i },
  { name: "approval-bypass", re: /\b(?:do not|don't|dont|never)\s+ask\b[^.]{0,40}\b(?:confirmation|approval|consent|permission|again|just)\b/i },
  { name: "approval-bypass", re: /\bwithout asking\b|\bproceed silently\b|\bsubmit silently\b/i },
  { name: "checkpoint-bypass", re: /\b(?:bypass|solve|skip|defeat|evade|circumvent|get (?:past|around))\b[^.]{0,40}\b(?:captcha|2fa|two[- ]factor|mfa|identity (?:check|verification)|id check|verification code)\b/i },
  { name: "checkpoint-bypass", re: /\b(?:enter|type|fill in?|provide)\b[^.]{0,30}\b(?:verification|otp|one[- ]time) code\b[^.]{0,30}\b(?:yourself|automatically|from (?:the )?(?:sms|email|message))\b/i },
  { name: "credential-request", re: /\b(?:ask|request|collect|prompt)\b[^.]{0,30}\b(?:the user|user)\b[^.]{0,20}\b(?:password|credential|secret)\b/i },
  { name: "credential-literal", re: /\b(?:type|enter|fill)\b[^.]{0,20}\b(?:the )?password\b(?![^.]{0,30}(?:valueRef|credential\.|vault|<password>|placeholder))/i },
];

export interface SanitizationResult {
  ok: boolean;
  body?: SkillBody;
  redactions: string[];
  reasons: string[];
}

// Detection-only folding: NFKC + casefold + Cyrillic/Greek confusables, so
// case, spacing, punctuation, percent-encoding, or lookalike letters cannot
// smuggle a known personal value past the re-scan below.
const CONFUSABLE_FOLD: Record<string, string> = {
  "\u0430": "a", "\u0435": "e", "\u043E": "o", "\u0440": "p", "\u0441": "c", "\u0443": "y", "\u0445": "x",
  "\u0456": "i", "\u0455": "s", "\u04BB": "h", "\u0458": "j", "\u0410": "a", "\u0412": "b", "\u0415": "e",
  "\u041A": "k", "\u041C": "m", "\u041D": "h", "\u041E": "o", "\u0420": "p", "\u0421": "c", "\u0422": "t",
  "\u0425": "x", "\u03B1": "a", "\u03B5": "e", "\u03B9": "i", "\u03BA": "k", "\u03BD": "v", "\u03BF": "o",
  "\u03C1": "p", "\u03C4": "t", "\u03C5": "u", "\u03C7": "x",
};
function foldForMatch(text: string): string {
  let out = "";
  for (const ch of String(text).normalize("NFKC")) out += CONFUSABLE_FOLD[ch] ?? ch;
  return out.toLowerCase();
}
function compactForMatch(text: string): string {
  return foldForMatch(text).replace(/[^\p{L}\p{N}]/gu, "");
}
function foldedHaystacks(text: string): { folded: string; compact: string } {
  let decoded = text;
  try { decoded = decodeURIComponent(text); } catch { /* keep raw */ }
  const joined = decoded === text ? text : `${text}\n${decoded}`;
  return { folded: foldForMatch(joined), compact: compactForMatch(joined) };
}
function knownValueRemains(clean: string, knownValues: string[]): boolean {
  const { folded, compact } = foldedHaystacks(clean);
  for (const value of knownValues) {
    const v = value.trim();
    if (v.length < 3) continue;
    if (clean.includes(v) || folded.includes(foldForMatch(v))) return true;
    const needle = compactForMatch(v);
    if (needle.length >= 4 && compact.includes(needle)) return true;
  }
  return false;
}

/// Shared guidance may name a site's origin and generic routes, never a
/// personalized URL: query, fragment, and userinfo are stripped here and
/// any remainder rejects at re-scan.
function scrubUrls(text: string, redactions: Set<string>): string {
  return text.replace(/https?:\/\/[^\s"')]+/gi, (m) => {
    try {
      const u = new URL(m);
      const clean = u.origin + u.pathname;
      if (clean !== m) redactions.add("url-query");
      return clean;
    } catch { return m; }
  });
}

function sanitizeText(text: string, knownValues: string[], redactions: Set<string>): string {
  let out = scrubUrls(String(text ?? ""), redactions);
  for (const value of knownValues) {
    const v = value.trim();
    if (v.length >= 3 && out.includes(v)) {
      out = out.split(v).join("<value>");
      redactions.add("known-value");
    }
  }
  for (const d of DETECTORS) {
    out = out.replace(d.re, () => { redactions.add(d.name); return d.placeholder; });
  }
  return out;
}

function bodyText(body: SkillBody): string {
  return [body.summary, ...body.steps, ...body.pitfalls, body.notes].join("\n");
}

/// Sanitize + validate a candidate body for promotion. `knownValues`
/// are the authoring user's own draft values, used ONLY as match
/// needles here — they are never stored, returned, or logged.
export function sanitizeSkillBody(input: unknown, knownValues: string[] = []): SanitizationResult {
  const reasons: string[] = [];
  const raw = (input ?? {}) as Partial<SkillBody>;
  const candidate: SkillBody = {
    summary: String(raw.summary ?? ""),
    steps: Array.isArray(raw.steps) ? raw.steps.map(String) : [],
    pitfalls: Array.isArray(raw.pitfalls) ? raw.pitfalls.map(String) : [],
    notes: String(raw.notes ?? ""),
  };
  if (!candidate.summary.trim()) reasons.push("missing summary");
  if (!candidate.steps.length || candidate.steps.some((s) => !s.trim())) reasons.push("missing steps");
  if (JSON.stringify(candidate).length > MAX_SKILL_BODY_BYTES) reasons.push("body too large");

  const rawText = bodyText(candidate);
  const foldedRaw = foldForMatch(rawText);
  for (const g of GUARDRAIL_PATTERNS) {
    if (g.re.test(rawText) || g.re.test(foldedRaw)) reasons.push(`guardrail: ${g.name}`);
  }

  const redactions = new Set<string>();
  const body: SkillBody = {
    summary: sanitizeText(candidate.summary, knownValues, redactions),
    steps: candidate.steps.map((s) => sanitizeText(s, knownValues, redactions)),
    pitfalls: candidate.pitfalls.map((s) => sanitizeText(s, knownValues, redactions)),
    notes: sanitizeText(candidate.notes, knownValues, redactions),
  };

  // Fail closed: re-scan the sanitized output; detectors must not fire
  // (placeholders themselves are exempt via the negative lookahead set).
  const clean = bodyText(body);
  for (const d of DETECTORS) {
    const matches = clean.match(d.re) ?? [];
    const leftover = matches.filter((m) => !/^<(?:email|token|credential|name|address|date|phone|postcode|value|password|username|rate)>$/i.test(m.trim())
      && !/^Bearer <token>$/i.test(m.trim()) && !/^credential: <credential>$/i.test(m.trim()) && !/^name: <name>$/i.test(m.trim()));
    if (leftover.length) reasons.push(`unsanitized ${d.name} remained`);
  }
  if (knownValueRemains(clean, knownValues)) reasons.push("known user value remained");
  if (/https?:\/\/[^\s"')]*[?#][^\s"')]+/i.test(clean)) reasons.push("personalized url remained");
  return reasons.length
    ? { ok: false, redactions: [...redactions], reasons }
    : { ok: true, body, redactions: [...redactions], reasons: [] };
}

// ---- distillation & maintenance ---------------------------------------

/// Distil a finished trace into a skill DRAFT (guidance, not a script).
/// Only successful, non-credential actions become steps; targets are
/// element labels/URLs (machine-checkable anchors), never typed values.
export function distillSkillDraft({ site, outcome, trace }: {
  site: string; outcome: SkillOutcome; trace: any[];
}): SkillBody {
  const steps: string[] = [];
  const pitfalls: string[] = [];
  for (const t of trace ?? []) {
    if (t.action === "done" || t.action === "askUser") continue;
    if (t.succeeded) {
      if (/password/i.test(t.target ?? "")) {
        steps.push("When a password field appears, fill it via valueRef credential.secret so the vault supplies it.");
      } else if (t.action === "navigate" && t.urlString) {
        // Observed URLs may be personalized (profile paths, invite queries):
        // only the origin and generic route may ever become guidance.
        let route = "";
        try { const u = new URL(String(t.urlString)); route = u.origin + u.pathname; } catch { /* unparseable: emit no step */ }
        if (route) steps.push(`Start at ${route} and look for the ${outcome} entry point.`);
      } else if (t.target) {
        steps.push(`Use the "${t.target}" control when it is visible on ${site}.`);
      }
    } else if (t.action === "needsHuman") {
      pitfalls.push("A verification, bot, two-factor or identity check may appear — Hygge gets a bounded number of tries at it before it must ask the user.");
    } else if (t.target) {
      pitfalls.push(`"${t.target}" was not found once — look for a different label if it is absent.`);
    }
  }
  return {
    summary: `How to ${outcome} on ${site} (distilled from a successful run; advisory only).`,
    steps: [...new Set(steps)].slice(0, 12).length
      ? [...new Set(steps)].slice(0, 12)
      : [`Explore ${site} from the landing page toward the ${outcome} goal, deciding from the live page.`],
    pitfalls: [...new Set(pitfalls)].slice(0, 6),
    notes: "Steps are advice, never a script: if the live page disagrees, trust the page. Fill user values from draft refs or placeholders such as <username> and <rate>.",
  };
}

/// Confidence maintenance. A failure whose failed action targets are
/// named in the skill's steps implicates the skill -> back to candidate
/// (not served) until re-corroborated. Deprecated is terminal here.
export function applySkillOutcome(skill: SharedSkill, success: boolean, implicated = false): SharedSkill {
  if (skill.status === "deprecated") return skill;
  const confidence = success
    ? Math.min(1, skill.confidence + 0.05)
    : Math.max(0, skill.confidence - 0.1);
  return {
    ...skill,
    confidence,
    sourceRunCount: skill.sourceRunCount + 1,
    lastVerifiedAt: success ? new Date().toISOString() : skill.lastVerifiedAt,
    status: !success && implicated ? "candidate" : skill.status,
  };
}

export function skillImplicatedByFailure(skill: SharedSkill, trace: any[]): boolean {
  const stepText = skill.body.steps.join("\n").toLowerCase();
  return (trace ?? []).some((t) => !t.succeeded && t.target
    && t.action !== "needsHuman" && t.action !== "askUser"
    && stepText.includes(String(t.target).toLowerCase()));
}

export function shouldPromote(candidate: SkillCandidate): boolean {
  return candidate.status === "candidate" && candidate.corroborationCount >= PROMOTION_THRESHOLD;
}

/// Stable content hash binding corroboration to the exact authored body:
/// a later run only corroborates when its distilled draft is identical.
export async function skillBodyHash(body: SkillBody): Promise<string> {
  const canonical = JSON.stringify({ summary: body.summary, steps: body.steps, pitfalls: body.pitfalls, notes: body.notes });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/// Legacy missions have no canonical receipt or reviewed postconditions, so
/// positive shared feedback requires observed evidence in the result itself.
/// A model "done" alone never moves shared confidence.
export function missionOutcomeVerified(task: any, result: any): boolean {
  if (result?.status !== "succeeded") return false;
  if (Array.isArray(result.extractedItems) && result.extractedItems.length > 0) return true;
  if (result.sessionProbe === "authenticated") return true;
  void task;
  return false;
}

// ---- repository (D1 in production, in-memory in tests) ----------------

export interface SkillRepository {
  loadActive(site: string, outcome: SkillOutcome): Promise<SharedSkill | null>;
  insertActive(skill: SharedSkill): Promise<void>;
  update(skill: SharedSkill): Promise<void>;
  /// Maintainer kill switch: terminally deprecate so loadActive never serves it.
  quarantine(id: string): Promise<boolean>;
}

export class InMemorySkillRepository implements SkillRepository {
  skills: SharedSkill[] = [];
  async loadActive(site: string, outcome: SkillOutcome) {
    const active = this.skills.filter((s) => s.site === site && s.outcome === outcome && s.status === "active");
    return active.sort((a, b) => b.version - a.version)[0] ?? null;
  }
  async insertActive(skill: SharedSkill) { this.skills.push({ ...skill }); }
  async update(skill: SharedSkill) {
    const i = this.skills.findIndex((s) => s.id === skill.id);
    if (i >= 0) this.skills[i] = { ...skill };
  }
  async quarantine(id: string): Promise<boolean> {
    const i = this.skills.findIndex((s) => s.id === id);
    if (i < 0 || this.skills[i].status === "deprecated") return false;
    this.skills[i] = { ...this.skills[i], status: "deprecated" };
    return true;
  }
  nextVersion(site: string, outcome: SkillOutcome): number {
    return Math.max(0, ...this.skills.filter((s) => s.site === site && s.outcome === outcome).map((s) => s.version)) + 1;
  }
}

/// D1-backed repository over the `skills` table (migration 0002).
/// Takes the D1 binding structurally so node tests never import CF types.
export class D1SkillRepository implements SkillRepository {
  db: any;
  constructor(db: any) { this.db = db; }
  async loadActive(site: string, outcome: SkillOutcome): Promise<SharedSkill | null> {
    const row = await this.db.prepare(
      "SELECT * FROM skills WHERE site = ?1 AND outcome = ?2 AND status = 'active' ORDER BY version DESC LIMIT 1",
    ).bind(site, outcome).first();
    return row ? rowToSkill(row) : null;
  }
  async nextVersion(site: string, outcome: SkillOutcome): Promise<number> {
    const row = await this.db.prepare(
      "SELECT COALESCE(MAX(version), 0) AS v FROM skills WHERE site = ?1 AND outcome = ?2",
    ).bind(site, outcome).first();
    return Number(row?.v ?? 0) + 1;
  }
  async insertActive(skill: SharedSkill): Promise<void> {
    await this.db.prepare(
      `INSERT INTO site_catalog (host, display_name) VALUES (?1, ?1) ON CONFLICT(host) DO NOTHING`,
    ).bind(skill.site).run().catch(() => {});
    await this.db.prepare(
      `INSERT INTO skills (id, site, outcome, version, body, confidence, source_run_count, last_verified_at, status)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'active')`,
    ).bind(skill.id, skill.site, skill.outcome, skill.version, JSON.stringify(skill.body),
      skill.confidence, skill.sourceRunCount, skill.lastVerifiedAt).run();
  }
  async update(skill: SharedSkill): Promise<void> {
    await this.db.prepare(
      `UPDATE skills SET confidence = ?2, source_run_count = ?3, last_verified_at = ?4, status = ?5,
       updated_at = datetime('now') WHERE id = ?1`,
    ).bind(skill.id, skill.confidence, skill.sourceRunCount, skill.lastVerifiedAt, skill.status).run();
  }
  async quarantine(id: string): Promise<boolean> {
    await this.db.prepare(
      `UPDATE skills SET status = 'deprecated', updated_at = datetime('now') WHERE id = ?1 AND status != 'deprecated'`,
    ).bind(id).run();
    const row = await this.db.prepare("SELECT status FROM skills WHERE id = ?1").bind(id).first();
    return row?.status === "deprecated";
  }
}

function rowToSkill(row: any): SharedSkill {
  return {
    id: String(row.id), site: String(row.site), outcome: row.outcome as SkillOutcome,
    version: Number(row.version), body: JSON.parse(String(row.body)),
    confidence: Number(row.confidence), sourceRunCount: Number(row.source_run_count),
    lastVerifiedAt: row.last_verified_at ?? null, status: row.status as SkillStatus,
  };
}

/// Attempt promotion of a corroborated candidate. Returns the shared
/// skill on success; on sanitization/guardrail failure the candidate
/// is rejected (never promoted) with reasons for the log.
export async function promoteCandidate(
  repo: SkillRepository & { nextVersion(site: string, o: SkillOutcome): Promise<number> | number },
  candidate: SkillCandidate,
  knownValues: string[] = [],
): Promise<{ promoted?: SharedSkill; rejected?: string[] }> {
  if (!shouldPromote(candidate)) return { rejected: [`corroboration ${candidate.corroborationCount} < ${PROMOTION_THRESHOLD}`] };
  const clean = sanitizeSkillBody(candidate.body, knownValues);
  if (!clean.ok || !clean.body) return { rejected: clean.reasons };
  const skill: SharedSkill = {
    id: candidate.id, site: candidate.site, outcome: candidate.outcome,
    version: await repo.nextVersion(candidate.site, candidate.outcome),
    body: clean.body, confidence: 0.7, sourceRunCount: candidate.corroborationCount,
    lastVerifiedAt: new Date().toISOString(), status: "active",
  };
  await repo.insertActive(skill);
  return { promoted: skill };
}
