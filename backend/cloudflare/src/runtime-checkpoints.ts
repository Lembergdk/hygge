import type { Checkpoint, MutationContext, RunCompletionReceipt, RuntimeLease, WorkspaceDurabilityReceipt, WorkspaceIdentity } from './workspace-contract.ts';
import { WorkspacePersistence, canonical, fail, nonempty, revision, sameOwner, type RuntimeAuthority } from './workspace-persistence.ts';
import type { EffectLedger } from './effect-ledger.ts';

export interface RunDefinition {
  taskId: string; runId: string; siteOrigin: string; outcome: RunCompletionReceipt['outcome'];
  candidate: { kind: 'ordinary' } | { kind: 'authoring' } | { kind: 'confirming'; bodyHash: string };
}
export interface CanonicalRun extends RunDefinition { revision: number; completed: boolean; completionReceiptId: string | null }
export type DurabilityVerifier = (owner: WorkspaceIdentity, receiptId: string) => Promise<WorkspaceDurabilityReceipt>;
export interface CompletionInput {
  runId: string;
  checkpoint: Omit<Checkpoint, 'revision' | 'committedAt' | 'phase' | 'nextStep' | 'generation' | 'incarnation'>;
  candidateBodyHash: string | null;
  verification: RunCompletionReceipt['verification'];
}
export interface CompletionReader {
  getCanonicalRunReceipt(owner: WorkspaceIdentity, receiptId: string): Promise<RunCompletionReceipt | null>;
  verifyDurabilityCoverage(owner: WorkspaceIdentity, receipt: RunCompletionReceipt, refs: readonly string[]): Promise<boolean>;
}
function hash(value: string | null): void { if (value !== null && !/^[a-f0-9]{64}$/.test(value)) fail('INVALID_HASH'); }
function origin(value: string): void {
  let u: URL; try { u = new URL(value); } catch { return fail('INVALID_ORIGIN'); }
  if (u.protocol !== 'https:' || u.origin !== value || u.username || u.password) fail('INVALID_ORIGIN');
}
function validateCheckpoint(checkpoint: CompletionInput['checkpoint'] | Checkpoint): void {
  if(checkpoint.schemaVersion!==1) fail('INVALID_CHECKPOINT');
  [checkpoint.taskId,checkpoint.runId,checkpoint.workspaceDurabilityReceiptId].forEach(nonempty);
  revision(checkpoint.filesystemRevision);revision(checkpoint.browserProfileRevision);
  if(!Array.isArray(checkpoint.privateArtifactRefs)) fail('INVALID_CHECKPOINT');
  checkpoint.privateArtifactRefs.forEach(nonempty);
}
function assertCoverage(owner: WorkspaceIdentity, receipt: WorkspaceDurabilityReceipt, checkpoint: CompletionInput['checkpoint'] | Checkpoint, lease?: RuntimeLease): void {
  if (!sameOwner(owner, receipt) || !sameOwner(owner, receipt.recoveryPoint) || !sameOwner(owner, checkpoint)) fail('OWNER_MISMATCH');
  if (lease && (receipt.generation !== lease.generation || receipt.incarnation !== lease.incarnation)) fail('STALE_GENERATION');
  if (receipt.filesystemRevision !== checkpoint.filesystemRevision || receipt.browserProfileRevision !== checkpoint.browserProfileRevision || receipt.receiptId !== checkpoint.workspaceDurabilityReceiptId || checkpoint.privateArtifactRefs.some(r => !receipt.coveredArtifactRefs.includes(r))) fail('DURABILITY_COVERAGE_MISSING');
}
/** A private DO execution ledger. Existing task/UI projection wiring belongs to Wave 2. */
export class CheckpointService implements CompletionReader {
  readonly db:WorkspacePersistence; readonly authority:RuntimeAuthority; readonly effects:EffectLedger;
  readonly verifyDurability:DurabilityVerifier; readonly verifyCompletion:(run:CanonicalRun,input:CompletionInput)=>Promise<boolean>; readonly now:()=>string;
  constructor(db: WorkspacePersistence, authority: RuntimeAuthority, effects: EffectLedger,
    verifyDurability: DurabilityVerifier,
    verifyCompletion: (run: CanonicalRun, input: CompletionInput) => Promise<boolean>,
    now: () => string = () => new Date().toISOString()) { this.db=db;this.authority=authority;this.effects=effects;this.verifyDurability=verifyDurability;this.verifyCompletion=verifyCompletion;this.now=now; }
  async startRun(context: MutationContext, definition: RunDefinition): Promise<CanonicalRun> {
    nonempty(definition.runId); nonempty(definition.taskId); origin(definition.siteOrigin);
    if (!['signup', 'update_profile', 'apply', 'message', 'book', 'discover'].includes(definition.outcome)) fail('INVALID_OUTCOME');
    if (!['ordinary', 'authoring', 'confirming'].includes(definition.candidate.kind)) fail('INVALID_CANDIDATE_MODE');
    if (definition.candidate.kind === 'confirming') hash(definition.candidate.bodyHash);
    return this.db.authorized(this.authority, 'checkpoint.commit', definition.taskId, context, definition, () => {
      if (context.expectedRevision !== 0 || this.db.get('run', definition.runId)) fail('REVISION_CONFLICT');
      const task = this.db.get<{activeRunId:string; status:string}>('runtime_task', definition.taskId);
      if (task?.value.status === 'succeeded') fail('TASK_COMPLETE');
      if (task && task.value.activeRunId !== definition.runId) fail('RUN_ALREADY_ACTIVE');
      const run: CanonicalRun = { ...definition, revision: 1, completed: false, completionReceiptId: null };
      this.db.put('run', definition.runId, 0, run);
      this.db.put('runtime_task', definition.taskId, task?.revision ?? 0, { activeRunId: definition.runId, status: 'running' });
      return run;
    });
  }
  async commit(context: MutationContext, checkpoint: Omit<Checkpoint, 'revision' | 'committedAt' | 'generation' | 'incarnation'>): Promise<Checkpoint> {
    validateCheckpoint(checkpoint);
    if(!['ready','running','needsHuman','uncertain','failed','succeeded'].includes(checkpoint.phase) || !['inspect','reconcile','await_user','done'].includes(checkpoint.nextStep)) fail('INVALID_CHECKPOINT');
    if (checkpoint.phase === 'succeeded' || checkpoint.phase === 'failed' || checkpoint.nextStep === 'done') fail('USE_CANONICAL_COMPLETION');
    const replay = await this.db.authorizedReplay<Checkpoint>(this.authority, 'checkpoint.commit', checkpoint.taskId, context, checkpoint);
    if (replay.found) return replay.result;
    const receipt = await this.verifyDurability(this.db.owner, checkpoint.workspaceDurabilityReceiptId);
    return this.db.authorized(this.authority, 'checkpoint.commit', checkpoint.taskId, context, checkpoint, lease => {
      this.activeRun(checkpoint.runId, checkpoint.taskId);
      assertCoverage(this.db.owner, receipt, checkpoint, lease);
      const saved: Checkpoint = { ...checkpoint, generation: lease.generation, incarnation: lease.incarnation, revision: context.expectedRevision + 1, committedAt: this.now() };
      this.db.put('checkpoint', checkpoint.runId, context.expectedRevision, saved);
      return saved;
    });
  }
  async complete(context: MutationContext, input: CompletionInput, projectCommitted?: (receipt: RunCompletionReceipt) => void): Promise<RunCompletionReceipt> {
    validateCheckpoint(input.checkpoint);
    hash(input.candidateBodyHash); nonempty(input.verification.policyVersion); nonempty(input.verification.evidenceRef);
    if (!['observed_postcondition','reviewed'].includes(input.verification.kind)) fail('UNVERIFIED_COMPLETION');
    const initial = this.db.get<CanonicalRun>('run', input.runId)?.value ?? fail('UNKNOWN_RUN');
    if (input.checkpoint.runId !== input.runId || input.checkpoint.taskId !== initial.taskId) fail('RUN_MISMATCH');
    const replay = await this.db.authorizedReplay<RunCompletionReceipt>(this.authority, 'task.complete', initial.taskId, context, input);
    if (replay.found) return replay.result;
    const receipt = await this.verifyDurability(this.db.owner, input.checkpoint.workspaceDurabilityReceiptId);
    if (!await this.verifyCompletion(initial, input)) fail('UNVERIFIED_COMPLETION');
    return this.db.authorized(this.authority, 'task.complete', initial.taskId, context, input, lease => {
      const run = this.activeRun(input.runId, initial.taskId);
      assertCoverage(this.db.owner, receipt, input.checkpoint, lease);
      if (!receipt.coveredArtifactRefs.includes(input.verification.evidenceRef)) fail('EVIDENCE_NOT_DURABLE');
      if (this.effects.unresolved(run.runId)) fail('OUTCOME_UNCERTAIN');
      if (run.candidate.kind === 'ordinary' && input.candidateBodyHash !== null) fail('CANDIDATE_MISMATCH');
      if (run.candidate.kind === 'confirming' && run.candidate.bodyHash !== input.candidateBodyHash) fail('CANDIDATE_MISMATCH');
      if (run.candidate.kind === 'authoring' && input.candidateBodyHash === null) fail('CANDIDATE_MISMATCH');
      const task = this.db.get<{activeRunId:string;status:string}>('runtime_task', run.taskId) ?? fail('UNKNOWN_TASK');
      if (task.revision !== context.expectedRevision) fail('REVISION_CONFLICT');
      const committedAt = this.now();
      const result: RunCompletionReceipt = { ...this.db.owner, schemaVersion: 1, receiptId: crypto.randomUUID(), runId: run.runId, taskId: run.taskId,
        generation: lease.generation, incarnation: lease.incarnation, siteOrigin: run.siteOrigin, outcome: run.outcome,
        candidateBodyHash: input.candidateBodyHash, taskRevision: task.revision + 1, workspaceDurabilityReceiptId: receipt.receiptId,
        status: 'succeeded', verification: input.verification, completedAt: committedAt };
      const priorCheckpoint = this.db.get<Checkpoint>('checkpoint', run.runId);
      this.db.put('checkpoint', run.runId, priorCheckpoint?.revision ?? 0, { ...input.checkpoint, revision: (priorCheckpoint?.revision ?? 0) + 1, phase:'succeeded', nextStep:'done', incarnation:lease.incarnation, generation:lease.generation, committedAt });
      this.db.put('run', run.runId, run.revision, { ...run, revision: run.revision + 1, completed: true, completionReceiptId: result.receiptId });
      this.db.put('runtime_task', run.taskId, task.revision, { ...task.value, status: 'succeeded', completionReceiptId: result.receiptId });
      this.db.put('completion', result.receiptId, 0, result);
      this.db.put('completion_dependencies', result.receiptId, 0, { filesystemRevision: receipt.filesystemRevision, browserProfileRevision: receipt.browserProfileRevision, refs:[...input.checkpoint.privateArtifactRefs, input.verification.evidenceRef] });
      this.db.put('outbox', result.receiptId, 0, { kind:'task.completed', taskId:run.taskId, receiptId:result.receiptId });
      projectCommitted?.(result);
      return result;
    });
  }
  private activeRun(runId: string, taskId: string): CanonicalRun {
    const run = this.db.get<CanonicalRun>('run', runId)?.value ?? fail('UNKNOWN_RUN');
    const task = this.db.get<{activeRunId:string;status:string}>('runtime_task', taskId)?.value;
    if (run.taskId !== taskId || run.completed || task?.activeRunId !== runId || task.status !== 'running') fail('RUN_UNAVAILABLE');
    return run;
  }
  async getCanonicalRunReceipt(owner: WorkspaceIdentity, receiptId: string): Promise<RunCompletionReceipt | null> {
    if (!sameOwner(this.db.owner, owner)) fail('OWNER_MISMATCH');
    return this.db.get<RunCompletionReceipt>('completion', receiptId)?.value ?? null;
  }
  getCompletion(owner: WorkspaceIdentity, receiptId: string): Promise<RunCompletionReceipt | null> { return this.getCanonicalRunReceipt(owner, receiptId); }
  async verifyDurabilityCoverage(owner: WorkspaceIdentity, receipt: RunCompletionReceipt, requiredArtifactRefs: readonly string[]): Promise<boolean> {
    try {
      const saved = await this.getCanonicalRunReceipt(owner, receipt.receiptId);
      if (!saved || canonical(saved) !== canonical(receipt)) return false;
      const durability = await this.verifyDurability(owner, saved.workspaceDurabilityReceiptId);
      const dependencies = this.db.get<{filesystemRevision:number;browserProfileRevision:number;refs:string[]}>('completion_dependencies', saved.receiptId)?.value;
      if (!dependencies || !sameOwner(owner, durability) || !sameOwner(owner, durability.recoveryPoint)) return false;
      return durability.receiptId === saved.workspaceDurabilityReceiptId && durability.generation === saved.generation && durability.incarnation === saved.incarnation
        && durability.filesystemRevision === dependencies.filesystemRevision && durability.browserProfileRevision === dependencies.browserProfileRevision
        && [...dependencies.refs, ...requiredArtifactRefs].every(ref => durability.coveredArtifactRefs.includes(ref));
    } catch { return false; }
  }
}
