import { test } from 'node:test';
import assert from 'node:assert/strict';
import { help, informationHelp, applyHelpReply, actionFingerprint, needsActionApproval, mobileTask, canResumeWithInboxCode } from '../src/task-help.ts';
import { runMission } from '../src/agent.ts';
const task = () => ({ id: 'task', kind: 'signup', target_url: 'https://example.com', goal: 'Connect account', status: 'approved', interaction_version: 1, drafted_payload: { location: 'Austin', setupMode: 'connect' } });
const snapshot = (labels = ['Account settings']) => ({ sessionID: 'kept', currentURLString: 'https://example.com', title: 'Account', elements: labels.map(label => ({ label, kind: 'click' })), humanControlled: false });
class Browser {
  mode = 'test'; actions: any[] = []; labels = ['Account settings'];
  async createSession() { return snapshot(this.labels); }
  async snapshot() { return snapshot(this.labels); }
  async act(_id: string, action: any) { this.actions.push(action); return snapshot(this.labels); }
}
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
