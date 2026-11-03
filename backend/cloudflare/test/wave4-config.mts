import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {loadReviewedSkillRegistry} from '../src/skill-registry.ts';
import {reviewedCompletionRules} from '../src/workspace-postconditions.ts';
const registryRaw=readFileSync(new URL('../config/skill-registry.wave4.json',import.meta.url),'utf8');
const postconditionsRaw=readFileSync(new URL('../config/postconditions.wave4.json',import.meta.url),'utf8');
test('wave4 reviewed artifacts load under current policy and agree on origin',()=>{
 const registry=loadReviewedSkillRegistry(JSON.parse(registryRaw));
 const config=JSON.parse(registryRaw);const origin=config.sites[0].origin;
 assert.equal(registry.siteIdForOrigin(origin),'wave4-jobs');
 assert.ok(registry.getSite('wave4-jobs'));
 const rules=reviewedCompletionRules(postconditionsRaw);
 assert.equal(rules.length,1);assert.equal(rules[0].origin,origin);assert.equal(rules[0].outcome,'apply');
});
