import {test} from 'node:test';import assert from 'node:assert/strict';
import {sqliteWorkspace} from './helpers/workspace-sqlite.mts';import {WorkspacePersistence} from '../src/workspace-persistence.ts';import {WorkspaceMigration} from '../src/workspace-migration.ts';
import type {WorkspaceDurabilityReceipt,RuntimeFenceEvidence} from '../src/workspace-contract.ts';
const owner={environment:'staging' as const,userId:'alice',workspaceId:'workspace'};
function fixture(){const f=sqliteWorkspace(),db=new WorkspacePersistence(f.storage,owner);let sourceRevision=4;let quiescent=true;let fenced=false;let currentCapture=true;
 const receipt:WorkspaceDurabilityReceipt={...owner,receiptId:'verified',writeId:'w',incarnation:'inc-1',generation:1,filesystemRevision:3,browserProfileRevision:2,coveredArtifactRefs:[],committedAt:'2026-11-02',recoveryPoint:{...owner,checkpointId:'checkpoint',sequence:3,sourceIncarnation:'inc-1',sourceGeneration:1,manifestHash:'b'.repeat(64),storage:'r2',policyVersion:'1'}};
 const migration=new WorkspaceMigration(db,{assertQuiescent(){if(!quiescent)throw Error('NOT_QUIESCENT');},assertFence(){if(!fenced)throw Error('FENCE_UNCONFIRMED');},assertLatestSourceRevision(r){if(r!==sourceRevision)throw Error('SOURCE_ADVANCED');},assertCurrentCapture(){if(!currentCapture)throw Error('CAPTURE_ADVANCED');}},async(id)=>{if(id!=='verified')throw Error('UNVERIFIED');return structuredClone(receipt);});
 const init={...owner,executionBackend:'legacy' as const,sourceRevision:4,schemaVersion:1,manifestHash:'initial',generation:1,targetGeneration:null,finalSourceRevision:null,initialized:true,sourceIncarnation:'inc-1',sourceRuntimeId:'runtime-1'};
 const fence:RuntimeFenceEvidence={...owner,provider:'cloudflare',previousRuntimeId:'runtime-1',providerRuntimeId:'provider-1',previousIncarnation:'inc-1',previousGeneration:1,browserRetired:true,result:'exact_incarnation_stopped',verifiedAt:'now',providerRequestIds:['stop-1']};
 return {...f,db,migration,init,receipt,fence,setFenced:(v:boolean)=>{fenced=v;},setQuiescent:(v:boolean)=>{quiescent=v;},setSource:(v:number)=>{sourceRevision=v;},setCurrentCapture:(v:boolean)=>{currentCapture=v;}};
}
async function quiesce(f:ReturnType<typeof fixture>){await f.migration.initialize('init',f.init);await f.migration.advance('provision',1,'provisioned');await f.migration.advance('copy',2,'copying');await f.migration.advance('verify',3,'verified');await f.migration.advance('quiesce',4,'quiescing');}
test('Must capture verified independent objects BEFORE exact incarnation retirement and activation',async()=>{
 const f=fixture();await quiesce(f);await assert.rejects(f.migration.retire('early',5,f.fence),/UNVERIFIED_CAPTURE/);
 await f.migration.capture('capture',5,'verified',4);await assert.rejects(f.migration.activate('early-active',6,2,'isolated_sandbox'),/ACTIVATION_UNVERIFIED/);
 await assert.rejects(f.migration.retire('stop',6,f.fence),/FENCE_UNCONFIRMED/);assert.equal(f.migration.get()!.phase,'finalizing');
 f.setFenced(true);await f.migration.retire('stop',6,f.fence);const active=await f.migration.activate('activate',7,2,'isolated_sandbox');assert.equal(active.phase,'active');assert.equal(active.capturedReceiptId,'verified');assert.equal(active.initialized,true);f.sqlite.close();
});
test('Missing capture, owner mismatch, wrong incarnation and lost quiescence fail closed',async()=>{
 const f=fixture();await quiesce(f);await assert.rejects(f.migration.capture('missing',5,'missing',4),/UNVERIFIED/);
 f.setQuiescent(false);await assert.rejects(f.migration.capture('capture',5,'verified',4),/NOT_QUIESCENT/);f.setQuiescent(true);
 f.receipt.userId='bob';await assert.rejects(f.migration.capture('owner',5,'verified',4),/OWNER_MISMATCH/);f.receipt.userId='alice';
 f.receipt.incarnation='wrong';await assert.rejects(f.migration.capture('inc',5,'verified',4),/STALE_GENERATION/);f.receipt.incarnation='inc-1';
 f.setCurrentCapture(false);await assert.rejects(f.migration.capture('advanced',5,'verified',4),/CAPTURE_ADVANCED/);assert.equal(f.migration.get()!.phase,'quiescing');f.sqlite.close();
});
test('Source changes after verified capture block switch; retries never initialize empty or overwrite newer source',async()=>{
 const f=fixture();await quiesce(f);const captured=await f.migration.capture('capture',5,'verified',4);assert.deepEqual(await f.migration.capture('capture',5,'verified',4),captured);
 f.setFenced(true);f.setSource(5);await assert.rejects(f.migration.retire('stop',6,f.fence),/SOURCE_ADVANCED/);
 assert.equal(f.migration.get()!.phase,'finalizing');assert.equal(f.migration.get()!.sourceRevision,4);
 await assert.rejects(f.migration.initialize('reset',{...f.init,initialized:false}),/REVISION_CONFLICT/);f.sqlite.close();
});
test('Post-write rollback clears old capture and requires new verified capture/fence before higher generation',async()=>{
 const f=fixture();await quiesce(f);await f.migration.capture('capture',5,'verified',4);f.setFenced(true);await f.migration.retire('stop',6,f.fence);await f.migration.activate('activate',7,2,'isolated_sandbox');
 f.setSource(9);const rollback=await f.migration.beginRollback('rollback',8,{incarnation:'inc-2',runtimeId:'runtime-2',generation:2,sourceRevision:9});assert.equal(rollback.capturedReceiptId,null);assert.equal(rollback.sourceRevision,9);
 await assert.rejects(f.migration.activate('stale',9,3,'legacy'),/ACTIVATION_UNVERIFIED/);
 f.receipt.incarnation='inc-2';f.receipt.generation=2;f.receipt.filesystemRevision=8;
 await f.migration.capture('newcapture',9,'verified',9);
 const fence={...f.fence,previousIncarnation:'inc-2',previousRuntimeId:'runtime-2',previousGeneration:2};await f.migration.retire('newstop',10,fence);
 const legacy=await f.migration.activate('legacy',11,3,'legacy');assert.equal(legacy.phase,'legacy_active');assert.equal(legacy.capturedFilesystemRevision,8);f.sqlite.close();
});
