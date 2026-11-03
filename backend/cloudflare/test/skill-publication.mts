import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { D1SkillPublicationRepository, SharedSkillPublisher, PrivateSkillValidator } from '../src/skill-publication.ts';
import { skillDigest, createReviewedRegistry } from '../src/skill-policy.ts';
import { SKILL_POLICY_VERSION } from '../src/skill-contract.ts';
import type { PublicationClaim, PublicationRequest, OwnerEvidenceSource, PrivateCandidate } from '../src/skill-contract.ts';
import type { RunCompletionReceipt, WorkspaceIdentity } from '../src/workspace-contract.ts';

const registry = createReviewedRegistry([{ siteId: 'jobs', origin: 'https://jobs.example.com', routes: { home: '/', search: '/search' },
  controls: ['search'], fieldSets: ['listings'], pitfalls: [], review: { source: 'developer_review', policyVersion: SKILL_POLICY_VERSION, reviewedRevision: 'review1' } }]);
const body = { schemaVersion: 2 as const, siteId: 'jobs', outcome: 'discover' as const,
  steps: [{ op: 'navigate' as const, routeId: 'home' }, { op: 'extract' as const, fieldSetId: 'listings' }], pitfalls: [] };
const owner: WorkspaceIdentity = { environment: 'staging', userId: 'userA', workspaceId: 'workspaceA' };
const now = Date.parse('2026-11-03T00:00:00.000Z');
/** Same prepared SQL/transaction boundaries as D1, backed by real SQLite with rollback. */
class SqliteD1 {
  sql = new DatabaseSync(':memory:');
  constructor() { this.sql.exec('PRAGMA foreign_keys=ON'); this.sql.exec(readFileSync(new URL('../migrations/0008_shared_skills_v2.sql', import.meta.url), 'utf8')); }
  prepare(sql: string) {
    const database = this.sql;
    const statement = { sql, values: [] as unknown[], bind(...values: unknown[]) { return { ...statement, values }; },
      async first<T>() { return (database.prepare(sql).get(...this.values as any[]) ?? null) as T | null; } };
    return statement;
  }
  async batch(statements: any[]) {
    this.sql.exec('BEGIN IMMEDIATE');
    try { const result = statements.map(s => ({ results: this.sql.prepare(s.sql).all(...s.values) })); this.sql.exec('COMMIT'); return result; }
    catch (e) { this.sql.exec('ROLLBACK'); throw e; }
  }
}
async function fixture() {
  const db = new SqliteD1(); const repo = new D1SkillPublicationRepository(db);
  const tokens = new Map<string, PublicationClaim>();
  const issuer = { async issue(c: PublicationClaim) { const token = crypto.randomUUID(); tokens.set(token, structuredClone(c)); return token; } };
  const verifier = { async verify(token: string) { return tokens.get(token) ?? null; } };
  const authorization = { async authorize(token: string) { return token === 'trusted-backend'; } };
  const service = new SharedSkillPublisher(repo, registry, 'staging', authorization, verifier, () => now);
  async function request(capsule = body, key = crypto.randomUUID()) {
    const hash = await skillDigest(capsule);
    const attestation = await issuer.issue({ audience: 'hygge-skill-publisher', environment: 'staging', policyVersion: SKILL_POLICY_VERSION,
      capsuleHash: hash, distinctSuccessCount: 3, tokenId: crypto.randomUUID(), idempotencyKey: key,
      expiresAt: new Date(now + 60_000).toISOString() });
    return { requestVersion: 1 as const, idempotencyKey: key, capsule, capsuleHash: hash, attestation };
  }
  return { db, repo, service, tokens, issuer, request };
}
function rows(f: Awaited<ReturnType<typeof fixture>>, table: string) { return f.db.sql.prepare(`SELECT * FROM ${table}`).all(); }

