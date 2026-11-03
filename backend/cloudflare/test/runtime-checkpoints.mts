import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sqliteWorkspace} from './helpers/workspace-sqlite.mts';
import {WorkspacePersistence, WorkspaceError, runtimeAuthority, type RuntimeAuthority} from '../src/workspace-persistence.ts';
import {EffectLedger} from '../src/effect-ledger.ts';
import {CheckpointService} from '../src/runtime-checkpoints.ts';
import type {RuntimeLease, WorkspaceDurabilityReceipt} from '../src/workspace-contract.ts';

const owner={environment:'staging' as const,userId:'alice',workspaceId:'alice-workspace'};
const bodyHash='a'.repeat(64);
function fixture(){
  const f=sqliteWorkspace(), db=new WorkspacePersistence(f.storage,owner);
  let generation=1, verified=true, postcondition=true;
  const lease=():RuntimeLease=>({...owner,runtimeId:'runtime-'+generation,incarnation:'incarnation-'+generation,generation,leaseId:'lease',expiresAt:'2099-01-01T00:00:00.000Z'});
  const authority:RuntimeAuthority={authorize:async(token)=>{if(token!=='valid')throw new WorkspaceError('UNAUTHORIZED');return lease();},assertCurrent:(l)=>{if(l.generation!==generation)throw new WorkspaceError('STALE_GENERATION');}};
  const durability:WorkspaceDurabilityReceipt={...owner,receiptId:'durable-1',writeId:'write-1',generation:1,incarnation:'incarnation-1',filesystemRevision:4,browserProfileRevision:2,coveredArtifactRefs:['evidence','candidate','context'],committedAt:'2026-11-02T12:00:00Z',recoveryPoint:{...owner,checkpointId:'manifest-1',sequence:4,sourceIncarnation:'incarnation-1',sourceGeneration:1,manifestHash:'b'.repeat(64),storage:'r2',policyVersion:'1'}};
  const effects=new EffectLedger(db,authority,{assertDispatchAllowed(){}},async()=>true);
  const service=new CheckpointService(db,authority,effects,async(o,id)=>{if(!verified||id!==durability.receiptId)throw new WorkspaceError('PERSISTENCE_UNAVAILABLE');return structuredClone(durability);},async()=>postcondition,()=> '2026-11-02T12:00:00Z');
  const ctx=(requestId:string,expectedRevision:number)=>({requestId,expectedRevision,capabilityToken:'valid'});
  const definition={taskId:'task',runId:'run',siteOrigin:'https://jobs.example',outcome:'apply' as const,candidate:{kind:'confirming' as const,bodyHash}};
  const checkpoint={...owner,schemaVersion:1 as const,taskId:'task',runId:'run',filesystemRevision:4,browserProfileRevision:2,workspaceDurabilityReceiptId:'durable-1',privateArtifactRefs:['candidate','context'],helpId:null};
  const input={runId:'run',checkpoint,candidateBodyHash:bodyHash,verification:{kind:'observed_postcondition' as const,policyVersion:'1',evidenceRef:'evidence'}};
  return {...f,db,authority,effects,service,durability,ctx,definition,checkpoint,input,setVerified:(x:boolean)=>{verified=x;},setPostcondition:(x:boolean)=>{postcondition=x;},nextGeneration:()=>{generation++;}};
}
test('DO SQLite completion commits task/checkpoint/immutable receipt/outbox together; retries return receipt',async()=>{
 const f=fixture();await f.service.startRun(f.ctx('start',0),f.definition);
 const result=await f.service.complete(f.ctx('finish',1),f.input);
 assert.equal(result.taskRevision,2);assert.equal(result.candidateBodyHash,bodyHash);
 assert.deepEqual(await f.service.complete(f.ctx('finish',1),f.input),result);
 assert.deepEqual(await f.service.getCanonicalRunReceipt(owner,result.receiptId),result);
 assert.equal(f.db.list('outbox').length,1);assert.equal(f.db.get<any>('runtime_task','task')!.value.status,'succeeded');
 await assert.rejects(f.service.complete(f.ctx('finish',1),{...f.input,candidateBodyHash:'c'.repeat(64)}),/IDEMPOTENCY_CONFLICT/);
 assert.equal(await f.service.verifyDurabilityCoverage(owner,result,['context']),true);
 assert.equal(await f.service.verifyDurabilityCoverage(owner,{...result,candidateBodyHash:null},[]),false);
 assert.equal(await f.service.verifyDurabilityCoverage(owner,result,['missing']),false);
 f.nextGeneration();assert.equal(await f.service.verifyDurabilityCoverage(owner,result,[]),true,'committed historical receipt survives replacement');
 f.sqlite.close();
});
test('No success without verified object commit, durable evidence, exact versions or verified postcondition',async()=>{
 for(const mode of ['missing','evidence','revision','owner','postcondition','candidate']){
 const f=fixture();await f.service.startRun(f.ctx('start',0),f.definition);let input=structuredClone(f.input);
 if(mode==='missing')f.setVerified(false);
 if(mode==='evidence')input.verification.evidenceRef='not-in-capture';
 if(mode==='revision')input.checkpoint.filesystemRevision++;
 if(mode==='owner')input.checkpoint.userId='bob';
 if(mode==='postcondition')f.setPostcondition(false);
 if(mode==='candidate')input.candidateBodyHash='c'.repeat(64);
 await assert.rejects(f.service.complete(f.ctx('finish',1),input));
 assert.equal(f.db.list('completion').length,0);assert.equal(f.db.list('outbox').length,0);assert.equal(f.db.get<any>('run','run')!.value.completed,false);f.sqlite.close();
 }
});
test('CAS/racing requests cannot manufacture two run receipts; owner and secret-token access rejects',async()=>{
 const f=fixture();await f.service.startRun(f.ctx('start',0),f.definition);
 const results=await Promise.allSettled([f.service.complete(f.ctx('finish-a',1),f.input),f.service.complete(f.ctx('finish-b',1),f.input)]);
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(f.db.list('completion').length,1);
 await assert.rejects(f.service.getCanonicalRunReceipt({...owner,userId:'bob'},'anything'),/OWNER_MISMATCH/);
 await assert.rejects(f.service.startRun({...f.ctx('denied',0),capabilityToken:'bad'}, {...f.definition,runId:'run2'}),/UNAUTHORIZED/);f.sqlite.close();
});
test('Persisted prepared/dispatching/consent state survives service recreation; crash never grants replay',async()=>{
 const f=fixture();await f.service.startRun(f.ctx('start',0),f.definition);
 const intent={effectId:'effect',taskId:'task',runId:'run',intentHash:'semantic-hash',approvalId:'approval',approvalScopeHash:'scope'};
 await f.effects.prepare(f.ctx('prepare',0),intent);
 await f.effects.dispatch(f.ctx('dispatch',1),'effect');
 assert.equal(f.db.get<any>('consent_consumed','approval')!.value.effectId,'effect');
 await assert.rejects(f.service.complete(f.ctx('finish',1),f.input),/OUTCOME_UNCERTAIN/);
 const recreated=new EffectLedger(new WorkspacePersistence(f.storage,owner),f.authority,{assertDispatchAllowed(){}},async()=>true);
 assert.throws(()=>recreated.recoverDispatches(()=>{throw new Error('fence unavailable');}),/fence unavailable/);
 assert.equal(recreated.require('effect').status,'dispatching');
 assert.equal(recreated.recoverDispatches(()=>{}),1);assert.equal(recreated.require('effect').status,'uncertain');
 await assert.rejects(recreated.dispatch(f.ctx('replay',3),'effect'),/OUTCOME_UNCERTAIN/);
 await recreated.resolve(f.ctx('resolve',3),'effect','confirmed','evidence');
 assert.equal((await f.service.complete(f.ctx('finish',1),f.input)).status,'succeeded');f.sqlite.close();
});
test('consent consumption rolls back if effect CAS fails; later approval cannot be consumed twice',async()=>{
 const f=fixture();await f.service.startRun(f.ctx('start',0),f.definition);
 const intent={effectId:'one',taskId:'task',runId:'run',intentHash:'hash',approvalId:'approval',approvalScopeHash:'scope'};
 await f.effects.prepare(f.ctx('prepare-one',0),intent);
 await assert.rejects(f.effects.dispatch(f.ctx('wrong-revision',9),'one'),/REVISION_CONFLICT/);
 assert.equal(f.db.get('consent_consumed','approval'),null);
 await f.effects.dispatch(f.ctx('dispatch-one',1),'one');
 await f.effects.prepare(f.ctx('prepare-two',0),{...intent,effectId:'two'});
 await assert.rejects(f.effects.dispatch(f.ctx('dispatch-two',1),'two'),/CONSENT_CONSUMED/);assert.equal(f.effects.require('two').status,'prepared');f.sqlite.close();
});
test('nonterminal checkpoint cannot claim success; stale receipt lineage blocks after runtime replacement',async()=>{
 const f=fixture();await f.service.startRun(f.ctx('start',0),f.definition);
 await assert.rejects(f.service.commit(f.ctx('bad',0),{...f.checkpoint,phase:'succeeded',nextStep:'done'}),/USE_CANONICAL_COMPLETION/);
 f.nextGeneration();await assert.rejects(f.service.commit(f.ctx('stale',0),{...f.checkpoint,phase:'running',nextStep:'inspect'}),/STALE_GENERATION/);f.sqlite.close();
});
test('ordinary successful run has null candidate and cannot count as skill corroboration',async()=>{
 const f=fixture();await f.service.startRun(f.ctx('start',0),{...f.definition,candidate:{kind:'ordinary'}});
 const result=await f.service.complete(f.ctx('finish',1),{...f.input,candidateBodyHash:null});assert.equal(result.candidateBodyHash,null);f.sqlite.close();
});
test('transaction failure rolls back canonical completion AND idempotency receipt',async()=>{
 const f=fixture();await f.service.startRun(f.ctx('start',0),f.definition);
 f.sqlite.exec("CREATE TRIGGER fail_outbox BEFORE INSERT ON hygge_workspace_records WHEN NEW.kind='outbox' BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END;");
 await assert.rejects(f.service.complete(f.ctx('finish',1),f.input),/simulated disk failure/);
 assert.equal(f.db.list('completion').length,0);assert.equal(f.db.get<any>('run','run')!.value.completed,false);
 f.sqlite.exec('DROP TRIGGER fail_outbox');const result=await f.service.complete(f.ctx('finish',1),f.input);assert.equal(result.status,'succeeded');f.sqlite.close();
});

