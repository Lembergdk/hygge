import {test} from 'node:test';import assert from 'node:assert/strict';
import {sqliteWorkspace} from './helpers/workspace-sqlite.mts';
import {createWorkspaceFoundation} from '../src/workspace-foundation.ts';
import {createWorkspaceTaskRunner,type TaskRunnerConfig,type WorkspaceMissionHooks} from '../src/workspace-task-runner.ts';
import {createWorkspaceTaskProjection} from '../src/workspace-task-projection.ts';
import type {WorkspaceBinding} from '../src/workspace-contract.ts';
const owner={environment:'staging' as const,userId:'private-a',workspaceId:'workspace-a'};const now=Date.parse('2026-11-02T12:00:00Z');
async function fixture(){
 const f=sqliteWorkspace();const objects=new Map<string,Uint8Array>(),artifacts=new Map<string,Uint8Array>();let writes=0,saveFail=false,completionProof=true,submissions=0;
 // Agent self-verification verdict for an uncertain effect. Tests set it to control what the agent
 // observes when it re-checks the live page: 'confirmed' (the action did happen) or 'not_applied'
 // (it did not, or the session is gone and a fresh session will re-observe). 'uncertain' means the
 // page cannot be observed at all, so the effect stays unresolved.
 let uncertainVerdict:{status:'confirmed'|'not_applied'|'uncertain';evidence:any}={status:'confirmed',evidence:{observed:'yes'}};
 let foundation:ReturnType<typeof createWorkspaceFoundation>;
 foundation=createWorkspaceFoundation({owner,storage:f.storage,signingKey:new Uint8Array(32).fill(18),now:()=>now,
  objects:{async putImmutable(k,b){if(!objects.has(k))objects.set(k,b.slice());},async get(k){return objects.get(k)?.slice()??null;}},
  provider:{async start(b){return{runtimeId:'runtime-'+b.generation,providerRuntimeId:'provider-'+b.generation,incarnation:'inc-'+b.generation,recoveredCheckpointId:b.recoveryPoint?.checkpointId??null};},async fence(b){return{...owner,provider:'cloudflare',previousRuntimeId:b.runtimeId!,previousIncarnation:b.incarnation,previousGeneration:b.generation,browserRetired:true,providerRuntimeId:b.providerRuntimeId!,result:'exact_incarnation_stopped',verifiedAt:new Date(now).toISOString(),providerRequestIds:['stop']};}},
  captureDriver:{async capture(lease,request){return{snapshot:{incarnation:lease.incarnation,generation:lease.generation,filesystemRevision:request.filesystemRevision,browserProfileRevision:0,browserState:'absent',files:[...artifacts].map(([path,bytes])=>({path,bytes})),artifacts:Object.fromEntries([...artifacts.keys()].map(ref=>[ref,ref]))},async release(){}};}},
  consent:{assertDispatchAllowed(effect){const grant=foundation.checkpoints.db.get<any>('runner_authorization',effect.effectId)?.value;if(!grant||grant.effectId!==effect.effectId||grant.intentHash!==effect.intentHash||grant.approvalId!==effect.approvalId)throw Error('NO_TRUSTED_CONSENT');}},
  verifyOutcome:async(effect,status,ref)=>{const e=foundation.checkpoints.db.get<any>('runner_evidence',ref)?.value;return e?.effectId===effect.effectId&&e?.intentHash===effect.intentHash&&e?.status===status;},
  verifyCompletion:async(_run,input)=>{const e=foundation.checkpoints.db.get<any>('runner_evidence',input.verification.evidenceRef)?.value;return e?.verified===true;},
 });
 const initial:WorkspaceBinding={...owner,provider:'cloudflare',namespaceId:'hygge-test',providerWorkspaceId:'private-sandbox',ownerDigest:'owner',schemaVersion:1,incarnation:'',generation:0,runtimeId:null,providerRuntimeId:null,desiredImageDigest:'pinned',leaseExpiresAt:null,lifecycleState:'unprovisioned',revision:0,recoveryPoint:null,lastVerifiedAt:new Date(now).toISOString()};
 await foundation.registry.initialize(owner,initial);await foundation.registry.ensure(owner,owner,'start');
 const config:TaskRunnerConfig={foundation,storage:f.storage,owner,now:()=>new Date(now).toISOString(),
  async saveWorkspace(input){if(saveFail)throw Error('OBJECT_STORE_DOWN');for(const item of input.evidence)artifacts.set(item.ref,new TextEncoder().encode(JSON.stringify(item.payload)));const binding=await foundation.registry.read(owner,owner);return foundation.save(await foundation.broker.issue(['workspace.commit'],{},input.expectedLease),{writeId:'save-'+(++writes),expectedRegistryRevision:binding.revision,filesystemRevision:writes,browserProfileRevision:0,artifactRefs:[...artifacts.keys()]});},
  async authorizeAction(_task,input){return{approvalId:'approval_'+input.effectId,approvalScopeHash:input.intentHash};},
  async verifyActionOutcome({observation}){return {status:observation.result?.succeeded&&observation.snapshot?.observed==='yes'?'confirmed':'uncertain',evidence:{observed:observation.snapshot?.observed??null}};},
  async verifyMissionCompletion({task,runId,result}){if(!completionProof)return null;return{verification:{kind:'observed_postcondition',policyVersion:'test-site-receipt-v1',evidenceRef:'complete_'+runId.replaceAll('-','')},evidence:{verified:true,taskId:task.id,siteReceipt:submissions||result.extractedItems?.length}};},
  async verifyUncertainEffect(){return uncertainVerdict;},
 };
 const runner=createWorkspaceTaskRunner(config);
 const task=(id='task',kind='discover')=>({id,kind,status:'approved',interaction_version:1,target_url:'https://jobs.example',drafted_payload:{},log:[],mobile_task:{id,title:'Check website',siteID:'site'}});
 const submit=async(hooks:WorkspaceMissionHooks)=>{const ticket=await hooks.onActionBefore({decision:{action:'click',target:'Submit application'},snapshot:{currentURLString:'https://jobs.example/apply'},sessionID:'session',approvedActionProof:{private:true}});submissions++;await hooks.onActionAfter(ticket,{result:{succeeded:true},snapshot:{observed:'yes'}});};
 return {...f,foundation,runner,config,task,submit,getSubmissions:()=>submissions,setSaveFail:(v:boolean)=>{saveFail=v;},setProof:(v:boolean)=>{completionProof=v;},setUncertainVerdict:(v:{status:'confirmed'|'not_applied'|'uncertain';evidence:any})=>{uncertainVerdict=v;},objects,artifacts};
}

