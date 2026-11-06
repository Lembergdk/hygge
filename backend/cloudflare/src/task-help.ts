// Conversation-first handoffs, grounded suggestions, and exact-action consent.
// Kept pure so the same policy is tested independently of storage and UI.
//
/// A help's deadline is an OPTIONAL EXPIRY TIME, FOR DISPLAY
/// ONLY (policy settled Nov 5, 2026, simplified Nov 5, 22:08 CST):
/// it never drives routing, escalation, or enforcement — every
/// decision card goes to chat anyway, so an expiry cannot gate
/// anything. The agent sets it where applicable (session-related
/// cards, client/job-site deadlines); never-deadline cases (e.g.
/// onboarding questions) never get one. There is no "short"
/// concept and no window: a deadline is a real expiration date on
/// the card, full stop. Garbage, past, and unparseable dates are
/// no deadline at all (see parseHelpDeadline). A deadline that
/// lapses after it was set renders as a past "Expires" date on a
/// still-live card — accepted as a display detail for now.
export function parseHelpDeadline(value: unknown, now: Date = new Date()): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = new Date(value.trim());
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.getTime() > now.getTime() ? parsed : null;
}

/// Deadline producers (the agent is the deadline producer — it
/// defines the deadline from page/client content using its own
/// reasoning; help() validates it, see above):
/// - SET a deadline: approval (agent.ts needsActionApproval path,
///   from decision.deadline), verification from a model needsHuman
///   decision (agent.ts, decision.deadline — e.g. a code expiry the
///   page states), information (informationHelp, only when the
///   agent surfaces one via decision.deadline).
/// - NEVER set one: credentials (a stale login does not expire),
///   recovery (a session ending carries no expiry), onboarding/
///   profile questions (never wanted), checkpoint-budget
///   verification (askAfterTrying — no expiry is knowable),
///   human-takeover verification (user-sandbox.ts), and the
///   workspace runner's silent pauses (no help, so no deadline
///   to set). A help built without a deadline has deadline null, and
///   the card shows no expiration date for it.

export function help(kind: string, message: string, questions: any[] = [], actionLabel = "Continue",
                     deadline: string | null = null, opts: { staticText?: boolean } = {}) {
  // The deadline is agent-set from page/client content (an offer
  // expiry, an application closing date, a code expiry) — never
  // invented. Validate it at construction: garbage or past dates
  // are dropped (and logged) rather than stored, so a malformed
  // model value can never reach the card as an expiration date.
  // `staticText` marks a help whose message is a hardcoded literal
  // rather than model-composed text (recovery/verification/
  // credentials fallbacks, checkpoint and takeover wording). The
  // mirror (saveTask) composes the chat message for a static help
  // from its facts via chat-composer.ts instead of relaying the
  // literal verbatim; the literal stays only as the logged
  // fallback when composition fails. Model-composed helps carry no
  // marker and relay verbatim.
  let validDeadline: string | null = null;
  if (deadline !== null && deadline !== undefined) {
    const parsed = parseHelpDeadline(deadline);
    if (parsed) validDeadline = parsed.toISOString();
    else console.warn(`help: dropping invalid deadline ${JSON.stringify(String(deadline).slice(0, 80))} for kind ${kind}`);
  }
  return { id: crypto.randomUUID(), kind, message, questions, actionLabel, deadline: validDeadline,
    ...(opts.staticText ? { staticText: true } : {}) };
}

/// Feed/chat routing for a task help (policy settled Nov 5, 2026,
/// as revised Nov 5, 21:07 CST): EVERY decision card warrants a
/// chat message linking to the card, and every chat message
/// generates a push. So every well-formed decision kind —
/// information, approval, verification, credentials, recovery —
/// routes to chat. The deadline no longer gates whether a decision
/// card gets a message (all do); the deadline is the card's
/// expiration date, display only — it never escalates or enforces
/// anything.
///
/// A help object with an unknown or missing kind is still a
/// decision card by construction — it is routed to chat and flagged
/// server-side (logged) rather than silently dropped or silently
/// routed. A null help (help-less needsHuman) carries no content
/// any message could be composed about, so it gets NO chat message
/// and NO push: a push only ever comes from a chat message, and a
/// feed card alone never pushes.
export function helpRoutesToChat(help: any): boolean {
  if (!help) return false;
  const known = ["information", "approval", "verification", "credentials", "recovery"];
  if (typeof help.kind !== "string" || !known.includes(help.kind)) {
    console.warn(`helpRoutesToChat: unknown help kind ${JSON.stringify(String(help.kind ?? null)).slice(0, 80)} (id ${String(help.id ?? "?").slice(0, 36)}) — routing to chat as a decision card by construction; investigate the producer`);
    return true;
  }
  return true;
}

