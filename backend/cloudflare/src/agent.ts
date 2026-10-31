// The mission loop — the ONLY way browsing happens.
//
//   observe page -> LLM decides ONE action -> execute -> observe -> ...
//
// There is no script, playbook, or step list. The agent starts every run with
// just a mission (goal + approved draft content + optional advisory memory
// hints from past runs on this domain) and finds its own path. Learned
// "skills" are an OUTPUT: after a run, the trajectory is distilled into
// hints for next time. Hints are context, never instructions to replay.
//
// Action schema (model output, validated before execution):
//   { "action": "navigate"|"click"|"type"|"extract"|"done"|"needsHuman",
//     "target": "visible element label or URL",
//     "value": "literal text to type (optional)",
//     "valueRef": "credential.username"|"credential.secret"|"draft.<key>",
//     "reason": "one short clause" }
//
// Safety rails enforced here, not by the prompt alone:
// - valueRef is resolved by the worker/vault; literal values aimed at
//   password-shaped targets are refused (secrets can't leak via the model).
// - Loop detection: same action+target+URL 3x -> escalate tier, then stop.
// - Hard step budget; CAPTCHA/2FA/payment/ID -> needsHuman, never bypassed.
import { selectTier, parseDecision, type LLMClient } from "./llm.ts";
import type { BrowserRunBrowser, Snapshot } from "./browser.ts";

const ACTIONS = new Set(["navigate", "click", "type", "extract", "askUser", "done", "needsHuman"]);
export const MAX_STEPS = 25;

const SYSTEM = [
  "You are browsing the web on behalf of one user to complete a mission.",
  "You see the current page as a list of interactive elements. Reply with ONE",
  'JSON action: {"action":"navigate|click|type|extract|done|needsHuman",',
  '"target":"element label exactly as listed, or a URL","value":"text to type",',
  '"valueRef":"credential.username|credential.secret|draft.<key>","reason":"short",',
  '"questions":["for askUser: the exact things you need from the user"]}.',
  "Find your own path: there is no script. Memory hints from past visits are",
  "advice only — if the page disagrees, trust the page. Never invent or type",
  "passwords; use valueRef credential.* and the vault fills them. Use extract",
  "to read listings/results, done when the mission is complete, needsHuman at",
  "CAPTCHA, 2FA, payment, or identity checks. SIGNUP/LOGIN missions have",
  "unknowns you must resolve by looking: does this user already have an",
  "account (a login that works with the vault credential means yes)? What",
  "information does this site's form require? NEVER invent personal data.",
  "If a required value is not in the available draft refs, use askUser with",
  "specific questions and stop. Do not repeat an action that",
  "just failed; try a different element or path.",
].join(" ");

export class LLMDecider {
  simulated = false;
  client: LLMClient;
  constructor(client: LLMClient) { this.client = client; }

  async decide(ctx: any): Promise<any> {
    const tier = selectTier(this.client.cfg, ctx.tierContext);
    const text = await this.client.complete({
      model: tier.model, system: SYSTEM,
      user: JSON.stringify({
        mission: ctx.mission,
        plan: "No predefined steps. Decide from the page in front of you.",
        memoryHints: ctx.hints,
        availableDraftRefs: Object.keys(ctx.draft ?? {}).map((k) => `draft.${k}`),
        hasStoredCredential: ctx.hasCredential,
        page: { url: ctx.snapshot.currentURLString, title: ctx.snapshot.title,
                elements: ctx.snapshot.elements.map((e: any) => e.label) },
        soFar: ctx.history.map((h: any) => `${h.action} ${h.target} -> ${h.succeeded ? "ok" : "FAILED"}`),
      }),
    });
    const decision = parseDecision(text) as any;
    if (!decision || !ACTIONS.has(decision.action)) {
      return { action: "needsHuman", target: "", reason: `unparseable model reply: ${String(text).slice(0, 120)}`,
               tier };
    }
    return { ...decision, tier };
  }
}

/**
 * Offline test double (used only when no API key is configured). Like the
 * real decider it chooses from the OBSERVED elements each step — no fixed
 * step sequence — so tests still exercise genuine observe-decide-act flow.
 */
export class SimulatedDecider {
  simulated = true;
  client: LLMClient;
  constructor(client: LLMClient) { this.client = client; }

