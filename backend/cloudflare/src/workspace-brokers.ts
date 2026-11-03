import type { RuntimeLease, RuntimeOperation, WorkspaceIdentity } from './workspace-contract.ts';
import { ContractError, assertLease, assertWorkspaceIdentity, issueRuntimeCapability, verifyRuntimeCapability } from './workspace-security.ts';

export interface WorkspaceAuthorizationConfig {
  readonly owner: WorkspaceIdentity;
  readonly audience: string;
  readonly allowedOperations: readonly RuntimeOperation[];
  readonly signingKey: Uint8Array;
  readonly readCurrentLease: () => Promise<RuntimeLease>;
  /** Must read the authoritative registry inside the caller's synchronous DO transaction. */
  readonly assertCurrent: (lease: RuntimeLease) => void;
  readonly isRevoked?: (tokenId: string) => Promise<boolean>;
  readonly now?: () => number;
}
const taskOperations = new Set<RuntimeOperation>(['checkpoint.commit', 'task.complete', 'action.prepare', 'action.dispatch', 'action.resolve', 'credential.fill', 'emailCode.fill', 'browser.connect']);
/** Internal owner-bound broker. No route is registered; secrets never enter an execution guest. */
export function createWorkspaceAuthorizationBroker(config: WorkspaceAuthorizationConfig) {
  assertWorkspaceIdentity(config.owner);
  if (!config.audience || config.signingKey.length < 32 || config.allowedOperations.length === 0 || typeof config.assertCurrent !== 'function') throw new ContractError('UNAUTHORIZED');
  const owner = Object.freeze({ ...config.owner });
  const secret = Uint8Array.from(config.signingKey);
  const allowed = new Set(config.allowedOperations);
  const now = config.now ?? Date.now;
  return {
    /** Only call after trusted code has resolved access/consent; never accept requested scopes from a model. */
    async issue(operations: readonly RuntimeOperation[], scope: { taskId?: string; domain?: string } = {}, expectedLineage?: RuntimeLease) {
      const expected=expectedLineage ? Object.freeze({...expectedLineage}) : undefined;
      if (operations.some(op => !allowed.has(op) || (taskOperations.has(op) && !scope.taskId) || ((op === 'credential.fill' || op === 'emailCode.fill') && !scope.domain))) throw new ContractError('UNAUTHORIZED');
      const lease = await config.readCurrentLease();
      const anchored=(current:RuntimeLease)=>{
        if(expected && (expected.environment!==current.environment || expected.userId!==current.userId || expected.workspaceId!==current.workspaceId
          || expected.runtimeId!==current.runtimeId || expected.incarnation!==current.incarnation || expected.generation!==current.generation || expected.leaseId!==current.leaseId))throw new ContractError('STALE_GENERATION');
      };
      anchored(lease);
      assertLease(owner, lease, lease, now());
      config.assertCurrent(lease);
      const expiresAt = new Date(Math.min(Date.parse(lease.expiresAt), now() + 5 * 60_000)).toISOString();
      const token=await issueRuntimeCapability(secret, { ...lease, expiresAt, audience: config.audience, operations: [...operations], ...scope, tokenId: crypto.randomUUID() }, now());
      const current=await config.readCurrentLease();
      anchored(current);assertLease(owner,current,lease,now());config.assertCurrent(lease);
      return token;
    },
    async authorize(token: string, operation: RuntimeOperation, taskId?: string, domain?: string): Promise<RuntimeLease> {
      if (!allowed.has(operation) || (taskOperations.has(operation) && !taskId) || ((operation === 'credential.fill' || operation === 'emailCode.fill') && !domain)) throw new ContractError('UNAUTHORIZED');
      const claims = await verifyRuntimeCapability(token, secret, { owner, audience: config.audience, operation, ...(taskId ? { taskId } : {}), ...(domain ? { domain } : {}) }, config.readCurrentLease, now, config.isRevoked);
      assertLease(owner, claims, claims, now());
      config.assertCurrent(claims);
      return { environment: claims.environment, userId: claims.userId, workspaceId: claims.workspaceId, runtimeId: claims.runtimeId, incarnation: claims.incarnation, generation: claims.generation, leaseId: claims.leaseId, expiresAt: claims.expiresAt };
    },
    assertCurrent(lease: RuntimeLease) { assertLease(owner, lease, lease, now()); config.assertCurrent(lease); },
  };
}
