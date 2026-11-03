import { CDPSessionEvent } from "@cloudflare/puppeteer/internal/api/CDPSession.js";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BrowserControl, BrowserControlInterrupted, validateBrowserInput } from '../src/browser-control.ts';
import { BrowserLive } from '../src/browser-live.ts';
import { runMission } from '../src/agent.ts';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
test('takeover waits for in-flight action and rejects stale decisions after release', async () => {
  const control = new BrowserControl(); let complete!: () => void;
  const step = control.agent(0, () => new Promise<void>(resolve => complete = resolve));
  await tick(); let acknowledged = false;
  const take = control.acquire('phone').then(() => acknowledged = true);
  await tick(); assert.equal(acknowledged, false);
  complete(); await step; await take;
  await assert.rejects(control.agent(0, async () => {}), BrowserControlInterrupted);
  await assert.rejects(control.input('other-phone', async () => {}));
  await control.release('phone');
  await assert.rejects(control.agent(0, async () => {}), BrowserControlInterrupted);
  assert.equal(await control.agent(control.epoch, async () => 'new'), 'new');
});
test('disconnect preserves pause, allows reclaim and rejects competing controllers', async () => {
  const control = new BrowserControl(); await control.acquire('phone');
  await assert.rejects(control.acquire('tablet'));
  control.disconnect('phone'); assert.equal(control.human, true); assert.equal(control.owner, null);
  await assert.rejects(control.agent(control.epoch, async () => {}));
  await control.acquire('tablet'); await control.release('tablet'); assert.equal(control.human, false);
});
test('input rejects arbitrary commands, unbounded coordinates and oversized text', () => {
  for (const m of [{ type: 'Runtime.evaluate' }, { type: 'pointer', phase: 'click', x: NaN, y: .5 },
    { type: 'pointer', phase: 'click', x: 1.1, y: 0 }, { type: 'text', text: 'a'.repeat(4097) }, { type: 'key', key: 'Enter', modifiers: -1 }]) assert.equal(validateBrowserInput(m), false);
  assert.equal(validateBrowserInput({ type: 'pointer', phase: 'click', x: .2, y: .8 }), true);
});
class Socket extends EventTarget {
  messages: any[] = [];
  send(text: string) { this.messages.push(JSON.parse(text)); }
  close() { this.dispatchEvent(new Event('close')); }
  input(value: any) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
}
class CDP extends EventEmitter {
  calls: any[] = [];
  async send(method: string, params?: any) { this.calls.push({ method, params }); }
  async detach() {}
}
function fixture() {
  const cdp = new CDP();
  const page = { createCDPSession: async () => cdp, viewport: () => ({ width: 1000, height: 800 }), url: () => 'https://example.com', once() {}, frames: () => [] };
  return { cdp, live: new BrowserLive(page) };
}
test('one live screencast serves multiple viewers; direct input requires ownership', async () => {
  const { cdp, live } = fixture(); const a = new Socket(), b = new Socket(); let resumes = 0;
  await live.connect(a as any, async () => { resumes++; }); await live.connect(b as any, async () => {});
  assert.equal(cdp.calls.filter(c => c.method === 'Page.startScreencast').length, 1);
  cdp.emit('Page.screencastFrame', { data: 'frame-a', sessionId: 1 });
  cdp.emit('Page.screencastFrame', { data: 'frame-b', sessionId: 2 });
  assert.equal(a.messages.filter(m => m.type === 'frame').length, 1);
  a.input({ type: 'pointer', phase: 'click', x: .25, y: .5 }); await tick();
  assert.equal(cdp.calls.filter(c => c.method === 'Input.dispatchMouseEvent').length, 0);
  a.input({ type: 'takeControl', requestID: 'take' }); await tick();
  assert.ok(a.messages.some(m => m.type === 'controlled'));
  b.input({ type: 'text', text: 'not owner' }); await tick();
  assert.equal(cdp.calls.filter(c => c.method === 'Input.insertText').length, 0);
  a.input({ type: 'pointer', phase: 'click', x: .25, y: .5 }); await tick();
  const click = cdp.calls.find(c => c.method === 'Input.dispatchMouseEvent');
  assert.equal(click.params.x, 250); assert.equal(click.params.y, 400);
  a.input({ type: 'text', text: 'hello' }); a.input({ type: 'key', key: 'Backspace' }); await tick();
  assert.ok(cdp.calls.some(c => c.method === 'Input.insertText' && c.params.text === 'hello'));
  a.input({ type: 'releaseControl', requestID: 'release' }); await tick();
  assert.equal(resumes, 1); assert.equal(live.control.human, false); a.close(); b.close();
});
test('refused resume preserves ownership and does not acknowledge release', async () => {
  const { live } = fixture(); const s = new Socket();
  await live.connect(s as any, async () => { throw new Error('Review approval in chat'); });
  s.input({ type: 'takeControl', requestID: 'take' }); await tick();
  s.input({ type: 'releaseControl', requestID: 'release' }); await tick();
  assert.equal(live.control.human, true);
  assert.ok(s.messages.some(m => m.type === 'error' && m.requestID === 'release'));
  assert.ok(!s.messages.some(m => m.type === 'released')); s.close();
});
test('mission exposes session and stops when takeover interrupts model thinking', async () => {
  const control = new BrowserControl(); let published = ''; let actions = 0;
  const snap = { sessionID: 'session', currentURLString: 'https://example.com', title: 'Example', elements: [] };
  const browser = { mode: 'test', createSession: async () => snap, snapshot: async () => snap, controlState: () => control,
    act: async () => { actions++; }, agentStep: (_id: string, epoch: number, op: any) => control.agent(epoch, op) };
  const result = await runMission({ browser, task: { kind: 'signup', goal: 'profile', target_url: 'https://example.com' },
    onSession: id => published = id, decider: { decide: async () => { assert.equal(published, 'session'); await control.acquire('phone'); return { action: 'click', target: 'Next' }; } } });
  assert.equal(actions, 0); assert.equal(result.status, 'needs_human'); assert.equal(result.sessionID, 'session');
});