test('Live SQL registry lineage is re-read inside mutation transaction after async authorization',async()=>{
 const f=fixture();const lease:RuntimeLease={...owner,runtimeId:'one',incarnation:'one',generation:1,leaseId:'original',expiresAt:'2099-01-01'};
 f.db.storage.transactionSync(()=>f.db.put('live_registry','current',0,lease));
 const authority=runtimeAuthority(async()=>{f.db.storage.transactionSync(()=>f.db.put('live_registry','current',1,{...lease,incarnation:'two',generation:2,leaseId:'replacement'}));return lease;},()=>f.db.get<RuntimeLease>('live_registry','current')!.value);
 await assert.rejects(f.db.authorized(authority,'checkpoint.commit','task',f.ctx('racing',0),{},()=>{f.db.put('should_not_exist','x',0,{});return true;}),/STALE_GENERATION/);
 assert.equal(f.db.get('should_not_exist','x'),null);f.sqlite.close();
});
test('Lease expiry and changed leaseId reject even with same owner/generation',()=>{
 const lease:RuntimeLease={...owner,runtimeId:'one',incarnation:'one',generation:1,leaseId:'original',expiresAt:'2099-01-01'};
 assert.throws(()=>runtimeAuthority(async()=>lease,()=>({...lease,expiresAt:'2000-01-01'})).assertCurrent(lease),/LEASE_EXPIRED/);
 assert.throws(()=>runtimeAuthority(async()=>lease,()=>({...lease,leaseId:'other'})).assertCurrent(lease),/STALE_GENERATION/);
});