test('Real DO SQL task projection and canonical completion share one transaction; response replay does not rerun mission',async()=>{
 const f=await fixture();let calls=0;
 const mission=async(hooks:WorkspaceMissionHooks)=>{calls++;await f.submit(hooks);return{status:'succeeded',sessionID:'session',extractedItems:['listing']};};
 const result=await f.runner.run({task:f.task(),mission});assert.equal(result.status,'succeeded');assert.equal(calls,1);assert.equal(f.getSubmissions(),1);
 assert.deepEqual(await f.runner.run({task:f.task(),mission}),result);assert.equal(calls,1);
 const task=JSON.parse(String(f.sqlite.prepare('SELECT task FROM tasks WHERE id=?').get('task')!.task));assert.equal(task.status,'succeeded');assert.equal(task.updated_at,new Date(now).toISOString());
 assert.equal(f.foundation.checkpoints.db.list('completion').length,1);assert.equal(f.foundation.checkpoints.db.list('outbox').length,1);assert.equal(f.foundation.effects.unresolved(result.workspace_run_id),false);f.sqlite.close();
});
test('Response lost after submit is durable uncertainty and explicit resume never resubmits',async()=>{
 const f=await fixture();let missionCalls=0;f.setUncertainVerdict({status:'uncertain',evidence:{}});
 const result=await f.runner.run({task:f.task('apply','apply'),mission:async hooks=>{missionCalls++;const t=await hooks.onActionBefore({decision:{action:'click',target:'Submit'},snapshot:null,sessionID:null});await hooks.onActionAfter(t,{error:new Error('lost response')});return{status:'succeeded'};}});
 assert.equal(result.status,'needsHuman');assert.equal(f.foundation.checkpoints.db.list<any>('effect')[0].value.status,'uncertain');
 // The resume re-observes the page, sees the submit already happened, and does not resubmit.
 // The agent then confirms the effect from that observation and the task succeeds.
 f.setUncertainVerdict({status:'confirmed',evidence:{observed:'yes'}});
 const retry=await f.runner.run({task:{...result,status:'approved'},resume:true,mission:async()=>{missionCalls++;return{status:'succeeded'};}});assert.equal(retry.status,'succeeded');assert.equal(missionCalls,2);assert.equal(f.foundation.checkpoints.db.list('effect').length,1);assert.equal(f.foundation.checkpoints.db.list<any>('effect')[0].value.status,'confirmed');f.sqlite.close();
});
test('Capture failure after actual submit cannot publish success or retry the effect',async()=>{
 const f=await fixture();f.setSaveFail(true);
 const result=await f.runner.run({task:f.task('apply','apply'),mission:async hooks=>{await f.submit(hooks);return{status:'succeeded'};}});
 // The submit happened and the agent self-verified it, so the effect is confirmed — but the
 // capture (durable save) failed, so success cannot be published and the task pauses.
 assert.equal(f.getSubmissions(),1);assert.equal(result.status,'needsHuman');assert.equal(f.foundation.checkpoints.db.list('completion').length,0);assert.equal(f.foundation.checkpoints.db.list<any>('effect')[0].value.status,'confirmed');
 // The resume re-observes the page, sees the submit already happened, and does not resubmit.
 // The agent confirms the effect from that observation and the task succeeds.
 f.setSaveFail(false);const retried=await f.runner.run({task:result,resume:true,mission:async()=>{return{status:'succeeded'};}});assert.equal(f.getSubmissions(),1);assert.equal(retried.status,'succeeded');assert.equal(f.foundation.checkpoints.db.list<any>('effect')[0].value.status,'confirmed');f.sqlite.close();
});
test('LLM done without trusted completion proof pauses and commits only a needsHuman checkpoint',async()=>{
 const f=await fixture();f.setProof(false);const result=await f.runner.run({task:f.task(),mission:async()=>({status:'succeeded',sessionID:'session'})});
 // No user-facing help is invented: the pause is silent, the reason stays in the log for operators.
 assert.equal(result.status,'needsHuman');assert.equal(result.help,null);assert.ok((result.log??[]).some((l:string)=>l.includes('Mission claimed success without trusted completion proof')));assert.equal(f.foundation.checkpoints.db.list('completion').length,0);assert.equal(f.foundation.checkpoints.db.list<any>('checkpoint')[0].value.phase,'needsHuman');f.sqlite.close();
});
test('Pause and resume retain run ID and consumed approval; fresh effects advance cursor',async()=>{
 const f=await fixture();let firstRun='';
 const paused=await f.runner.run({task:f.task(),mission:async(hooks,runId)=>{firstRun=runId;await f.submit(hooks);return{status:'needs_human',sessionID:'session',help:{id:'help',kind:'verification',message:'Please finish',questions:[]}};}});
 assert.equal(paused.status,'needsHuman');
 const resumed=await f.runner.run({task:{...paused,status:'approved',help:null},resume:true,mission:async(hooks,runId)=>{assert.equal(runId,firstRun);await f.submit(hooks);return{status:'succeeded',extractedItems:['listing']};}});
 assert.equal(resumed.status,'succeeded');assert.equal(f.getSubmissions(),2);assert.equal(f.foundation.checkpoints.db.list('consent_consumed').length,2);assert.equal(f.foundation.checkpoints.db.list('run').length,1);f.sqlite.close();
});
test('Owner queue serializes different HTTP/scheduler/probe missions and rejects second runner incarnation admission',async()=>{
 const f=await fixture();let release!:()=>void;const wait=new Promise<void>(r=>release=r);let active=0,max=0;
 const mission=async()=>{active++;max=Math.max(max,active);await wait;active--;return{status:'succeeded',extractedItems:['listing']};};
 const first=f.runner.run({task:f.task('http'),mission});await new Promise(r=>setTimeout(r,10));
 const other=createWorkspaceTaskRunner(f.config);await assert.rejects(other.run({task:f.task('other'),mission}),/WORKSPACE_ADMISSION_BUSY/);
 const second=f.runner.run({task:f.task('scheduler'),mission});release();await Promise.all([first,second]);assert.equal(max,1);f.sqlite.close();
});
test('Injected projection failure after capture rolls back canonical success and outbox, preserving committed objects',async()=>{
 const f=await fixture();f.sqlite.exec("CREATE TRIGGER reject_success BEFORE UPDATE ON tasks WHEN json_extract(NEW.task,'$.status')='succeeded' BEGIN SELECT RAISE(ABORT,'projection failure'); END;");
 const result=await f.runner.run({task:f.task(),mission:async()=>({status:'succeeded',extractedItems:['listing']})});assert.equal(result.status,'needsHuman');assert.equal(f.foundation.checkpoints.db.list('completion').length,0);assert.equal(f.foundation.checkpoints.db.list('outbox').length,0);assert.ok(f.objects.size>0);
 assert.equal(f.foundation.checkpoints.db.list<any>('run')[0].value.completed,false);f.sqlite.exec('DROP TRIGGER reject_success');
 const restored=await f.runner.run({task:result,resume:true,mission:async()=>({status:'succeeded',extractedItems:['listing']})});assert.equal(restored.status,'succeeded');assert.equal(f.foundation.checkpoints.db.list('completion').length,1);f.sqlite.close();
});
test('Rejection closes canonical run and source task; later admission cannot revive it',async()=>{
 const f=await fixture();const paused=await f.runner.run({task:f.task(),mission:async()=>({status:'needs_info',help:{id:'question',kind:'information',message:'Which location?',questions:[]}})});
 const rejected=await f.runner.reject(paused);assert.equal(rejected.status,'rejected');const result=await f.runner.run({task:{...rejected,status:'approved'},resume:true,mission:async()=>{throw Error('must not run');}});assert.equal(result.status,'rejected');assert.equal(f.foundation.checkpoints.db.list<any>('run')[0].value.completed,true);f.sqlite.close();
});
test('Private evidence IDs reject changed payload rather than silently retaining incompatible evidence',async()=>{
 const f=await fixture();let firstRun='';f.setProof(false);
 const paused=await f.runner.run({task:f.task(),mission:async(_hooks,runId)=>{firstRun=runId;return{status:'succeeded'};}});
 const ref='complete_'+firstRun.replaceAll('-','');f.foundation.checkpoints.db.storage.transactionSync(()=>f.foundation.checkpoints.db.put('runner_evidence',ref,0,{different:true}));f.setProof(true);
 const result=await f.runner.run({task:paused,resume:true,mission:async()=>({status:'succeeded',extractedItems:['listing']})});assert.equal(result.status,'needsHuman');assert.equal(f.foundation.checkpoints.db.list('completion').length,0);f.sqlite.close();
});


