import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReviewedRegistry, validateSkillBody, canonicalJson, skillDigest } from '../src/skill-policy.ts';
import { SKILL_POLICY_VERSION } from '../src/skill-contract.ts';

export const site = { siteId: 'jobs', origin: 'https://jobs.example.com', routes: { home: '/', search: '/jobs/search' },
  controls: ['search', 'apply', 'email'], fieldSets: ['listings'], pitfalls: ['human-checkpoint'],
  review: { policyVersion: SKILL_POLICY_VERSION, reviewedRevision: 'fixture-reviewed-1', source: 'developer_review' as const } };
export const registry = createReviewedRegistry([site]);
export const body = { schemaVersion: 2 as const, siteId: 'jobs', outcome: 'discover' as const,
  steps: [{ op: 'navigate' as const, routeId: 'search' }, { op: 'fill' as const, controlId: 'search', valueRef: 'search.terms' as const },
    { op: 'extract' as const, fieldSetId: 'listings' }, { op: 'complete' as const, outcome: 'discover' as const }], pitfalls: [] };

test('V2 accepts reviewed generic guidance and private parameter references only', () => {
  assert.deepEqual(validateSkillBody(body, registry), body);
  const copy = registry.getSite('jobs')!; copy.controls.push?.('private') as never;
  assert.equal(registry.getSite('jobs')!.controls.includes('private'), false);
});
test('V2 rejects free prose, personalized/encoded IDs and unknown metadata throughout the body', () => {
  for (const dirty of [
    { ...body, notes: 'Personal details' }, { ...body, userId: 'private' }, { ...body, siteId: 'https://jobs.example.com/me?code=short' },
    { ...body, steps: [{ op: 'navigate', routeId: '/candidates/Ada?invite=abc' }] },
    { ...body, steps: [{ op: 'navigate', routeId: '%2faccount%2fAda' }] },
    { ...body, steps: [{ op: 'inspect', controlId: 'Ada' }] },
    { ...body, steps: [{ op: 'inspect', controlId: 'search', label: 'Ada' }] },
    { ...body, steps: [{ op: 'fill', controlId: 'email', valueRef: 'profile.email', value: 'private' }] },
    { ...body, steps: [{ op: 'fill', controlId: 'email', valueRef: 'profile.rawSecret' }] },
    { ...body, steps: [{ op: 'script', source: 'unsafe' }] },
    { ...body, pitfalls: [{ code: 'human-checkpoint', notes: 'personal' }] },
    { ...body, steps: [{ op: 'complete', outcome: 'apply' }] },
    { ...body, steps: [{ op: 'checkpoint', kind: ['captcha'] }] },
    { ...body, steps: [{ op: 'checkpoint', kind: { toString: () => 'captcha' } }] },
  ]) assert.throws(() => validateSkillBody(dirty, registry));
});
test('schema rejects oversized UTF8, unpaired unicode, nested values and unknown registry entries', () => {
  assert.throws(() => validateSkillBody({ ...body, notes: '💡'.repeat(5000) }, registry), /BODY_TOO_LARGE/);
  assert.throws(() => validateSkillBody({ ...body, siteId: '\ud800' }, registry), /INVALID_UNICODE/);
  assert.throws(() => validateSkillBody({ ...body, siteId: { jobs: true } }, registry));
  assert.throws(() => validateSkillBody(body, registry, ['SEARCH']), /PRIVATE_VALUE/);
  assert.throws(() => validateSkillBody(body, registry, ['ſearch']), /PRIVATE_VALUE/);
});
test('registry rejects unreviewed or personalized URL syntax and never learns from a request', () => {
  for (const origin of ['http://jobs.example.com', 'https://jobs.example.com/account', 'https://u:p@jobs.example.com', 'https://127.0.0.1', 'https://jobs.example.com:8443']) {
    assert.throws(() => createReviewedRegistry([{ ...site, origin }]));
  }
  for (const path of ['/account?code=x', '/person/Ada#private', '/%41da', '//evil.com', '/foo/../bar']) {
    assert.throws(() => createReviewedRegistry([{ ...site, routes: { home: path } }]));
  }
  assert.throws(() => createReviewedRegistry([{ ...site, review: { ...site.review, policyVersion: 'old' } }]));
});
test('canonical hashing is key-order stable, domain separated and rejects non-JSON values', async () => {
  assert.equal(await skillDigest(body), await skillDigest({ pitfalls: [], steps: body.steps, outcome: 'discover', siteId: 'jobs', schemaVersion: 2 }));
  assert.notEqual(await skillDigest(body), await skillDigest(body, 'other-domain'));
  for (const value of [NaN, Infinity, -1, undefined, new Date(), { x: undefined }]) assert.throws(() => canonicalJson(value));
});
