import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LLMClient } from '../src/llm.ts';
import { LLMDecider, runMission, mobileBrowserAction } from '../src/agent.ts';
import { actionFingerprint, needsActionApproval } from '../src/task-help.ts';
import { redact, safePageURL } from '../src/browser-observation.ts';
import { detectCheckpoint } from '../src/session-profile.ts';
const cfg = { baseUrl: 'https://example.invalid', modelFast: 'muse-spark-1.3', modelStrong: 'muse-wonder-1.0' };
const snapshot = (elements: any[] = []) => ({ sessionID: 's', currentURLString: 'https://example.com', title: 'A page', elements, screenshotBase64: 'aW1hZ2U=', humanControlled: false });

test('browser model gets bounded semantic input, last results and safe screenshot', async () => {
  let input: any;
  const decider = new LLMDecider({ cfg, complete: async (args: any) => { input = args; return '{"action":"scroll","value":"down"}'; } } as any);
  const page = { ...snapshot([{ ref: 'e1-doc-1', label: 'Continue', kind: 'click', role: 'button', disabled: false }]), visionSafe: true,
    pageText: [{ url: 'https://example.com', text: 'Available projects' }], accessibility: [{ role: 'heading', name: 'Projects' }], scroll: { y: 0, pageHeight: 2000 } };
  await decider.decide({ snapshot: page, tierContext: {}, draft: {}, history: [{ action: 'extract', succeeded: true, summary: 'Extracted a writing project' }] });
  const user = JSON.parse(input.user);
  assert.equal(input.imageDataURL, 'data:image/png;base64,aW1hZ2U=');
  assert.equal(user.page.elements[0].ref, 'e1-doc-1');
  assert.equal(user.page.text[0].text, 'Available projects');
  assert.equal(user.soFar[0].result, 'Extracted a writing project');
  assert.match(input.system, /untrusted website data/);
  await decider.decide({ snapshot: { ...page, visionSafe: false }, tierContext: {}, history: [] });
  assert.equal(input.imageDataURL, undefined);
  await decider.decide({ snapshot: snapshot(), tierContext: {}, history: [] });
  assert.equal(input.imageDataURL, undefined, 'old snapshots do not implicitly enable vision');
});

test('LLM multimodal request uses input_image content and prevents gateway image-body logging', async () => {
  const original = globalThis.fetch;
  const requests: any[] = [];
  globalThis.fetch = (async (_url: any, init: any) => {
    requests.push(init);
    return Response.json({ id: 'resp-1', model: 'm-fast', status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: '{"action":"done"}' }] }] });
  }) as any;
  try {
    const client = new LLMClient({ ...cfg, gatewayToken: 'test', gatewayCollectPayload: true });
    await client.complete({ model: cfg.modelStrong, system: 'system', user: 'page', imageDataURL: 'data:image/png;base64,aW1hZ2U=' });
    assert.deepEqual(JSON.parse(requests[0].body).input, [{ type: 'input_text', text: 'page' }, { type: 'input_image', image_url: 'data:image/png;base64,aW1hZ2U=' }]);
    assert.equal(requests[0].headers['cf-aig-collect-log-payload'], 'false');
    await client.complete({ model: cfg.modelFast, system: 'system', user: 'text only' });
    assert.equal(JSON.parse(requests[1].body).input, 'text only');
    await assert.rejects(client.complete({ model: cfg.modelFast, system: '', user: '', imageDataURL: 'https://arbitrary.example/private' }), /Invalid/);
    assert.equal(requests.length, 2);
  } finally { globalThis.fetch = original; }
});

test('stable references do not bypass public/destructive approval or keyboard submission gates', () => {
  const task = { interaction_version: 1, kind: 'signup', drafted_payload: {} };
  assert.equal(needsActionApproval(task, { action: 'click', target: 'e1-doc-1', targetLabel: 'Publish profile', effect: 'reversible' }), true);
  assert.equal(needsActionApproval(task, { action: 'check', targetLabel: 'Subscribe', effect: 'reversible' }), true);
  assert.equal(needsActionApproval(task, { action: 'press', value: 'Enter', effect: 'reversible' }), true);
  assert.equal(needsActionApproval(task, { action: 'press', value: 'Space', effect: 'reversible' }), true);
  assert.equal(needsActionApproval(task, { action: 'select', targetLabel: 'Work category', effect: 'reversible' }), false);
});

test('approval is invalidated if the target node or its semantics change', () => {
  const element = { ref: 'e1-doc-1', label: 'Save', role: 'button', disabled: false };
  const decision = { action: 'click', target: element.ref };
  const before = actionFingerprint(decision, snapshot([element]), {});
  assert.notEqual(actionFingerprint(decision, snapshot([{ ...element, ref: 'e1-doc-2' }]), {}), before);
  assert.notEqual(actionFingerprint(decision, snapshot([{ ...element, disabled: true }]), {}), before);
  assert.equal(actionFingerprint(decision, snapshot([{ ...element }]), {}), before);
});

test('literal private-field typing via an opaque ref is refused', async () => {
  const page = snapshot([{ ref: 'e1-doc-1', label: 'PIN', inputType: 'text', sensitive: true, kind: 'type' },
    { ref: 'e1-doc-2', label: 'e1-doc-1', kind: 'click' }]);
  let acted = false;
  const result = await runMission({ browser: { createSession: async () => page, snapshot: async () => page, act: async () => { acted = true; } },
    task: { id: 't', kind: 'signup', target_url: 'https://example.com', drafted_payload: {} },
    decider: { decide: async () => ({ action: 'type', target: 'e1-doc-1', value: 'invented-code', effect: 'reversible' }) }, maxSteps: 1 });
  assert.equal(acted, false);
  assert.equal(result.trace[0].succeeded, false);
  assert.match(result.trace[0].summary, /Refused/);
  const keyResult = await runMission({ browser: { createSession: async () => page, snapshot: async () => page, act: async () => { acted = true; } },
    task: { id: 't', kind: 'signup', target_url: 'https://example.com', drafted_payload: {} },
    decider: { decide: async () => ({ action: 'press', target: 'e1-doc-1', value: 'Tab', effect: 'reversible' }) }, maxSteps: 1 });
  assert.equal(acted, true, 'Tab is not mistaken for a literal secret');
  assert.equal(keyResult.trace[0].succeeded, true);
});

test('checkpoint notices stop the loop, a marketing footer does not', () => {
  assert.equal(detectCheckpoint({ ...snapshot(), notices: ['Verify your identity'] }), 'identity check');
  assert.equal(detectCheckpoint({ ...snapshot(), notices: ['Welcome'], pageText: [{ url: 'https://example.com', text: 'This site is protected by reCAPTCHA.' }] }), null);
});

test('new browser actions retain iOS-decodable trace kinds', () => {
  const known = new Set(['navigate', 'click', 'type', 'select', 'extract', 'screenshot', 'waitForHuman', 'askUser', 'done', 'needsHuman']);
  for (const action of ['hover', 'check', 'press', 'back', 'forward', 'scroll', 'wait', 'upload', 'select']) assert.ok(known.has(mobileBrowserAction(action)));
});

test('private text and URL authentication parameters are redacted', () => {
  assert.equal(redact('contains abc"123 and abc"123', new Set(['abc"123'])), 'contains [redacted] and [redacted]');
  const url = safePageURL('https://user:pass@example.com/path?code=private&query=design#access_token=secret');
  assert.ok(!url.includes('private')); assert.ok(!url.includes('secret')); assert.ok(!url.includes('pass@')); assert.ok(url.includes('query=design'));
});
