import type { Checkpoint, RunCompletionReceipt, RuntimeLease, RuntimeOperation, WorkspaceDurabilityReceipt, WorkspaceIdentity } from './workspace-contract.ts';
import type { createWorkspaceFoundation } from './workspace-foundation.ts';
import type { RunDefinition } from './runtime-checkpoints.ts';
import { canonical, digest, fail, InvalidWorkspacePayload, nonempty, sameOwner, type WorkspaceStorage } from './workspace-persistence.ts';
import { createWorkspaceTaskProjection, type TaskProjector, type WorkspaceTask } from './workspace-task-projection.ts';
import { outcomeForTaskKind } from './skills.ts';

export interface WorkspaceActionInput { decision:Record<string,any>; snapshot:Record<string,any>|null; sessionID:string|null; approvedActionProof?:unknown }
export interface ActionTicket { effectId:string; intentHash:string; runId:string; sequence:number; input:WorkspaceActionInput }
export interface WorkspaceActionObservation { result?:any; error?:unknown; snapshot?:Record<string,any>|null }
export interface WorkspaceMissionHooks {
  onSession?(id:string):void;
  onActionBefore(input:WorkspaceActionInput):Promise<ActionTicket>;
  onActionAfter(ticket:ActionTicket,observation:WorkspaceActionObservation):Promise<void>;
}
export interface PrivateEvidence { ref:string; payload:unknown }
export interface WorkspaceSaveInput { expectedLease?:RuntimeLease; task:WorkspaceTask; runId:string; reason:'step'|'pause'|'completion'; evidence:readonly PrivateEvidence[]; requiresBrowserFreeze:true }
export interface WorkspaceMissionResult { status:string; sessionID?:string; trace?:unknown[]; log?:string[]; extractedItems?:string[]; informationRequests?:string[]; help?:any; pendingAction?:any; checkpoint?:any; [key:string]:unknown }
export interface RunnerRecord {
  taskId:string;runId:string;sequence:number;pendingEffectId:string|null;status:'created'|'running'|'needsHuman'|'succeeded'|'failed'|'rejected';task:WorkspaceTask;
}
export class WorkspaceActionUncertain extends Error { constructor(){super('WORKSPACE_ACTION_UNCERTAIN');this.name='WorkspaceActionUncertain';} }
export interface TaskRunnerConfig {
  foundation:ReturnType<typeof createWorkspaceFoundation>; storage:WorkspaceStorage; owner:WorkspaceIdentity;
  saveWorkspace(input:WorkspaceSaveInput):Promise<WorkspaceDurabilityReceipt>;
  projectTask?:TaskProjector;
  authorizeAction(task:WorkspaceTask,input:WorkspaceActionInput & {effectId:string;intentHash:string;runId:string}):Promise<{approvalId:string|null;approvalScopeHash:string|null}>;
  verifyActionOutcome(input:{task:WorkspaceTask;ticket:ActionTicket;observation:WorkspaceActionObservation}):Promise<{status:'confirmed'|'not_applied'|'uncertain';evidence:unknown}>;
  verifyMissionCompletion(input:{task:WorkspaceTask;runId:string;result:WorkspaceMissionResult}):Promise<{verification:RunCompletionReceipt['verification'];evidence:unknown;candidateBodyHash?:string|null}|null>;
  /** Agent self-verification of an uncertain effect: re-observe the live page and determine whether the
   * action's outcome is achieved. 'confirmed' when the mission goal is observably achieved, 'not_applied'
   * when it is not (the mission re-observes the page and continues/retries, never duplicating a submission),
   * 'uncertain' only when the page cannot be observed at all. The user is never asked to judge an outcome. */
  verifyUncertainEffect?(input:{task:WorkspaceTask;effectId:string;runId:string}):Promise<{status:'confirmed'|'not_applied'|'uncertain';evidence:unknown}>;
  /** Must block a different task while a user/browser owns live control. */
  assertWorkspaceReady?(task:WorkspaceTask):Promise<void>;
  now?:()=>string;
}
export interface WorkspaceRunContext {
  task:WorkspaceTask;resume?:boolean;candidate?:RunDefinition['candidate'];
  mission(hooks:WorkspaceMissionHooks,runId:string,task:WorkspaceTask):Promise<WorkspaceMissionResult>;
}
const copy=<T>(v:T):T=>JSON.parse(JSON.stringify(v));
function trustedMissionPatch(task:WorkspaceTask|null){return task?Object.fromEntries(['credential_id','session_id','email_code_available'].filter(k=>Object.hasOwn(task,k)).map(k=>[k,task[k]])):{};}
function evidenceId(runId:string,kind:string,sequence:number){return `ev_${runId.replaceAll('-','')}_${kind}_${sequence}`;}
interface ExecutionGuard { assertCurrent():void; verify():Promise<void>; lease():RuntimeLease }
/** One per owner DO. Serializes all task entrypoints; persistent admission prevents parallel replacement. */
export function createWorkspaceTaskRunner(config:TaskRunnerConfig) {
  const {foundation:f,owner}=config,db=f.checkpoints.db;
  if(!sameOwner(owner,db.owner))fail('OWNER_MISMATCH');
  const now=config.now??(()=>new Date().toISOString());
  const project=config.projectTask??createWorkspaceTaskProjection(config.storage,db,now);
  const instanceId=crypto.randomUUID();let tail:Promise<unknown>=Promise.resolve(),pendingOperations=0;
  function serialized<T>(operation:()=>Promise<T>):Promise<T>{pendingOperations++;const next=tail.then(operation).finally(()=>{pendingOperations--;});tail=next.catch(()=>{});return next;}
  type Phase='waiting_for_workspace'|'browser_starting'|'running'|'recovery'|'finished';
  function progress(taskId:string,phase:Phase){
    const old=db.get('runner_progress',taskId);
    db.put('runner_progress',taskId,old?.revision??0,{taskId,runId:record(taskId)?.value.runId??null,phase,updatedAt:now()});
  }
  /** Queue exhaustion is an observation, never permission to release an admission or replay an effect. */
  function applyDeliveryFailure(task:WorkspaceTask,jobId:string){
    const old=record(task.id)?.value;
    const notice=db.get<{taskId:string;runId:string|null;applied:boolean}>('runner_delivery',jobId)!;
    if(notice.value.applied)return copy(old?.task??task);
    if((old&&old.runId!==notice.value.runId)||['succeeded','failed','rejected'].includes(old?.status??task.status)){
      db.put('runner_delivery',jobId,notice.revision,{...notice.value,applied:true});return copy(old?.task??task);
    }
    const admission=db.get<{instanceId:string;taskId:string}>('runner_owner','active')?.value;
    if(admission?.taskId===task.id&&admission.instanceId===instanceId)return copy(old?.task??task);
    const next:RunnerRecord=old??{taskId:task.id,runId:crypto.randomUUID(),sequence:0,pendingEffectId:null,status:'created',task:copy(task)};
    const effects=db.list<import('./workspace-contract.ts').EffectRecord>('effect').filter(e=>e.value.runId===next.runId);
    const needsPause=(!!admission&&admission.taskId===task.id)||!!next.pendingEffectId||effects.length>0;
    const status=needsPause?'needsHuman' as const:'failed' as const;
    // A delivery failure is internal queue state, never a user prompt. The task pauses (or fails)
    // silently; the agent's self-verification resolves any uncertain effect when the mission resumes.
    const updated={...next.task,status,authorized_action:null,failure:{code:'job_delivery_exhausted'},
      help:next.task.help??null,
      log:[...(next.task.log??[]),'Queue delivery exhausted; existing effects and admission preserved.']};
    const canonicalTask=db.get<any>('runtime_task',task.id);
    if(canonicalTask)db.put('runtime_task',task.id,canonicalTask.revision,{...canonicalTask.value,status});
    saveRecord({...next,status,task:updated},`${next.runId}:delivery:${jobId}`);progress(task.id,'recovery');
    db.put('runner_delivery',jobId,notice.revision,{...notice.value,applied:true});
    return copy(record(task.id)!.value.task);
  }
  function deliveryFailed(task:WorkspaceTask,jobId:string){
    nonempty(jobId);
    return db.storage.transactionSync(()=>{
      const old=db.get<{taskId:string}>('runner_delivery',jobId);
      if(old&&old.value.taskId!==task.id)fail('JOB_TASK_MISMATCH');
      if(!old)db.put('runner_delivery',jobId,0,{taskId:task.id,jobId,runId:record(task.id)?.value.runId??null,applied:false});
      return applyDeliveryFailure(task,jobId);
    });
  }
  async function context(taskId:string,requestId:string,expectedRevision:number,op:RuntimeOperation,guard?:ExecutionGuard){
    await guard?.verify();
    const capabilityToken=await f.broker.issue([op],{taskId},guard?.lease());
    await guard?.verify();
    return {capabilityToken,requestId,expectedRevision};
  }
  function record(taskId:string){return db.get<RunnerRecord>('runner_task',taskId);}
  function saveRecord(value:RunnerRecord,requestId:string,completionReceiptId?:string){
    value.task={...value.task,updated_at:now(),updatedAt:now(),workspace_run_id:value.runId,workspace_pending_effect_id:value.pendingEffectId,workspace_sequence:value.sequence};
    const previous=record(value.taskId);db.put('runner_task',value.taskId,previous?.revision??0,copy(value));
    project(value.task,{runId:value.runId,requestId,...(completionReceiptId?{completionReceiptId}:{})});
  }
  function state(taskId:string):RunnerRecord{return record(taskId)?.value??fail('UNKNOWN_RUN');}
  function checkpoint(runId:string){return db.get<Checkpoint>('checkpoint',runId);}
  function evidence(ref:string,payload:unknown){const prior=db.get('runner_evidence',ref);if(prior){if(canonical(prior.value)!==canonical(payload))fail('EVIDENCE_IDEMPOTENCY_CONFLICT');return;}db.put('runner_evidence',ref,0,copy(payload));}
  async function capture(task:WorkspaceTask,runId:string,reason:WorkspaceSaveInput['reason'],items:PrivateEvidence[],guard?:ExecutionGuard){
    await guard?.verify();
    for(const e of items)db.storage.transactionSync(()=>{guard?.assertCurrent();evidence(e.ref,e.payload);});
    const receipt=await config.saveWorkspace({...(guard?{expectedLease:guard.lease()}:{}),task:copy(task),runId,reason,evidence:copy(items),requiresBrowserFreeze:true});
    await guard?.verify();
    if(!sameOwner(owner,receipt)||items.some(e=>!receipt.coveredArtifactRefs.includes(e.ref)))fail('DURABILITY_COVERAGE_MISSING');
    // Verify committed bytes through A; callback-returned receipt alone is never proof.
    const committed=await f.verifyDurability(receipt.receiptId);
    await guard?.verify();
    if(await digest(committed)!==await digest(receipt))fail('DURABILITY_RECEIPT_MISMATCH');
    return receipt;
  }
  function checkpointInput(task:WorkspaceTask,runId:string,r:WorkspaceDurabilityReceipt,phase:Checkpoint['phase'],helpId:string|null){
    return {...owner,schemaVersion:1 as const,taskId:task.id,runId,phase,nextStep:(phase==='running'?'inspect':'await_user') as Checkpoint['nextStep'],filesystemRevision:r.filesystemRevision,browserProfileRevision:r.browserProfileRevision,workspaceDurabilityReceiptId:r.receiptId,privateArtifactRefs:r.coveredArtifactRefs,helpId};
  }
  async function commitPause(s:RunnerRecord,reason:string,receipt?:WorkspaceDurabilityReceipt,guard?:ExecutionGuard){
    await guard?.verify();
    // The runner never invents a user-facing recovery prompt. A pause keeps the mission's own help
    // (a legitimate stop: a check, a credential, an approval) or no help at all. The reason is
    // recorded in the log for operators, never shown as a message.
    const task={...s.task,status:'needsHuman',authorized_action:null,help:s.task.help??null,log:[...(s.task.log??[]),`Paused pending=${s.pendingEffectId??'none'} seq=${s.sequence} (${reason})`]};
    if(receipt){const old=checkpoint(s.runId);await f.checkpoints.commit(await context(task.id,`${s.runId}:pause:${old?.revision??0}:${receipt.receiptId}`,old?.revision??0,'checkpoint.commit',guard),checkpointInput(task,s.runId,receipt,'needsHuman',task.help?.id??null));}
    db.storage.transactionSync(()=>{guard?.assertCurrent();return saveRecord({...s,status:'needsHuman',task},`${s.runId}:pause-projection:${record(task.id)!.revision}`);});
    return task;
  }
  async function unknown(s:RunnerRecord,effectId:string,ref:string,guard?:ExecutionGuard){
    await guard?.verify();
    const effect=f.effects.require(effectId);
    if(effect.status==='dispatching')await f.effects.noteUncertain(await context(s.taskId,`${effectId}:uncertain`,effect.revision,'action.resolve',guard),effectId,ref);
  }
  /** Agent self-verification of an uncertain effect. Re-observes the live page (via verifyUncertainEffect)
   * and resolves the effect from the agent's own observation — never from a user tap. Returns the resolved
   * status ('confirmed'|'not_applied') or null when the page could not be observed (the effect stays
   * uncertain and the task pauses silently, with no user-facing prompt). A prepared-but-never-dispatched
   * ticket has no external effect; it is cancelled as not_applied. */
  async function selfResolveUncertain(s:RunnerRecord,makeContext:(taskId:string,requestId:string,expectedRevision:number,op:RuntimeOperation)=>Promise<import('./workspace-contract.ts').MutationContext>):Promise<'confirmed'|'not_applied'|null>{
    if(!s.pendingEffectId)return null;
    const effect=db.get<import('./workspace-contract.ts').EffectRecord>('effect',s.pendingEffectId)?.value;
    if(!effect)return null;
    // A prepared-but-never-dispatched ticket has no external effect; it is cancelled by the
    // resume/reject paths, not here. This helper only resolves dispatched effects.
    if(effect.status==='prepared')return null;
    if(['confirmed','not_applied'].includes(effect.status))return effect.status as 'confirmed'|'not_applied';
    if(!['uncertain','dispatching'].includes(effect.status))return null;
    if(!config.verifyUncertainEffect)return null;
    const verdict=await config.verifyUncertainEffect({task:s.task,effectId:effect.effectId,runId:s.runId});
    if(verdict.status==='uncertain')return null;
    const ref=`ev_${s.runId.replaceAll('-','')}_selfverify_${crypto.randomUUID().replaceAll('-','')}`;
    const payload={effectId:effect.effectId,intentHash:effect.intentHash,status:verdict.status,evidence:verdict.evidence,verifiedBy:'agent'};
    db.storage.transactionSync(()=>{evidence(ref,payload);});
    await f.effects.resolve(await makeContext(s.taskId,`${effect.effectId}:selfverify`,effect.revision,'action.resolve'),effect.effectId,verdict.status,ref);
    return verdict.status;
  }
  async function execute(input:WorkspaceRunContext):Promise<WorkspaceTask>{
    nonempty(input.task.id);await config.assertWorkspaceReady?.(input.task);
    let s=record(input.task.id)?.value;
    if(s&&['succeeded','rejected'].includes(s.status))return copy(s.task);
    if(s&&['needsHuman','failed'].includes(s.status)&&!input.resume)return copy(s.task);
    const anchoredLease=await f.registry.readLease(owner,owner);
    const executionId=crypto.randomUUID();let refreshedLease=anchoredLease;let anchoredRunId:string|null=s?.runId??null;
    function sameLineage(lease:RuntimeLease){return sameOwner(anchoredLease,lease)&&lease.runtimeId===anchoredLease.runtimeId&&lease.incarnation===anchoredLease.incarnation&&lease.generation===anchoredLease.generation;}
    const guard:ExecutionGuard={
      lease:()=>refreshedLease,
      assertCurrent(){
        if(!sameLineage(refreshedLease))fail('STALE_WORKSPACE_EXECUTION');
        f.checkpoints.authority.assertCurrent(refreshedLease);
        const admission=db.get<{instanceId:string;taskId:string;executionId:string}>('runner_owner','active')?.value;
        if(!admission||admission.instanceId!==instanceId||admission.taskId!==input.task.id||admission.executionId!==executionId)fail('STALE_WORKSPACE_EXECUTION');
        if(anchoredRunId&&record(input.task.id)?.value.runId!==anchoredRunId)fail('STALE_WORKSPACE_EXECUTION');
      },
      async verify(){const current=await f.registry.readLease(owner,owner);if(!sameLineage(current))fail('STALE_WORKSPACE_EXECUTION');refreshedLease=current;guard.assertCurrent();},
    };
    db.storage.transactionSync(()=>{
      f.checkpoints.authority.assertCurrent(anchoredLease);
      if(db.get('image_upgrade_lock','active'))fail('WORKSPACE_IMAGE_UPGRADE_PENDING');if(db.get('runner_owner','active'))fail('WORKSPACE_ADMISSION_BUSY');
      db.put('runner_owner','active',0,{instanceId,executionId,taskId:input.task.id,runtimeId:anchoredLease.runtimeId,incarnation:anchoredLease.incarnation,generation:anchoredLease.generation,leaseId:anchoredLease.leaseId});
    });
    function atomicExecution<T>(operation:()=>T):T{return db.storage.transactionSync(()=>{guard.assertCurrent();return operation();});}
    const executionContext=(taskId:string,requestId:string,expectedRevision:number,op:RuntimeOperation)=>context(taskId,requestId,expectedRevision,op,guard);
    const executionCapture=(task:WorkspaceTask,runId:string,reason:WorkspaceSaveInput['reason'],items:PrivateEvidence[])=>capture(task,runId,reason,items,guard);
    const executionPause=(r:RunnerRecord,reason:string,receipt?:WorkspaceDurabilityReceipt)=>commitPause(r,reason,receipt,guard);
    const executionUnknown=(r:RunnerRecord,effectId:string,ref:string)=>unknown(r,effectId,ref,guard);
    let latestMissionTask:WorkspaceTask|null=null;
    try{
      if(!s){s={taskId:input.task.id,runId:crypto.randomUUID(),sequence:0,pendingEffectId:null,status:'created',task:copy(input.task)};atomicExecution(()=>saveRecord(s!,`${s!.runId}:created`));anchoredRunId=s.runId;}
      if(s.status==='running')return await executionPause(s,'Previous run interrupted.');
      if(s.pendingEffectId){
        const pending=db.get<import('./workspace-contract.ts').EffectRecord>('effect',s.pendingEffectId)?.value;
        if(pending?.status==='prepared')await f.effects.cancelPrepared(await executionContext(s.taskId,`${pending.effectId}:cancel-undispatched`,pending.revision,'action.resolve'),pending.effectId);
        if(!pending||['prepared','confirmed','not_applied'].includes(pending.status)){
          s={...s,pendingEffectId:null,sequence:s.sequence+1};atomicExecution(()=>saveRecord(s!,`${s!.runId}:reinspect:${record(s!.taskId)!.revision}`));
        } else {
          // An uncertain/dispatched effect: the agent re-observes the live page and resolves it
          // itself. No user review. If the page cannot be observed, the task pauses silently.
          const resolved=await selfResolveUncertain(s,executionContext);
          if(resolved){s={...s,pendingEffectId:null,sequence:s.sequence+1};atomicExecution(()=>saveRecord(s!,`${s!.runId}:selfverify:${record(s!.taskId)!.revision}`));}
        }
      }
      if(f.effects.unresolved(s.runId))return await executionPause(s,'Unresolved effect could not be verified from the live page.');
      const run=db.get('run',s.runId);
      if(!run){const url=new URL(input.task.target_url);await f.checkpoints.startRun(await executionContext(input.task.id,`${s.runId}:start`,0,'checkpoint.commit'),{taskId:input.task.id,runId:s.runId,siteOrigin:url.origin,outcome:outcomeForTaskKind(input.task.kind),candidate:input.candidate??{kind:'ordinary'}});}
      s={...s,status:'running',task:{...copy(input.task),status:'running',workspace_run_id:s.runId}};
      atomicExecution(()=>saveRecord(s!,`${s!.runId}:running:${record(s!.taskId)!.revision}`));
      // A paused checkpoint must return to running before any effect admission.
      const prior=checkpoint(s.runId);
      if(prior&&prior.value.phase!=='running'){
        const resumed=await executionCapture(s.task,s.runId,'pause',[]);
        await f.checkpoints.commit(await executionContext(s.taskId,`${s.runId}:resume:${prior.revision}`,prior.revision,'checkpoint.commit'),checkpointInput(s.task,s.runId,resumed,'running',null));
      }
      const hooks:WorkspaceMissionHooks={
        onSession(id){
          nonempty(id);
          atomicExecution(()=>{
            const current=state(input.task.id);
            if(current.status!=='running'||current.runId!==anchoredRunId)fail('RUN_NOT_RUNNING');
            if(current.task.session_id===id)return;
            saveRecord({...current,task:{...current.task,session_id:id}},`${current.runId}:session:${id}`);
          });
        },
        async onActionBefore(action){
          await guard.verify();
          let current=state(input.task.id);if(current.status!=='running')fail('RUN_NOT_RUNNING');
          if(current.pendingEffectId)throw new WorkspaceActionUncertain();
          const sequence=current.sequence;
          const effectId=`fx_${current.runId.replaceAll('-','')}_${sequence}`;
          atomicExecution(()=>progress(current.taskId,action.sessionID===null?'browser_starting':'running'));
          const intentHash=await digest({taskId:current.taskId,runId:current.runId,sequence,decision:action.decision,snapshot:action.snapshot,sessionID:action.sessionID});
          await guard.verify();
          const policy=await config.authorizeAction(current.task,{...action,effectId,intentHash,runId:current.runId});
          await guard.verify();
          atomicExecution(()=>{
            current=state(input.task.id);if(current.pendingEffectId||current.sequence!==sequence)fail('REVISION_CONFLICT');
            db.put('runner_authorization',effectId,0,{...policy,effectId,intentHash,taskId:current.taskId,runId:current.runId});
            saveRecord({...current,pendingEffectId:effectId},`${effectId}:reserved`);
          });
          await f.effects.prepare(await executionContext(current.taskId,`${effectId}:prepare`,0,'action.prepare'),{effectId,taskId:current.taskId,runId:current.runId,intentHash,approvalId:policy.approvalId,approvalScopeHash:policy.approvalScopeHash});
          await f.effects.dispatch(await executionContext(current.taskId,`${effectId}:dispatch`,1,'action.dispatch'),effectId);
          return {effectId,intentHash,runId:current.runId,sequence,input:copy(action)};
        },
        async onActionAfter(ticket,observation){
          await guard.verify();
          let current=state(input.task.id);
          const canonicalEffect=f.effects.require(ticket.effectId);
          if(current.pendingEffectId!==ticket.effectId||current.runId!==ticket.runId||current.sequence!==ticket.sequence||canonicalEffect.intentHash!==ticket.intentHash)fail('ACTION_TICKET_MISMATCH');
          const ref=evidenceId(current.runId,'step',ticket.sequence);
          try{
            if(observation.error)throw new WorkspaceActionUncertain();
            const verified=await config.verifyActionOutcome({task:current.task,ticket,observation});
            await guard.verify();
            const payload={effectId:ticket.effectId,intentHash:ticket.intentHash,taskId:current.taskId,status:verified.status,evidence:verified.evidence};
            atomicExecution(()=>evidence(ref,payload));
            if(verified.status==='uncertain')throw new WorkspaceActionUncertain();
            const receipt=await executionCapture(current.task,current.runId,'step',[{ref,payload}]);
            const effect=f.effects.require(ticket.effectId);
            await f.effects.resolve(await executionContext(current.taskId,`${ticket.effectId}:resolve`,effect.revision,'action.resolve'),ticket.effectId,verified.status,ref);
            const old=checkpoint(current.runId);
            await f.checkpoints.commit(await executionContext(current.taskId,`${ticket.effectId}:checkpoint`,old?.revision??0,'checkpoint.commit'),checkpointInput(current.task,current.runId,receipt,'running',null));
            atomicExecution(()=>{current=state(input.task.id);saveRecord({...current,sequence:ticket.sequence+1,pendingEffectId:null},`${ticket.effectId}:observed`);progress(current.taskId,'running');});
          }catch(error){
            const uncertainRef=ref+'_uncertain';
            atomicExecution(()=>evidence(uncertainRef,{effectId:ticket.effectId,status:'uncertain',reason:'lost_or_unverified_response'}));
            await executionUnknown(current,ticket.effectId,uncertainRef);
            // Preserve a code-shaped infrastructure reason for operators;
            // genuine outcome uncertainty keeps the generic marker.
            const raw=error instanceof Error?error.message:'';
            throw /^[A-Z][A-Z0-9_]{2,48}$/.test(raw)&&raw!=='WORKSPACE_ACTION_UNCERTAIN'?new Error(raw):new WorkspaceActionUncertain();
          }
        },
      };
      const missionTask=s.task;latestMissionTask=missionTask;
      // The patch reads the task object the mission actually mutated. On a retry the mission
      // receives a fresh task object, so read latestMissionTask (updated each attempt), not the
      // first attempt's object.
      const privateMissionPatch=()=>trustedMissionPatch(latestMissionTask);
      let result:WorkspaceMissionResult;
      // The mission may be interrupted (lost browser response, dead session). The agent recovers
      // itself: it re-observes the live page, resolves the uncertain effect from that observation,
      // and retries the mission once. No user tap. If recovery is impossible, the task pauses
      // silently (no user-facing prompt; the code stays in the log for operators).
      let attempts=0;
      while(true){
        attempts++;
        latestMissionTask=s.task;
        try{result=await input.mission(hooks,s.runId,s.task);await guard.verify();break;}
        catch(error){
          await guard.verify();
          s=state(input.task.id);s={...s,task:{...s.task,...privateMissionPatch()}};
          if(s.pendingEffectId){const ref=evidenceId(s.runId,'lost',s.sequence);atomicExecution(()=>evidence(ref,{effectId:s!.pendingEffectId,status:'uncertain'}));await executionUnknown(s,s.pendingEffectId,ref);}
          // The code stays in the log for operators; it never reaches a user-facing message.
          const raw=error instanceof Error?error.message:String(error);
          const code=/^[A-Z][A-Z0-9_]{2,48}$/.test(raw)?raw:'INTERRUPTED';
          const detail=error instanceof InvalidWorkspacePayload?` path=${error.path} type=${error.valueType}`:'';
          s={...s,task:{...s.task,log:[...(s.task.log??[]),`Recovery check paused [${code}]${detail}`]}};
          const resolved=s.pendingEffectId?await selfResolveUncertain(s,executionContext):null;
          // Retry only when the action verifiably did NOT happen: re-running the mission is
          // then safe (it re-dispatches an action that never landed). When the action DID
          // happen (confirmed), re-running the mission from the start would risk duplicating
          // it, so the task pauses silently and the resume path re-observes and continues.
          if(resolved==='not_applied'&&attempts<2){
            s={...s,pendingEffectId:null,sequence:s.sequence+1};
            atomicExecution(()=>saveRecord(s!,`${s!.runId}:selfverify-retry:${record(s!.taskId)!.revision}`));
            continue;
          }
          return await executionPause(s,`Mission interrupted [${code}]`);
        }
      }
      s=state(input.task.id);
      const task:WorkspaceTask={...s.task,...privateMissionPatch(),session_id:result.sessionID??latestMissionTask?.session_id??s.task.session_id,browser_trace:result.trace??[],extracted_items:result.extractedItems??[],information_requests:result.informationRequests??[],log:[...(s.task.log??[]),...(result.log??[])],pending_action:result.pendingAction??null,checkpoint:result.checkpoint??null,help:result.help??null,authorized_action:null};
      s={...s,task};
      if(s.pendingEffectId||f.effects.unresolved(s.runId)){
        // A prepared-but-never-dispatched ticket has no external effect; cancel it and continue.
        const pending=s.pendingEffectId?db.get<import('./workspace-contract.ts').EffectRecord>('effect',s.pendingEffectId)?.value:null;
        if(pending?.status==='prepared'){
          await f.effects.cancelPrepared(await executionContext(s.taskId,`${pending.effectId}:postmission-cancel`,pending.revision,'action.resolve'),pending.effectId);
          s={...s,pendingEffectId:null,sequence:s.sequence+1};
          atomicExecution(()=>saveRecord(s!,`${s!.runId}:cancel-prepared:${record(s!.taskId)!.revision}`));
        } else {
          s={...s,task:{...s.task,log:[...(s.task.log??[]),`Pause pending verification [${s.pendingEffectId??'unresolved'}]`]}};
          // The agent re-observes the live page and resolves the uncertain effect itself.
          // No user review. If the page cannot be observed, the task pauses silently.
          const resolved=s.pendingEffectId?await selfResolveUncertain(s,executionContext):null;
          if(resolved){s={...s,pendingEffectId:null,sequence:s.sequence+1};atomicExecution(()=>saveRecord(s!,`${s!.runId}:selfverify:${record(s!.taskId)!.revision}`));}
          else if(f.effects.unresolved(s.runId))return await executionPause(s,'Unresolved effect could not be verified from the live page.');
        }
      }
      if(result.status==='succeeded'){
        const proof=await config.verifyMissionCompletion({task,runId:s.runId,result});
        await guard.verify();
        if(proof){
          const ref=proof.verification.evidenceRef;
          const receipt=await executionCapture(task,s.runId,'completion',[{ref,payload:proof.evidence}]);
          const successful={...s,status:'succeeded' as const,task:{...task,status:'succeeded',help:null,workspace_persistence_error:false}};
          const taskRevision=db.get('runtime_task',task.id)!.revision;
          const completeInput={runId:s.runId,checkpoint:checkpointInput(task,s.runId,receipt,'running',null),candidateBodyHash:proof.candidateBodyHash??null,verification:proof.verification};
          await f.checkpoints.complete(await executionContext(task.id,`${s.runId}:complete`,taskRevision,'task.complete'),completeInput,committed=>{guard.assertCurrent();return saveRecord(successful,`${s!.runId}:succeeded`,committed.receiptId);});
          return copy(successful.task);
        }
        // No trusted completion proof: the mission said done but the page does not prove it.
        // The agent does not ask the user to check; the task pauses silently and can be retried.
        task.log=[...(task.log??[]),'Mission claimed success without trusted completion proof.'];
      }
      const ref=evidenceId(s.runId,'pause',s.sequence);
      const receipt=await executionCapture(task,s.runId,'pause',[{ref,payload:{status:result.status,help:task.help??null}}]);
      task.log=[...(task.log??[]),`Mission paused [${result.status}:${(result as any).failure?.kind??'none'}]`];return await executionPause({...s,task},`Mission ended with status ${result.status}.`,receipt);
    }catch(error){
      await guard.verify();
      const current=record(input.task.id)?.value;
      if(current){const safe={...current.task,...trustedMissionPatch(latestMissionTask),status:'needsHuman',authorized_action:null,workspace_persistence_error:true,help:current.task.help??null};atomicExecution(()=>saveRecord({...current,status:'needsHuman',task:safe},`${current.runId}:recovery:${record(current.taskId)!.revision}`));return safe;}
      throw error;
    }finally{
      db.storage.transactionSync(()=>{
        const old=db.get<{instanceId:string;taskId:string;executionId:string}>('runner_owner','active');
        if(old?.value.instanceId===instanceId&&old.value.executionId===executionId){ // Delete only this owner's completed admission; no cross-incarnation release.
          config.storage.sql.exec('DELETE FROM hygge_workspace_records WHERE scope=? AND kind=? AND id=?',db.scope,'runner_owner','active');
          for(const notice of db.list<{taskId:string;jobId:string;applied:boolean}>('runner_delivery'))if(!notice.value.applied&&notice.value.taskId===input.task.id)applyDeliveryFailure(input.task,notice.value.jobId);
          const status=record(input.task.id)?.value.status;
          progress(input.task.id,status==='succeeded'||status==='rejected'?'finished':'recovery');
        }
      });
    }
  }
  return {
    deliveryFailed,
    /** Background document work shares admission and fails fast while missions/review own the workspace. */
    withWorkspaceMutation<T>(taskId:string,work:(lease:RuntimeLease)=>Promise<T>):Promise<T>{
      if(db.get('image_upgrade_lock','active'))return Promise.reject(Error('WORKSPACE_IMAGE_UPGRADE_PENDING'));
      if(pendingOperations||db.get('runner_owner','active'))return Promise.reject(Error('WORKSPACE_ADMISSION_BUSY'));
      return serialized(async()=>{
        const lease=await f.registry.readLease(owner,owner),executionId=crypto.randomUUID();
        db.storage.transactionSync(()=>{
          f.checkpoints.authority.assertCurrent(lease);if(db.get('image_upgrade_lock','active'))fail('WORKSPACE_IMAGE_UPGRADE_PENDING');if(db.get('runner_owner','active'))fail('WORKSPACE_ADMISSION_BUSY');
          db.put('runner_owner','active',0,{instanceId,taskId,executionId,runtimeId:lease.runtimeId,incarnation:lease.incarnation,generation:lease.generation,leaseId:lease.leaseId});
        });
        try{return await work(lease);}finally{db.storage.transactionSync(()=>{
          const old=db.get<{instanceId:string;executionId:string}>('runner_owner','active');
          if(old?.value.instanceId===instanceId&&old.value.executionId===executionId)config.storage.sql.exec('DELETE FROM hygge_workspace_records WHERE scope=? AND kind=? AND id=?',db.scope,'runner_owner','active');
        });}
      });
    },
    progress:(taskId:string)=>db.get('runner_progress',taskId)?.value??null,
    waiting:(taskId:string)=>db.storage.transactionSync(()=>{if(!['succeeded','failed','rejected'].includes(record(taskId)?.value.status??'')&&db.get<{taskId:string}>('runner_owner','active')?.value.taskId!==taskId)progress(taskId,'waiting_for_workspace');}),
    unavailable:(taskId:string)=>db.storage.transactionSync(()=>{if(!['succeeded','failed','rejected'].includes(record(taskId)?.value.status??'')&&!db.get('runner_owner','active'))progress(taskId,'recovery');}),
    run:(input:WorkspaceRunContext)=>serialized(()=>execute(input)),
    /** Agent self-reconciliation of an uncertain effect. The agent re-observes the live page and resolves
     * the effect from that observation — never from a user tap. This never dispatches or resumes a mission.
     * No fresh-approval flag, no blanket pre-authorization, no user-facing prompt. */
    reconcile:(input:{taskId:string;effectId:string})=>serialized(async()=>{
      const current=state(input.taskId);const effect=f.effects.require(input.effectId);
      if(effect.taskId!==input.taskId||effect.runId!==current.runId)fail('ACTION_TICKET_MISMATCH');
      if(current.pendingEffectId!==input.effectId)fail('ACTION_TICKET_MISMATCH');
      // A prepared-but-never-dispatched ticket has no external effect; cancel it. Dispatched
      // effects are resolved from the agent's own page observation.
      let resolved:'confirmed'|'not_applied'|null=null;
      if(effect.status==='prepared'){
        await f.effects.cancelPrepared(await context(input.taskId,`${input.effectId}:reconcile-cancel`,effect.revision,'action.resolve'),input.effectId);
        resolved='not_applied';
      } else {
        resolved=await selfResolveUncertain(current,context);
      }
      if(!resolved)fail('AGENT_VERIFY_UNAVAILABLE');
      return db.storage.transactionSync(()=>{
        const latest=state(input.taskId);const canonical=f.effects.require(input.effectId);
        if(canonical.status!==resolved)fail('UNVERIFIED_OUTCOME');
        if(latest.pendingEffectId!==input.effectId){if(latest.pendingEffectId===null)return copy(latest.task);return fail('ACTION_TICKET_MISMATCH');}
        // Reconcile clears the pending effect, never a legitimate
        // help: the app only calls this endpoint while a help is
        // live, so forcing help:null would destroy the request the
        // user is meant to answer. (The old review prompt no longer
        // exists, so there is no help here that reconcile itself
        // should clear.)
        const task={...latest.task,status:'needsHuman',authorized_action:null,pending_action:null,help:latest.task.help??null};
        saveRecord({...latest,status:'needsHuman',task,pendingEffectId:null,sequence:latest.sequence+1},`selfverify_projection_${effect.effectId}`);
        return copy(task);
      });
    }),
    /** Root routes rejection through this same queue; terminal cancellation issues no success receipt. */
    reject:(task:WorkspaceTask)=>serialized(async()=>{
      let old=record(task.id)?.value;if(old?.status==='succeeded')fail('TASK_COMPLETE');
      if(old){
        for(const entry of db.list<import('./workspace-contract.ts').EffectRecord>('effect'))if(entry.value.runId===old.runId&&entry.value.status==='prepared')await f.effects.cancelPrepared(await context(task.id,`${entry.value.effectId}:reject-undispatched`,entry.revision,'action.resolve'),entry.value.effectId);
        if(old.pendingEffectId){const pending=db.get<import('./workspace-contract.ts').EffectRecord>('effect',old.pendingEffectId)?.value;if(!pending||['confirmed','not_applied'].includes(pending.status))old={...old,pendingEffectId:null,sequence:old.sequence+1};}
      }
      if(old?.pendingEffectId||old&&f.effects.unresolved(old.runId)){
        // The user is stopping the task; an uncertain effect never blocks that. The agent
        // self-verifies where it can, and the effect stays in the ledger for audit either way.
        if(old.pendingEffectId){
          const resolved=await selfResolveUncertain(old,context);
          if(resolved)old={...old,pendingEffectId:null,sequence:old.sequence+1};
        }
      }
      const next:RunnerRecord=old??{taskId:task.id,runId:crypto.randomUUID(),sequence:0,pendingEffectId:null,status:'rejected',task};
      db.storage.transactionSync(()=>{
        const run=db.get<any>('run',next.runId);if(run)db.put('run',next.runId,run.revision,{...run.value,completed:true});
        const canonical=db.get<any>('runtime_task',task.id);if(canonical)db.put('runtime_task',task.id,canonical.revision,{...canonical.value,status:'rejected'});
        saveRecord({...next,status:'rejected',task:{...copy(task),status:'rejected',help:null,authorized_action:null}},`${next.runId}:rejected`);
      });return {...copy(task),status:'rejected',help:null,authorized_action:null};
    }),
    /** Trusted supervisor only after exact prior runtime/browser retirement. Never automatically invoked. */
    recoverAdmission(assertFenced:()=>void){db.storage.transactionSync(()=>{assertFenced();f.effects.recoverDispatches(assertFenced);config.storage.sql.exec('DELETE FROM hygge_workspace_records WHERE scope=? AND kind=? AND id=?',db.scope,'runner_owner','active');});},
  };
}
