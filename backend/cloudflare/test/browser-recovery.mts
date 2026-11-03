import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserRunBrowser } from '../src/browser.ts';
import { classifyBrowserFailure, failureFeedback } from '../src/browser-failure.ts';
import { runMission, LLMDecider, distillHints } from '../src/agent.ts';
import { help, reconcileEndedSession, rejectTaskHelp, applyHelpReply, mobileTask } from '../src/task-help.ts';
const page = { sessionID: 's', currentURLString: 'https://example.test', title: 'Account', elements: [{ label: 'Sign out', kind: 'click' }], humanControlled: false };
const task = () => ({ id: 't', kind: 'signup', target_url: page.currentURLString, goal: 'Connect account', interaction_version: 1, drafted_payload: { setupMode: 'connect' } });

test('navigation rejects target-only URL instead of reporting a no-op as success', async () => {
  const adapter = new BrowserRunBrowser({} as any); const visits: string[] = [];
  (adapter as any).sessions.set('s', { live: { control: { human: false } }, page: { url: () => page.currentURLString, goto: async (url: string) => visits.push(url) } });
  adapter.snapshot = async () => page;
  await assert.rejects(adapter.act('s', { action: 'navigate', target: 'https://example.test/login' }), /Unsupported/);
  assert.deepEqual(visits, []);
  assert.equal(await adapter.act('s', { action: 'navigate', value: '/login' }), page);
  assert.deepEqual(visits, ['https://example.test/login']);
  await assert.rejects(adapter.act('missing', { action: 'navigate', value: '/login' }), /session ended/);
});

test('failure classification never copies provider text, URLs or secrets', () => {
  const secret = 'person@example.test token=private-code password=secret';
  for (const [message, code] of [['Timeout exceeded', 'timeout'], ['Target is missing or ambiguous', 'target_missing'],
    ['Stale element reference', 'target_changed'], ['This control is disabled', 'target_disabled'],
    ['net::ERR_FAILED', 'navigation_failed'], ['Target closed', 'session_ended'], ['arbitrary provider body', 'unknown']]) {
    const failure = classifyBrowserFailure(new Error(`${message}: https://example.test/?${secret}`));
    assert.equal(failure.code, code); assert.ok(!JSON.stringify(failure).includes('person@'));
    assert.ok(!JSON.stringify(failure).includes('private-code')); assert.equal(failure.outcome, 'unconfirmed');
  }
  assert.equal(failureFeedback('__proto__').code, 'unknown');
});

