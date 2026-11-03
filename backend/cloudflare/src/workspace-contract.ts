/** Shared private-workspace protocol. Validate all claims and provider evidence at trust boundaries. */
export type Environment = 'staging' | 'production';
export type Revision = number; // validate safe nonnegative integer at runtime
export interface WorkspaceIdentity {
  readonly environment: Environment;
  readonly userId: string;
  readonly workspaceId: string;
}
export interface RuntimeLease extends WorkspaceIdentity {
  readonly runtimeId: string;
  readonly incarnation: string;
  readonly generation: number;
  readonly leaseId: string;
  readonly expiresAt: string;
}
export type RuntimeOperation =
  | 'state.read' | 'state.commit' | 'workspace.commit' | 'checkpoint.commit'
  | 'task.complete' | 'action.prepare' | 'action.dispatch'
  | 'action.resolve' | 'credential.fill' | 'emailCode.fill' | 'model.invoke'
  | 'skill.read' | 'skill.candidate.submit' | 'browser.connect';
/** Claims alone grant nothing: verify signature, audience, expiry and live lineage. */
export interface CapabilityClaims extends RuntimeLease {
  readonly audience: string;
  readonly operations: readonly RuntimeOperation[];
  readonly taskId?: string;
  readonly domain?: string;
  readonly tokenId: string;
}
export interface MutationContext {
  readonly capabilityToken: string;
  readonly requestId: string;
  readonly expectedRevision: Revision;
}
export interface DurableReceipt {
  readonly requestId: string;
  readonly revision: Revision;
  readonly committedAt: string;
}
/** Private committed object manifest; never a public URL or bare native snapshot. */
export interface RecoveryPoint extends WorkspaceIdentity {
  readonly checkpointId: string;
  readonly sequence: Revision;
  readonly sourceIncarnation: string;
  readonly sourceGeneration: number;
  readonly manifestHash: string;
  readonly storage: 'r2' | 'gcs';
  readonly policyVersion: string;
}
/** A local flush or enqueued upload cannot produce this receipt. */
export interface WorkspaceDurabilityReceipt extends WorkspaceIdentity {
  readonly receiptId: string;
  readonly incarnation: string;
  readonly generation: number;
  readonly writeId: string;
  readonly filesystemRevision: Revision;
  readonly browserProfileRevision: Revision; // 0 = no saved profile
  readonly coveredArtifactRefs: readonly string[];
  readonly recoveryPoint: RecoveryPoint;
  readonly committedAt: string;
}
interface FenceBase extends WorkspaceIdentity {
  readonly previousRuntimeId: string;
  readonly previousIncarnation: string;
  readonly previousGeneration: number;
  readonly browserRetired: true;
  readonly verifiedAt: string;
  readonly providerRequestIds: readonly string[];
}
export type RuntimeFenceEvidence =
  | (FenceBase & {
      readonly provider: 'cloudflare';
      readonly providerRuntimeId: string;
      readonly result: 'exact_incarnation_stopped';
    })
  | (FenceBase & {
      readonly provider: 'gcp';
      readonly projectId: string;
      readonly zone: string;
      readonly instanceId: string;
      readonly providerState: 'stopped' | 'deleted';
      readonly volumeId: string;
      readonly attachmentState: 'detached';
    });
export interface Checkpoint extends WorkspaceIdentity {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly runId: string;
  readonly revision: Revision;
  readonly incarnation: string;
  readonly generation: number;
  readonly phase: 'ready' | 'running' | 'needsHuman' | 'uncertain' | 'succeeded' | 'failed';
  readonly nextStep: 'inspect' | 'reconcile' | 'await_user' | 'done';
  readonly filesystemRevision: Revision;
  readonly browserProfileRevision: Revision;
  readonly workspaceDurabilityReceiptId: string;
  readonly lastEffectId?: string;
  readonly privateArtifactRefs: readonly string[];
  readonly helpId: string | null;
  readonly committedAt: string;
}
export type EffectStatus = 'prepared' | 'dispatching' | 'confirmed' | 'not_applied' | 'uncertain';
export interface EffectRecord extends WorkspaceIdentity {
  readonly effectId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly intentHash: string;
  readonly approvalId: string | null;
  readonly approvalScopeHash: string | null;
  readonly incarnation: string;
  readonly generation: number;
  readonly revision: Revision;
  readonly status: EffectStatus;
  readonly privateEvidenceRef?: string;
}
export interface StateCommit {
  readonly context: MutationContext;
  readonly checkpoint: Checkpoint;
}
export type MigrationPhase =
  | 'inventoried' | 'provisioned' | 'copying' | 'verified' | 'quiescing'
  | 'finalizing' | 'ready' | 'active' | 'accepted' | 'rollback_pending'
  | 'legacy_active' | 'recovering' | 'blocked';