test('Trusted credential/session changes made during mission survive final projection; arbitrary model result patches do not',async()=>{
 const f=await fixture();const result=await f.runner.run({task:f.task(),mission:async(_hooks,_run,task)=>{task.credential_id='credential-owned';task.session_id='live-session';task.email_code_available=true;return{status:'succeeded',extractedItems:['listing'],credential_id:'model-forged',arbitrary:'must-not-project'};}});
 assert.equal(result.credential_id,'credential-owned');assert.equal(result.session_id,'live-session');assert.equal(result.email_code_available,true);assert.equal(result.arbitrary,undefined);assert.equal(JSON.parse(String(f.sqlite.prepare('SELECT task FROM tasks').get()!.task)).credential_id,'credential-owned');f.sqlite.close();
});

test('Reject safely cancels prepared work without reviving or consuming its approval',async()=>{
 const f=await fixture();const deny={...f.config,authorizeAction:async()=>({approvalId:'grant',approvalScopeHash:'scope'})};
 // Foundation consent policy sees no matching runner grant only when the test deliberately interrupts before prepare.
 const runner=createWorkspaceTaskRunner(deny);
 const task=await runner.run({task:f.task(),mission:async hooks=>{const before=f.foundation.effects.dispatch.bind(f.foundation.effects);f.foundation.effects.dispatch=async()=>{throw Error('before-dispatch failure');};try{await hooks.onActionBefore({decision:{action:'click'},snapshot:null,sessionID:null});}finally{f.foundation.effects.dispatch=before;}return{status:'needs_human'};}});
 assert.equal(task.status,'needsHuman');const effect=f.foundation.checkpoints.db.list<any>('effect')[0].value;assert.equal(effect.status,'prepared');
 const rejected=await runner.reject(task);assert.equal(rejected.status,'rejected');assert.equal(f.foundation.effects.require(effect.effectId).status,'not_applied');assert.equal(f.foundation.checkpoints.db.get('consent_consumed','grant'),null);f.sqlite.close();
});

