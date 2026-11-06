// Per-site mission gating: an unresolved effect blocks only a mission
// against the same site. One stuck mission on Fiverr must not stop a
// mission on Upwork from starting; two missions on the same site still
// cannot act twice on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasBlockingUnresolvedEffect, hasBlockingHumanSession } from '../src/workspace-execution.ts';

const task = (id: string, url: string) => ({ id, target_url: url, status: 'running' });
const effect = (taskId: string, status: string) => ({ value: { taskId, status } });
const load = (byId: Record<string, string>) => (id: string) => byId[id] ? { id, target_url: byId[id], status: 'needsHuman' } : null;

test('an unresolved effect on the same site blocks the mission', () => {
  for (const status of ['prepared', 'dispatching', 'uncertain']) {
    assert.equal(
      hasBlockingUnresolvedEffect(task('new', 'https://www.fiverr.com/jobs'), [effect('old', status)], load({ old: 'https://fiverr.com/jobs' })),
      true);
  }
});

test('an unresolved effect on another site does not block the mission', () => {
  assert.equal(
    hasBlockingUnresolvedEffect(task('new', 'https://www.upwork.com/jobs'), [effect('old', 'uncertain')], load({ old: 'https://fiverr.com/jobs' })),
    false);
});

test("the mission's own unresolved effect does not block it", () => {
  assert.equal(
    hasBlockingUnresolvedEffect(task('same', 'https://fiverr.com/jobs'), [effect('same', 'uncertain')], load({ same: 'https://fiverr.com/jobs' })),
    false);
});

test('a resolved effect on the same site does not block the mission', () => {
  for (const status of ['confirmed', 'rejected', 'expired']) {
    assert.equal(
      hasBlockingUnresolvedEffect(task('new', 'https://fiverr.com/jobs'), [effect('old', status)], load({ old: 'https://fiverr.com/jobs' })),
      false);
  }
});

test('an effect whose task cannot be loaded blocks (fail closed)', () => {
  assert.equal(
    hasBlockingUnresolvedEffect(task('new', 'https://fiverr.com/jobs'), [effect('gone', 'uncertain')], load({})),
    true);
});

test('an unparseable URL falls back to the raw string', () => {
  assert.equal(
    hasBlockingUnresolvedEffect(task('new', 'not a url'), [effect('old', 'uncertain')], load({ old: 'not a url' })),
    true);
  assert.equal(
    hasBlockingUnresolvedEffect(task('new', 'not a url'), [effect('old', 'uncertain')], load({ old: 'another broken url' })),
    false);
});

test('a human-controlled session on the same site blocks the mission', () => {
  const status = { humanControlled: true, humanControlledSessions: [{ sessionID: 'fx_1', url: 'https://www.fiverr.com/jobs/123' }] };
  assert.equal(hasBlockingHumanSession(task('new', 'https://fiverr.com/jobs'), status), true);
});

test('a human-controlled session on another site does not block the mission', () => {
  const status = { humanControlled: true, humanControlledSessions: [{ sessionID: 'fx_1', url: 'https://fiverr.com/jobs/123' }] };
  assert.equal(hasBlockingHumanSession(task('new', 'https://upwork.com/jobs'), status), false);
});

test('no human-controlled session does not block the mission', () => {
  assert.equal(hasBlockingHumanSession(task('new', 'https://fiverr.com/jobs'), { humanControlled: false, humanControlledSessions: [] }), false);
});

test('an old container without the session list still blocks everything', () => {
  assert.equal(hasBlockingHumanSession(task('new', 'https://upwork.com/jobs'), { humanControlled: true }), true);
  assert.equal(hasBlockingHumanSession(task('new', 'https://upwork.com/jobs'), { humanControlled: false }), false);
});

test('a human-controlled blank session does not block a real site', () => {
  const status = { humanControlled: true, humanControlledSessions: [{ sessionID: 'fx_1', url: 'about:blank' }] };
  assert.equal(hasBlockingHumanSession(task('new', 'https://fiverr.com/jobs'), status), false);
});
