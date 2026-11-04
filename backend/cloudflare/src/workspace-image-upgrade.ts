import type {WorkspaceBinding,WorkspaceDurabilityReceipt} from './workspace-contract.ts';
import {WorkspacePersistence} from './workspace-persistence.ts';

export type ImageUpgradePhase='reserved'|'captured'|'fenced'|'selected'|'restored'|'verified'|'aborted';
export interface ImageUpgrade {
 operationId:string;expectedGeneration:number;source:WorkspaceBinding;targetImage:string;phase:ImageUpgradePhase;
 structuredHash?:string;sourceReceipt?:WorkspaceDurabilityReceipt;fencedRevision?:number;target?:WorkspaceBinding;targetReceipt?:WorkspaceDurabilityReceipt;
 error?:string|null;createdAt:string;updatedAt:string;
}
export interface ImageUpgradeAdapters {
 db:WorkspacePersistence;
 allowed(from:string,to:string):boolean;
 prepare():Promise<WorkspaceBinding>;
 assertIdle():void;
 structuredHash():Promise<string>;
 verifyFiles(source:WorkspaceDurabilityReceipt,target:WorkspaceDurabilityReceipt):Promise<void>;
 capture(record:ImageUpgrade,target:boolean):Promise<WorkspaceDurabilityReceipt>;
 verify(receipt:WorkspaceDurabilityReceipt):Promise<void>;
 fence(record:ImageUpgrade):Promise<WorkspaceBinding>;
 select(record:ImageUpgrade):Promise<void>;
 restore(record:ImageUpgrade):Promise<WorkspaceBinding>;
 current():Promise<WorkspaceBinding>;
 abortCheck(record:ImageUpgrade):Promise<void>;
}
/** Owner-private, resumable controller. No reset, old-head rollback, admission theft or action dispatch. */
export function createWorkspaceImageUpgrade(a:ImageUpgradeAdapters){
 const db=a.db;let aborting=false;let active:{id:string;generation:number;target:string;promise:Promise<any>}|undefined;
 const get=(id:string)=>db.get<ImageUpgrade>('image_upgrade',id)?.value;
 const update=(record:ImageUpgrade,patch:Partial<ImageUpgrade>)=>db.storage.transactionSync(()=>{
  const old=db.get<ImageUpgrade>('image_upgrade',record.operationId);if(!old||old.value.phase!==record.phase)throw Error('UPGRADE_REVISION_CONFLICT');
  const next={...old.value,...patch,updatedAt:new Date().toISOString()};db.put('image_upgrade',record.operationId,old.revision,next);return next;
 });
 async function perform(input:{operationId:string;expectedGeneration:number;targetImage:string}){
  if(!/^[A-Za-z0-9_-]{1,80}$/.test(input.operationId)||!Number.isSafeInteger(input.expectedGeneration)||input.expectedGeneration<1)throw Error('INVALID_IMAGE_UPGRADE');
  let record=get(input.operationId);
  if(record&&(record.expectedGeneration!==input.expectedGeneration||record.targetImage!==input.targetImage))throw Error('IDEMPOTENCY_CONFLICT');
  if(!record){
   if(db.get('image_upgrade_lock','active'))throw Error('WORKSPACE_IMAGE_UPGRADE_PENDING');
   const source=await a.prepare();
   if(source.generation!==input.expectedGeneration)throw Error('STALE_GENERATION');
   if(source.lifecycleState!=='ready'||!a.allowed(source.desiredImageDigest,input.targetImage)||source.desiredImageDigest===input.targetImage)throw Error('UNREVIEWED_IMAGE_TRANSITION');
   record=db.storage.transactionSync(()=>{
    a.assertIdle();if(db.get('image_upgrade_lock','active'))throw Error('WORKSPACE_IMAGE_UPGRADE_PENDING');
    const now=new Date().toISOString(),value:ImageUpgrade={...input,source,phase:'reserved',createdAt:now,updatedAt:now};
    db.put('image_upgrade',input.operationId,0,value);db.put('image_upgrade_lock','active',0,{operationId:input.operationId});return value;
   });
  }
  try{
   for(;;){
    record=get(input.operationId)!;
    if(record.phase==='reserved'){
     if(!record.structuredHash){record=update(record,{structuredHash:await a.structuredHash()});}
     const receipt=await a.capture(record,false);await a.verify(receipt);
     if(receipt.incarnation!==record.source.incarnation||receipt.generation!==record.source.generation)throw Error('UPGRADE_CAPTURE_LINEAGE');
     if(await a.structuredHash()!==record.structuredHash)throw Error('UPGRADE_STRUCTURED_STATE_CHANGED');
     record=update(record,{sourceReceipt:receipt,phase:'captured',error:null});continue;
    }
    if(record.phase==='captured'){
     if(await a.structuredHash()!==record.structuredHash)throw Error('UPGRADE_STRUCTURED_STATE_CHANGED');
     await a.verify(record.sourceReceipt!);const stopped=await a.fence(record);
     if(stopped.lifecycleState!=='stopped'||stopped.generation!==record.source.generation)throw Error('FENCE_UNCONFIRMED');
     record=update(record,{fencedRevision:stopped.revision,phase:'fenced',error:null});continue;
    }
    if(record.phase==='fenced'){await a.verify(record.sourceReceipt!);await a.select(record);record=update(record,{phase:'selected',error:null});continue;}
    if(record.phase==='selected'){
     const target=await a.restore(record);
     if(target.lifecycleState!=='ready'||target.desiredImageDigest!==record.targetImage||target.generation<=record.source.generation||target.incarnation===record.source.incarnation
       ||target.recoveryPoint?.checkpointId!==record.sourceReceipt!.recoveryPoint.checkpointId)throw Error('UPGRADE_RESTORE_UNVERIFIED');
     record=update(record,{target,phase:'restored',error:null});continue;
    }
    if(record.phase==='restored'){
     const receipt=await a.capture(record,true);await a.verify(receipt);
     if(receipt.incarnation!==record.target!.incarnation||receipt.generation!==record.target!.generation
       ||record.sourceReceipt!.coveredArtifactRefs.some(ref=>!receipt.coveredArtifactRefs.includes(ref)))throw Error('UPGRADE_TARGET_UNVERIFIED');
     await a.verifyFiles(record.sourceReceipt!,receipt);
     if(await a.structuredHash()!==record.structuredHash)throw Error('UPGRADE_STRUCTURED_STATE_CHANGED');
     const latest=await a.current();
     if(latest.lifecycleState!=='ready'||latest.incarnation!==receipt.incarnation||latest.generation!==receipt.generation||latest.desiredImageDigest!==record.targetImage
       ||latest.recoveryPoint?.checkpointId!==receipt.recoveryPoint.checkpointId)throw Error('UPGRADE_TARGET_UNVERIFIED');
     db.storage.transactionSync(()=>{
      const saved=db.get<ImageUpgrade>('image_upgrade',record!.operationId)!;
      if(saved.value.phase!=='restored')throw Error('UPGRADE_REVISION_CONFLICT');
      record={...saved.value,targetReceipt:receipt,phase:'verified',error:null,updatedAt:new Date().toISOString()};
      db.put('image_upgrade',record.operationId,saved.revision,record);
      const lock=db.get<{operationId:string}>('image_upgrade_lock','active');
      if(lock?.value.operationId!==record.operationId)throw Error('UPGRADE_LOCK_CHANGED');
      db.storage.sql.exec('DELETE FROM hygge_workspace_records WHERE scope=? AND kind=? AND id=?',db.scope,'image_upgrade_lock','active');
     });continue;
    }
    return {operation:record,current:await a.current()};
   }
  }catch(error){
   const latest=get(input.operationId);if(latest&&!['verified','aborted'].includes(latest.phase))update(latest,{error:error instanceof Error?error.message:'UPGRADE_INTERRUPTED'});
   throw error;
  }
 }
 return {
  async abort(operationId:string){
   if(active||aborting)throw Error('WORKSPACE_IMAGE_UPGRADE_PENDING');const record=get(operationId);
   if(!record||!['reserved','captured'].includes(record.phase))throw Error('UPGRADE_CANNOT_ABORT_AFTER_FENCE');
   aborting=true;try{await a.abortCheck(record);return db.storage.transactionSync(()=>{
    const latest=db.get<ImageUpgrade>('image_upgrade',operationId),lock=db.get<{operationId:string}>('image_upgrade_lock','active');
    if(!latest||latest.value.phase!==record.phase||lock?.value.operationId!==operationId)throw Error('UPGRADE_REVISION_CONFLICT');
    const next={...latest.value,phase:'aborted' as const,error:null,updatedAt:new Date().toISOString()};db.put('image_upgrade',operationId,latest.revision,next);
    db.storage.sql.exec('DELETE FROM hygge_workspace_records WHERE scope=? AND kind=? AND id=?',db.scope,'image_upgrade_lock','active');return next;
   });}finally{aborting=false;}
  },
  status:(id?:string)=>id?get(id)??null:db.list<ImageUpgrade>('image_upgrade').map(r=>r.value),
  run(input:{operationId:string;expectedGeneration:number;targetImage:string}){
   if(aborting)return Promise.reject(Error('WORKSPACE_IMAGE_UPGRADE_PENDING'));
   if(active)return active.id===input.operationId&&active.generation===input.expectedGeneration&&active.target===input.targetImage?active.promise:Promise.reject(Error('IDEMPOTENCY_CONFLICT'));
   const promise=perform(input).finally(()=>{active=undefined;});active={id:input.operationId,generation:input.expectedGeneration,target:input.targetImage,promise};return promise;
  },
 };
}