test('replacement viewer waits for previous screencast teardown', async () => {
  const first = new CDP(), second = new CDP();
  let finishStop!: () => void;
  const send = first.send.bind(first);
  first.send = async (method, params) => {
    await send(method, params);
    if (method === 'Page.stopScreencast') await new Promise<void>(resolve => finishStop = resolve);
  };
  let created = 0;
  const page = { createCDPSession: async () => ++created === 1 ? first : second,
    viewport: () => ({ width: 1000, height: 800 }), url: () => 'https://example.com', once() {} };
  const live = new BrowserLive(page), a = new Socket(), b = new Socket();
  await live.connect(a as any, async () => {});
  a.close();
  const replacing = live.connect(b as any, async () => {});
  await tick();
  assert.equal(created, 1, 'new stream cannot start while old page stop is pending');
  finishStop(); await replacing;
  second.emit('Page.screencastFrame', { data: 'fresh-frame', sessionId: 1 });
  assert.ok(b.messages.some(m => m.type === 'frame' && m.data === 'fresh-frame'));
  b.close();
});

test('leaving during startup tears down after startup finishes', async () => {
  const cdp = new CDP(); let create!: (cdp: CDP) => void;
  const page = { createCDPSession: () => new Promise<CDP>(resolve => create = resolve),
    viewport: () => ({ width: 1000, height: 800 }), url: () => 'https://example.com', once() {} };
  const live = new BrowserLive(page), socket = new Socket();
  const opening = live.connect(socket as any, async () => {});
  await tick(); socket.close(); create(cdp); await opening; await tick();
  assert.ok(cdp.calls.some(c => c.method === 'Page.stopScreencast'));
  assert.equal(socket.messages.length, 0, 'no messages to departed viewer');
});

test('static page heartbeats do not wait behind a pending handoff', async () => {
  const { live, cdp } = fixture(); const socket = new Socket();
  await live.connect(socket as any, async () => {});
  cdp.emit('Page.screencastFrame', { data: 'static-frame', sessionId: 1 });
  let finish!: () => void;
  const action = live.control.agent(0, () => new Promise<void>(resolve => finish = resolve));
  await tick(); socket.input({ type: 'takeControl', requestID: 'take' }); await tick();
  socket.input({ type: 'ping' }); await tick();
  assert.ok(socket.messages.some(m => m.type === 'pong'));
  assert.ok(!socket.messages.some(m => m.type === 'controlled'));
  finish(); await action; await tick();
  assert.ok(socket.messages.some(m => m.type === 'controlled'));
  socket.close();
});

test('actual Puppeteer disconnect event ends viewers and rejects stale reconnect', async () => {
  const { live, cdp } = fixture(); const a = new Socket(), b = new Socket();
  await live.connect(a as any, async () => {});
  cdp.emit(CDPSessionEvent.Disconnected);
  assert.equal(live.ended, true);
  assert.ok(a.messages.some(m => m.type === 'ended'));
  await live.connect(b as any, async () => {});
  assert.ok(b.messages.some(m => m.type === 'ended'));
  assert.equal(cdp.calls.filter(c => c.method === 'Page.startScreencast').length, 1);
});

test('late heartbeat failure from a departed viewer cannot end its replacement', async () => {
  const first = new CDP(), second = new CDP(); let rejectPing!: (error: Error) => void;
  const send = first.send.bind(first);
  first.send = async (method, params) => {
    await send(method, params);
    if (method === 'Page.getLayoutMetrics') await new Promise<void>((_, reject) => rejectPing = reject);
  };
  let created = 0;
  const page = { createCDPSession: async () => ++created === 1 ? first : second,
    viewport: () => ({ width: 1000, height: 800 }), url: () => 'https://example.com', once() {} };
  const live = new BrowserLive(page), a = new Socket(), b = new Socket();
  await live.connect(a as any, async () => {});
  a.input({ type: 'ping' }); await tick(); a.close();
  await live.connect(b as any, async () => {});
  rejectPing(new Error('old session detached')); await tick();
  assert.equal(live.ended, false);
  second.emit('Page.screencastFrame', { data: 'fresh-frame', sessionId: 1 });
  assert.ok(b.messages.some(m => m.type === 'frame'));
  b.close();
});
