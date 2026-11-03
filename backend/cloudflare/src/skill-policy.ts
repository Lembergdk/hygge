import { PARAM_REFS, SKILL_OUTCOMES_V2, SKILL_POLICY_VERSION, type SharedSkillBodyV2, type SkillRegistry, type ReviewedSite } from './skill-contract.ts';

export class SkillPolicyError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; this.name = 'SkillPolicyError'; }
}
export const MAX_PUBLIC_SKILL_BYTES = 16_384;
function fail(code: string): never { throw new SkillPolicyError(code); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail('SCHEMA_OBJECT');
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) {
  if (Object.keys(value).some(k => !required.includes(k) && !optional.includes(k)) || required.some(k => !Object.hasOwn(value, k))) fail('SCHEMA_KEYS');
}
export function opaqueId(v: unknown): string {
  if (typeof v !== 'string' || !/^[a-zA-Z0-9_-]{1,96}$/.test(v)) fail('INVALID_ID');
  return v;
}
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v === 'boolean') return JSON.stringify(v);
  if (typeof v === 'string') {
    // Reject isolated UTF-16 surrogates rather than hashing silently replaced bytes.
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v)) fail('INVALID_UNICODE');
    return JSON.stringify(v);
  }
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const r = record(v);
  return `{${Object.keys(r).sort().map(k => `${canonicalJson(k)}:${canonicalJson(r[k])}`).join(',')}}`;
}
export async function skillDigest(value: unknown, domain = 'hygge:shared-skill:v2'): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${domain}\n${canonicalJson(value)}`));
  return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
}
export function validateReviewedSite(site: ReviewedSite): void {
  opaqueId(site.siteId);
  const u = new URL(site.origin);
  if (u.protocol !== 'https:' || u.origin !== site.origin || u.username || u.password || u.port || u.hostname.includes('%')
      || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(u.hostname)
      || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(u.hostname)) fail('UNSAFE_ORIGIN');
  if (!site.review || site.review.policyVersion !== SKILL_POLICY_VERSION || !site.review.reviewedRevision
      || !['developer_review', 'independent_public_evidence'].includes(site.review.source)) fail('REGISTRY_UNREVIEWED');
  for (const [id, path] of Object.entries(site.routes)) {
    opaqueId(id);
    // Public paths are reviewed constants, not observed authenticated URLs. No encoded segments, query or fragments.
    if (!/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]*\/?$/.test(path)) fail('UNSAFE_ROUTE');
  }
  for (const ids of [site.controls, site.fieldSets, site.pitfalls]) {
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length) fail('REGISTRY_INVALID');
    ids.forEach(opaqueId);
  }
}
export function createReviewedRegistry(sites: readonly ReviewedSite[]): SkillRegistry {
  const values = new Map<string, ReviewedSite>();
  for (const source of sites) {
    const site = structuredClone(source); validateReviewedSite(site);
    if (values.has(site.siteId)) fail('REGISTRY_DUPLICATE');
    values.set(site.siteId, site);
  }
  return { getSite: id => { const s = values.get(id); return s ? structuredClone(s) : undefined; } };
}
export function validateSkillBody(input: unknown, registry: SkillRegistry, privateKnownValues: readonly string[] = []): SharedSkillBodyV2 {
  // The raw input must be JSON data. Size before interpretation includes unknown fields.
  if (new TextEncoder().encode(canonicalJson(input)).length > MAX_PUBLIC_SKILL_BYTES) fail('BODY_TOO_LARGE');
  const v = record(input); exact(v, ['schemaVersion', 'siteId', 'outcome', 'steps', 'pitfalls']);
  if (v.schemaVersion !== 2 || !SKILL_OUTCOMES_V2.includes(v.outcome as any)) fail('SCHEMA_VERSION_OUTCOME');
  const site = registry.getSite(opaqueId(v.siteId)); if (!site) fail('UNKNOWN_SITE');
  validateReviewedSite(site);
  if (!Array.isArray(v.steps) || !v.steps.length || v.steps.length > 12 || !Array.isArray(v.pitfalls) || v.pitfalls.length > 6) fail('STEP_LIMIT');
  for (const value of v.steps) {
    const s = record(value);
    switch (s.op) {
      case 'navigate': exact(s, ['op', 'routeId']); if (!Object.hasOwn(site.routes, opaqueId(s.routeId))) fail('UNKNOWN_ROUTE'); break;
      case 'inspect': case 'click': exact(s, ['op', 'controlId']); if (!site.controls.includes(opaqueId(s.controlId))) fail('UNKNOWN_CONTROL'); break;
      case 'fill': case 'upload':
        exact(s, ['op', 'controlId', 'valueRef']);
        if (!site.controls.includes(opaqueId(s.controlId))) fail('UNKNOWN_CONTROL');
        if (!(PARAM_REFS as readonly unknown[]).includes(s.valueRef) || (s.op === 'upload' && s.valueRef !== 'application.resume')) fail('UNSAFE_VALUE_REF');
        break;
      case 'extract': exact(s, ['op', 'fieldSetId']); if (!site.fieldSets.includes(opaqueId(s.fieldSetId))) fail('UNKNOWN_FIELD_SET'); break;
      case 'checkpoint': exact(s, ['op', 'kind']); if (typeof s.kind !== 'string' || !['captcha', 'mfa', 'identity', 'payment'].includes(s.kind)) fail('UNKNOWN_CHECKPOINT'); break;
      case 'complete': exact(s, ['op', 'outcome']); if (s.outcome !== v.outcome) fail('OUTCOME_MISMATCH'); break;
      default: fail('UNKNOWN_OPERATION');
    }
  }
  for (const value of v.pitfalls) {
    const p = record(value); exact(p, ['code'], ['controlId']);
    if (!site.pitfalls.includes(opaqueId(p.code))) fail('UNKNOWN_PITFALL');
    if (p.controlId !== undefined && !site.controls.includes(opaqueId(p.controlId))) fail('UNKNOWN_CONTROL');
  }
  const body = structuredClone(v) as unknown as SharedSkillBodyV2;
  // Secondary private check, including short original values. Structured registry validation is primary.
  const clean = canonicalJson(body).normalize('NFKC').toLowerCase();
  if (privateKnownValues.some(x => x.trim() && clean.includes(x.trim().normalize('NFKC').toLowerCase()))) fail('PRIVATE_VALUE');
  return body;
}
