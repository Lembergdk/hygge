import { SKILL_POLICY_VERSION, type AttestationIssuer, type AttestationVerifier, type PublicationClaim, type ServiceAuthorization } from './skill-contract.ts';
import type { WorkspaceIdentity } from './workspace-contract.ts';
import { canonicalJson } from './workspace-security.ts';

type Operation = Parameters<ServiceAuthorization['authorize']>[1];
const encoder = new TextEncoder();
function encode(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''); }
function decode(s: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new Error('INVALID_ASSERTION');
  const result = Uint8Array.from(atob(s.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0));
  if (encode(result) !== s) throw new Error('INVALID_ASSERTION'); return result;
}
async function key(bytes: Uint8Array) {
  if (bytes.length < 32) throw new Error('SIGNING_UNAVAILABLE');
  return crypto.subtle.importKey('raw', Uint8Array.from(bytes), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
function codec(secret: Uint8Array, purpose: string) {
  const bytes = Uint8Array.from(secret);
  if (bytes.length < 32) throw new Error('SIGNING_UNAVAILABLE');
  return {
    async seal(claims: unknown): Promise<string> {
      const data = encoder.encode(canonicalJson({ version: 1, purpose, claims }));
      if (data.length > 4096) throw new Error('INVALID_ASSERTION');
      return encode(data) + '.' + encode(new Uint8Array(await crypto.subtle.sign('HMAC', await key(bytes), data)));
    },
    async open(token: string): Promise<unknown | null> {
      try {
        if (typeof token !== 'string' || token.length > 8192) return null;
        const parts = token.split('.'); if (parts.length !== 2) return null;
        const data = decode(parts[0]); const sig = decode(parts[1]);
        if (sig.length !== 32 || !await crypto.subtle.verify('HMAC', await key(bytes), sig, data)) return null;
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
        return value?.version === 1 && value.purpose === purpose && Object.keys(value).sort().join(',') === 'claims,purpose,version' ? value.claims : null;
      } catch { return null; }
    },
  };
}
const opaque = (s: unknown) => typeof s === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(s);
function validClaim(c: PublicationClaim, environment: WorkspaceIdentity['environment'], now: number): boolean {
  const expected = ['audience', 'environment', 'policyVersion', 'capsuleHash', 'distinctSuccessCount', 'tokenId', 'idempotencyKey', 'expiresAt'].sort().join(',');
  return !!c && typeof c === 'object' && Object.keys(c).sort().join(',') === expected && c.audience === 'hygge-skill-publisher' && c.environment === environment &&
    c.policyVersion === SKILL_POLICY_VERSION && /^[a-f0-9]{64}$/.test(c.capsuleHash) && Number.isSafeInteger(c.distinctSuccessCount) && c.distinctSuccessCount >= 3 &&
    opaque(c.tokenId) && opaque(c.idempotencyKey) && Number.isFinite(Date.parse(c.expiresAt)) && Date.parse(c.expiresAt) > now && Date.parse(c.expiresAt) <= now + 60_000;
}
/** Provide issuer ONLY to the private trusted validator, verifier ONLY to shared publisher. No public signing route. */
export function createSkillAttestationBroker(secret: Uint8Array, environment: WorkspaceIdentity['environment'], now = Date.now,
  authorizeIssue?: (claim: Readonly<PublicationClaim>) => Promise<boolean>,
): { issuer: AttestationIssuer; verifier: AttestationVerifier } {
  if (!['staging', 'production'].includes(environment)) throw new Error('INVALID_ENVIRONMENT');
  const signing = codec(secret, 'hygge-skill-publication-v1');
  return {
    issuer: { async issue(claim) {
      const stable = Object.freeze(JSON.parse(canonicalJson(claim)) as PublicationClaim);
      if (!validClaim(stable, environment, now())) throw new Error('INVALID_ASSERTION');
      if (!authorizeIssue || !await authorizeIssue(stable)) throw new Error('UNAUTHORIZED');
      return signing.seal(stable);
    } },
    verifier: { async verify(token) { const value = await signing.open(token) as PublicationClaim; return validClaim(value, environment, now()) ? value : null; } },
  };
}
interface ServiceGrant {
  environment: WorkspaceIdentity['environment']; operation: Operation;
  binding: Readonly<Record<string, unknown>>; expiresAt: string; nonce: string;
}
/** Evidence checker must authenticate a trusted DO/maintainer and verify canonical usage. Absent checker denies issuance. */
export function createSkillServiceBroker(secret: Uint8Array, environment: WorkspaceIdentity['environment'],
  authorizeIssue?: (operation: Operation, binding: Readonly<Record<string, unknown>>) => Promise<boolean>, now = Date.now,
): { issue(operation: Operation, binding: Readonly<Record<string, unknown>>): Promise<string>; authorization: ServiceAuthorization } {
  if (!['staging', 'production'].includes(environment)) throw new Error('INVALID_ENVIRONMENT');
  const signing = codec(secret, 'hygge-skill-service-v1');
  const operations = new Set<Operation>(['publish', 'usage', 'quarantine', 'admit', 'consume']);
  return {
    async issue(operation, binding) {
      // Defensive copy before asynchronous evidence check prevents argument substitution.
      const stable = JSON.parse(canonicalJson(binding)) as Readonly<Record<string, unknown>>;
      if (!operations.has(operation) || !authorizeIssue || !await authorizeIssue(operation, stable)) throw new Error('UNAUTHORIZED');
      const grant: ServiceGrant = { environment, operation, binding: stable, expiresAt: new Date(now() + 30_000).toISOString(), nonce: crypto.randomUUID() };
      return signing.seal(grant);
    },
    authorization: { async authorize(token, operation, binding) {
      const grant = await signing.open(token) as ServiceGrant;
      if (!grant || typeof grant !== 'object' || Object.keys(grant).sort().join(',') !== 'binding,environment,expiresAt,nonce,operation' ||
          grant.environment !== environment || !operations.has(operation) || grant.operation !== operation || !opaque(grant.nonce) ||
          !Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= now() || Date.parse(grant.expiresAt) > now() + 30_000) return false;
      try { return canonicalJson(grant.binding) === canonicalJson(binding); } catch { return false; }
    } },
  };
}