  async decide(ctx: any): Promise<any> {
    const tier = selectTier(this.client.cfg, ctx.tierContext);
    const labels: string[] = ctx.snapshot.elements.map((e: any) => e.label);
    const has = (...subs: string[]) => labels.find((l) => subs.some((s) => l.toLowerCase().includes(s)));
    const did = (action: string, sub: string) => ctx.history.some((h: any) => h.action === action && h.target.toLowerCase().includes(sub));
    const out = (d: any) => ({ ...d, tier });

    if (ctx.taskKind === "signup") {
      const onSignupForm = has("create account", "phone number", "date of birth");
      if (!onSignupForm) {
        const join = has("sign up / join", "sign up", "join");
        if (join) return out({ action: "click", target: join, reason: "find how signup works on this site" });
      } else {
        const missing: string[] = [];
        if (!ctx.draft?.phone) missing.push("What phone number should we use for verification texts on this site?");
        if (!ctx.draft?.dateOfBirth) missing.push("What is your date of birth? (this site asks for it, likely for 18+ checks)");
        if (missing.length) return out({ action: "askUser", target: "", questions: missing, reason: "signup form requires information I do not have" });
        const phone = has("phone number");
        if (phone && !did("type", "phone")) return out({ action: "type", target: phone, valueRef: "draft.phone", reason: "user provided phone" });
        const dob = has("date of birth");
        if (dob && !did("type", "date")) return out({ action: "type", target: dob, valueRef: "draft.dateOfBirth", reason: "user provided date of birth" });
        const create = has("create account");
        if (create) return out({ action: "click", target: create, reason: "submit signup with provided details" });
      }
      return out({ action: "done", target: "", reason: "signup submitted" });
    }

    // Authenticate only if the page actually offers login and we have a credential.
    const passwordField = has("password");
    if (ctx.hasCredential && passwordField && !did("type", "password")) {
      const userField = has("email", "username");
      if (userField && !did("type", "email") && !did("type", "username")) {
        return out({ action: "type", target: userField, valueRef: "credential.username", reason: "login form visible" });
      }
      return out({ action: "type", target: passwordField, valueRef: "credential.secret", reason: "login form visible" });
    }
    const loginBtn = has("log in button", "sign in button");
    if (ctx.hasCredential && loginBtn && did("type", "password")) {
      return out({ action: "click", target: loginBtn, reason: "submit login" });
    }
    const loginLink = has("log in / sign in", "log in", "sign in");
    if (ctx.hasCredential && loginLink && !passwordField && !did("click", "log in")) {
      return out({ action: "click", target: loginLink, reason: "open login" });
    }

    const extracted = ctx.history.some((h: any) => h.action === "extract" && h.succeeded);
    if (ctx.taskKind === "discover") {
      const search = has("search field", "search");
      if (search && search.toLowerCase().includes("field") && !did("type", "search")) {
        return out({ action: "type", target: search, valueRef: "draft.searchTerms", reason: "search for the user's skills" });
      }
      const searchBtn = labels.find((l) => /search button|^search$/i.test(l));
      if (searchBtn && did("type", "search") && !did("click", "search")) {
        return out({ action: "click", target: searchBtn, reason: "run search" });
      }
      if (!extracted) return out({ action: "extract", target: "listings", reason: "read what is on the page" });
      return out({ action: "done", target: "", reason: "listings extracted" });
    }

    // apply / buildProfile / signup / message: use whatever the page offers.
    const letterField = has("cover letter", "message", "about / bio", "bio field");
    if (letterField && !did("type", "cover") && !did("type", "message") && !did("type", "bio")) {
      const ref = ctx.draft?.coverLetter ? "draft.coverLetter" : "draft.profileBio";
      return out({ action: "type", target: letterField, valueRef: ref, reason: "fill approved draft" });
    }
    const applyBtn = has("apply / contact", "apply", "submit application", "save profile");
    if (applyBtn && !did("click", "apply") && !did("click", "submit") && !did("click", "save")) {
      return out({ action: "click", target: applyBtn, reason: "submit as approved" });
    }
    const listing = has("first listing");
    if (listing && !did("click", "listing")) {
      return out({ action: "click", target: listing, reason: "open the listing" });
    }
    if (!extracted) return out({ action: "extract", target: "page", reason: "understand the page" });
    return out({ action: "done", target: "", reason: "mission actions completed" });
  }
}

export function makeDecider(client: LLMClient) {
  return client.configured ? new LLMDecider(client) : new SimulatedDecider(client);
}

/**
 * Execute one validated decision. fillCredentialValue(ref, target) is provided
 * by the server and types vault secrets without exposing them here.
 */
async function execute({ browser, sessionID, decision, task, fillCredentialValue }: any) {
  if (/password/i.test(decision.target ?? "") && decision.value) {
    return { succeeded: false, summary: "Refused: model tried to type a literal value into a password field" };
  }
  if (decision.valueRef?.startsWith("credential.")) {
    await fillCredentialValue(decision.valueRef, decision.target, sessionID);
    return { succeeded: true, summary: "Credential injected from vault inside the browser worker (secret redacted)" };
  }
  let value = decision.value ?? "";
  if (decision.valueRef?.startsWith("draft.")) {
    value = task.drafted_payload?.[decision.valueRef.slice(6)] ?? "";
  }
  if (decision.action === "extract") {
    const items = await (browser as BrowserRunBrowser).extract(sessionID);
    return { succeeded: items.length > 0, items,
             summary: items.length ? `Extracted ${items.length}: ${items.join(" | ")}` : "No listing-like content found" };
  }
  await (browser as BrowserRunBrowser).act(sessionID, { action: decision.action, target: decision.target, value });
  return { succeeded: true, summary: `${decision.action}: ${decision.target}` };
}

/**
 * Run one mission to completion. Returns { status, trace, extractedItems, log }.
 * Statuses: succeeded | needs_human | failed (budget exhausted / looping).
 */
