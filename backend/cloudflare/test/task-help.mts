import { test } from 'node:test';
import assert from 'node:assert/strict';
import { help, helpRoutesToChat, decisionHelpMessageText, parseHelpDeadline, isShortDeadline, DEADLINE_WINDOW_HOURS, informationHelp, applyHelpReply, actionFingerprint, needsActionApproval, mobileTask, canResumeWithInboxCode } from '../src/task-help.ts';
import { runMission } from '../src/agent.ts';
const task = () => ({ id: 'task', kind: 'signup', target_url: 'https://example.com', goal: 'Connect account', status: 'approved', interaction_version: 1, drafted_payload: { location: 'Austin', setupMode: 'connect' } });
const snapshot = (labels = ['Account settings']) => ({ sessionID: 'kept', currentURLString: 'https://example.com', title: 'Account', elements: labels.map(label => ({ label, kind: 'click' })), humanControlled: false });
class Browser {
  mode = 'test'; actions: any[] = []; labels = ['Account settings'];
  async createSession() { return snapshot(this.labels); }
  async snapshot() { return snapshot(this.labels); }
  async act(_id: string, action: any) { this.actions.push(action); return snapshot(this.labels); }
}
test('feed/chat routing (policy Nov 5, 2026): every decision card routes to chat; help-less never does', () => {
  // Every well-formed decision kind routes to chat: all decision
  // cards warrant a chat message linking to the card, and every
  // chat message generates a push.
  for (const kind of ['information', 'approval', 'verification', 'credentials', 'recovery']) {
    assert.equal(helpRoutesToChat(help(kind, 'Something needs you')), true, `${kind} routes to chat`);
  }
  // The deadline no longer gates routing: a deadline-free approval
  // routes to chat exactly like a deadline approval.
  assert.equal(helpRoutesToChat(help('approval', 'Publish?')), true);
  const soon = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
  assert.equal(helpRoutesToChat(help('approval', 'Publish?', [], 'Approve and continue', soon)), true);
  // Help-less needsHuman: no content any message could be composed
  // about, so NO chat message and NO push (a push only ever comes
  // from a chat message).
  assert.equal(helpRoutesToChat(null), false, "a help-less needsHuman gets no message and no push");
  assert.equal(helpRoutesToChat(undefined), false);
});

