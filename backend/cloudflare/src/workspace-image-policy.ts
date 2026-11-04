import type {WorkspaceBinding,WorkspaceIdentity,RecoveryPoint} from './workspace-contract.ts';
import type {WorkspacePersistence,WorkspaceStorage} from './workspace-persistence.ts';
import {canonical,digest,fail} from './workspace-persistence.ts';

export interface WorkspaceImagePolicy {
 schemaVersion:1;policyVersion:string;sourceImage:string;targetImage:string;canaryUserIds:string[];allowRollback:boolean;
}
const image=/^registry\.cloudflare\.com\/[a-f0-9]{32}\/hygge-workspace@sha256:[a-f0-9]{64}$/;
export function imagePolicy(raw:string|undefined,base:string):WorkspaceImagePolicy|null {
 if(!raw)return null;
 const p=JSON.parse(raw) as WorkspaceImagePolicy;
 if(p.schemaVersion!==1||!p.policyVersion||!image.test(p.sourceImage)||!image.test(p.targetImage)||p.sourceImage===p.targetImage||![p.sourceImage,p.targetImage].includes(base)||p.sourceImage.split('@')[0]!==p.targetImage.split('@')[0]||!Array.isArray(p.canaryUserIds)||p.canaryUserIds.some(id=>typeof id!=='string'||!id||id.length>256)||typeof p.allowRollback!=='boolean')fail('INVALID_IMAGE_UPGRADE_POLICY');
 return Object.freeze(p);
}
export type ImageUpgradePhase='capturing'|'captured'|'fencing'|'fenced'|'switching'|'restoring'|'verifying'|'accepted'|'cancelled';
export interface ImageUpgradeRequest {operationId:string;direction:'upgrade'|'rollback';expectedGeneration:number;expectedCheckpointId:string|null;confirm:true}
export interface ImageUpgradeRecord {
 operationId:string;request:ImageUpgradeRequest;policyVersion:string;phase:ImageUpgradePhase;
 source:WorkspaceBinding;targetImage:string;targetGeneration:number;structuredHash:string;
 sourceReceiptId:string|null;targetReceiptId:string|null;switchRevision:number|null;
 failureCode:string|null;updatedAt:string;
}
export function lockedUpgrade(db:WorkspacePersistence):ImageUpgradeRecord|null {
 const r=db.get<ImageUpgradeRecord>('image_upgrade','current')?.value;
 return r&&!['accepted','cancelled'].includes(r.phase)?r:null;
}
export function restoreAuthorized(db:WorkspacePersistence,point:RecoveryPoint,sourceImage:string,target:WorkspaceBinding):boolean {
 const r=lockedUpgrade(db);
 return !!r&&['restoring','verifying'].includes(r.phase)&&r.source.desiredImageDigest===sourceImage&&r.targetImage===target.desiredImageDigest&&r.targetGeneration===target.generation&&r.source.recoveryPoint?.manifestHash===point.manifestHash&&r.source.recoveryPoint?.sourceIncarnation===point.sourceIncarnation&&r.source.recoveryPoint?.sourceGeneration===point.sourceGeneration&&canonical(r.source.recoveryPoint)===canonical(point);
}
/** A digest only; no rows or keys leave the owner's trusted object. Lifecycle records are expected to change. */
export async function structuredWorkspaceHash(storage:WorkspaceStorage):Promise<string>{
 const tables=[...storage.sql.exec("SELECT name,sql FROM sqlite_schema WHERE type='table' ORDER BY name")].filter(r=>!String(r.name).startsWith('sqlite_')&&!String(r.name).startsWith('_cf')&&r.name!=='workspace_registry');
 const values=tables.map(t=>{
  const name=String(t.name),quoted='"'+name.replaceAll('"','""')+'"';
  const rows=[...storage.sql.exec(`SELECT * FROM ${quoted}`)].filter(r=>name!=='hygge_workspace_records'||!['image_upgrade','image_upgrade_history','image_fence_intent'].includes(String(r.kind)));
  return{name,schema:String(t.sql),rows:rows.map(row=>canonical(row)).sort()};
 });
 return digest(values);
}
export function fenceIdentity(b:WorkspaceBinding):string {
 return JSON.stringify([b.environment,b.userId,b.workspaceId,b.provider,b.provider==='cloudflare'?b.namespaceId:null,b.provider==='cloudflare'?b.providerWorkspaceId:null,b.runtimeId,b.providerRuntimeId,b.incarnation,b.generation,b.desiredImageDigest,b.recoveryPoint]);
}
export function fenceIntent(db:WorkspacePersistence){
 return {
  read(id:string){return db.get<WorkspaceBinding>('image_fence_intent',id)?.value??null;},
  record(id:string,b:WorkspaceBinding){db.storage.transactionSync(()=>{const old=db.get<WorkspaceBinding>('image_fence_intent',id);if(old){if(fenceIdentity(old.value)!==fenceIdentity(b))fail('FENCE_INTENT_CONFLICT');return;}db.put('image_fence_intent',id,0,structuredClone(b));});},
 };
}