test('Agent self-verification resolves the exact pending effect and resumes inspection without replaying it',async()=>{
 const f=await fixture();let runId='';f.setUncertainVerdict({status:'uncertain',evidence:{}});
 const paused=await f.runner.run({task:f.task('review','apply'),mission:async(hooks,run)=>{runId=run;const t=await hooks.onActionBefore({decision:{action:'click',target:'Submit'},snapshot:null,sessionID:null});await hooks.onActionAfter(t,{error:Error('timeout')});return{status:'succeeded'};}});
 assert.equal(paused.status,'needsHuman');
 const effect=f.foundation.checkpoints.db.list<any>('effect')[0].value;assert.equal(effect.status,'uncertain');
 // No user review: the agent re-observes the live page and confirms the submit happened.
 f.setUncertainVerdict({status:'confirmed',evidence:{observed:'yes'}});
 const reconciled=await f.runner.reconcile({taskId:'review',effectId:effect.effectId});assert.equal(reconciled.status,'needsHuman');assert.equal(reconciled.authorized_action,null);assert.equal(f.foundation.checkpoints.db.get<any>('runner_task','review')!.value.pendingEffectId,null);assert.equal(f.foundation.checkpoints.db.list('consent_consumed').length,1);
 assert.equal(f.foundation.effects.require(effect.effectId).status,'confirmed');
 const complete=await f.runner.run({task:reconciled,resume:true,mission:async(_hooks,currentRun)=>{assert.equal(currentRun,runId);return{status:'succeeded',extractedItems:['receipt']};}});assert.equal(complete.status,'succeeded');assert.equal(f.foundation.checkpoints.db.list('effect').length,1);f.sqlite.close();
});

test('Not-applied self-verification lets the mission retry without fresh approval; the action is never duplicated',async()=>{
 const f=await fixture();f.setUncertainVerdict({status:'uncertain',evidence:{}});
 const paused=await f.runner.run({task:f.task('review','apply'),mission:async hooks=>{const t=await hooks.onActionBefore({decision:{action:'click',target:'Submit'},snapshot:null,sessionID:null});await hooks.onActionAfter(t,{error:Error('timeout')});return{status:'succeeded'};}});
 assert.equal(paused.status,'needsHuman');
 const effect=f.foundation.checkpoints.db.list<any>('effect')[0].value;assert.equal(effect.status,'uncertain');
 assert.equal(f.foundation.checkpoints.db.list('consent_consumed').length,1,'the uncertain submit consumed one approval');
 // The agent re-observes and finds the submit did not happen, so it is safe to retry.
 f.setUncertainVerdict({status:'not_applied',evidence:{observed:'no'}});
 const reconciled=await f.runner.reconcile({taskId:'review',effectId:effect.effectId});assert.equal(reconciled.status,'needsHuman');assert.equal(f.foundation.effects.require(effect.effectId).status,'not_applied');assert.equal(f.foundation.checkpoints.db.get<any>('runner_task','review')!.value.pendingEffectId,null);assert.equal((reconciled as any).workspace_requires_fresh_approval,undefined);
 assert.equal(f.foundation.checkpoints.db.list('consent_consumed').length,1,'reconcile consumes nothing and never revives the old approval');
 // No fresh approval is required: the retry re-dispatches the action once and succeeds.
 const finished=await f.runner.run({task:reconciled,resume:true,mission:async hooks=>{await f.submit(hooks);return{status:'succeeded',extractedItems:['receipt']};}});assert.equal(finished.status,'succeeded');assert.equal(f.getSubmissions(),1);assert.equal(f.foundation.checkpoints.db.list('effect').length,2);assert.equal(f.foundation.effects.require(effect.effectId).status,'not_applied');
 // The retry consumed a FRESH approval (length 1 -> 2): the old
 // consumed approval was never revived by the self-verification
 // retry path. A revived approval would have let the retry reuse
 // the first submit's grant and left the length at 1.
 assert.equal(f.foundation.checkpoints.db.list('consent_consumed').length,2,'the retry consumed a fresh approval');f.sqlite.close();
});