/// The chat message relaying a decision help: the help's own
/// words, verbatim — the help message plus its first question. For
/// a model-composed help both were written by the mission model
/// from live page context (agent.ts), so the mirror relays; it
/// does not rephrase, so the message and the feed card can never
/// disagree. For a help marked `staticText` (a hardcoded literal,
/// see help()), this relay is only the immediately-written text:
/// saveTask composes the message from the help's facts via
/// chat-composer.ts and replaces this row's text with the composed
/// version, falling back to this relay (logged) when composition
/// fails. The old `${title}: ` prefix is gone from the server
/// mirror (the card carries the title). This is the single text
/// shape for the mirror — saveTask (user-sandbox.ts) and the
/// workspace projector (workspace-task-projection.ts) both use it,
/// so the two mirror paths cannot silently diverge. Null when
/// there is no message to relay.
export function decisionHelpMessageText(task: any): string | null {
  const help = task?.help;
  if (!help || typeof help.message !== "string" || !help.message.trim()) return null;
  const firstQuestion = typeof help.questions?.[0]?.text === "string" && help.questions[0].text.trim()
    ? help.questions[0].text.trim() : "";
  return firstQuestion ? `${help.message.trim()}\n\n${firstQuestion}` : help.message.trim();
}

export function informationHelp(decision: any, draft: Record<string, string>) {
  // An information help carries a deadline only when the agent
  // surfaces one (decision.deadline, from page/client content) —
  // onboarding and profile questions never do.
  const deadline = typeof decision?.deadline === "string" ? decision.deadline : null;
  const raw = Array.isArray(decision.questions) ? decision.questions.slice(0, 5) : [];
  const questions = raw.map((q: any) => {
    const text = String(typeof q === "string" ? q : q.text ?? "").slice(0, 400);
    // Suggestions must refer to known draft values, not model-invented personal facts.
    const refs = Array.isArray(q?.suggestedRefs) ? q.suggestedRefs : [];
    const suggestions = refs.filter((r: any) => typeof r === "string" && !/password|secret|token|code/i.test(r))
      .map((r: string) => draft[r.replace(/^draft\./, "")])
      .filter((v: any) => typeof v === "string" && v.trim().length > 0).slice(0, 3);
    return { text, suggestions: [...new Set(suggestions)] };
  }).filter((q: any) => q.text);
  if (questions.some((q: any) => /password|secret|passcode|one.time code|verification code/i.test(q.text))) {
    return help("verification", "This sign-in step needs you. Enter the requested secret only on the site, never in chat.", [], "Complete check", deadline, { staticText: true });
  }
  const usedFallbackQuestion = !questions.length;
  if (usedFallbackQuestion) questions.push({ text: "What should I use for this step?", suggestions: [] });
  // Static when the message is the literal fallback (no model
  // reason) or the question is the literal fallback (the model
  // asked nothing): the mirror composes from these facts instead
  // of relaying the literal. A model reason with model questions
  // relays verbatim.
  const staticText = !decision.reason || usedFallbackQuestion;
  return help("information", String(decision.reason || "I need a detail to continue."), questions, "Continue", deadline, staticText ? { staticText: true } : {});
}

export function actionFingerprint(decision: any, snapshot: any, draft: any): string {
  return JSON.stringify([snapshot.sessionID, snapshot.currentURLString, snapshot.title, snapshot.elements.map((e: any) => e.label).sort(),
    snapshot.elements.find((e: any) => e.ref === decision.target) ?? null,
    decision.action, decision.target ?? "", decision.value ?? "", decision.valueRef ?? "", draft]);
}

