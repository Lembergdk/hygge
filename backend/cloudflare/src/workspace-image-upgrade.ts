import type {WorkspaceBinding,WorkspaceDurabilityReceipt,RecoveryPoint} from './workspace-contract.ts';
import type {createWorkspaceFoundation} from './workspace-foundation.ts';
import type {createContainerWorkspace} from './workspace-container.ts';
import {canonical,fail} from './workspace-persistence.ts';
import {lockedUpgrade,structuredWorkspaceHash,type ImageUpgradeRequest,type ImageUpgradeRecord,type WorkspaceImagePolicy} from './workspace-image-policy.ts';

type Foundation=ReturnType<typeof createWorkspaceFoundation>;
type Bridge=ReturnType<typeof createContainerWorkspace>;
export interface ImageUpgradeConfig {
 foundation:Foundation;bridge:Bridge;policy:WorkspaceImagePolicy|null;
 assertIdle():void;
 capture(writeId:string):Promise<WorkspaceDurabilityReceipt>;
}
/** Owner-private lifecycle journal. No browser action, approval or business-state mutation is admitted here. */
export function createWorkspaceImageUpgrade(config:ImageUpgradeConfig){
 const {foundation:f,bridge,policy}=config,db=f.persistence,owner=db.owner;
 let executing:{id:string;request:ImageUpgradeRequest;promise:Promise<ImageUpgradeRecord>}|null=null;
 const current=()=>db.get<ImageUpgradeRecord>('image_upgrade','current')?.value??null;
 function update(expected:ImageUpgradeRecord,patch:Partial<ImageUpgradeRecord>){
  return db.storage.transactionSync(()=>{
   const old=db.get<ImageUpgradeRecord>('image_upgrade','current')??fail('UPGRADE_REVISION_CONFLICT');
   if(canonical(old.value)!==canonical(expected))fail('UPGRADE_REVISION_CONFLICT');
   const next={...old.value,...patch,updatedAt:new Date().toISOString()};db.put('image_upgrade','current',old.revision,next);return next;
  });
 }
 async function assertStructured(record:ImageUpgradeRecord){if(await structuredWorkspaceHash(db.storage)!==record.structuredHash)fail('UPGRADE_STRUCTURED_STATE_CHANGED');}
 async function verifyHead(record:ImageUpgradeRecord){
  if(!record.sourceReceiptId||!record.source.recoveryPoint)fail('UPGRADE_CHECKPOINT_REQUIRED');
  const receipt=await f.verifyDurability(record.sourceReceiptId!);
  if(canonical(receipt.recoveryPoint)!==canonical(record.source.recoveryPoint)||receipt.incarnation!==record.source.incarnation||receipt.generation!==record.source.generation)fail('UPGRADE_CHECKPOINT_MISMATCH');
  await bridge.verifyRecovery(receipt.recoveryPoint,record.source.desiredImageDigest);
  return receipt;
 }
 async function verifyFiles(source:RecoveryPoint,target:RecoveryPoint,sourceImage:string,targetImage:string){
  const before=await bridge.verifyRecovery(source,sourceImage),after=await bridge.verifyRecovery(target,targetImage);
  if(after.manifest.sequence!==before.manifest.sequence+1||canonical(after.manifest.artifacts)!==canonical(before.manifest.artifacts))fail('UPGRADE_TREE_MISMATCH');
  for(const file of before.manifest.files){
   const next=after.manifest.files.find(f=>f.path===file.path);
   if(!next)fail('UPGRADE_FILE_MISSING');
   if(file.path==='.sessions.json'){
    const first=JSON.parse(new TextDecoder().decode(before.bytes.get(file.path))),second=JSON.parse(new TextDecoder().decode(after.bytes.get(file.path)));
    if(next!.mode!==file.mode||first.length!==second.length||first.some((s:any)=>{const n=second.find((v:any)=>v.id===s.id);return !n||n.url!==s.url||n.requestedURL!==s.requestedURL||n.human!==s.human||n.epoch!==s.epoch+1;}))fail('UPGRADE_SESSION_MISMATCH');
   }else if(file.path==='.artifacts.json'){
    if(next!.mode!==file.mode||canonical(JSON.parse(new TextDecoder().decode(before.bytes.get(file.path))))!==canonical(JSON.parse(new TextDecoder().decode(after.bytes.get(file.path)))))fail('UPGRADE_ARTIFACT_INDEX_MISMATCH');
   }else if(canonical(next)!==canonical(file))fail('UPGRADE_FILE_MISMATCH');
  }
  for(const file of after.manifest.files)if(!before.bytes.has(file.path)&&file.path!=='.artifact-tombstones.json')fail('UPGRADE_UNEXPECTED_FILE');
  for(const dir of before.manifest.directories){const next=after.manifest.directories.find(d=>d.path===dir.path);if(!next||canonical(next)!==canonical(dir))fail('UPGRADE_DIRECTORY_MISMATCH');}
  for(const dir of after.manifest.directories)if(!before.manifest.directories.some(d=>d.path===dir.path)&&!['artifacts','.artifact-transfers'].includes(dir.path))fail('UPGRADE_UNEXPECTED_DIRECTORY');
  if(canonical(before.manifest.symlinks)!==canonical(after.manifest.symlinks))fail('UPGRADE_LINK_MISMATCH');
 }
 function requestValid(input:ImageUpgradeRequest){
  if(!input||Object.keys(input).some(key=>!['operationId','direction','expectedGeneration','expectedCheckpointId','confirm'].includes(key))||input.confirm!==true||!['upgrade','rollback'].includes(input.direction)||!/^[A-Za-z0-9_-]{1,80}$/.test(input.operationId)||!Number.isSafeInteger(input.expectedGeneration)||input.expectedGeneration<1||!(input.expectedCheckpointId===null||/^[a-f0-9]{64}$/.test(input.expectedCheckpointId)))fail('INVALID_IMAGE_UPGRADE_REQUEST');
  if(!policy||!policy.canaryUserIds.includes(owner.userId))fail('IMAGE_UPGRADE_NOT_AUTHORIZED');
 }
 async function execute(input:ImageUpgradeRequest):Promise<ImageUpgradeRecord>{
  requestValid(input);
  let record=current();
  if(record?.operationId!==input.operationId){
   const historical=db.get<ImageUpgradeRecord>('image_upgrade_history',input.operationId)?.value;
   if(historical){if(canonical(historical.request)!==canonical(input))fail('IDEMPOTENCY_CONFLICT');return historical;}
   if(lockedUpgrade(db))fail('IMAGE_UPGRADE_IN_PROGRESS');
   config.assertIdle();
   let source=await f.registry.read(owner,owner);
   if(source.lifecycleState!=='ready'||source.generation!==input.expectedGeneration||(source.recoveryPoint?.checkpointId??null)!==input.expectedCheckpointId)fail('UPGRADE_SOURCE_CHANGED');
   const targetImage=input.direction==='upgrade'?policy!.targetImage:policy!.sourceImage;
   if(source.desiredImageDigest!==(input.direction==='upgrade'?policy!.sourceImage:policy!.targetImage)||input.direction==='rollback'&&!policy!.allowRollback)fail('UNREVIEWED_IMAGE_PAIR');
   await bridge.attach(source);config.assertIdle();
   const lease=await f.registry.readLease(owner,owner);
   if(Date.parse(lease.expiresAt)<=Date.now())await f.registry.reattachVerified(owner,owner,source.revision,b=>bridge.attach(b));
   else if(Date.parse(lease.expiresAt)-Date.now()<120_000)await f.registry.heartbeat(owner,lease);
   source=await f.registry.read(owner,owner);
   if((await bridge.status()).humanControlled)fail('HUMAN_CONTROL_ACTIVE');
   config.assertIdle();
   // Starting the journal blocks ordinary owner routes and mirror/mission ensures.
   const next:ImageUpgradeRecord={operationId:input.operationId,request:structuredClone(input),policyVersion:policy!.policyVersion,phase:'capturing',source,targetImage,targetGeneration:source.generation+1,structuredHash:'',sourceReceiptId:null,targetReceiptId:null,switchRevision:null,failureCode:null,updatedAt:new Date().toISOString()};
   db.storage.transactionSync(()=>{
    const old=db.get<ImageUpgradeRecord>('image_upgrade','current');
    if(old){if(!['accepted','cancelled'].includes(old.value.phase))fail('IMAGE_UPGRADE_IN_PROGRESS');db.put('image_upgrade_history',old.value.operationId,0,old.value);}
    db.put('image_upgrade','current',old?.revision??0,next);
   });
   record=update(next,{structuredHash:await structuredWorkspaceHash(db.storage)});
  }else if(canonical(record.request)!==canonical(input)||record.policyVersion!==policy!.policyVersion)fail('IDEMPOTENCY_CONFLICT');
  for(;;){
   record=current()!;
   switch(record.phase){
    case 'accepted':case 'cancelled':return record;
    case 'capturing':{
     try{
      await bridge.attach(record.source);
      const lease=await f.registry.readLease(owner,owner);
      if(Date.parse(lease.expiresAt)<=Date.now())await f.registry.reattachVerified(owner,owner,(await f.registry.read(owner,owner)).revision,b=>bridge.attach(b));
      const receipt=await config.capture(`${input.operationId}_source`);
      const source=await f.registry.read(owner,owner);
      if(source.incarnation!==record.source.incarnation||source.generation!==record.source.generation||canonical(source.recoveryPoint)!==canonical(receipt.recoveryPoint))fail('UPGRADE_SOURCE_CHANGED');
      await assertStructured(record);
      update(record,{phase:'captured',source,sourceReceiptId:receipt.receiptId});
     }catch(error){
      const code=error instanceof Error&&/^[A-Z][A-Z0-9_]{2,60}$/.test(error.message)?error.message:'UPGRADE_CAPTURE_FAILED';
      // No runtime was retired or image changed. Leave the original workspace available.
      update(current()!,{phase:'cancelled',failureCode:code});throw error;
     }
     break;
    }
    case 'captured':{
     await verifyHead(record);await assertStructured(record);
     const binding=await f.registry.read(owner,owner);
     if(canonical(binding)!==canonical(record.source))fail('UPGRADE_SOURCE_CHANGED');
     update(record,{phase:'fencing'});break;
    }
    case 'fencing':{
     await verifyHead(record);await assertStructured(record);
     const stopped=await f.registry.fence(owner,owner,record.source.generation,`${input.operationId}_fence`);
     if(stopped.lifecycleState!=='stopped')fail('FENCE_UNCONFIRMED');
     update(record,{phase:'fenced',switchRevision:stopped.revision});break;
    }
    case 'fenced':update(record,{phase:'switching'});break;
    case 'switching':{
     await f.registry.changeStoppedImage(owner,owner,{operationId:`${input.operationId}_image`,fenceOperationId:`${input.operationId}_fence`,sourceImage:record.source.desiredImageDigest,targetImage:record.targetImage,generation:record.source.generation,expectedRevision:record.switchRevision!,checkpointId:record.source.recoveryPoint!.checkpointId});
     update(record,{phase:'restoring'});break;
    }
    case 'restoring':{
     await assertStructured(record);await verifyHead(record);
     let ready:WorkspaceBinding;
     try{ready=await f.registry.ensure(owner,owner,`${input.operationId}_start`);}
     catch(error){
      if(!(error instanceof Error)||error.message!=='RESTORE_NOT_ALLOWED')throw error;
      // An older image cannot resume an interrupted chunk stream. The replacement has never
      // held a lease; retire that exact uninitialized instance and retry the same reservation.
      await bridge.abandonUninitialized(await f.registry.read(owner,owner),`${input.operationId}_start`);
      break;
     }
     if(ready.lifecycleState!=='ready'||ready.generation!==record.targetGeneration||ready.desiredImageDigest!==record.targetImage||ready.incarnation===record.source.incarnation)fail('UPGRADE_RESTORE_MISMATCH');
     const status=await bridge.attach(ready);
     if(status.recoveredCheckpointId!==record.source.recoveryPoint!.checkpointId||record.request.direction==='upgrade'&&status.artifactProtocolVersion!==1)fail('UPGRADE_PROTOCOL_MISMATCH');
     update(record,{phase:'verifying'});break;
    }
    case 'verifying':{
     const binding=await f.registry.read(owner,owner);await bridge.attach(binding);
     const receipt=await config.capture(`${input.operationId}_target`);
     if(receipt.generation!==record.targetGeneration)fail('UPGRADE_RESTORE_MISMATCH');
     await verifyFiles(record.source.recoveryPoint!,receipt.recoveryPoint,record.source.desiredImageDigest,record.targetImage);
     await assertStructured(record);
     update(record,{phase:'accepted',targetReceiptId:receipt.receiptId});break;
    }
   }
  }
 }
 return {
  status:current,locked:()=>!!lockedUpgrade(db),
  run(input:ImageUpgradeRequest){
   if(executing){if(executing.id!==input.operationId)return Promise.reject(Error('IMAGE_UPGRADE_IN_PROGRESS'));if(canonical(executing.request)!==canonical(input))return Promise.reject(Error('IDEMPOTENCY_CONFLICT'));return executing.promise;}
   const promise=execute(input).finally(()=>{executing=null;});executing={id:input.operationId,request:structuredClone(input),promise};return promise;
  },
 };
}