test('An uncertain effect is resolved by the agent re-observing the live page, with no user review',async()=>{
 const f=await fixture();
 // The action was dispatched but its observation was lost (no onActionAfter). The mission
 // returns; the agent re-observes the page, confirms the submit happened, and the task completes.
 const result=await f.runner.run({task:f.task('apply','apply'),mission:async hooks=>{await hooks.onActionBefore({decision:{action:'click',target:'Submit'},snapshot:null,sessionID:null});return{status:'succeeded'};}});
 // The agent re-observed the page, confirmed the submit happened, and the task completed.
 // No reconcile call, no user review, no help prompt.
 assert.equal(result.status,'succeeded');assert.equal(result.help,null);assert.equal(f.foundation.checkpoints.db.list<any>('effect')[0].value.status,'confirmed');
 const evidence=f.foundation.checkpoints.db.list<any>('runner_evidence').map((e:any)=>e.value);
 assert.ok(evidence.some((p:any)=>p.verifiedBy==='agent' && p.effectId===f.foundation.checkpoints.db.list<any>('effect')[0].value.effectId),'resolution evidence is agent self-verification, not a user review');
 assert.equal(evidence.filter((p:any)=>p.reviewedBy).length,0);f.sqlite.close();
});

test('Reconcile does not require reviewed:true',async()=>{
 const f=await fixture();f.setUncertainVerdict({status:'uncertain',evidence:{}});
 const paused=await f.runner.run({task:f.task('review','apply'),mission:async hooks=>{const t=await hooks.onActionBefore({decision:{action:'click',target:'Submit'},snapshot:null,sessionID:null});await hooks.onActionAfter(t,{error:Error('timeout')});return{status:'succeeded'};}});
 assert.equal(paused.status,'needsHuman');
 const effect=f.foundation.checkpoints.db.list<any>('effect')[0].value;
 // Reconcile takes only the task and effect ids. No reviewed flag, no review evidence,
 // no user tap anywhere in the call.
 f.setUncertainVerdict({status:'not_applied',evidence:{observed:'no'}});
 const reconciled=await f.runner.reconcile({taskId:'review',effectId:effect.effectId});
 assert.equal(reconciled.status,'needsHuman');assert.equal(f.foundation.effects.require(effect.effectId).status,'not_applied');
 assert.equal(f.foundation.checkpoints.db.list<any>('runner_evidence').map((e:any)=>e.value).filter((p:any)=>p.reviewedBy).length,0);f.sqlite.close();
});

test('No user-facing help string contains a bracketed internal code',async()=>{
 const f=await fixture();f.setUncertainVerdict({status:'uncertain',evidence:{}});
 // A mission interrupted mid-flight: the code stays in the log, help stays null.
 const interrupted=await f.runner.run({task:f.task('interrupted'),mission:async hooks=>{const t=await hooks.onActionBefore({decision:{action:'click',target:'Submit'},snapshot:null,sessionID:null});await hooks.onActionAfter(t,{error:new Error('lost response')});throw new Error('WORKSPACE_ACTION_UNCERTAIN');}});
 assert.equal(interrupted.status,'needsHuman');assert.equal(interrupted.help,null);
 assert.ok((interrupted.log??[]).some((l:string)=>l.includes('[WORKSPACE_ACTION_UNCERTAIN]')),'code is preserved in the log for operators');
 // A mission that claims success without proof: same — silent pause, no help string.
 f.setProof(false);
 const unproven=await f.runner.run({task:f.task('unproven'),mission:async()=>({status:'succeeded',sessionID:'session'})});
 assert.equal(unproven.status,'needsHuman');assert.equal(unproven.help,null);
 // Any help the runner ever surfaces must not carry a bracketed code.
 for(const t of [interrupted,unproven]){if(t.help)assert.ok(!/\[.*\]/.test(t.help.message),'help must not contain a bracketed internal code');}
 f.sqlite.close();
});