test('feed/chat routing: an unknown or missing kind is made visible, not silently routed', () => {
  const warnings: unknown[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
  try {
    assert.equal(helpRoutesToChat({ id: 'x', message: 'Typo kind' }), true, "unknown kind routes to chat as a decision card by construction");
    assert.equal(helpRoutesToChat(help('info', 'Typo kind')), true);
    assert.equal(helpRoutesToChat({ id: 'y', kind: 'Information', message: 'Wrong case' }), true);
    assert.equal(warnings.length, 3, "each unknown kind is logged server-side");
    assert.match(String(warnings[0]), /unknown help kind/);
  } finally {
    console.warn = original;
  }
});

test('deadline validation: garbage, past, and blank dates are no deadline; far-future is a deadline but not short', () => {
  assert.equal(DEADLINE_WINDOW_HOURS, 24, "Mikael's call to change — the short window is one named constant");
  const now = new Date('2026-11-05T12:00:00.000Z');
  const inWindow = new Date(now.getTime() + 6 * 60 * 60 * 1000).toISOString();
  const farFuture = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const past = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  assert.equal(parseHelpDeadline(inWindow, now)?.toISOString(), inWindow);
  assert.equal(parseHelpDeadline(farFuture, now)?.toISOString(), farFuture, "a far-future date is still a real expiration date");
  assert.equal(parseHelpDeadline(past, now), null, "a past date is no deadline");
  assert.equal(parseHelpDeadline('not a date', now), null, "garbage is no deadline");
  assert.equal(parseHelpDeadline('  ', now), null, "a blank deadline is no deadline");
  assert.equal(parseHelpDeadline(null, now), null);
  assert.equal(isShortDeadline(inWindow, now), true, "a valid in-window deadline is short");
  assert.equal(isShortDeadline(farFuture, now), false, "a far-future date must NOT escalate");
  assert.equal(isShortDeadline(past, now), false);
  assert.equal(isShortDeadline('garbage', now), false);
  assert.equal(isShortDeadline(new Date(now.getTime() + DEADLINE_WINDOW_HOURS * 60 * 60 * 1000).toISOString(), now), true, "exactly at the window edge is still short");
  assert.equal(isShortDeadline(new Date(now.getTime() + (DEADLINE_WINDOW_HOURS + 1) * 60 * 60 * 1000).toISOString(), now), false);
});

test('help() normalizes deadlines: valid future dates are stored, garbage/past are dropped and logged', () => {
  const warnings: unknown[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
  try {
    const soon = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    const dated = help('approval', 'Publish?', [], 'Approve and continue', soon);
    assert.equal(dated.deadline, new Date(soon).toISOString());
    assert.equal(help('approval', 'Publish?').deadline, null);
    assert.equal(help('approval', 'Publish?', [], 'Approve and continue', 'garbage').deadline, null);
    assert.equal(help('approval', 'Publish?', [], 'Approve and continue', '2020-01-01T00:00:00.000Z').deadline, null);
    assert.equal(warnings.length, 2, "each dropped deadline is logged");
    assert.match(String(warnings[0]), /dropping invalid deadline/);
  } finally {
    console.warn = original;
  }
});

test('decision-help message text relays the help verbatim, with no static framing', () => {
  const task = { help: help('information', 'I need a detail to continue.', [{ text: 'Which dates are you free?' }]), mobile_task: { id: 't', title: 'Rover signup' } };
  assert.equal(decisionHelpMessageText(task), 'I need a detail to continue.\n\nWhich dates are you free?');
  assert.equal(decisionHelpMessageText({ help: help('verification', 'Finish the check') }), 'Finish the check');
  assert.equal(decisionHelpMessageText({ help: null }), null, "no help, no message text");
  assert.equal(decisionHelpMessageText({ help: { message: '   ' } }), null, "a blank help message relays nothing");
  assert.ok(!decisionHelpMessageText(task)!.includes('Rover signup'), "the task title prefix is gone — the card carries the title");
});

test('an approval producer carries the model deadline onto the help', async () => {
  const browser = new Browser(); const t: any = task();
  const soon = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
  const decision = { action: 'click', target: 'Save', effect: 'public', reason: 'Publish profile', deadline: soon };
  const result = await runMission({ task: t, browser, decider: { decide: async () => ({ ...decision }) } });
  assert.equal(result.help.kind, 'approval');
  assert.equal(result.help.deadline, new Date(soon).toISOString());
  assert.equal(helpRoutesToChat(result.help), true);
});

test('an approval producer with a garbage deadline keeps the help but drops the deadline', async () => {
  const browser = new Browser(); const t: any = task();
  const decision = { action: 'click', target: 'Save', effect: 'public', reason: 'Publish profile', deadline: 'soon-ish' };
  const warnings: unknown[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
  try {
    const result = await runMission({ task: t, browser, decider: { decide: async () => ({ ...decision }) } });
    assert.equal(result.help.kind, 'approval');
    assert.equal(result.help.deadline, null);
    assert.ok(warnings.some((w) => String(w).includes('dropping invalid deadline')));
  } finally {
    console.warn = original;
  }
});
test('personal suggestions use known facts, never invented literals or secrets', () => {
  const result = informationHelp({ questions: [{ text: 'Where?', suggestedRefs: ['draft.location', 'draft.missing', 'draft.password'], suggestions: ['Paris'] }] }, { location: 'Austin', password: 'secret' });
  assert.deepEqual(result.questions[0].suggestions, ['Austin']);
});
test('reversible actions run automatically; consequential and unknown effects require consent', () => {
  assert.equal(needsActionApproval(task(), { action: 'click', target: 'Next', effect: 'reversible' }), false);
  for (const d of [{ target: 'Save', effect: 'public' }, { target: 'Publish', effect: 'reversible' }, { target: 'Delete account', effect: 'reversible' }, { target: 'Save' }, { target: 'Create account', effect: 'accountCreation' }])
    assert.equal(needsActionApproval(task(), { ...d, action: 'click' }), true);
  assert.equal(needsActionApproval({ ...task(), drafted_payload: {} }, { action: 'click', target: 'Create account', effect: 'accountCreation' }), false);
});
test('partial answer asks remaining question, then resumes without another approval', () => {
  const t: any = { ...task(), status: 'needsHuman', help: help('information', 'Details', [{ text: 'Where?', suggestions: [] }, { text: 'When?', suggestions: [] }]) };
  const firstID = t.help.id;
  assert.equal(applyHelpReply(t, { helpID: firstID, answers: { 'Where?': 'Austin' } }), null);
  assert.notEqual(t.help.id, firstID);
  assert.deepEqual(t.help.questions.map((q: any) => q.text), ['When?']);
  assert.ok(applyHelpReply(t, { helpID: firstID, answers: { 'When?': 'Tomorrow' } }));
  assert.equal(applyHelpReply(t, { helpID: t.help.id, answers: { 'When?': 'Tomorrow' } }), null);
  assert.equal(t.help, null); assert.equal(t.drafted_payload['answer:Where?'], 'Austin'); assert.equal(t.authorized_action, undefined);
});
test('stale, duplicate and unapproved consequential replies are rejected', () => {
  const t: any = { ...task(), status: 'needsHuman', help: help('approval', 'Publish?'), pending_action: { decision: { action: 'click', target: 'Publish' } } };
  const id = t.help.id;
  assert.ok(applyHelpReply(t, { helpID: id, approved: false }));
  assert.ok(applyHelpReply(t, { helpID: 'stale', approved: true }));
  assert.equal(applyHelpReply(t, { helpID: id, approved: true }), null);
  assert.ok(applyHelpReply(t, { helpID: id, approved: true }));
});
test('browser pauses before public action and executes that action once after approval', async () => {
  const browser = new Browser(); const t: any = task();
  const decision = { action: 'click', target: 'Save', effect: 'public', reason: 'Publish profile' };
  let result = await runMission({ task: t, browser, decider: { decide: async () => ({ ...decision }) } });
  assert.equal(result.help.kind, 'approval'); assert.equal(browser.actions.length, 0);
  t.status = 'needsHuman'; t.help = result.help; t.pending_action = result.pendingAction;
  assert.equal(applyHelpReply(t, { helpID: t.help.id, approved: true }), null);
  result = await runMission({ task: t, browser, existingSessionID: 'kept', decider: { decide: async () => ({ action: 'done' }) } });
  assert.equal(result.status, 'succeeded'); assert.equal(browser.actions.length, 1); assert.equal(t.authorized_action, undefined);
});
test('model cannot fabricate consent; page changes invalidate approved actions', async () => {
  const browser = new Browser(); const t: any = task();
  const decision = { action: 'click', target: 'Save', effect: 'public', consentGranted: true };
  let result = await runMission({ task: t, browser, decider: { decide: async () => ({ ...decision }) } });
  assert.equal(result.help.kind, 'approval');
  t.authorized_action = { decision, fingerprint: actionFingerprint(decision, snapshot(), t.drafted_payload) };
  browser.labels = ['Different profile'];
  result = await runMission({ task: t, browser, decider: { decide: async () => ({ ...decision }) } });
  assert.equal(result.help.kind, 'approval'); assert.equal(browser.actions.length, 0);
});
test('safe recovery retries LLM errors without interrupting the user', async () => {
  const browser = new Browser(); let calls = 0;
  const result = await runMission({ task: task(), browser, decider: { decide: async () => {
    calls++; if (calls === 1) throw new Error('temporary');
    return calls === 2 ? { action: 'click', target: 'Next', effect: 'reversible' } : { action: 'done' };
  } } });
  assert.equal(result.status, 'succeeded'); assert.equal(browser.actions.length, 1);
});
test('connection completion requires visible signed-in evidence', async () => {
  const browser = new Browser(); browser.labels = ['Welcome'];
  const result = await runMission({ task: task(), browser, decider: { decide: async () => ({ action: 'done' }) } });
  assert.equal(result.status, 'needs_human'); assert.equal(result.help.kind, 'credentials');
});
test('mobile projection owns status and clears stale controls', () => {
  const projected = mobileTask({ ...task(), status: 'succeeded', mobile_task: { id: 'client', status: 'running', pendingReply: { approved: true } } });
  assert.equal(projected.status, 'succeeded'); assert.equal(projected.pendingReply, null);
});
test('mobile projection carries the step awaiting review, and null when none is stuck', () => {
  const base = { ...task(), status: 'needsHuman', mobile_task: { id: 'client', status: 'needsHuman' } };
  assert.equal(mobileTask({ ...base, workspace_pending_effect_id: 'fx_1' }).pendingEffectID, 'fx_1');
  assert.equal(mobileTask(base).pendingEffectID, null);
});

test('Swift uppercase UUID replies match lowercase stored request IDs', () => {
  const t: any = { ...task(), status: 'needsHuman', help: help('verification', 'Finish check') };
  assert.equal(applyHelpReply(t, { helpID: t.help.id.toUpperCase() }), null);
});
test('secret requests are handed to the secure site instead of chat input', () => {
  const result = informationHelp({ questions: ['What is your verification code?'] }, {});
  assert.equal(result.kind, 'verification'); assert.deepEqual(result.questions, []);
});

test('inbox codes resume only the matching human verification, never approval, CAPTCHA or scans', () => {
  const t = { ...task(), status: 'needsHuman', help: help('verification', 'Code'), checkpoint: 'two-factor check', email_code_available: true };
  assert.equal(canResumeWithInboxCode(t), true);
  assert.equal(canResumeWithInboxCode({ ...t, help: help('approval', 'Publish?') }), false);
  assert.equal(canResumeWithInboxCode({ ...t, checkpoint: 'CAPTCHA' }), false);
  assert.equal(canResumeWithInboxCode({ ...t, scheduled_scan: true }), false);
});
test('a waiting secure-login request can be restored from the imported snapshot', () => {
  const request = help('credentials', 'Connect account');
  const projected = mobileTask({ _fromSnapshot: true, id: 'local', status: 'needsHuman', help: request, createdAt: '2026-11-02T12:00:00Z' });
  assert.equal(projected.backendTaskID, null);
  assert.equal(projected.help.id, request.id);
  assert.equal(typeof projected.createdAt, 'number');
});

test('a stuck live task without a mobile projection is synthesized so it can be reviewed', () => {
  // Apple Fiverr, Nov 5: needsHuman with an uncertain effect, but no
  // mobile_task and no _fromSnapshot, so the app dropped it entirely —
  // no feed card, no conversation, no review.
  const stuck: any = { id: 'task-fiverr', kind: 'discover', target_url: 'https://www.fiverr.com/search', goal: 'Find work', title: 'Scheduled look at Fiverr', status: 'needsHuman', help: help('recovery', 'This work could not start after several tries.'), workspace_pending_effect_id: 'fx_1', session_id: 'fx_run1_0', drafted_payload: {}, log: [], createdAt: '2026-11-04T12:00:00Z' };
  const projected = mobileTask(stuck);
  assert.ok(projected);
  assert.equal(projected.id, 'task-fiverr');
  assert.equal(projected.backendTaskID, 'task-fiverr');
  assert.equal(projected.pendingEffectID, 'fx_1');
  assert.equal(projected.status, 'needsHuman');
  assert.equal(projected.siteID, 'fiverr.com');
  assert.equal(projected.targetURLString, 'https://www.fiverr.com/search');
  assert.equal(projected.help.id, stuck.help.id);
  assert.equal(typeof projected.createdAt, 'number');
  // The app decodes exactly these required AgentTask fields.
  for (const k of ['id', 'kind', 'siteID', 'targetURLString', 'goal', 'title', 'draftedPayload', 'browserTrace', 'informationRequests', 'status', 'log', 'createdAt']) assert.ok(k in projected, k);
});

test('a stuck live task with a pending effect but no help is still reviewable', () => {
  const t: any = { id: 't', kind: 'discover', target_url: 'https://fiverr.com/', goal: 'g', title: 't', status: 'needsHuman', help: null, workspace_pending_effect_id: 'fx_9', createdAt: '2026-11-04T12:00:00Z' };
  assert.equal(mobileTask(t).pendingEffectID, 'fx_9');
});

test('a synthesized projection never carries a field the app cannot decode', () => {
  // The raw record is model-shaped: the trace can hold an action the
  // app's BrowserActionKind does not know, the payload can hold a
  // non-string value, the log can hold a non-string entry, and the
  // stored date can be unparseable. One such field would fail the
  // whole tasks response to decode (the app decodes the list as one
  // document), so the synthesis must drop it, not pass it through.
  // This is the Apple Fiverr shape: the #108 synthesis was live and
  // the gate passed, yet the task still did not appear after a cold
  // restart — the projection itself must have been undecodable.
  const dirty: any = { id: 'task-fiverr', kind: 'discover', target_url: 'https://www.fiverr.com/search', goal: 'Find work', title: 'Scheduled look at Fiverr', status: 'needsHuman', help: help('recovery', 'm'), workspace_pending_effect_id: 'fx_1',
    drafted_payload: { searchTerms: 'design', hourlyRate: 50 },
    browser_trace: [
      { action: 'scrollDown', target: '', urlString: 'https://www.fiverr.com/', summary: 'scrolled', succeeded: true },
      { action: 'click', target: 'Sign in', urlString: 'https://www.fiverr.com/', summary: 'clicked', succeeded: true, modelTier: 'spark', model: 'muse-spark-1.3' },
      { action: 'click', target: '', urlString: 'https://www.fiverr.com/', summary: 'no success flag' },
    ],
    information_requests: ['phone', { text: 'dob' }],
    log: ['looked', { event: 'x' }],
    createdAt: 'not a date' };
  const projected = mobileTask(dirty);
  assert.ok(projected);
  assert.deepEqual(projected.draftedPayload, { searchTerms: 'design' });
  assert.deepEqual(projected.browserTrace, [{ action: 'click', target: 'Sign in', urlString: 'https://www.fiverr.com/', summary: 'clicked', succeeded: true }]);
  assert.deepEqual(projected.informationRequests, ['phone']);
  assert.deepEqual(projected.log, ['looked']);
  assert.ok(Number.isFinite(projected.createdAt));
  // The projection round-trips through JSON with every required
  // AgentTask field present and typed as the app decodes it.
  const roundTripped = JSON.parse(JSON.stringify(projected));
  assert.equal(typeof roundTripped.createdAt, 'number');
  assert.ok(Object.values(roundTripped.draftedPayload).every((v: any) => typeof v === 'string'));
  assert.ok(roundTripped.browserTrace.every((e: any) => ['navigate', 'click', 'type', 'select', 'extract', 'screenshot', 'waitForHuman', 'askUser', 'done', 'needsHuman'].includes(e.action) && typeof e.target === 'string' && typeof e.urlString === 'string' && typeof e.summary === 'string' && typeof e.succeeded === 'boolean'));
  assert.ok(roundTripped.informationRequests.every((v: any) => typeof v === 'string'));
  assert.ok(roundTripped.log.every((v: any) => typeof v === 'string'));
});

test('internal and unreviewable tasks without a mobile projection stay hidden', () => {
  const base: any = { id: 't', kind: 'discover', target_url: 'https://fiverr.com/', goal: 'g', title: 't', status: 'needsHuman', help: help('recovery', 'm'), createdAt: '2026-11-04T12:00:00Z' };
  assert.equal(mobileTask({ ...base, target_url: 'https://invalid.example' }), null); // fixture/document work
  assert.equal(mobileTask({ ...base, web_probe: true }), null); // probe
  assert.equal(mobileTask({ ...base, status: 'running' }), null); // not stuck
  assert.equal(mobileTask({ ...base, help: null }), null); // nothing asking the user
  assert.equal(mobileTask({ ...base, kind: 'unknown-kind' }), null); // undecodable kind
  assert.equal(mobileTask({ ...base, target_url: 'not a url' }), null);
});
