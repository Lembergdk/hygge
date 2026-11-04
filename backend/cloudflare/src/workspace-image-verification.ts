import type {WorkspaceStorage} from './workspace-persistence.ts';
import {canonical,digest} from './workspace-persistence.ts';
import type {PrivateObjectStore} from './workspace-capture.ts';
import {sha256} from './workspace-capture.ts';
import {ownerKey} from './workspace-runtime.ts';
import {validateTree} from './workspace-container-protocol.ts';
import type {WorkspaceIdentity,WorkspaceDurabilityReceipt} from './workspace-contract.ts';
export async function structuredWorkspaceHash(storage:WorkspaceStorage):Promise<string>{
 const tables=[...storage.sql.exec("SELECT name,sql FROM sqlite_schema WHERE type='table' ORDER BY name")].filter(r=>!String(r.name).startsWith('sqlite_')&&!String(r.name).startsWith('_cf')&&r.name!=='workspace_registry');
 const values=tables.map(t=>{
  const name=String(t.name),quoted='"'+name.replaceAll('"','""')+'"';
  const rows=[...storage.sql.exec(`SELECT * FROM ${quoted}`)].filter(r=>name!=='hygge_workspace_records'||!['image_upgrade','image_upgrade_lock','image_capture_request','image_fence'].includes(String(r.kind)));
  return{name,schema:String(t.sql),rows:rows.map(row=>canonical(row)).sort()};
 });
 return digest(values);
}
export async function verifyImageFiles(objects:PrivateObjectStore,owner:WorkspaceIdentity,source:WorkspaceDurabilityReceipt,target:WorkspaceDurabilityReceipt){
 const reject=(code:string):never=>{throw Error(code);};
 async function load(receipt:WorkspaceDurabilityReceipt){
  const prefix=`hygge-workspaces/v1/${ownerKey(owner)}`,data=await objects.get(`${prefix}/manifests/${receipt.recoveryPoint.manifestHash}`);
  if(!data||await sha256(data)!==receipt.recoveryPoint.manifestHash)throw Error('UPGRADE_MANIFEST_INVALID');
  const manifest=JSON.parse(new TextDecoder().decode(data));validateTree(manifest);const bytes=new Map<string,Uint8Array>();
  for(const f of manifest.files){const value=await objects.get(`${prefix}/blobs/${f.hash}`);if(!value||value.length!==f.size||await sha256(value)!==f.hash)throw Error('UPGRADE_FILE_INVALID');bytes.set(f.path,value);}
  return {manifest,bytes};
 }
 const before=await load(source),after=await load(target);
  if(after.manifest.sequence!==before.manifest.sequence+1||canonical(after.manifest.artifacts)!==canonical(before.manifest.artifacts))reject('UPGRADE_TREE_MISMATCH');
  for(const file of before.manifest.files){
   const next=after.manifest.files.find((f:any)=>f.path===file.path);
   if(!next)reject('UPGRADE_FILE_MISSING');
   if(file.path==='.sessions.json'){
    const first=JSON.parse(new TextDecoder().decode(before.bytes.get(file.path)!)),second=JSON.parse(new TextDecoder().decode(after.bytes.get(file.path)!));
    if(next!.mode!==file.mode||first.length!==second.length||first.some((s:any)=>{const n=second.find((v:any)=>v.id===s.id);return !n||n.url!==s.url||n.requestedURL!==s.requestedURL||n.human!==s.human||n.epoch!==s.epoch+1;}))reject('UPGRADE_SESSION_MISMATCH');
   }else if(file.path==='.artifacts.json'){
    if(next!.mode!==file.mode||canonical(JSON.parse(new TextDecoder().decode(before.bytes.get(file.path)!)))!==canonical(JSON.parse(new TextDecoder().decode(after.bytes.get(file.path)!))))reject('UPGRADE_ARTIFACT_INDEX_MISMATCH');
   }else if(canonical(next)!==canonical(file))reject('UPGRADE_FILE_MISMATCH');
  }
  for(const file of after.manifest.files)if(!before.bytes.has(file.path)&&file.path!=='.artifact-tombstones.json')reject('UPGRADE_UNEXPECTED_FILE');
  for(const dir of before.manifest.directories){const next=after.manifest.directories.find((d:any)=>d.path===dir.path);if(!next||canonical(next)!==canonical(dir))reject('UPGRADE_DIRECTORY_MISMATCH');}
  for(const dir of after.manifest.directories)if(!before.manifest.directories.some((d:any)=>d.path===dir.path)&&!['artifacts','.artifact-transfers'].includes(dir.path))reject('UPGRADE_UNEXPECTED_DIRECTORY');
  if(canonical(before.manifest.symlinks)!==canonical(after.manifest.symlinks))reject('UPGRADE_LINK_MISMATCH');
}
