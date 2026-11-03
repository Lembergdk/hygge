import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, hashJson, issueRuntimeCapability, verifyRuntimeCapability } from '../src/workspace-security.ts';
import type { CapabilityClaims, RuntimeLease } from '../src/workspace-contract.ts';
import { createWorkspaceAuthorizationBroker } from '../src/workspace-brokers.ts';

const now = Date.parse('2026-11-02T12:00:00Z');
const owner = { environment: 'staging' as const, userId: 'user-a', workspaceId: 'workspace-a' };
const lease: RuntimeLease = { ...owner, runtimeId: 'runtime-a', incarnation: 'incarnation-a', generation: 2, leaseId: 'lease-a', expiresAt: new Date(now + 60_000).toISOString() };
const claims: CapabilityClaims = { ...lease, audience: 'hygge-state', operations: ['checkpoint.commit'], taskId: 'task-a', domain: 'jobs.example', tokenId: 'token-a' };
const secret = new Uint8Array(32).fill(71);
const required = { owner, audience: 'hygge-state', operation: 'checkpoint.commit' as const, taskId: 'task-a', domain: 'jobs.example' };

test('signed capabilities bind owner, operation, audience, task, domain and current incarnation', async () => {
  const token = await issueRuntimeCapability(secret, claims, now);
  assert.deepEqual(await verifyRuntimeCapability(token, secret, required, async () => lease, now), claims);
  for (const override of [
    { owner: { ...owner, userId: 'user-b' } }, { audience: 'different' },
    { operation: 'credential.fill' as const }, { taskId: 'task-b' }, { domain: 'evil.example' },
  ]) await assert.rejects(verifyRuntimeCapability(token, secret, { ...required, ...override }, async () => lease, now));
  for (const override of [{ generation: 3 }, { incarnation: 'replaced' }, { runtimeId: 'replacement' }, { leaseId: 'new-lease' }]) {
    await assert.rejects(verifyRuntimeCapability(token, secret, required, async () => ({ ...lease, ...override }), now));
  }
});

test('tampering, key substitution, expiry, revocation and malformed tokens fail closed', async () => {
  const token = await issueRuntimeCapability(secret, claims, now);
  await assert.rejects(verifyRuntimeCapability(token, new Uint8Array(32).fill(11), required, async () => lease, now));
  await assert.rejects(verifyRuntimeCapability(token, secret, required, async () => lease, now + 60_000));
  await assert.rejects(verifyRuntimeCapability(token, secret, required, async () => lease, now, async () => true));
  const parts = token.split('.');
  const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString()); payload.claims.userId = 'user-b';
  await assert.rejects(verifyRuntimeCapability(Buffer.from(JSON.stringify(payload)).toString('base64url') + '.' + parts[1], secret, required, async () => lease, now));
  for (const invalid of ['', 'x.y.z', '!.!', token + '=', 'a'.repeat(12001)]) await assert.rejects(verifyRuntimeCapability(invalid, secret, required, async () => lease, now));
  await assert.rejects(issueRuntimeCapability(new Uint8Array(8), claims, now));
  await assert.rejects(issueRuntimeCapability(secret, { ...claims, operations: ['bogus'] } as any, now));
});

test('canonical hashes reject lossy/non-JSON state and ignore object insertion order', async () => {
  assert.equal(canonicalJson({ z: 1, a: [true, null, 'x'] }), '{"a":[true,null,"x"],"z":1}');
  assert.equal(await hashJson({ a: 1, b: 2 }), await hashJson({ b: 2, a: 1 }));
  assert.notEqual(await hashJson({ a: 1 }, 'one'), await hashJson({ a: 1 }, 'two'));
  const circular: any = {}; circular.self = circular;
  for (const invalid of [undefined, NaN, Infinity, new Date(), circular, { a: undefined }, new Array(2), { get secret() { throw new Error('must not run'); } }]) assert.throws(() => canonicalJson(invalid));
});

test('owner-bound broker restricts issuance and rechecks transactional authority after verification', async () => {
  let current = lease;
  const broker = createWorkspaceAuthorizationBroker({ owner, audience: 'hygge-state', signingKey: secret, allowedOperations: ['checkpoint.commit', 'credential.fill'], now: () => now,
    readCurrentLease: async () => current, assertCurrent: candidate => { assert.equal(candidate.generation, current.generation); } });
  await assert.rejects(broker.issue(['checkpoint.commit']));
  await assert.rejects(broker.issue(['state.commit'], { taskId: 'task-a' }));
  await assert.rejects(broker.issue(['credential.fill'], { taskId: 'task-a' }));
  const token = await broker.issue(['checkpoint.commit'], { taskId: 'task-a' });
  const authorized = await broker.authorize(token, 'checkpoint.commit', 'task-a');
  current = { ...lease, generation: 3 };
  assert.throws(() => broker.assertCurrent(authorized));
  await assert.rejects(broker.authorize(token, 'checkpoint.commit', 'task-a'));
});

test('verification rechecks time after asynchronous authority reads', async () => {
  let clock = now;
  const token = await issueRuntimeCapability(secret, claims, now);
  await assert.rejects(verifyRuntimeCapability(token, secret, required, async () => {
    clock = now + 60_001; return lease;
  }, () => clock), /LEASE_EXPIRED/);
});

test('anchored issuance cannot silently upgrade an old mission to a replacement runtime',async()=>{
 let reads=0,current=lease;
 const broker=createWorkspaceAuthorizationBroker({owner,audience:'hygge-state',signingKey:secret,allowedOperations:['checkpoint.commit'],now:()=>now,
  readCurrentLease:async()=>{reads++;if(reads===2)current={...lease,generation:3,incarnation:'replacement',leaseId:'replacement-lease'};return current;},assertCurrent:()=>{}});
 await assert.rejects(broker.issue(['checkpoint.commit'],{taskId:'task-a'},lease),/STALE_GENERATION/);
 await assert.rejects(broker.issue(['checkpoint.commit'],{taskId:'task-a'},lease),/STALE_GENERATION/);
});