test('Initial navigation loss retains trusted pre-reserved session and credential metadata for owner review',async()=>{
 const f=await fixture();let expectedSession='';let navigated=false;
 // The browser.create response was lost, so the navigation outcome cannot be verified from
 // any page: the effect stays uncertain and the task pauses with its pre-reserved session.
 f.setUncertainVerdict({status:'uncertain',evidence:{}});
 const result=await f.runner.run({task:{...f.task('initial-navigation'),session_id:null},mission:async(hooks,_run,task)=>{
   // The LLM re-observes on retry: the navigation was already attempted, so it does not re-navigate.
   if(!navigated){
     const ticket=await hooks.onActionBefore({decision:{action:'navigate',target:'https://jobs.example'},snapshot:null,sessionID:null});
     expectedSession=ticket.effectId;
     task.session_id=expectedSession;task.credential_id='owner-credential';task.email_code_available=true;
     navigated=true;
   }
   throw new Error('initial browser.create response lost');
 }});
 assert.equal(result.status,'needsHuman');assert.equal(result.session_id,expectedSession);assert.equal(result.credential_id,'owner-credential');assert.equal(result.email_code_available,true);
 const persisted=JSON.parse(String(f.sqlite.prepare('SELECT task FROM tasks WHERE id=?').get('initial-navigation')!.task));assert.equal(persisted.session_id,expectedSession);
 assert.equal(f.foundation.checkpoints.db.list<any>('effect')[0].value.status,'uncertain');assert.equal(f.foundation.checkpoints.db.list('completion').length,0);f.sqlite.close();
});


test('Last-resort recovery projection retains initial session even if uncertainty journaling itself is unavailable',async()=>{
 const f=await fixture();f.foundation.effects.noteUncertain=async()=>{throw Error('lease expired before outcome journal');};let session='';
 const result=await f.runner.run({task:{...f.task('journal-outage'),session_id:null},mission:async(hooks,_run,task)=>{const ticket=await hooks.onActionBefore({decision:{action:'navigate'},snapshot:null,sessionID:null});session=ticket.effectId;task.session_id=session;task.credential_id='owner-key';throw Error('lost initial nav');}});
 assert.equal(result.status,'needsHuman');assert.equal(result.session_id,session);assert.equal(result.credential_id,'owner-key');assert.equal(result.workspace_persistence_error,true);assert.equal(f.foundation.checkpoints.db.list<any>('effect')[0].value.status,'dispatching');assert.equal(f.foundation.checkpoints.db.list('completion').length,0);f.sqlite.close();
});


async function seedRecovery(f:Awaited<ReturnType<typeof fixture>>){await f.config.saveWorkspace({task:f.task('bootstrap'),runId:'bootstrap',reason:'pause',evidence:[],requiresBrowserFreeze:true});}
async function replaceIncarnation(f:Awaited<ReturnType<typeof fixture>>){
 const before=await f.foundation.registry.read(owner,owner);await f.foundation.registry.fence(owner,owner,before.generation,'operator_fence');
 f.runner.recoverAdmission(()=>{const saved=f.foundation.checkpoints.db.storage.sql.exec('SELECT value FROM workspace_registry WHERE key = ?', 'workspace/staging/private-a/workspace-a');assert.equal(JSON.parse(String([...saved][0].value)).binding.lifecycleState,'stopped');});
 await f.foundation.registry.ensure(owner,owner,'operator_replace');
}

test('Fenced old model continuation cannot mint replacement capabilities, dispatch or clear a newer admission',async()=>{
 const f=await fixture();await seedRecovery(f);
 let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>enter=r),held=new Promise<void>(r=>release=r);
 let issueCount=0;const originalIssue=f.foundation.broker.issue.bind(f.foundation.broker);f.foundation.broker.issue=async(...args)=>{issueCount++;return originalIssue(...args);};
 const old=f.runner.run({task:f.task('old'),mission:async hooks=>{enter();await held;await hooks.onActionBefore({decision:{action:'click',target:'Submit'},snapshot:null,sessionID:null});return{status:'succeeded'};}}).then(v=>({value:v,error:null}),error=>({value:null,error}));
 await entered;await replaceIncarnation(f);
 const replacement=createWorkspaceTaskRunner(f.config);let enterNew!:()=>void,releaseNew!:()=>void;const enteredNew=new Promise<void>(r=>enterNew=r),heldNew=new Promise<void>(r=>releaseNew=r);
 const fresh=replacement.run({task:f.task('new'),mission:async()=>{enterNew();await heldNew;return{status:'succeeded',extractedItems:['listing']};}});
 await enteredNew;issueCount=0;const admissionBefore=f.foundation.checkpoints.db.get<any>('runner_owner','active')!.value;
 release();const stale=await old;assert.match(String(stale.error),/STALE_WORKSPACE_EXECUTION/);assert.equal(issueCount,0);assert.equal(f.foundation.checkpoints.db.list('effect').length,0);assert.equal(f.foundation.checkpoints.db.list('runner_authorization').length,0);
 assert.deepEqual(f.foundation.checkpoints.db.get<any>('runner_owner','active')!.value,admissionBefore);assert.equal(f.foundation.checkpoints.db.get<any>('runner_task','new')!.value.status,'running');
 releaseNew();assert.equal((await fresh).status,'succeeded');f.sqlite.close();
});