test('agent sees structured failure on its next decision and retry sees prior uncertainty', async () => {
  let calls = 0;
  const browser = { createSession: async () => page, snapshot: async () => page, act: async () => { throw new Error('Timeout with secret=password'); } };
  const result = await runMission({ browser, task: { ...task(), failure: { code: 'repeated_action' } }, maxSteps: 3,
    decider: { decide: async (ctx: any) => {
      assert.equal(ctx.previousFailure.code, 'repeated_action');
      if (++calls === 2) { assert.equal(ctx.history[0].failure.code, 'timeout'); assert.match(ctx.history[0].failure.nextStep, /may have taken effect/); }
      return { action: 'click', target: 'e1', effect: 'reversible' };
    } } });
  assert.equal(result.status, 'failed'); assert.equal(result.failure.code, 'step_limit');
  assert.equal(result.failure.lastActionCode, 'timeout');
  assert.match(result.help.message, /couldn't confirm/); assert.equal(result.help.actionLabel, 'Open new session');
  assert.ok(!JSON.stringify(result).includes('secret=password'));
  assert.deepEqual(distillHints({ domain: 'example.test', trace: result.trace }), [], 'timeouts must not teach that controls are absent');
  let input: any;
  const model = new LLMDecider({ cfg: { modelFast: 'fast', modelStrong: 'strong' }, complete: async (args: any) => { input = JSON.parse(args.user); return '{"action":"done"}'; } } as any);
  await model.decide({ snapshot: page, history: result.trace, tierContext: {}, previousFailure: result.failure });
  assert.equal(input.soFar[0].failure.code, 'timeout'); assert.equal(input.previousAttempt.lastActionFailure.code, 'timeout');
});

test('unknown startup failures and unparseable model replies are truthful, sanitized recoveries', async () => {
  const result = await runMission({ task: task(), browser: { createSession: async () => { throw new Error('provider raw secret'); } }, decider: {} });
  assert.equal(result.failure.code, 'unknown'); assert.equal(result.help.kind, 'recovery');
  assert.ok(!JSON.stringify(result).includes('provider raw secret'));
  const decider = new LLMDecider({ cfg: { modelFast: 'fast', modelStrong: 'strong' }, complete: async () => 'raw secret response' } as any);
  await assert.rejects(decider.decide({ snapshot: page, history: [], tierContext: {} }), { message: 'No usable browser decision' });
});

test('ended checkpoint becomes one durable recovery request and invalidates page-bound approval', async () => {
  const t: any = { ...task(), status: 'needsHuman', session_id: 'expired', help: help('verification', 'Complete check'),
    mobile_task: { id: 'mobile' }, pending_action: { decision: 'publish' }, authorized_action: { decision: 'publish' }, checkpoint: 'captcha' };
  const oldID = t.help.id;
  assert.equal(reconcileEndedSession(t, false, true), false, 'never interrupt a running owner');
  assert.equal(reconcileEndedSession(t, true, false), false, 'preserve a live checkpoint');
  assert.equal(reconcileEndedSession(t, false, false), true);
  const id = t.help.id;
  assert.notEqual(id, oldID); assert.equal(t.help.kind, 'recovery'); assert.equal(t.session_id, null);
  assert.equal(t.pending_action, null); assert.equal(t.authorized_action, null);
  assert.equal(reconcileEndedSession(t, false, false), false); assert.equal(t.help.id, id);
  assert.ok(applyHelpReply(t, { helpID: oldID }));
  assert.equal(applyHelpReply(t, { helpID: id }), null);
  let created = 0;
  const result = await runMission({ task: t, existingSessionID: t.session_id,
    browser: { createSession: async () => { created++; return page; }, snapshot: async () => page },
    decider: { decide: async ctx => { assert.equal(ctx.previousFailure.code, 'session_ended'); return { action: 'done' }; } } });
  assert.equal(created, 1); assert.equal(result.status, 'succeeded');
});

test('stopping clears server help/session/consent, survives serialization and refuses stale choices', () => {
  const t: any = { ...task(), status: 'needsHuman', session_id: 's', help: help('recovery', 'Expired'), mobile_task: { id: 'mobile' },
    pending_action: {}, authorized_action: {}, information_requests: ['When?'] };
  const id = t.help.id;
  assert.ok(rejectTaskHelp(t, 'stale')); assert.equal(t.status, 'needsHuman');
  assert.equal(rejectTaskHelp(t, id), null);
  const restored = JSON.parse(JSON.stringify(t)); const projected = mobileTask(restored);
  assert.equal(projected.status, 'rejected'); assert.equal(projected.help, null); assert.equal(projected.browserSessionID, null);
  assert.deepEqual(projected.informationRequests, []); assert.equal(restored.authorized_action, null);
  assert.equal(rejectTaskHelp(restored, id), null); assert.equal(restored.log.length, 1);
  assert.equal(reconcileEndedSession({ ...restored, session_id: 'old' }, false, false), false);
  assert.ok(applyHelpReply(restored, { helpID: id }), 'stopped work cannot resume through an old button');
});

test('human help uses a concise user update instead of the model diagnostic reason', async () => {
  const browser = { createSession: async () => page, snapshot: async () => page };
  const result = await runMission({ task: task(), browser, decider: { decide: async () => ({ action: 'needsHuman',
    reason: 'Technical CAPTCHA inference with internal observations', userMessage: 'Fiverr needs to check that you’re a person. Open the browser to finish the check.' }) } });
  assert.match(result.help.message, /Open the browser/);
  assert.ok(!result.help.message.includes('Technical'));
  const fallback = await runMission({ task: task(), browser, decider: { decide: async () => ({ action: 'needsHuman', reason: 'Verbose internal diagnostic' }) } });
  assert.ok(!fallback.help.message.includes('diagnostic'));
  assert.match(fallback.help.message, /stop here/);
});

test('session loss during an action is never recorded as successful navigation', async () => {
  const result = await runMission({ task: task(), maxSteps: 1,
    browser: { createSession: async () => page, snapshot: async () => page, act: async () => null },
    decider: { decide: async () => ({ action: 'navigate', value: 'https://example.test/login', effect: 'reversible' }) } });
  assert.equal(result.trace[0].succeeded, false);
  assert.equal(result.trace[0].failure.code, 'session_ended');
});