export async function runMission({ browser, task, hints = [], hasCredential = false,
                                   decider, fillCredentialValue, maxSteps = MAX_STEPS }: any) {
  const log: string[] = [];
  const trace: any[] = [];
  const extractedItems: string[] = [];
  const snap = (await browser.createSession(task.target_url)) as Snapshot;
  log.push(`Mission started on ${snap.currentURLString} (${browser.mode} browser, ` +
           `${decider.simulated ? "simulated decider — no API key" : "LLM decider"}, ` +
           `${hints.length} memory hint(s) from past runs, advisory only)`);
  let failures = 0;
  const actionKeys = new Map<string, number>();

  for (let step = 1; step <= maxSteps; step++) {
    const snapshot = await browser.snapshot(snap.sessionID);
    const lastKey = trace.length ? `${trace.at(-1).action}|${trace.at(-1).target}|${snapshot.currentURLString}` : "";
    const repeated = (actionKeys.get(lastKey) ?? 0) >= 2;
    let decision: any;
    try {
      decision = await decider.decide({
        mission: task.goal, taskKind: task.kind, draft: task.drafted_payload,
        hints, hasCredential, snapshot, history: trace,
        tierContext: { taskKind: task.kind, failures, repeatedAction: repeated },
      });
    } catch (e: any) {
      failures += 1;
      log.push(`Decider error at step ${step}: ${e.message}; escalating tier and retrying`);
      if (failures >= 3) return { status: "failed", trace, extractedItems, log, sessionID: snap.sessionID };
      continue;
    }
    const tierLabel = decision.tier ? `${decision.tier.model} (${decision.tier.reason})` : null;

    if (decision.action === "done") {
      trace.push({ action: "done", target: "", urlString: snapshot.currentURLString,
                   summary: decision.reason || "Mission complete", succeeded: true, modelTier: tierLabel });
      return { status: "succeeded", trace, extractedItems, log, sessionID: snap.sessionID };
    }
    if (decision.action === "askUser") {
      const questions = Array.isArray(decision.questions) && decision.questions.length
        ? decision.questions : [decision.reason || "What information do you need?"];
      trace.push({ action: "askUser", target: "", urlString: snapshot.currentURLString,
                   summary: `Agent needs information: ${questions.join(" ")}`, succeeded: false, modelTier: tierLabel });
      return { status: "needs_info", trace, extractedItems, log, sessionID: snap.sessionID, informationRequests: questions };
    }
    if (decision.action === "needsHuman") {
      trace.push({ action: "needsHuman", target: decision.target ?? "", urlString: snapshot.currentURLString,
                   summary: decision.reason || "Human checkpoint", succeeded: false, modelTier: tierLabel });
      return { status: "needs_human", trace, extractedItems, log, sessionID: snap.sessionID };
    }

    let result: any;
    try {
      result = await execute({ browser, sessionID: snap.sessionID, decision, task, fillCredentialValue });
    } catch (e: any) {
      result = { succeeded: false, summary: `Action failed (deviation): ${e.message.slice(0, 140)}` };
    }
    if (result.items?.length) extractedItems.push(...result.items);
    if (!result.succeeded) failures += 1;
    const key = `${decision.action}|${decision.target}|${snapshot.currentURLString}`;
    actionKeys.set(key, (actionKeys.get(key) ?? 0) + 1);
    trace.push({ action: decision.action, target: decision.target ?? "",
                 urlString: snapshot.currentURLString,
                 summary: `${result.summary}${decision.reason ? ` — ${decision.reason}` : ""}`,
                 succeeded: result.succeeded, modelTier: tierLabel });
    if ((actionKeys.get(key) ?? 0) >= 4) {
      log.push("Stopped: agent repeated the same action without progress");
      return { status: "failed", trace, extractedItems, log, sessionID: snap.sessionID };
    }
  }
  log.push(`Stopped: step budget (${maxSteps}) exhausted`);
  return { status: "failed", trace, extractedItems, log, sessionID: snap.sessionID };
}

/**
 * Distil a finished trajectory into advisory memory hints for this domain.
 * Hints describe what worked ONCE; future agents may ignore them.
 */
export function distillHints({ domain, trace, extractedItems = [], existing = [] }: any): string[] {
  const hints: string[] = [...existing];
  const add = (h: string) => { if (h && !hints.includes(h)) hints.push(h); };
  for (const t of trace) {
    if (t.succeeded && t.action === "click") add(`Clicking "${t.target}" worked on ${domain}`);
    if (t.succeeded && t.action === "type" && !/password/i.test(t.target)) add(`Typing into "${t.target}" worked on ${domain}`);
    if (!t.succeeded && t.action !== "needsHuman") add(`"${t.target}" was NOT found on ${domain} — look for a different label/element`);
  }
  if (extractedItems.length) add(`Listings were readable directly from the landing page on ${domain}`);
  if (trace.some((t: any) => /vault/i.test(t.summary))) add(`Vault credential login worked on ${domain}`);
  return hints.slice(-12);
}