test('Fence during async consent verification invalidates the old action before grant storage or dispatch',async()=>{
 const f=await fixture();await seedRecovery(f);let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>enter=r),held=new Promise<void>(r=>release=r);
 const runner=createWorkspaceTaskRunner({...f.config,authorizeAction:async(_task,input)=>{enter();await held;return{approvalId:'fresh_'+input.effectId,approvalScopeHash:input.intentHash};}});
 const old=runner.run({task:f.task('old-consent'),mission:async hooks=>{await hooks.onActionBefore({decision:{action:'click'},snapshot:null,sessionID:null});return{status:'succeeded'};}}).then(()=>null,error=>error);
 await entered;await replaceIncarnation(f);release();assert.match(String(await old),/STALE_WORKSPACE_EXECUTION/);assert.equal(f.foundation.checkpoints.db.list('effect').length,0);assert.equal(f.foundation.checkpoints.db.list('runner_authorization').length,0);f.sqlite.close();
});

test('Fence during outcome verification preserves operator uncertainty and blocks old confirmation/capture',async()=>{
 const f=await fixture();await seedRecovery(f);let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>enter=r),held=new Promise<void>(r=>release=r);
 const runner=createWorkspaceTaskRunner({...f.config,verifyActionOutcome:async()=>{enter();await held;return{status:'confirmed',evidence:{observed:'yes'}};}});
 const old=runner.run({task:f.task('old-outcome'),mission:async hooks=>{const t=await hooks.onActionBefore({decision:{action:'click'},snapshot:null,sessionID:null});await hooks.onActionAfter(t,{result:{succeeded:true}});return{status:'succeeded'};}}).then(()=>null,error=>error);
 await entered;await replaceIncarnation(f);const receiptsBefore=f.foundation.checkpoints.db.storage.sql.exec("SELECT COUNT(*) n FROM workspace_registry WHERE key LIKE 'receipt/%'");const receiptCount=Number([...receiptsBefore][0].n);
 release();assert.match(String(await old),/STALE_WORKSPACE_EXECUTION/);assert.equal(f.foundation.checkpoints.db.list<any>('effect')[0].value.status,'uncertain');assert.equal(f.foundation.checkpoints.db.list('completion').length,0);
 assert.equal(Number([...f.foundation.checkpoints.db.storage.sql.exec("SELECT COUNT(*) n FROM workspace_registry WHERE key LIKE 'receipt/%'")][0].n),receiptCount);f.sqlite.close();
});

test('Heartbeats may extend expiry without upgrading the execution lineage anchor',async()=>{
 const f=await fixture();const result=await f.runner.run({task:f.task('heartbeat'),mission:async hooks=>{const lease=await f.foundation.registry.readLease(owner,owner);await f.foundation.registry.heartbeat(owner,lease);await f.submit(hooks);return{status:'succeeded',extractedItems:['listing']};}});assert.equal(result.status,'succeeded');f.sqlite.close();
});


test('Synchronous onSession projects only live owner session pointer and rejects stale callback after replacement',async()=>{
 const f=await fixture();await seedRecovery(f);
 let oldHooks:WorkspaceMissionHooks|null=null,enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>enter=r),held=new Promise<void>(r=>release=r);
 const old=f.runner.run({task:{...f.task('old-session'),goal:'original goal'},mission:async(hooks,_run,task)=>{
   oldHooks=hooks;task.session_id='reserved-session';hooks.onSession?.('reserved-session');
   const stored=JSON.parse(String(f.sqlite.prepare('SELECT task FROM tasks WHERE id=?').get('old-session')!.task));assert.equal(stored.session_id,'reserved-session');assert.equal(stored.goal,'original goal');assert.equal(stored.status,'running');
   enter();await held;return{status:'succeeded',extractedItems:['listing']};
 }}).then(()=>null,error=>error);
 await entered;await replaceIncarnation(f);
 const replacement=createWorkspaceTaskRunner(f.config);let enterNew!:()=>void,releaseNew!:()=>void;const enteredNew=new Promise<void>(r=>enterNew=r),heldNew=new Promise<void>(r=>releaseNew=r);
 const fresh=replacement.run({task:f.task('new-session'),mission:async hooks=>{hooks.onSession?.('current-session');enterNew();await heldNew;return{status:'succeeded',extractedItems:['listing']};}});
 await enteredNew;const before=String(f.sqlite.prepare('SELECT task FROM tasks WHERE id=?').get('new-session')!.task);
 assert.throws(()=>oldHooks!.onSession?.('stale-session'),/STALE_GENERATION|STALE_WORKSPACE_EXECUTION/);
 assert.equal(String(f.sqlite.prepare('SELECT task FROM tasks WHERE id=?').get('new-session')!.task),before);
 assert.equal(JSON.parse(String(f.sqlite.prepare('SELECT task FROM tasks WHERE id=?').get('old-session')!.task)).session_id,'reserved-session');
 release();assert.match(String(await old),/STALE_WORKSPACE_EXECUTION/);releaseNew();assert.equal((await fresh).status,'succeeded');f.sqlite.close();
});

