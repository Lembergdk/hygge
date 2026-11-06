import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceExecution } from '../src/workspace-execution.ts';
import { sqliteWorkspace } from './helpers/workspace-sqlite.mts';

// Read-only diagnostics: seeded unresolved effects, admission and tasks
// are reported with the gate verdict, even when ensure() cannot attach
// (fresh workspace, no binding, no container).
test('diagnostics reports unresolved effects and the gate verdict without a container', async () => {
  const { storage } = sqliteWorkspace();
  for (const sql of ["CREATE TABLE tasks(id TEXT PRIMARY KEY,task TEXT NOT NULL,created_at TEXT NOT NULL)", "CREATE TABLE session_profiles(domain TEXT PRIMARY KEY,has_profile INTEGER)", "CREATE TABLE credentials(id TEXT PRIMARY KEY,username TEXT)", "CREATE TABLE profile(id TEXT PRIMARY KEY,payload TEXT)"]) storage.sql.exec(sql);
  const loadTask = (id: string) => { const row = [...storage.sql.exec('SELECT task FROM tasks WHERE id=?', id)][0] as any; return row ? JSON.parse(String(row.task)) : null; };
  const projectTask = (value: any) => storage.sql.exec('INSERT INTO tasks(id,task,created_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET task=excluded.task', value.id, JSON.stringify(value), new Date().toISOString());
  const task: any = { id: 'task-1', kind: 'signup', target_url: 'https://example.invalid/signup', goal: 'Sign up', status: 'needsHuman', drafted_payload: {}, interaction_version: 1, log: [], session_id: 'sess-1', help: { kind: 'recovery' } };
  projectTask(task);
  // Internal work stays invisible: a running fixture task has no help
  // and no pending effect, and its target is not a real site.
  const internal: any = { id: 'task-internal', kind: 'discover', target_url: 'https://invalid.example', goal: 'g', status: 'running', drafted_payload: {}, interaction_version: 1, log: [], session_id: null, help: null };
  projectTask(internal);
  const container: any = { inspect: async () => null, start() { throw new Error('NO_CONTAINER'); }, monitor: async () => {}, setInactivityTimeout: async () => {}, interceptOutboundHttp: async () => {}, interceptOutboundHttps: async () => {}, destroy: async () => {}, getTcpPort: () => { throw new Error('NO_TCP'); } };
  const blobs = new Map<string, Uint8Array>();
  const bucket: any = { put: async (k: string, v: Uint8Array) => { blobs.set(k, Uint8Array.from(v)); }, get: async (k: string) => { const v = blobs.get(k); return v ? { arrayBuffer: async () => Uint8Array.from(v).buffer } : null; } };
  const env: any = { SELF: { fetch: async () => new Response('denied', { status: 403 }) }, WORKSPACE_CHECKPOINTS: bucket, HYGGE_WORKSPACE_IMAGE: 'registry.example/hygge-test@sha256:' + 'a'.repeat(64), HYGGE_WORKSPACE_NAMESPACE: 'hygge-test', HYGGE_ENV: 'staging', DB: { prepare() { throw new Error('No shared registry configured'); } } };
  const owner = { environment: 'staging', userId: 'diag-user', workspaceId: 'diag-do' };
  const workspace = createWorkspaceExecution({ owner, env, storage, container, loadTask, projectTask });
  const db = workspace.foundation.persistence;
  const base = { ...db.owner, intentHash: 'h', approvalId: null, approvalScopeHash: null, incarnation: '', generation: 0 };
  db.put('effect', 'eff-stuck', 0, { ...base, effectId: 'eff-stuck', taskId: 'task-1', runId: 'run-1', status: 'dispatching', revision: 1 });
  db.put('effect', 'eff-done', 0, { ...base, effectId: 'eff-done', taskId: 'task-1', runId: 'run-1', status: 'confirmed', revision: 1 });
  db.put('runner_owner', 'active', 0, { taskId: 'task-1' });
  const diag: any = await workspace.diagnostics();
  assert.equal(diag.ensure.ok, false);
  assert.equal(diag.container.ok, false);
  assert.equal(diag.admission.runnerOwnerActive, true);
  assert.equal(diag.effects.counts.dispatching, 1);
  assert.equal(diag.effects.counts.confirmed, 1);
  assert.deepEqual(diag.effects.unresolved.map((e: any) => e.effectId), ['eff-stuck']);
  assert.equal(diag.effects.unresolved[0].taskId, 'task-1');
  // Look both tasks up by id: they share a created_at timestamp, so
  // their order in the created_at DESC list is not stable.
  const taskRow = diag.tasks.find((t: any) => t.id === 'task-1');
  assert.equal(taskRow.status, 'needsHuman');
  // The task has no stored mobile projection, but it is stuck waiting
  // on the user with a help, so GET /tasks synthesizes one — and the
  // diagnostics says so. A task the server lists but the app never
  // sees is diagnosed here first: mobileTaskPresent false names the
  // server side, true points at the app's pull/decode.
  assert.equal(taskRow.mobileTaskPresent, true);
  assert.equal(taskRow.mobileTaskPendingEffectID, null);
  assert.equal(taskRow.pendingEffectID, null);
  assert.equal(taskRow.targetHost, 'example.invalid');
  assert.equal(taskRow.webProbe, false);
  const internalRow = diag.tasks.find((t: any) => t.id === 'task-internal');
  assert.equal(internalRow.mobileTaskPresent, false);
  assert.equal(internalRow.targetHost, 'invalid.example');
  // The unresolved effect is still reported for audit, but it no
  // longer blocks a new mission — there is no effect gate. (The
  // verdict here is null only because this fixture has no container;
  // the repair test proves a mission starts with a live container.)
  assert.doesNotMatch(diag.blockReasons.join(' '), /eff-stuck/);
  assert.equal(diag.wouldBlockNewMission, null);
  // A clean workspace reports no blockers.
  const { storage: storage2 } = sqliteWorkspace();
  for (const sql of ["CREATE TABLE tasks(id TEXT PRIMARY KEY,task TEXT NOT NULL,created_at TEXT NOT NULL)", "CREATE TABLE session_profiles(domain TEXT PRIMARY KEY,has_profile INTEGER)", "CREATE TABLE credentials(id TEXT PRIMARY KEY,username TEXT)", "CREATE TABLE profile(id TEXT PRIMARY KEY,payload TEXT)"]) storage2.sql.exec(sql);
  const workspace2 = createWorkspaceExecution({ owner, env, storage: storage2, container, loadTask: () => null, projectTask: () => {} });
  const diag2: any = await workspace2.diagnostics();
  assert.deepEqual(diag2.effects.unresolved, []);
  assert.equal(diag2.admission.runnerOwnerActive, false);
  assert.equal(diag2.wouldBlockNewMission, null);
});