export function needsActionApproval(task: any, decision: any): boolean {
  // Keyboard submission has no trustworthy button label; require explicit
  // approval rather than letting Enter/Space bypass consequential-click gates.
  if (decision.action === "press" && ["Enter", "Space"].includes(decision.value)) return true;
  if (task.interaction_version !== 1 || !["click", "type", "upload", "navigate", "select", "check", "press", "hover"].includes(decision.action)) return false;
  const target = String(decision.targetLabel ?? decision.target ?? "");
  // Obvious consequential controls override a model's "reversible" classification.
  const destructive = /delete|remove account|close account|purchase|pay now|subscribe|accept offer|book now/i.test(target);
  if (destructive) return true;
  const publicAction = /publish|post (now|profile|message)|send message|submit application/i.test(target);
  const effect = decision.effect;
  if (effect === "accountCreation" && task.kind === "signup" && task.drafted_payload?.setupMode !== "connect") return false;
  // Existing explicitly approved drafts retain their scoped permission.
  if ((publicAction || effect === "public") && ["buildProfile", "apply", "message"].includes(task.kind)) return false;
  if (publicAction) return true;
  // Unknown impact fails closed. Safe routine navigation/input needs no user intervention.
  return effect !== "reversible";
}

export function applyHelpReply(task: any, body: any): string | null {
  const pending = task.help;
  if (!pending || String(pending.id).toLowerCase() !== String(body.helpID).toLowerCase()) return "This request has changed. Refresh the conversation.";
  if (!["needsHuman", "failed"].includes(task.status)) return "This task is no longer waiting for a reply.";
  if (pending.kind === "approval") {
    if (body.approved !== true || !task.pending_action) return "Explicit approval is required.";
    task.authorized_action = task.pending_action;
  }
  if (pending.kind === "information") {
    const answers = body.answers ?? {};
    const provided = pending.questions.filter((q: any) => typeof answers[q.text] === "string" && answers[q.text].trim());
    if (!provided.length || provided.some((q: any) => answers[q.text].length > 4000)) return "Please answer the requested question.";
    for (const q of provided) {
      const key = /phone/i.test(q.text) ? "phone" : /date of birth/i.test(q.text) ? "dateOfBirth" : `answer:${q.text}`;
      task.drafted_payload[key] = answers[q.text].trim();
    }
    const remaining = pending.questions.filter((q: any) => !provided.includes(q));
    if (remaining.length) {
      task.help = help("information", "Thanks. One more detail before I continue.", remaining,
        "Continue", pending.deadline ?? null, { staticText: true });
      task.information_requests = remaining.map((q: any) => q.text);
      return null;
    }
  }
  task.help = null;
  task.pending_action = null;
  task.information_requests = [];
  return null;
}

export function mobileTask(task: any) {
  if (!task.mobile_task) {
    if (task._fromSnapshot && task.help) {
      return { ...task, backendTaskID: null,
        createdAt: typeof task.createdAt === "string" ? (Date.parse(task.createdAt) / 1000 - 978307200) : task.createdAt };
    }
    // A live task that lost its mobile projection is invisible to the
    // app — no feed card, no conversation, no review — even when it is
    // stuck waiting on the user (Apple Fiverr, Nov 5: needsHuman with
    // an uncertain effect, no mobile_task, no _fromSnapshot). Synthesize
    // a projection from the task's own fields so it can be reviewed.
    // Only a real site task asking the user something (a help, or a
    // pending effect); internal work (probes, fixtures, document saves)
    // has neither and stays hidden.
    const host = siteHost(task.target_url);
    if (!host || task.web_probe || typeof task.id !== "string"
        || !["needsHuman", "failed"].includes(task.status)
        || !["discover", "signup", "buildProfile", "apply", "message", "bookCalendar"].includes(task.kind)
        || (!task.help && !task.workspace_pending_effect_id)) return null;
    // The projection is the app's only view of this task, and one bad
    // field poisons the whole tasks response (the app decodes the list
    // as one document, so a single undecodable row drops every task).
    // The raw record's fields are model-shaped, so sanitize them to
    // exactly what AgentTask decodes: string-valued payload, string
    // lists, trace entries with a known action kind and the fields the
    // app requires, and a finite createdAt.
    const createdAt = createdAtSeconds(task.createdAt);
    return { id: task.id, kind: task.kind, siteID: host, targetURLString: task.target_url,
      goal: typeof task.goal === "string" ? task.goal : "", title: typeof task.title === "string" ? task.title : host,
      draftedPayload: stringRecord(task.drafted_payload),
      browserTrace: validTrace(task.browser_trace), informationRequests: stringList(task.information_requests),
      status: task.status === "awaiting_approval" ? "awaitingApproval" : task.status,
      log: stringList(task.log), createdAt, backendTaskID: task.id,
      browserSessionID: task.session_id ?? null, help: task.help ?? null, pendingReply: null,
      pendingEffectID: task.workspace_pending_effect_id ?? null };
  }
  return { ...task.mobile_task, backendTaskID: task.id, status: task.status === "awaiting_approval" ? "awaitingApproval" : task.status,
    draftedPayload: task.drafted_payload, browserSessionID: task.session_id ?? null,
    browserTrace: task.browser_trace ?? [], informationRequests: task.information_requests ?? [],
    help: task.help ?? null, pendingReply: null, log: task.log ?? [],
    // The step awaiting review, so the app can ask the user whether it
    // happened on the site and reconcile it. Null when nothing is stuck.
    pendingEffectID: task.workspace_pending_effect_id ?? null };
}

