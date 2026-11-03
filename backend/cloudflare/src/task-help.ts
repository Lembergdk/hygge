// Conversation-first handoffs, grounded suggestions, and exact-action consent.
// Kept pure so the same policy is tested independently of storage and UI.
export function help(kind: string, message: string, questions: any[] = [], actionLabel = "Continue") {
  return { id: crypto.randomUUID(), kind, message, questions, actionLabel };
}

export function informationHelp(decision: any, draft: Record<string, string>) {
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
    return help("verification", "This sign-in step needs you. Enter the requested secret only on the site, never in chat.", [], "Complete check");
  }
  if (!questions.length) questions.push({ text: "What should I use for this step?", suggestions: [] });
  return help("information", String(decision.reason || "I need a detail to continue."), questions);
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
      task.help = help("information", "Thanks. One more detail before I continue.", remaining);
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
    if (!task._fromSnapshot || !task.help) return null;
    return { ...task, backendTaskID: null,
      createdAt: typeof task.createdAt === "string" ? (Date.parse(task.createdAt) / 1000 - 978307200) : task.createdAt };
  }
  return { ...task.mobile_task, backendTaskID: task.id, status: task.status === "awaiting_approval" ? "awaitingApproval" : task.status,
    draftedPayload: task.drafted_payload, browserSessionID: task.session_id ?? null,
    browserTrace: task.browser_trace ?? [], informationRequests: task.information_requests ?? [],
    help: task.help ?? null, pendingReply: null, log: task.log ?? [] };
}

export function canResumeWithInboxCode(task: any): boolean {
  return task.interaction_version === 1 && task.status === "needsHuman" && task.help?.kind === "verification"
    && task.checkpoint === "two-factor check" && task.email_code_available === true && task.scheduled_scan !== true;
}

/** Expiration invalidates page-bound consent and replaces the dead checkpoint once. */
export function reconcileEndedSession(task: any, sessionAvailable: boolean, active: boolean): boolean {
  if (active || sessionAvailable || !task.session_id || task.interaction_version !== 1
      || !["needsHuman", "failed", "running"].includes(task.status)) return false;
  task.session_id = null;
  task.status = "needsHuman";
  task.pending_action = null;
  task.authorized_action = null;
  task.checkpoint = null;
  task.information_requests = [];
  task.failure = { code: "session_ended" };
  task.help = help("recovery", "This browser session ended before we finished. I can open a new session and check where we left off, or you can stop here.", [], "Open new session");
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
