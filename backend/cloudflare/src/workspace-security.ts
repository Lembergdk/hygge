import type { CapabilityClaims, ContractFailure, RuntimeLease, RuntimeOperation, WorkspaceIdentity } from './workspace-contract.ts';

export class ContractError extends Error {
  readonly code: ContractFailure['code'];
  constructor(code: ContractFailure['code']) { super(code); this.name = 'ContractError'; this.code = code; }
}
const encoder = new TextEncoder();
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200 && !/[\s\x00-\x1f]/.test(v);
export function assertWorkspaceIdentity(value: WorkspaceIdentity): void {
  if (!value || !['staging', 'production'].includes(value.environment) || !id(value.userId) || !id(value.workspaceId)) throw new ContractError('OWNER_MISMATCH');
}
export function sameOwner(a: WorkspaceIdentity, b: WorkspaceIdentity): boolean {
  assertWorkspaceIdentity(a); assertWorkspaceIdentity(b);
  return a.environment === b.environment && a.userId === b.userId && a.workspaceId === b.workspaceId;
}
export function assertLease(owner: WorkspaceIdentity, current: RuntimeLease, candidate: RuntimeLease, now = Date.now()): void {
  if (!Number.isFinite(now)) throw new ContractError('UNAUTHORIZED');
  if (!sameOwner(owner, current) || !sameOwner(owner, candidate)) throw new ContractError('OWNER_MISMATCH');
  if (!Number.isSafeInteger(current.generation) || current.generation < 1 || current.generation !== candidate.generation ||
      current.incarnation !== candidate.incarnation || current.runtimeId !== candidate.runtimeId || current.leaseId !== candidate.leaseId) {
    throw new ContractError('STALE_GENERATION');
  }
  for (const lease of [current, candidate]) {
    if (!id(lease.incarnation) || !id(lease.runtimeId) || !id(lease.leaseId) || !Number.isFinite(Date.parse(lease.expiresAt)) || Date.parse(lease.expiresAt) <= now) throw new ContractError('LEASE_EXPIRED');
  }
}