function siteHost(targetUrl: unknown): string | null {
  try {
    const u = new URL(String(targetUrl));
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const host = u.hostname.replace(/^www\./, "");
    return host && host !== "invalid.example" ? host : null;
  } catch { return null; }
}

// Seconds since 2001-01-01 (the app's TimeInterval), never NaN: an
// unparseable stored date falls back to now rather than poisoning
// the projection (JSON has no NaN; it would serialize as null and
// the app's required createdAt would fail to decode).
function createdAtSeconds(value: unknown): number {
  const seconds = typeof value === "string" ? Date.parse(value) / 1000 - 978307200
    : typeof value === "number" ? value : NaN;
  return Number.isFinite(seconds) ? seconds : Date.now() / 1000 - 978307200;
}

function stringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      if (typeof v === "string") out[k] = v;
  return out;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v: unknown): v is string => typeof v === "string") : [];
}

// The app's BrowserTraceEvent: action must be a known BrowserActionKind
// and the other fields the app requires must have the right types.
// The model can emit an action outside that set (mobileBrowserAction
// only maps a few), and one such entry would fail the whole tasks
// response to decode — so drop entries that do not match, and emit
// only the fields the app reads.
const TRACE_ACTIONS = ["navigate", "click", "type", "select", "extract", "screenshot", "waitForHuman", "askUser", "done", "needsHuman"];
function validTrace(value: unknown): any[] {
  if (!Array.isArray(value)) return [];
  return value.filter((e: any) => e && typeof e === "object" && TRACE_ACTIONS.includes(e.action)
      && typeof e.target === "string" && typeof e.urlString === "string"
      && typeof e.summary === "string" && typeof e.succeeded === "boolean")
    .map((e: any) => ({ action: e.action, target: e.target, urlString: e.urlString, summary: e.summary, succeeded: e.succeeded }));
}

export function canResumeWithInboxCode(task: any): boolean {
  return task.interaction_version === 1 && task.status === "needsHuman" && task.help?.kind === "verification"
    && task.checkpoint === "two-factor check" && task.email_code_available === true && task.scheduled_scan !== true;
}

/** Expiration invalidates page-bound consent and replaces the dead checkpoint once.
 * A retained-v2 session end is a silent pause (silent=true): no recovery
 * prompt is set — the task resumes on its own through the server-side
 * auto-resume, and no chat message or push is composed for it (saveTask
 * only mirrors a non-null help). Legacy callers keep the recovery prompt
 * (silent=false, the default) so the user can still tap "Open new session". */
export function reconcileEndedSession(task: any, sessionAvailable: boolean, active: boolean, silent = false): boolean {
  if (active || sessionAvailable || !task.session_id || task.interaction_version !== 1
      || !["needsHuman", "failed", "running"].includes(task.status)) return false;
  task.session_id = null;
  task.status = "needsHuman";
  task.pending_action = null;
  task.authorized_action = null;
  task.checkpoint = null;
  task.information_requests = [];
  task.failure = { code: "session_ended" };
  if (!silent) {
    task.help = help("recovery", "This browser session ended before we finished. I can open a new session and check where we left off, or you can stop here.", [], "Open new session", null, { staticText: true });
  } else {
    task.help = null;
  }
  return true;
}

/** Synchronous transition: persist this before awaiting browser cleanup. */
export function rejectTaskHelp(task: any, helpID?: string): string | null {
  if (task.status === "rejected") return null;
  if (helpID && String(task.help?.id).toLowerCase() !== String(helpID).toLowerCase()) return "This request has changed. Refresh the conversation.";
  if (!["awaiting_approval", "needsHuman", "failed"].includes(task.status)) return "This task is no longer waiting for a choice.";
  task.status = "rejected";
  task.session_id = null;
  task.help = null;
  task.pending_action = null;
  task.authorized_action = null;
  task.checkpoint = null;
  task.information_requests = [];
  task.log ??= [];
  task.log.push("Stopped by user");
  return null;
}
