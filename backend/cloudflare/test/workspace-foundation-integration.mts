import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { sqliteWorkspace } from './helpers/workspace-sqlite.mts';
import { WorkspaceRegistry, sqliteWorkspaceRegistryStorage } from '../src/workspace-runtime.ts';
import { WorkspaceCaptureService, type PrivateObjectStore } from '../src/workspace-capture.ts';
import { WorkspacePersistence, runtimeAuthority } from '../src/workspace-persistence.ts';
import { EffectLedger } from '../src/effect-ledger.ts';
import { CheckpointService } from '../src/runtime-checkpoints.ts';
import { createWorkspaceAuthorizationBroker } from '../src/workspace-brokers.ts';
import { assertLease } from '../src/workspace-security.ts';
import { createSkillAttestationBroker, createSkillServiceBroker } from '../src/skill-brokers.ts';
import { PrivateSkillValidator, SharedSkillPublisher, D1SkillPublicationRepository } from '../src/skill-publication.ts';
import { createReviewedRegistry, skillDigest } from '../src/skill-policy.ts';
import { SKILL_POLICY_VERSION } from '../src/skill-contract.ts';
import { createWorkspaceFoundation } from '../src/workspace-foundation.ts';
import { ownerKey } from '../src/workspace-runtime.ts';
import type { WorkspaceBinding, WorkspaceIdentity, RuntimeOperation } from '../src/workspace-contract.ts';

const now = Date.parse('2026-11-02T12:00:00Z');
const owner = { environment: 'staging' as const, userId: 'private-user-a', workspaceId: 'private-workspace-a' };
const other = { ...owner, userId: 'private-user-b', workspaceId: 'private-workspace-b' };
const key = new Uint8Array(32).fill(42);
const publicRegistry = createReviewedRegistry([{ siteId: 'jobs', origin: 'https://jobs.example.com', routes: { home: '/' }, controls: ['search'], fieldSets: ['listings'], pitfalls: [], review: { source: 'developer_review', policyVersion: SKILL_POLICY_VERSION, reviewedRevision: 'review1' } }]);
const body = { schemaVersion: 2 as const, siteId: 'jobs', outcome: 'discover' as const, steps: [{ op: 'navigate' as const, routeId: 'home' }, { op: 'extract' as const, fieldSetId: 'listings' }], pitfalls: [] };

async function fixture() {
  const f = sqliteWorkspace(); const sqlRegistry = sqliteWorkspaceRegistryStorage(f.storage);
  const registry = new WorkspaceRegistry(sqlRegistry, {
    async start(binding) { return { runtimeId: 'runtime-' + binding.generation, providerRuntimeId: 'provider-' + binding.generation, incarnation: 'incarnation-' + binding.generation, recoveredCheckpointId: binding.recoveryPoint?.checkpointId ?? null }; },
    async fence(binding) { return { ...owner, provider: 'cloudflare', previousRuntimeId: binding.runtimeId!, previousIncarnation: binding.incarnation, previousGeneration: binding.generation, browserRetired: true, providerRuntimeId: binding.providerRuntimeId!, result: 'exact_incarnation_stopped', verifiedAt: new Date(now).toISOString(), providerRequestIds: ['synthetic-stop'] }; },
  }, () => now);
  const initial: WorkspaceBinding = { ...owner, provider: 'cloudflare', namespaceId: 'hygge-only-namespace', providerWorkspaceId: 'owner-private-sandbox', ownerDigest: 'synthetic-digest', schemaVersion: 1, incarnation: '', generation: 0, runtimeId: null, providerRuntimeId: null, desiredImageDigest: 'pinned-image', leaseExpiresAt: null, lifecycleState: 'unprovisioned', revision: 0, recoveryPoint: null, lastVerifiedAt: new Date(now).toISOString() };
  await registry.initialize(owner, initial); await registry.ensure(owner, owner, 'start-one');
  const broker = createWorkspaceAuthorizationBroker({ owner, audience: 'hygge-private-ledger', signingKey: key, now: () => now,
    allowedOperations: ['checkpoint.commit', 'task.complete', 'action.prepare', 'action.dispatch', 'action.resolve', 'skill.candidate.submit'],
    readCurrentLease: () => registry.readLease(owner, owner), assertCurrent: candidate => assertLease(owner, sqlRegistry.readCurrentLease(owner), candidate, now) });
  const authority = runtimeAuthority(broker.authorize, o => sqlRegistry.readCurrentLease(o), () => now);
  const db = new WorkspacePersistence(f.storage, owner);
  const effects = new EffectLedger(db, authority, { assertDispatchAllowed(effect) { if (effect.approvalId !== 'approved-once') throw new Error('NO_CONSENT'); } }, async (_effect, _status, ref) => ref === 'evidence');
  const objects = new Map<string, Uint8Array>();
  const objectStore: PrivateObjectStore = { async putImmutable(path, bytes) { if (!objects.has(path)) objects.set(path, bytes.slice()); }, async get(path) { return objects.get(path)?.slice() ?? null; } };
  const capture = new WorkspaceCaptureService(registry, objectStore, { async capture(lease, request) {
    return { snapshot: { incarnation: lease.incarnation, generation: lease.generation, filesystemRevision: request.filesystemRevision, browserProfileRevision: 0, browserState: 'absent',
      files: [{ path: 'evidence.txt', bytes: new TextEncoder().encode('Observed synthetic postcondition') }, { path: 'candidate.json', bytes: new TextEncoder().encode(JSON.stringify(body)) }, { path: 'context.json', bytes: new TextEncoder().encode('private-original-context') }], artifacts: { evidence: 'evidence.txt', candidate: 'candidate.json', context: 'context.json' } }, async release() {} };
  } }, () => now);
  const checkpoints = new CheckpointService(db, authority, effects, (o, id) => capture.verifyReceipt(o, o, id), async (_run, input) => input.verification.evidenceRef === 'evidence', () => new Date(now).toISOString());
  async function token(taskId: string, ops: readonly RuntimeOperation[] = ['checkpoint.commit', 'task.complete', 'action.prepare', 'action.dispatch', 'action.resolve']) { return broker.issue(ops, { taskId }); }
  async function save(index: number) {
    const binding = await registry.read(owner, owner); const lease = await registry.readLease(owner, owner);
    return capture.commit(owner, lease, { writeId: 'write-' + index, expectedRegistryRevision: binding.revision, filesystemRevision: index, browserProfileRevision: 0, artifactRefs: ['candidate', 'context', 'evidence'] });
  }
  return { ...f, registry, broker, db, effects, capture, checkpoints, token, save };
}
class SqliteD1 {
  sql = new DatabaseSync(':memory:');
  constructor() { this.sql.exec('PRAGMA foreign_keys=ON'); this.sql.exec(readFileSync(new URL('../migrations/0008_shared_skills_v2.sql', import.meta.url), 'utf8')); }
  prepare(sql: string) {
    const database = this.sql;
    const statement = { sql, values: [] as unknown[], bind(...values: unknown[]) { return { ...statement, values }; }, async first<T>() { return (database.prepare(sql).get(...this.values as any[]) ?? null) as T | null; } };
    return statement;
  }
  async batch(statements: any[]) {
    this.sql.exec('BEGIN IMMEDIATE');
    try { const result = statements.map(s => ({ results: this.sql.prepare(s.sql).all(...s.values) })); this.sql.exec('COMMIT'); return result; }
    catch (error) { this.sql.exec('ROLLBACK'); throw error; }
  }
}

