import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedicatedHyggeProject, assertHyggeGoogleResource, assertHyggeResourceProject, assertHyggeServiceAccount, assertHyggeProjectPlacement } from '../src/workspace-project-policy.ts';

const input = { projectId: 'hygge-isolated-test', projectNumber: '123456789012', organizationId: '1234567890', billingAccountId: '012ABC-345DEF-678ABC', getBobProjectIds: ['getbob-production', 'getbob-staging'], getBobProjectNumbers: ['999999999999'] };
test('Google project selection is explicit, dedicated and disjoint from Get BOB projects', () => {
  const policy = dedicatedHyggeProject(input);
  assert.equal(policy.projectId, input.projectId);
  assert.throws(() => dedicatedHyggeProject({ ...input, projectId: 'getbob-production' }));
  assert.throws(() => dedicatedHyggeProject({ ...input, getBobProjectIds: [input.projectId] }));
  assert.throws(() => dedicatedHyggeProject({ ...input, getBobProjectNumbers: [input.projectNumber] }));
  assert.throws(() => dedicatedHyggeProject({ ...input, getBobProjectIds: [] }));
  assert.throws(() => dedicatedHyggeProject(undefined as any));
  assert.throws(() => dedicatedHyggeProject({ ...input, projectId: '' }));
  assertHyggeResourceProject(policy, input);
  assert.throws(() => assertHyggeResourceProject(policy, { projectId: input.projectId, projectNumber: '999999999999' }));
});
test('dedicated Hygge project belongs to Get BOB organization and uses its intended billing account', () => {
  const policy = dedicatedHyggeProject(input);
  assertHyggeProjectPlacement(policy, input);
  assert.throws(() => assertHyggeProjectPlacement(policy, { ...input, organizationId: '9876543210' }));
  assert.throws(() => assertHyggeProjectPlacement(policy, { ...input, billingAccountId: 'FEDCBA-987654-321FED' }));
  assert.throws(() => dedicatedHyggeProject({ ...input, organizationId: '' }));
  assert.throws(() => dedicatedHyggeProject({ ...input, billingAccountId: '' }));
});
test('resource and service identities cannot cross the dedicated project boundary', () => {
  const policy = dedicatedHyggeProject(input);
  assertHyggeGoogleResource(policy, 'projects/hygge-isolated-test/zones/example-a/disks/workspace-a');
  assertHyggeGoogleResource(policy, 'https://compute.googleapis.com/compute/v1/projects/hygge-isolated-test/zones/example-a/instances/runtime-a');
  assertHyggeServiceAccount(policy, 'runtime-control@hygge-isolated-test.iam.gserviceaccount.com');
  for (const resource of [
    'projects/getbob-production/global/networks/default', 'projects/999999999999/zones/example-a/disks/x',
    'projects/hygge-isolated-test/../getbob-production/disks/x', 'projects/hygge-isolated-test/zones/x/projects/other/disks/x',
    'https://evil.example/v1/projects/hygge-isolated-test/disks/x', 'projects/hygge-isolated-test/disks/x%2fother',
  ]) assert.throws(() => assertHyggeGoogleResource(policy, resource));
  assert.throws(() => assertHyggeServiceAccount(policy, 'runtime@getbob-production.iam.gserviceaccount.com'));
  assert.throws(() => assertHyggeServiceAccount(policy, 'runtime@evil@hygge-isolated-test.iam.gserviceaccount.com'));
});
