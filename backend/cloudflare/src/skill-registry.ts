import { SKILL_POLICY_VERSION, type ReviewedSite, type SkillRegistry } from './skill-contract.ts';
import { canonicalJson, createReviewedRegistry, SkillPolicyError } from './skill-policy.ts';

export interface WorkspaceSkillRegistry extends SkillRegistry { siteIdForOrigin(origin: string): string | null }
/** Configuration is supplied by reviewed server deployment, never a public request or model. */
export function loadReviewedSkillRegistry(config?: unknown): WorkspaceSkillRegistry {
  if (config === undefined || config === null || config === '') return { getSite: () => undefined, siteIdForOrigin: () => null };
  const input = typeof config === 'string' ? JSON.parse(config) : structuredClone(config);
  if (new TextEncoder().encode(canonicalJson(input)).length > 65_536 || !input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).sort().join(',') !== 'schemaVersion,sites' || input.schemaVersion !== 1 || !Array.isArray(input.sites)) throw new SkillPolicyError('REGISTRY_CONFIG');
  const origins = new Map<string,string>();
  for (const site of input.sites as ReviewedSite[]) {
    if (!site || Object.keys(site).sort().join(',') !== 'controls,fieldSets,origin,pitfalls,review,routes,siteId'
        || !site.review || Object.keys(site.review).sort().join(',') !== 'policyVersion,reviewedRevision,source'
        || site.review.policyVersion !== SKILL_POLICY_VERSION || origins.has(site.origin)) throw new SkillPolicyError('REGISTRY_CONFIG');
    origins.set(site.origin, site.siteId);
  }
  const registry = createReviewedRegistry(input.sites);
  return { getSite: id => registry.getSite(id), siteIdForOrigin: origin => origins.get(origin) ?? null };
}
