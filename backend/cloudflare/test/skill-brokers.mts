import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSkillAttestationBroker, createSkillServiceBroker } from '../src/skill-brokers.ts';
import { SKILL_POLICY_VERSION, type PublicationClaim } from '../src/skill-contract.ts';

const start = Date.parse('2026-11-02T12:00:00Z');
const secret = new Uint8Array(32).fill(91);
const claim: PublicationClaim = { audience: 'hygge-skill-publisher', environment: 'staging', policyVersion: SKILL_POLICY_VERSION,
  capsuleHash: 'a'.repeat(64), distinctSuccessCount: 3, tokenId: 'token-a', idempotencyKey: 'publication-a', expiresAt: new Date(start + 60_000).toISOString() };
test('private publication attestation rejects forgery, cross-environment, unknown personal fields and expiry', async () => {
  let now = start; const broker = createSkillAttestationBroker(secret, 'staging', () => now, async () => true);
  await assert.rejects(createSkillAttestationBroker(secret, 'staging', () => now).issuer.issue(claim));
  const token = await broker.issuer.issue(claim);
  assert.deepEqual(await broker.verifier.verify(token), claim);
  assert.equal(await createSkillAttestationBroker(secret, 'production', () => now).verifier.verify(token), null);
  assert.equal(await createSkillAttestationBroker(new Uint8Array(32).fill(92), 'staging', () => now).verifier.verify(token), null);
  await assert.rejects(broker.issuer.issue({ ...claim, userId: 'private-user' } as any));
  await assert.rejects(broker.issuer.issue({ ...claim, distinctSuccessCount: 2 }));
  assert.equal(await broker.verifier.verify(token + 'tamper'), null);
  now += 60_000; assert.equal(await broker.verifier.verify(token), null);
});
test('shared-service authorization requires evidence and exact operation binding; runtime capabilities are not service grants', async () => {
  let now = start;
  const binding = { usageId: 'usage-a', skillId: 'skill-a', succeeded: true, implicated: false };
  const broker = createSkillServiceBroker(secret, 'staging', async (operation, args) => operation === 'usage' && args.usageId === 'usage-a', () => now);
  await assert.rejects(createSkillServiceBroker(secret, 'staging', undefined, () => now).issue('usage', binding));
  const token = await broker.issue('usage', binding);
  assert.equal(await broker.authorization.authorize(token, 'usage', binding), true);
  assert.equal(await broker.authorization.authorize(token, 'usage', { ...binding, succeeded: false }), false);
  assert.equal(await broker.authorization.authorize(token, 'quarantine', binding), false);
  assert.equal(await createSkillServiceBroker(secret, 'production', undefined, () => now).authorization.authorize(token, 'usage', binding), false);
  assert.equal(await createSkillAttestationBroker(secret, 'staging', () => now).verifier.verify(token), null);
  now += 30_000; assert.equal(await broker.authorization.authorize(token, 'usage', binding), false);
});