test('real registry+crypto+capture+DO completion produce eligible receipts and private shared-skill publication', async () => {
  const f = await fixture(); const receipts: string[] = []; const hash = await skillDigest(body);
  try {
    for (let i = 1; i <= 3; i++) {
      const taskId = 'task-' + i, runId = 'run-' + i, cap = await f.token(taskId);
      const ctx = (requestId: string, expectedRevision: number) => ({ requestId, expectedRevision, capabilityToken: cap });
      await f.checkpoints.startRun(ctx('begin-' + i, 0), { taskId, runId, siteOrigin: 'https://jobs.example.com', outcome: 'discover', candidate: { kind: 'confirming', bodyHash: hash } });
      const saved = await f.save(i);
      const input = { runId, checkpoint: { ...owner, schemaVersion: 1 as const, taskId, runId, filesystemRevision: i, browserProfileRevision: 0, workspaceDurabilityReceiptId: saved.receiptId, privateArtifactRefs: ['candidate', 'context'], helpId: null }, candidateBodyHash: hash, verification: { kind: 'observed_postcondition' as const, policyVersion: 'synthetic-postcondition-v1', evidenceRef: 'evidence' } };
      const receipt = await f.checkpoints.complete(ctx('finish-' + i, 1), input);
      assert.deepEqual(await f.checkpoints.complete(ctx('finish-' + i, 1), input), receipt);
      receipts.push(receipt.receiptId);
    }
    const candidateCap = await f.broker.issue(['skill.candidate.submit']);
    const authorizeOwner = async (o: WorkspaceIdentity, token: string) => { if (JSON.stringify(o) !== JSON.stringify(owner)) return false; try { await f.broker.authorize(token, 'skill.candidate.submit'); return true; } catch { return false; } };
    const attestation = createSkillAttestationBroker(key, 'staging', () => now, async () => authorizeOwner(owner, candidateCap));
    const validator = new PrivateSkillValidator({ authorizeOwner, async loadCandidate() { return { candidateId: 'candidate-a', body, candidateBodyHash: hash, receiptIds: receipts, requiredArtifactRefs: ['candidate', 'context'], privateKnownValues: ['private-original-context', 'private-user-a'] }; },
      getCanonicalRunReceipt: f.checkpoints.getCanonicalRunReceipt.bind(f.checkpoints), verifyDurabilityCoverage: f.checkpoints.verifyDurabilityCoverage.bind(f.checkpoints) }, publicRegistry, attestation.issuer, () => now);
    assert.equal((await validator.prepare(other, candidateCap, 'candidate-a')).status, 'held');
    const request = await validator.prepare(owner, candidateCap, 'candidate-a'); assert.equal(request.status, 'ready');
    const d1 = new SqliteD1();
    try {
      const serviceGrant = createSkillServiceBroker(key, 'staging', async (op) => op === 'publish', () => now);
      const publisher = new SharedSkillPublisher(new D1SkillPublicationRepository(d1), publicRegistry, 'staging', serviceGrant.authorization, attestation.verifier, () => now);
      if (request.status !== 'ready') throw new Error('Expected eligible publication');
      const token = await serviceGrant.issue('publish', {});
      const published = await publisher.publish(token, request.request); assert.equal(published.status, 'published');
      assert.equal((await publisher.publish(token, request.request)).status, 'existing');
      const shared = JSON.stringify(d1.sql.prepare('SELECT * FROM public_skills_v2').all());
      for (const privateValue of ['private-user-a', 'private-workspace-a', 'private-original-context', 'evidence.txt', ...receipts]) assert.equal(shared.includes(privateValue), false);
      assert.deepEqual((await publisher.resolve('jobs', 'discover'))?.body, body);
    } finally { d1.sql.close(); }
  } finally { f.sqlite.close(); }
});