export interface MigrationRecord extends WorkspaceIdentity {
  readonly revision: Revision;
  readonly phase: MigrationPhase;
  readonly executionBackend: 'legacy' | 'isolated_sandbox';
  readonly sourceRevision: Revision;
  readonly schemaVersion: number;
  readonly manifestHash: string;
  readonly generation: number;
  readonly targetGeneration: number | null;
  readonly finalSourceRevision: Revision | null;
}
export interface ContractFailure {
  readonly code:
    | 'UNAUTHORIZED' | 'OWNER_MISMATCH' | 'STALE_GENERATION' | 'LEASE_EXPIRED'
    | 'REVISION_CONFLICT' | 'IDEMPOTENCY_CONFLICT' | 'PERSISTENCE_UNAVAILABLE'
    | 'FENCE_UNCONFIRMED' | 'OUTCOME_UNCERTAIN' | 'REAUTH_REQUIRED';
  readonly requestId: string;
}
/** Private DO record; never export owner/evidence identifiers to shared skills. */
export interface RunCompletionReceipt extends WorkspaceIdentity {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly taskId: string;
  readonly incarnation: string;
  readonly generation: number;
  readonly siteOrigin: string;
  readonly outcome: 'signup' | 'update_profile' | 'apply' | 'message' | 'book' | 'discover';
  readonly candidateBodyHash: string | null; // null => ordinary completion, not corroboration
  readonly taskRevision: Revision;
  readonly workspaceDurabilityReceiptId: string;
  readonly status: 'succeeded';
  readonly verification: {
    readonly kind: 'observed_postcondition' | 'reviewed';
    readonly policyVersion: string;
    readonly evidenceRef: string;
  };
  readonly completedAt: string;
  readonly receiptId: string;
}
export type LifecycleState =
  | 'unprovisioned' | 'provisioning' | 'starting' | 'ready'
  | 'quiescing' | 'stopped' | 'fencing' | 'recovering' | 'error' | 'deleting';
interface BindingBase extends WorkspaceIdentity {
  readonly ownerDigest: string;
  readonly schemaVersion: number;
  readonly incarnation: string;
  readonly generation: number;
  readonly runtimeId: string | null;
  readonly providerRuntimeId: string | null; // exact provider instance, not display name
  readonly desiredImageDigest: string;
  readonly leaseExpiresAt: string | null;
  readonly lifecycleState: LifecycleState;
  readonly revision: Revision;
  readonly recoveryPoint: RecoveryPoint | null; // null only before first initialization
  readonly lastVerifiedAt: string;
}
export type WorkspaceBinding =
  | (BindingBase & {
      readonly provider: 'cloudflare';
      readonly namespaceId: string;
      readonly providerWorkspaceId: string;
    })
  | (BindingBase & {
      readonly provider: 'gcp'; // conditional alternative, not provisioning instruction
      readonly projectId: string;
      readonly region: string;
      readonly zone: string;
      readonly volumeId: string;
    });
export type LifecycleRequest =
  | { readonly protocolVersion: 1; readonly op: 'ensure'; readonly owner: WorkspaceIdentity;
      readonly operationId: string; readonly imageDigest: string }
  | { readonly protocolVersion: 1; readonly op: 'heartbeat'; readonly lease: RuntimeLease;
      readonly capabilityToken: string }
  | { readonly protocolVersion: 1; readonly op: 'quiesce'; readonly owner: WorkspaceIdentity;
      readonly operationId: string; readonly expectedGeneration: number }
  | { readonly protocolVersion: 1; readonly op: 'replace'; readonly owner: WorkspaceIdentity;
      readonly operationId: string; readonly expectedGeneration: number; readonly imageDigest: string }
  | { readonly protocolVersion: 1; readonly op: 'status'; readonly owner: WorkspaceIdentity };
export interface LifecycleResult {
  readonly operationId: string;
  readonly status: 'pending' | 'ready' | 'stopped' | 'error';
  readonly lifecycleState: LifecycleState;
  readonly generation: number;
  readonly incarnation: string;
  readonly failure?: ContractFailure;
}
