import type { Checkpoint, EffectRecord, MutationContext, RuntimeLease } from './workspace-contract.ts';
import { WorkspacePersistence, fail, nonempty, type RuntimeAuthority } from './workspace-persistence.ts';

export interface EffectIntent { effectId: string; taskId: string; runId: string; intentHash: string; approvalId: string | null; approvalScopeHash: string | null }
export interface ConsentAuthority {
  /** Trusted policy verifies scope and task consent, including allowed routine effects. Runs in transaction. */
  assertDispatchAllowed(effect: EffectRecord, lease: RuntimeLease): void;
}
/** Persistent external-effect state; never infers not_applied from a timeout. */
export class EffectLedger {
  readonly db: WorkspacePersistence; readonly authority: RuntimeAuthority; readonly consent: ConsentAuthority;
  readonly verifyOutcome:(effect:EffectRecord,status:string,evidenceRef:string)=>Promise<boolean>;
  constructor(db: WorkspacePersistence, authority: RuntimeAuthority, consent: ConsentAuthority, verifyOutcome:(effect:EffectRecord,status:string,evidenceRef:string)=>Promise<boolean>) { this.db=db; this.authority=authority; this.consent=consent; this.verifyOutcome=verifyOutcome; }
  async prepare(context: MutationContext, intent: EffectIntent): Promise<EffectRecord> {
    [intent.effectId, intent.taskId, intent.runId, intent.intentHash].forEach(nonempty);
    if ((intent.approvalId === null) !== (intent.approvalScopeHash === null)) fail('INVALID_CONSENT');
    return this.db.authorized(this.authority, 'action.prepare', intent.taskId, context, intent, lease => {
      if (context.expectedRevision !== 0 || this.db.get('effect', intent.effectId)) fail('REVISION_CONFLICT');
      const run = this.db.get<{taskId:string; completed:boolean}>('run', intent.runId)?.value;
      if (!run || run.taskId !== intent.taskId || run.completed) fail('RUN_UNAVAILABLE');
      const record: EffectRecord = { ...this.db.owner, ...intent, incarnation: lease.incarnation, generation: lease.generation, revision: 1, status: 'prepared' };
      this.db.put('effect', intent.effectId, 0, record);
      return record;
    });
  }
  async dispatch(context: MutationContext, effectId: string): Promise<EffectRecord> {
    const initial = this.require(effectId);
    return this.db.authorized(this.authority, 'action.dispatch', initial.taskId, context, { effectId }, lease => {
      const effect = this.require(effectId);
      if (effect.status !== 'prepared') fail('OUTCOME_UNCERTAIN');
      const run = this.db.get<{ taskId:string; completed:boolean }>('run', effect.runId)?.value;
      const task = this.db.get<{ activeRunId:string; status:string }>('runtime_task', effect.taskId)?.value;
      const checkpoint = this.db.get<Checkpoint>('checkpoint', effect.runId)?.value;
      if (!run || run.completed || run.taskId !== effect.taskId || task?.activeRunId !== effect.runId || task.status !== 'running' || (checkpoint && checkpoint.phase !== 'running')) fail('RUN_NOT_RUNNING');
      this.consent.assertDispatchAllowed(effect, lease);
      if (effect.approvalId) {
        if (this.db.get('consent_consumed', effect.approvalId)) fail('CONSENT_CONSUMED');
        this.db.put('consent_consumed', effect.approvalId, 0, { effectId, intentHash: effect.intentHash });
      }
      const next: EffectRecord = { ...effect, incarnation: lease.incarnation, generation: lease.generation, status: 'dispatching', revision: context.expectedRevision + 1 };
      this.db.put('effect', effectId, context.expectedRevision, next);
      return next;
    });
  }
  async resolve(context: MutationContext, effectId: string, status: 'confirmed' | 'not_applied' | 'uncertain', privateEvidenceRef: string): Promise<EffectRecord> {
    nonempty(privateEvidenceRef);
    if(!['confirmed','not_applied','uncertain'].includes(status)) fail('INVALID_TRANSITION');
    const initial = this.require(effectId);
    const payload = { effectId, status, privateEvidenceRef };
    const replay = await this.db.authorizedReplay<EffectRecord>(this.authority, 'action.resolve', initial.taskId, context, payload);
    if (replay.found) return replay.result;
    if (!await this.verifyOutcome(initial, status, privateEvidenceRef)) fail('UNVERIFIED_OUTCOME');
    return this.db.authorized(this.authority, 'action.resolve', initial.taskId, context, payload, lease => {
      const effect = this.require(effectId);
      if (!['dispatching', 'uncertain'].includes(effect.status)) fail('INVALID_TRANSITION');
      const next: EffectRecord = { ...effect, status, privateEvidenceRef, generation: lease.generation, incarnation: lease.incarnation, revision: context.expectedRevision + 1 };
      this.db.put('effect', effectId, context.expectedRevision, next);
      return next;
    });
  }
  /** Conservative loss record requires no claim that an external action did or did not happen. */
  async noteUncertain(context: MutationContext, effectId: string, privateEvidenceRef: string): Promise<EffectRecord> {
    nonempty(privateEvidenceRef); const initial=this.require(effectId);
    return this.db.authorized(this.authority,'action.resolve',initial.taskId,context,{effectId,kind:'note_uncertain',privateEvidenceRef},lease=>{
      const effect=this.require(effectId);if(!['dispatching','uncertain'].includes(effect.status))fail('INVALID_TRANSITION');
      const next:EffectRecord={...effect,status:'uncertain',privateEvidenceRef,generation:lease.generation,incarnation:lease.incarnation,revision:context.expectedRevision+1};
      this.db.put('effect',effectId,context.expectedRevision,next);return next;
    });
  }
  /** Safe local cancellation: the transaction proves no dispatch grant was committed. */
  async cancelPrepared(context: MutationContext, effectId: string): Promise<EffectRecord> {
    const initial = this.require(effectId);
    return this.db.authorized(this.authority, 'action.resolve', initial.taskId, context, { effectId, kind:'cancel_prepared' }, lease => {
      const effect = this.require(effectId);
      if (effect.status !== 'prepared') fail('INVALID_TRANSITION');
      const consumption = effect.approvalId ? this.db.get<{ effectId:string }>('consent_consumed', effect.approvalId)?.value : null;
      if (consumption?.effectId === effectId) fail('CONSENT_ALREADY_DISPATCHED');
      const next: EffectRecord = { ...effect, status:'not_applied', revision:context.expectedRevision+1, generation:lease.generation, incarnation:lease.incarnation };
      this.db.put('effect', effectId, context.expectedRevision, next);
      return next;
    });
  }
  /** Trusted recovery supervisor only, AFTER exact-incarnation physical fencing. No retry grants produced. */
  recoverDispatches(assertFenced: () => void): number {
    return this.db.storage.transactionSync(() => {
      assertFenced();
      let count = 0;
      for (const saved of this.db.list<EffectRecord>('effect')) if (saved.value.status === 'dispatching') {
        this.db.put('effect', saved.value.effectId, saved.revision, { ...saved.value, revision: saved.revision + 1, status: 'uncertain' }); count++;
      }
      return count;
    });
  }
  require(id: string): EffectRecord { return this.db.get<EffectRecord>('effect', id)?.value ?? fail('UNKNOWN_EFFECT'); }
  unresolved(runId: string): boolean {
    return this.db.list<EffectRecord>('effect').some(r => r.value.runId === runId && !['confirmed', 'not_applied'].includes(r.value.status));
  }
}