test('Committed completion replay bypasses unavailable or changed proof services but still authenticates and checks live lineage',async()=>{
 const f=fixture();await f.service.startRun(f.ctx('start',0),f.definition);
 const result=await f.service.complete(f.ctx('finish',1),f.input);
 let proofCalls=0;
 const retry=new CheckpointService(f.db,f.authority,f.effects,async()=>{proofCalls++;throw Error('OBJECT_STORE_DOWN');},async()=>{proofCalls++;throw Error('REVIEW_POLICY_CHANGED');});
 assert.deepEqual(await retry.complete(f.ctx('finish',1),f.input),result);assert.equal(proofCalls,0);
 await assert.rejects(retry.complete(f.ctx('finish',1),{...f.input,verification:{...f.input.verification,policyVersion:'changed'}}),/IDEMPOTENCY_CONFLICT/);assert.equal(proofCalls,0);
 await assert.rejects(retry.complete({...f.ctx('finish',1),capabilityToken:'invalid'},f.input),/UNAUTHORIZED/);
 f.authority.assertCurrent=()=>{throw new WorkspaceError('STALE_GENERATION');};
 await assert.rejects(retry.complete(f.ctx('finish',1),f.input),/STALE_GENERATION/);assert.equal(proofCalls,0);f.sqlite.close();
});
test('Committed checkpoint replay succeeds during object verifier outage and rejects changed request content',async()=>{
 const f=fixture();await f.service.startRun(f.ctx('start',0),f.definition);
 const checkpoint={...f.checkpoint,phase:'running' as const,nextStep:'inspect' as const};
 const first=await f.service.commit(f.ctx('checkpoint',0),checkpoint);f.setVerified(false);
 assert.deepEqual(await f.service.commit(f.ctx('checkpoint',0),checkpoint),first);
 await assert.rejects(f.service.commit(f.ctx('checkpoint',0),{...checkpoint,helpId:'changed'}),/IDEMPOTENCY_CONFLICT/);
 await assert.rejects(f.service.commit(f.ctx('fresh',1),checkpoint),/PERSISTENCE_UNAVAILABLE/);f.sqlite.close();
});
test('Committed effect resolution replay survives verifier outage; changed resolution does not bypass idempotency',async()=>{
 const f=fixture();await f.service.startRun(f.ctx('start',0),f.definition);
 await f.effects.prepare(f.ctx('prepare',0),{effectId:'effect',taskId:'task',runId:'run',intentHash:'hash',approvalId:'approval',approvalScopeHash:'scope'});
 await f.effects.dispatch(f.ctx('dispatch',1),'effect');
 const first=await f.effects.resolve(f.ctx('resolve',2),'effect','confirmed','evidence');let checks=0;
 const retry=new EffectLedger(f.db,f.authority,{assertDispatchAllowed(){}},async()=>{checks++;throw Error('VERIFIER_DOWN');});
 assert.deepEqual(await retry.resolve(f.ctx('resolve',2),'effect','confirmed','evidence'),first);assert.equal(checks,0);
 await assert.rejects(retry.resolve(f.ctx('resolve',2),'effect','not_applied','evidence'),/IDEMPOTENCY_CONFLICT/);assert.equal(checks,0);
 f.authority.assertCurrent=()=>{throw new WorkspaceError('LEASE_EXPIRED');};
 await assert.rejects(retry.resolve(f.ctx('resolve',2),'effect','confirmed','evidence'),/LEASE_EXPIRED/);assert.equal(checks,0);f.sqlite.close();
});
test('Prepared cancellation proves non-dispatch atomically and never consumes approval',async()=>{
 const f=fixture();await f.service.startRun(f.ctx('start',0),f.definition);
 await f.effects.prepare(f.ctx('prepare',0),{effectId:'effect',taskId:'task',runId:'run',intentHash:'hash',approvalId:'approval',approvalScopeHash:'scope'});
 const first=await f.effects.cancelPrepared(f.ctx('cancel',1),'effect');assert.equal(first.status,'not_applied');assert.equal(f.db.get('consent_consumed','approval'),null);
 assert.deepEqual(await f.effects.cancelPrepared(f.ctx('cancel',1),'effect'),first);
 await assert.rejects(f.effects.dispatch(f.ctx('dispatch',2),'effect'),/OUTCOME_UNCERTAIN/);
 assert.equal((await f.service.complete(f.ctx('finish',1),f.input)).status,'succeeded');f.sqlite.close();
});
test('Racing prepared cancellation and dispatch have one winner, never a cancelled dispatched effect',async()=>{
 const f=fixture();await f.service.startRun(f.ctx('start',0),f.definition);
 await f.effects.prepare(f.ctx('prepare',0),{effectId:'effect',taskId:'task',runId:'run',intentHash:'hash',approvalId:'approval',approvalScopeHash:'scope'});
 const results=await Promise.allSettled([f.effects.dispatch(f.ctx('dispatch',1),'effect'),f.effects.cancelPrepared(f.ctx('cancel',1),'effect')]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 const state=f.effects.require('effect').status;
 assert.ok(['dispatching','not_applied'].includes(state));assert.equal(f.db.get('consent_consumed','approval')!==null,state==='dispatching');
 if(state==='dispatching')await assert.rejects(f.effects.cancelPrepared(f.ctx('latecancel',2),'effect'),/INVALID_TRANSITION/);f.sqlite.close();
});
test('Generic failed checkpoint is rejected and dispatch waits for explicitly running latest checkpoint',async()=>{
 const f=fixture();await f.service.startRun(f.ctx('start',0),f.definition);
 await assert.rejects(f.service.commit(f.ctx('failed',0),{...f.checkpoint,phase:'failed',nextStep:'inspect'}),/USE_CANONICAL_COMPLETION/);
 assert.equal(f.db.get('checkpoint','run'),null);assert.equal(f.db.get<any>('run','run')!.value.completed,false);
 await f.effects.prepare(f.ctx('prepare',0),{effectId:'effect',taskId:'task',runId:'run',intentHash:'hash',approvalId:'approval',approvalScopeHash:'scope'});
 await f.service.commit(f.ctx('pause',0),{...f.checkpoint,phase:'needsHuman',nextStep:'await_user'});
 await assert.rejects(f.effects.dispatch(f.ctx('blocked',1),'effect'),/RUN_NOT_RUNNING/);assert.equal(f.db.get('consent_consumed','approval'),null);
 await f.service.commit(f.ctx('resume',1),{...f.checkpoint,phase:'running',nextStep:'inspect'});
 assert.equal((await f.effects.dispatch(f.ctx('dispatch',1),'effect')).status,'dispatching');f.sqlite.close();
});
test('Dispatch rejects canonical terminal or uncertain checkpoints even if task projection is still running',async()=>{
 for(const phase of ['failed','succeeded','uncertain'] as const){
 const f=fixture();await f.service.startRun(f.ctx('start',0),f.definition);
 await f.effects.prepare(f.ctx('prepare',0),{effectId:'effect',taskId:'task',runId:'run',intentHash:'hash',approvalId:'approval',approvalScopeHash:'scope'});
 f.db.storage.transactionSync(()=>f.db.put('checkpoint','run',0,{...f.checkpoint,phase}));
 await assert.rejects(f.effects.dispatch(f.ctx('dispatch',1),'effect'),/RUN_NOT_RUNNING/);assert.equal(f.effects.require('effect').status,'prepared');assert.equal(f.db.get('consent_consumed','approval'),null);f.sqlite.close();}
});