test('real SQL atomic publication allocates distinct versions concurrently; repeats deduplicate', async () => {
  const f = await fixture(); const req = await f.request();
  const results = await Promise.all(Array.from({ length: 8 }, () => f.service.publish('trusted-backend', req)));
  assert.ok(results.every(r => ['published', 'existing'].includes(r.status)));
  assert.equal(rows(f, 'public_skills_v2').length, 1);
  const second = await f.request({ ...body, steps: [{ op: 'navigate', routeId: 'search' }] });
  await Promise.all([f.service.publish('trusted-backend', second), f.service.publish('trusted-backend', await f.request())]);
  assert.deepEqual(rows(f, 'public_skills_v2').map(r => r.version), [1, 2]);
  const active = await f.service.resolve('jobs', 'discover'); assert.equal(active?.version, 2);
  assert.equal(rows(f, 'skill_publications_v2').length, 3);
  const publicText = JSON.stringify(rows(f, 'public_skills_v2'));
  for (const privateValue of ['userA', 'workspaceA', 'receiptA', 'private-evidence']) assert.equal(publicText.includes(privateValue), false);
});
test('changed request, token replay, absent verifier, expired/wrong-environment claims fail closed', async () => {
  const f = await fixture(); const req = await f.request(); await f.service.publish('trusted-backend', req);
  assert.equal((await f.service.publish('trusted-backend', { ...req, idempotencyKey: crypto.randomUUID() })).status, 'held');
  assert.equal((await f.service.publish('runtime', req)).status, 'held');
  assert.equal((await new SharedSkillPublisher(f.repo, registry, 'staging').publish('trusted-backend', req)).status, 'held');
  for (const change of [{ environment: 'production' }, { distinctSuccessCount: 2 }, { expiresAt: new Date(now).toISOString() }]) {
    const r = await f.request(); Object.assign(f.tokens.get(r.attestation)!, change);
    assert.equal((await f.service.publish('trusted-backend', r)).status, 'held');
  }
  const different = await f.request({ ...body, steps: [{ op: 'navigate', routeId: 'search' }] }, req.idempotencyKey);
  assert.equal((await f.service.publish('trusted-backend', different)).status, 'rejected');
  assert.equal(rows(f, 'public_skills_v2').length, 1); assert.equal(rows(f, 'skill_publications_v2').length, 1);
});
test('usage receipts deduplicate atomically; failures demote and quarantine is never undone', async () => {
  const f = await fixture(); const pub = await f.service.publish('trusted-backend', await f.request());
  assert.ok('skillId' in pub); const id = pub.skillId;
  await Promise.all(Array.from({ length: 6 }, () => f.service.usage('trusted-backend', 'usage1', id, true, false)));
  assert.equal(Number(rows(f, 'public_skills_v2')[0].source_run_count), 4);
  await assert.rejects(() => f.service.usage('trusted-backend', 'usage1', id, false, true));
  assert.equal(Number(rows(f, 'public_skills_v2')[0].source_run_count), 4);
  await f.service.usage('trusted-backend', 'usage2', id, false, true);
  assert.equal(await f.service.resolve('jobs', 'discover'), null);
  assert.equal(rows(f, 'public_skills_v2')[0].status, 'needs_reverification');
  await f.service.quarantine('trusted-backend', 'q1', id, 'privacy');
  const epoch = rows(f, 'public_skills_v2')[0].epoch;
  await f.service.quarantine('trusted-backend', 'q1', id, 'privacy');
  await f.service.usage('trusted-backend', 'usage3', id, true, false);
  assert.equal(rows(f, 'public_skills_v2')[0].status, 'quarantined'); assert.equal(rows(f, 'public_skills_v2')[0].epoch, epoch);
  assert.equal((await f.service.publish('trusted-backend', await f.request())).status, 'held');
});
test('quarantine blocks post-transition admissions/consumption, including warm cached versions', async () => {
  const f = await fixture(); const pub = await f.service.publish('trusted-backend', await f.request()); assert.ok('skillId' in pub);
  const warm = await f.service.resolve('jobs', 'discover'); assert.ok(warm);
  assert.ok(await f.service.admit('trusted-backend', 'before', warm.id, warm.version, warm.epoch));
  assert.equal(await f.service.consume('trusted-backend', 'before', 'private-effect-binding'), true);
  assert.equal(await f.service.consume('trusted-backend', 'before', 'different-binding'), false);
  assert.ok(await f.service.admit('trusted-backend', 'pending', warm.id, warm.version, warm.epoch));
  await f.service.quarantine('trusted-backend', 'privacy1', pub.skillId, 'privacy');
  assert.equal(await f.service.admit('trusted-backend', 'after', warm.id, warm.version, warm.epoch), null);
  assert.equal(await f.service.consume('trusted-backend', 'pending', 'binding2'), false);
  // A pre-transition dispatch may already have happened: no promise of retroactive undo.
  assert.equal(rows(f, 'skill_admissions_v2').find(r => r.admission_id === 'before')!.consumed_by, 'private-effect-binding');
});
test('admission retries retain original expiry and exact binding; expired or forged context cannot dispatch', async () => {
  const f = await fixture(); await f.service.publish('trusted-backend', await f.request());
  const skill = await f.service.resolve('jobs', 'discover'); assert.ok(skill);
  const first = await f.service.admit('trusted-backend', 'replay', skill.id, skill.version, skill.epoch); assert.ok(first);
  const second = await f.repo.admit('replay', skill.id, skill.version, skill.epoch, new Date(now + 999_000).toISOString(), skill);
  assert.equal(second?.expiresAt, first.expiresAt);
  await assert.rejects(() => f.repo.admit('replay', skill.id, skill.version + 1, skill.epoch, first.expiresAt, skill), /IDEMPOTENCY_CONFLICT/);
  assert.equal(await f.repo.consume('replay', 'binding', new Date(now + 10_000).toISOString(), skill), false);
  const bound = new SharedSkillPublisher(f.repo, registry, 'staging', { async authorize(_token, op, binding) {
    return op === 'consume' && binding.effectBinding === 'authorized-effect';
  } }, undefined, () => now);
  assert.equal(await bound.consume('credential', 'replay', 'different-effect'), false);
});
test('quarantine/admission race is transactional and rejected payload rolls back all SQL', async () => {
  const f = await fixture(); await f.service.publish('trusted-backend', await f.request());
  const skill = await f.service.resolve('jobs', 'discover'); assert.ok(skill);
  await Promise.all([f.service.admit('trusted-backend', 'race1', skill.id, skill.version, skill.epoch),
    f.service.quarantine('trusted-backend', 'raceq', skill.id, 'privacy'),
    f.service.admit('trusted-backend', 'race2', skill.id, skill.version, skill.epoch)]);
  assert.equal(await f.service.consume('trusted-backend', 'race1', 'effect1'), false);
  assert.equal(await f.service.consume('trusted-backend', 'race2', 'effect2'), false);
  assert.equal(await f.service.resolve('jobs', 'discover'), null);
  await assert.rejects(() => f.service.quarantine('trusted-backend', 'raceq', skill.id, 'integrity'), /IDEMPOTENCY_CONFLICT/);
  assert.equal(rows(f, 'skill_quarantines_v2').length, 1);
  assert.equal(rows(f, 'skill_quarantines_v2')[0].reason_code, 'privacy');
});
test('current registry, policy and stored hash/body validation protect reads, admission and consumption', async () => {
  for (const mutation of ['route', 'control', 'fieldSet', 'policy', 'body', 'hash', 'metadata'] as const) {
    const f = await fixture();
    const testBody = { ...body, steps: [{ op: 'navigate' as const, routeId: 'home' },
      { op: 'inspect' as const, controlId: 'search' }, { op: 'extract' as const, fieldSetId: 'listings' }] };
    const pub = await f.service.publish('trusted-backend', await f.request(testBody)); assert.ok('skillId' in pub);
    const cached = await f.service.resolve('jobs', 'discover'); assert.ok(cached);
    assert.ok(await f.service.admit('trusted-backend', 'pending-policy', cached.id, cached.version, cached.epoch));
    let currentRegistry = registry;
    if (['route', 'control', 'fieldSet'].includes(mutation)) {
      const site = registry.getSite('jobs')!;
      if (mutation === 'route') delete (site.routes as Record<string,string>).home;
      if (mutation === 'control') site.controls = [];
      if (mutation === 'fieldSet') site.fieldSets = [];
      currentRegistry = createReviewedRegistry([site]);
    } else if (mutation === 'policy') {
      f.db.sql.prepare('UPDATE public_skills_v2 SET policy_version=? WHERE id=?').run('obsolete-policy', cached.id);
    } else if (mutation === 'body') {
      f.db.sql.prepare('UPDATE public_skills_v2 SET body=? WHERE id=?').run(JSON.stringify({ ...testBody, steps: [{ op: 'navigate', routeId: 'search' }] }), cached.id);
    } else if (mutation === 'hash') {
      f.db.sql.prepare('UPDATE public_skills_v2 SET content_hash=? WHERE id=?').run('a'.repeat(64), cached.id);
    } else {
      f.db.sql.prepare('UPDATE public_skills_v2 SET site_id=? WHERE id=?').run('other-site', cached.id);
    }
    const current = new SharedSkillPublisher(f.repo, currentRegistry, 'staging', { async authorize() { return true; } }, undefined, () => now);
    assert.equal(await current.resolve('jobs', 'discover'), null, mutation);
    assert.equal(await current.readValidated(cached.id), null, mutation);
    assert.equal(await current.admit('trusted-backend', 'new-policy', cached.id, cached.version, cached.epoch), null, mutation);
    assert.equal(await current.consume('trusted-backend', 'pending-policy', 'effect'), false, mutation);
  }
});
test('atomic admission and consumption reject a stored-body change after validated read', async () => {
  const f = await fixture(); await f.service.publish('trusted-backend', await f.request());
  const cached = await f.service.resolve('jobs', 'discover'); assert.ok(cached);
  assert.ok(await f.service.admit('trusted-backend', 'pending-cas', cached.id, cached.version, cached.epoch));
  f.db.sql.prepare('UPDATE public_skills_v2 SET body=? WHERE id=?').run(JSON.stringify({ ...body, steps: [{ op: 'navigate', routeId: 'search' }] }), cached.id);
  assert.equal(await f.repo.admit('new-cas', cached.id, cached.version, cached.epoch, new Date(now + 1000).toISOString(), cached), null);
  assert.equal(await f.repo.consume('pending-cas', 'effect', new Date(now).toISOString(), cached), false);
});
async function evidenceFixture() {
  const f = await fixture(); const hash = await skillDigest(body);
  const receipts = new Map<string, RunCompletionReceipt>();
  for (let i = 0; i < 3; i++) receipts.set(`receipt${i}`, { ...owner, schemaVersion: 1, receiptId: `receipt${i}`,
    runId: `run${i}`, taskId: `task${i}`, incarnation: 'historical-incarnation', generation: 1,
    siteOrigin: 'https://jobs.example.com', outcome: 'discover', candidateBodyHash: hash,
    taskRevision: i + 1, workspaceDurabilityReceiptId: `durable${i}`, status: 'succeeded',
    verification: { kind: 'observed_postcondition', policyVersion: 'postcondition-v1', evidenceRef: `private-evidence${i}` },
    completedAt: new Date(now - 1000).toISOString() });
  const candidate: PrivateCandidate = { candidateId: 'candidate', body, candidateBodyHash: hash,
    receiptIds: [...receipts.keys()], requiredArtifactRefs: ['original-context', 'browser-profile'], privateKnownValues: ['Synthetic Private Person'] };
  let authorized = true; let durable = true;
  const source: OwnerEvidenceSource = { async authorizeOwner(o) { return authorized && o.userId === owner.userId; },
    async loadCandidate() { return structuredClone(candidate); }, async getCanonicalRunReceipt(_o, id) { return receipts.get(id) ?? null; },
    async verifyDurabilityCoverage(_o, r, refs) { return durable && !!r.workspaceDurabilityReceiptId && refs.includes('original-context'); } };
  const validator = new PrivateSkillValidator(source, registry, f.issuer, () => now);
  return { ...f, receipts, candidate, validator, setAuthorized(v: boolean) { authorized = v; }, setDurable(v: boolean) { durable = v; } };
}
test('private validator uses 3 canonical durable distinct runs; historical receipts survive replacement', async () => {
  const f = await evidenceFixture(); const result = await f.validator.prepare(owner, 'owner-capability', 'candidate');
  assert.equal(result.status, 'ready'); assert.ok('request' in result);
  const serialized = JSON.stringify(result.request);
  for (const secret of ['Synthetic Private Person', 'private-evidence', 'original-context', 'userA', 'workspaceA']) assert.equal(serialized.includes(secret), false);
  const published = await f.service.publish('trusted-backend', result.request); assert.equal(published.status, 'published');
  const claim = f.tokens.get(result.request.attestation)!; assert.equal(claim.distinctSuccessCount, 3);
});
test('duplicate/mismatched/unverified/undurable receipts or missing authority never promote', async () => {
  for (const mutation of [
    (f: any) => { f.receipts.get('receipt1').runId = 'run0'; },
    (f: any) => { f.receipts.get('receipt1').candidateBodyHash = null; },
    (f: any) => { f.receipts.get('receipt1').userId = 'userB'; },
    (f: any) => { f.receipts.get('receipt1').siteOrigin = 'https://other.example.com'; },
    (f: any) => { f.receipts.get('receipt1').verification.kind = 'model-done'; },
    (f: any) => { f.setDurable(false); }, (f: any) => { f.setAuthorized(false); },
  ]) { const f = await evidenceFixture(); mutation(f); assert.equal((await f.validator.prepare(owner, 'capability', 'candidate')).status, 'held'); }
});