test('same-database replacement fences signed old capabilities and preserves uncertain effects without replay', async () => {
  const f = await fixture();
  try {
    const taskId = 'task-effect', cap = await f.token(taskId);
    const context = (requestId: string, expectedRevision: number) => ({ requestId, expectedRevision, capabilityToken: cap });
    await f.checkpoints.startRun(context('begin', 0), { taskId, runId: 'run-effect', siteOrigin: 'https://jobs.example.com', outcome: 'apply', candidate: { kind: 'ordinary' } });
    await f.effects.prepare(context('prepare', 0), { taskId, runId: 'run-effect', effectId: 'effect-one', intentHash: 'semantic-intent', approvalId: 'approved-once', approvalScopeHash: 'approved-scope' });
    await f.effects.dispatch(context('dispatch', 1), 'effect-one');
    await f.save(1);
    const current = await f.registry.read(owner, owner);
    await f.registry.fence(owner, owner, current.generation, 'fence-one');
    assert.equal(f.effects.recoverDispatches(() => {
      const state = [...f.storage.sql.exec('SELECT value FROM workspace_registry WHERE key = ?', 'workspace/' + ownerKey(owner))][0];
      const proof = [...f.storage.sql.exec('SELECT value FROM workspace_registry WHERE key = ?', 'fence/' + ownerKey(owner) + '/fence-one')][0];
      assert.equal(JSON.parse(String(state.value)).binding.lifecycleState, 'stopped');
      assert.equal(JSON.parse(String(proof.value)).previousGeneration, current.generation);
      assert.equal(JSON.parse(String(proof.value)).previousIncarnation, current.incarnation);
    }), 1);
    await f.registry.ensure(owner, owner, 'replacement-one');
    await assert.rejects(f.effects.dispatch(context('old-replay', 3), 'effect-one'));
    const newCap = await f.token(taskId);
    await assert.rejects(f.effects.dispatch({ ...context('new-replay', 3), capabilityToken: newCap }, 'effect-one'), /OUTCOME_UNCERTAIN/);
    assert.equal(f.effects.require('effect-one').status, 'uncertain');
    const fresh = new WorkspacePersistence(f.storage, owner);
    assert.equal(fresh.get<any>('consent_consumed', 'approved-once')?.value.effectId, 'effect-one');
    await assert.rejects(f.capture.verifyReceipt(other, owner, 'write-1'), /OWNER_MISMATCH/);
  } finally { f.sqlite.close(); }
});

test('production composition defaults deny unsupported provider activation and missing trusted policies', async () => {
  const f = sqliteWorkspace();
  try {
    const config = { owner, storage: f.storage, signingKey: key, objects: { async get() { return null; }, async putImmutable() {} },
      consent: { assertDispatchAllowed() { throw new Error('UNCONFIGURED_CONSENT'); } }, verifyOutcome: async () => false, verifyCompletion: async () => false, now: () => now };
    const foundation = createWorkspaceFoundation(config);
    assert.throws(() => createWorkspaceFoundation({ ...config, verifyCompletion: undefined } as any), /TRUSTED_WORKSPACE_ADAPTERS_REQUIRED/);
    await foundation.registry.initialize(owner, { ...owner, provider: 'cloudflare', namespaceId: 'hygge-private', providerWorkspaceId: 'workspace-private', ownerDigest: 'digest', schemaVersion: 1, incarnation: '', generation: 0, runtimeId: null, providerRuntimeId: null, desiredImageDigest: 'pinned-image', leaseExpiresAt: null, lifecycleState: 'unprovisioned', revision: 0, recoveryPoint: null, lastVerifiedAt: new Date(now).toISOString() });
    await assert.rejects(foundation.registry.ensure(owner, owner, 'activate'), /BROWSER_PROVIDER_FEASIBILITY_REQUIRED/);
    await assert.rejects(foundation.save('unsigned-token', { writeId: 'write', expectedRegistryRevision: 0, filesystemRevision: 1, browserProfileRevision: 0, artifactRefs: [] }));
  } finally { f.sqlite.close(); }
});