test('exhausted undispatched delivery fails visibly through canonical projection, once',async()=>{
 const f=await fixture(),task=f.task('undelivered');
 const result=f.runner.deliveryFailed(task,'job-a');assert.equal(result.status,'failed');assert.equal(result.failure.code,'job_delivery_exhausted');
 const projected=JSON.parse(String(f.sqlite.prepare('SELECT task FROM tasks WHERE id=?').get(task.id)!.task));assert.equal(projected.status,'failed');
 const count=f.foundation.persistence.list('task_projection_outbox').length;assert.deepEqual(f.runner.deliveryFailed(task,'job-a'),result);assert.equal(f.foundation.persistence.list('task_projection_outbox').length,count);
 assert.equal(f.foundation.persistence.list('effect').length,0);assert.equal(f.foundation.persistence.list('completion').length,0);f.sqlite.close();
});
test('exhausted delivery retains unknown effect, consumed approval, and orphan admission',async()=>{
 const f=await fixture();const task=await f.runner.run({task:f.task('uncertain','apply'),mission:async hooks=>{
  const ticket=await hooks.onActionBefore({decision:{action:'click',target:'Submit'},snapshot:null,sessionID:'s'});
  await hooks.onActionAfter(ticket,{error:Error('lost response')});return{status:'succeeded'};
 }});
 const before=f.foundation.persistence.list<any>('effect')[0];
 f.foundation.persistence.put('runner_owner','active',0,{instanceId:'retired-instance',taskId:task.id,executionId:'old'});
 const result=f.runner.deliveryFailed(task,'job-exhausted');assert.equal(result.status,'needsHuman');assert.equal(result.workspace_pending_effect_id,task.workspace_pending_effect_id);
 assert.deepEqual(f.foundation.persistence.list<any>('effect')[0],before);assert.ok(f.foundation.persistence.get('runner_owner','active'));
 assert.equal(f.foundation.persistence.list('completion').length,0);f.sqlite.close();
});
test('dead-letter interleaving never changes a live run and cannot overwrite its verified success',async()=>{
 const f=await fixture();let entered!:()=>void,release!:()=>void;const inside=new Promise<void>(r=>entered=r),hold=new Promise<void>(r=>release=r);
 const running=f.runner.run({task:f.task('live'),mission:async()=>{entered();await hold;return{status:'succeeded',extractedItems:['verified listing']};}});
 await inside;const before=f.foundation.persistence.get('runner_task','live');const admission=f.foundation.persistence.get('runner_owner','active');
 assert.equal(f.runner.deliveryFailed(f.task('live'),'job-live').status,'running');
 assert.deepEqual(f.foundation.persistence.get('runner_task','live'),before);assert.deepEqual(f.foundation.persistence.get('runner_owner','active'),admission);
 release();assert.equal((await running).status,'succeeded');assert.equal(f.runner.deliveryFailed(f.task('live'),'job-live').status,'succeeded');
 assert.equal(f.foundation.persistence.list('completion').length,1);assert.equal(f.foundation.persistence.get('runner_owner','active'),null);f.sqlite.close();
});
test('background documents share admission, fail fast while busy, and serialize before browser missions',async()=>{
 const f=await fixture();let entered!:()=>void,release!:()=>void;const inside=new Promise<void>(r=>entered=r),hold=new Promise<void>(r=>release=r);let ran=false;
 const file=f.runner.withWorkspaceMutation('document-save',async()=>{entered();await hold;return 'saved';});await inside;
 await assert.rejects(f.runner.withWorkspaceMutation('document-delete',async()=>{}),/ADMISSION_BUSY/);
 const mission=f.runner.run({task:f.task('after-file'),mission:async()=>{ran=true;return{status:'succeeded',extractedItems:['verified']};}});
 await Promise.resolve();assert.equal(ran,false);assert.equal(f.foundation.persistence.get<any>('runner_owner','active')!.value.taskId,'document-save');
 release();assert.equal(await file,'saved');assert.equal((await mission).status,'succeeded');assert.equal(ran,true);
 f.foundation.persistence.put('runner_owner','active',0,{instanceId:'old-file-writer',taskId:'document-save',executionId:'old'});
 await assert.rejects(f.runner.withWorkspaceMutation('document-save',async()=>{}),/ADMISSION_BUSY/);assert.ok(f.foundation.persistence.get('runner_owner','active'));f.sqlite.close();
});
test('invalid action shape is diagnosed before effect admission without logging rejected content',async()=>{
 const f=await fixture();let dispatched=false;
 const result=await f.runner.run({task:f.task('invalid'),mission:async hooks=>{
  await hooks.onActionBefore({decision:{action:'scroll',targetLabel:undefined},snapshot:null,sessionID:null});dispatched=true;return{status:'succeeded'};
 }});
 assert.equal(result.status,'needsHuman');assert.equal(dispatched,false);assert.equal(f.foundation.persistence.list('effect').length,0);
 assert.ok(result.log.some((line:string)=>line.includes('path=$.decision.targetLabel type=undefined')));f.sqlite.close();
});
test('replayed terminal tasks keep their final progress phase when startup is retried',async()=>{
 const f=await fixture();await f.runner.run({task:f.task('finished'),mission:async()=>({status:'succeeded',extractedItems:['verified']})});
 const progress=f.runner.progress('finished');f.runner.waiting('finished');f.runner.unavailable('finished');assert.deepEqual(f.runner.progress('finished'),progress);f.sqlite.close();
});