/** Strict JSON canonicalization: reject lossy values, custom prototypes and cycles. */
export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  function visit(v: unknown, depth: number): string {
    if (depth > 64) throw new ContractError('IDEMPOTENCY_CONFLICT');
    if (v === null) return 'null';
    if (typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
    if (typeof v === 'number' && Number.isFinite(v)) return JSON.stringify(v);
    if (typeof v !== 'object' || !v || seen.has(v)) throw new ContractError('IDEMPOTENCY_CONFLICT');
    if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) throw new ContractError('IDEMPOTENCY_CONFLICT');
    if (Object.getOwnPropertySymbols(v).length) throw new ContractError('IDEMPOTENCY_CONFLICT');
    seen.add(v);
    const descriptors = Object.getOwnPropertyDescriptors(v);
    if (Object.keys(v).some(k => !('value' in descriptors[k]))) throw new ContractError('IDEMPOTENCY_CONFLICT');
    let result: string;
    if (Array.isArray(v)) {
      if (Object.keys(v).length !== v.length) throw new ContractError('IDEMPOTENCY_CONFLICT');
      result = '[' + Array.from(v, item => visit(item, depth + 1)).join(',') + ']';
    } else {
      const keys = Object.keys(v).sort();
      if (keys.some(k => !('value' in descriptors[k]))) throw new ContractError('IDEMPOTENCY_CONFLICT');
      result = '{' + keys.map(k => JSON.stringify(k) + ':' + visit(descriptors[k].value, depth + 1)).join(',') + '}';
    }
    seen.delete(v); return result;
  }
  return visit(value, 0);
}
export async function hashJson(value: unknown, domain = 'hygge-workspace-v1'): Promise<string> {
  if (!domain || domain.includes('\n')) throw new ContractError('IDEMPOTENCY_CONFLICT');
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(domain + '\n' + canonicalJson(value)));
  return [...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, '0')).join('');
}
function encode(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''); }
function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new ContractError('UNAUTHORIZED');
  const result = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)), c => c.charCodeAt(0));
  if (encode(result) !== value) throw new ContractError('UNAUTHORIZED');
  return result;
}
const operations = new Set<RuntimeOperation>(['state.read', 'state.commit', 'workspace.commit', 'checkpoint.commit', 'task.complete', 'action.prepare', 'action.dispatch', 'action.resolve', 'credential.fill', 'emailCode.fill', 'model.invoke', 'skill.read', 'skill.candidate.submit', 'browser.connect']);
function validateClaims(c: CapabilityClaims, now: number): void {
  assertWorkspaceIdentity(c);
  const allowed = new Set(['environment', 'userId', 'workspaceId', 'runtimeId', 'incarnation', 'generation', 'leaseId', 'expiresAt', 'audience', 'operations', 'taskId', 'domain', 'tokenId']);
  if (Object.keys(c).some(k => !allowed.has(k)) || !id(c.audience) || !id(c.tokenId) || !id(c.runtimeId) || !id(c.incarnation) || !id(c.leaseId) ||
      !Number.isSafeInteger(c.generation) || c.generation < 1 || !Array.isArray(c.operations) || c.operations.length === 0 || c.operations.length > operations.size ||
      new Set(c.operations).size !== c.operations.length || c.operations.some(op => !operations.has(op)) ||
      (c.taskId !== undefined && !id(c.taskId)) || (c.domain !== undefined && !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(c.domain))) throw new ContractError('UNAUTHORIZED');
  const expiration = Date.parse(c.expiresAt);
  if (!Number.isFinite(expiration) || expiration <= now || expiration > now + 15 * 60_000) throw new ContractError('LEASE_EXPIRED');
}
async function key(secret: Uint8Array): Promise<CryptoKey> {
  if (secret.length < 32) throw new ContractError('UNAUTHORIZED');
  return crypto.subtle.importKey('raw', Uint8Array.from(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
/** Trusted broker only; never make signing key available to an agent or public caller. */
export async function issueRuntimeCapability(secret: Uint8Array, claims: CapabilityClaims, now = Date.now()): Promise<string> {
  validateClaims(claims, now);
  const payload = encoder.encode(canonicalJson({ version: 1, claims }));
  if (payload.length > 8192) throw new ContractError('UNAUTHORIZED');
  const signed = await crypto.subtle.sign('HMAC', await key(secret), payload);
  return encode(payload) + '.' + encode(new Uint8Array(signed));
}
export interface CapabilityRequirement {
  readonly owner: WorkspaceIdentity;
  readonly audience: string;
  readonly operation: RuntimeOperation;
  readonly taskId?: string;
  readonly domain?: string;
}
/** Re-read live lease after cryptographic verification; mutations must recheck inside their transaction too. */
export async function verifyRuntimeCapability(
  token: string, secret: Uint8Array, required: CapabilityRequirement,
  readCurrentLease: () => Promise<RuntimeLease>, now: number | (() => number) = Date.now,
  isRevoked: (tokenId: string) => Promise<boolean> = async () => false,
): Promise<CapabilityClaims> {
  try {
    const clock = typeof now === 'function' ? now : () => now;
    if (typeof token !== 'string' || token.length > 12000) throw new ContractError('UNAUTHORIZED');
    const pieces = token.split('.'); if (pieces.length !== 2) throw new ContractError('UNAUTHORIZED');
    const payload = decode(pieces[0]); const signature = decode(pieces[1]);
    if (signature.length !== 32 || !await crypto.subtle.verify('HMAC', await key(secret), signature, payload)) throw new ContractError('UNAUTHORIZED');
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
    if (!parsed || parsed.version !== 1 || Object.keys(parsed).sort().join(',') !== 'claims,version') throw new ContractError('UNAUTHORIZED');
    const claims = parsed.claims as CapabilityClaims; validateClaims(claims, clock());
    if (claims.audience !== required.audience || !claims.operations.includes(required.operation) ||
        (required.taskId !== undefined && claims.taskId !== required.taskId) || (required.domain !== undefined && claims.domain !== required.domain) ||
        await isRevoked(claims.tokenId)) throw new ContractError('UNAUTHORIZED');
    const current = await readCurrentLease();
    // Crypto, revocation and storage reads may outlive the token/lease.
    validateClaims(claims, clock());
    assertLease(required.owner, current, claims, clock());
    if (Date.parse(claims.expiresAt) > Date.parse(current.expiresAt)) throw new ContractError('LEASE_EXPIRED');
    return Object.freeze({ ...claims, operations: Object.freeze([...claims.operations]) });
  } catch (error) {
    if (error instanceof ContractError) throw error;
    throw new ContractError('UNAUTHORIZED');
  }
}
