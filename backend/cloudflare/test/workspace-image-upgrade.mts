import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sqliteWorkspace} from './helpers/workspace-sqlite.mts';
import {createWorkspaceFoundation} from '../src/workspace-foundation.ts';
import {createWorkspaceImageUpgrade} from '../src/workspace-image-upgrade.ts';
import {restoreAuthorized,structuredWorkspaceHash,imagePolicy} from '../src/workspace-image-policy.ts';
import {sha256} from '../src/workspace-capture.ts';
import type {WorkspaceBinding} from '../src/workspace-contract.ts';
const owner={environment:'staging' as const,userId:'canary',workspaceId:'workspace'};
const repository='registry.cloudflare.com/'+'a'.repeat(32)+'/hygge-workspace@sha256:';
const oldImage=repository+'1'.repeat(64),newImage=repository+'2'.repeat(64);
const policy={schemaVersion:1 as const,policyVersion:'paired-image-test-v1',sourceImage:oldImage,targetImage:newImage,canaryUserIds:['canary'],allowRollback:true};
const encode=(s:string)=>new TextEncoder().encode(s);
async function fixture(){
 const sql=sqliteWorkspace(),objects=new Map<string,Uint8Array>();let disk=new Map<string,Uint8Array>([
  ['profile/Cookies',encode('synthetic-cookie-database')],['private.txt',encode('private notes')],
  ['.sessions.json',encode(JSON.stringify([{id:'s',url:'https://jobs.example/',requestedURL:'https://jobs.example/',epoch:2,human:false}]))],
 ]);
 let runtime:any=null,starts=0,stops=0,stopLost=false,startLost=false,captureFails=false,busy=false,human=false;
 const intent=new Set<string>();let f:ReturnType<typeof createWorkspaceFoundation>;
 const store={async putImmutable(k:string,v:Uint8Array){if(!objects.has(k))objects.set(k,v.slice());},async get(k:string){return objects.get(k)?.slice()??null;}};
 async function recovery(point:any,image:string){
  const key=[...objects.keys()].find(k=>k.endsWith('/manifests/'+point.manifestHash))!;
  const raw=objects.get(key)!;assert.equal(await sha256(raw),point.manifestHash);const manifest=JSON.parse(new TextDecoder().decode(raw));assert.equal(manifest.imageDigest,image);
  const bytes=new Map<string,Uint8Array>();for(const file of manifest.files){const raw=objects.get(key.split('/manifests/')[0]+'/blobs/'+file.hash)!;assert.equal(await sha256(raw),file.hash);bytes.set(file.path,raw.slice());}return{manifest,bytes};
 }
 const provider={
  async start(b:WorkspaceBinding){
   if(!runtime){
    starts++;let recoveredCheckpointId=null;
    if(b.recoveryPoint){const result=await recovery(b.recoveryPoint,b.desiredImageDigest===newImage?oldImage:newImage);
     assert.equal(restoreAuthorized(f.persistence,b.recoveryPoint,result.manifest.imageDigest,b),true,'only the persisted exact migration grant permits a different image');
     disk=result.bytes;const sessions=JSON.parse(new TextDecoder().decode(disk.get('.sessions.json')));for(const s of sessions)s.epoch++;disk.set('.sessions.json',encode(JSON.stringify(sessions)));recoveredCheckpointId=b.recoveryPoint.checkpointId;
    }
    runtime={image:b.desiredImageDigest,incarnation:`inc-${starts}`,generation:b.generation,recoveredCheckpointId};
   }
   if(startLost){startLost=false;throw Error('PROVIDER_LOST_ACK');}
   return{runtimeId:'r',providerRuntimeId:runtime.incarnation,incarnation:runtime.incarnation,recoveredCheckpointId:runtime.recoveredCheckpointId};
  },
  async fence(b:WorkspaceBinding,id:string){
   if(runtime){assert.equal(runtime.incarnation,b.incarnation);intent.add(id);runtime=null;stops++;}
   else assert.ok(intent.has(id),'absence alone cannot prove a fence');
   if(stopLost){stopLost=false;throw Error('PROVIDER_STOP_ACK_LOST');}
   return{...owner,provider:'cloudflare' as const,previousRuntimeId:b.runtimeId!,previousIncarnation:b.incarnation,previousGeneration:b.generation,providerRuntimeId:b.providerRuntimeId!,browserRetired:true as const,result:'exact_incarnation_stopped' as const,verifiedAt:new Date().toISOString(),providerRequestIds:[id]};
  },
 };
 f=createWorkspaceFoundation({owner,storage:sql.storage,objects:store,provider,signingKey:new Uint8Array(32).fill(3),leaseDurationMs:300000,
  consent:{assertDispatchAllowed(){throw Error('no actions');}},verifyOutcome:async()=>false,verifyCompletion:async()=>false,
  captureDriver:{async capture(lease,r){if(captureFails)throw Error('CAPTURE_LIMIT');return{snapshot:{incarnation:lease.incarnation,generation:lease.generation,filesystemRevision:r.filesystemRevision,browserProfileRevision:1,browserState:'quiesced',files:[...disk].map(([path,bytes])=>({path,bytes})),directories:[{path:'profile',mode:0o700}],symlinks:[],artifacts:{}},async release(){}};}},
 });
 await f.registry.initialize(owner,{...owner,provider:'cloudflare',namespaceId:'staging',providerWorkspaceId:'workspace',ownerDigest:'owner',schemaVersion:1,incarnation:'',generation:0,runtimeId:null,providerRuntimeId:null,desiredImageDigest:oldImage,leaseExpiresAt:null,lifecycleState:'unprovisioned',revision:0,recoveryPoint:null,lastVerifiedAt:new Date().toISOString()});
 await f.registry.ensure(owner,owner,'initial');
 f.persistence.put('effect','unknown',0,{status:'uncertain',intentHash:'reviewed-action',approvalId:'consumed-once'});
 sql.storage.sql.exec('CREATE TABLE chat_agent_records (key TEXT PRIMARY KEY,payload TEXT NOT NULL)');sql.storage.sql.exec('INSERT INTO chat_agent_records VALUES (?,?)','note',JSON.stringify({content:'canonical private note',revision:1}));
 const bridge:any={async attach(b:any){assert.equal(b.incarnation,runtime?.incarnation);assert.equal(b.desiredImageDigest,runtime?.image);return{recoveredCheckpointId:runtime.recoveredCheckpointId,artifactProtocolVersion:runtime.image===newImage?1:undefined};},async status(){return{humanControlled:human};},verifyRecovery:recovery};
 const capture=async(writeId:string)=>{const old=await f.registry.saved(owner,owner,writeId);if(old)return f.verifyDurability(writeId);const b=await f.registry.read(owner,owner);return f.save(await f.broker.issue(['workspace.commit']),{writeId,expectedRegistryRevision:b.revision,filesystemRevision:(b.recoveryPoint?.sequence??0)+1,browserProfileRevision:1,artifactRefs:[]});};
 const config={foundation:f,bridge,policy,assertIdle(){if(busy)throw Error('WORKSPACE_BUSY');},capture};
 const upgrade=createWorkspaceImageUpgrade(config);
 const request=async(id:string,direction:'upgrade'|'rollback'='upgrade')=>{const b=await f.registry.read(owner,owner);return{operationId:id,direction,expectedGeneration:b.generation,expectedCheckpointId:b.recoveryPoint?.checkpointId??null,confirm:true as const};};
 return{...sql,f,upgrade,config,request,objects,getDisk:()=>disk,getRuntime:()=>runtime,getStarts:()=>starts,getStops:()=>stops,setBusy:(v:boolean)=>busy=v,setHuman:(v:boolean)=>human=v,loseStop:()=>stopLost=true,loseStart:()=>startLost=true,failCapture:()=>captureFails=true};
}

test('upgrade and rollback preserve latest files, canonical notes, pending effect and owner; replay never restarts',async()=>{
 const t=await fixture(),before=await structuredWorkspaceHash(t.storage),effect=t.f.persistence.get('effect','unknown');const input=await t.request('up');
 const result=await t.upgrade.run(input);assert.equal(result.phase,'accepted');assert.equal(result.targetGeneration,2);assert.equal(t.getRuntime().image,newImage);assert.equal(await structuredWorkspaceHash(t.storage),before);assert.deepEqual(t.f.persistence.get('effect','unknown'),effect);
 const starts=t.getStarts();assert.deepEqual(await t.upgrade.run(input),result);assert.equal(t.getStarts(),starts);
 t.getDisk().set('private.txt',encode('new work after upgrade'));
 t.storage.sql.exec('UPDATE chat_agent_records SET payload=? WHERE key=?',JSON.stringify({content:'corrected canonical note',revision:2}),'note');
 const latest=await structuredWorkspaceHash(t.storage);const rollback=await t.upgrade.run(await t.request('back','rollback'));
 assert.equal(rollback.phase,'accepted');assert.equal(rollback.targetGeneration,3);assert.equal(t.getRuntime().image,oldImage);assert.equal(new TextDecoder().decode(t.getDisk().get('private.txt')),'new work after upgrade');assert.equal(await structuredWorkspaceHash(t.storage),latest);assert.deepEqual(t.f.persistence.get('effect','unknown'),effect);assert.equal(t.getStops(),2);
 t.sqlite.close();
});
test('busy/human/wrong generation/unreviewed owners block before any fence; capture failure cancels without reset',async()=>{
 const t=await fixture(),input=await t.request('up');t.setBusy(true);await assert.rejects(t.upgrade.run(input),/WORKSPACE_BUSY/);t.setBusy(false);t.setHuman(true);await assert.rejects(t.upgrade.run(input),/HUMAN_CONTROL/);t.setHuman(false);
 await assert.rejects(t.upgrade.run({...input,expectedGeneration:9}),/SOURCE_CHANGED/);
 const denied=createWorkspaceImageUpgrade({...t.config,policy:{...policy,canaryUserIds:['other']}});await assert.rejects(denied.run(input),/NOT_AUTHORIZED/);
 t.failCapture();await assert.rejects(t.upgrade.run(input),/CAPTURE_LIMIT/);assert.equal(t.upgrade.status()?.phase,'cancelled');assert.equal(t.upgrade.locked(),false);assert.equal(t.getStops(),0);assert.equal(t.getRuntime().image,oldImage);t.sqlite.close();
});
test('lost fence acknowledgement resumes the exact operation after reconstruction; lease never revives old runtime',async()=>{
 const t=await fixture(),input=await t.request('up'),lease=await t.f.registry.readLease(owner,owner);t.loseStop();await assert.rejects(t.upgrade.run(input),/STOP_ACK_LOST/);assert.equal(t.upgrade.status()?.phase,'fencing');assert.equal(t.upgrade.locked(),true);
 await assert.rejects(t.f.registry.heartbeat(owner,lease),/STALE/);
 const reconstructed=createWorkspaceImageUpgrade(t.config);assert.equal((await reconstructed.run(input)).phase,'accepted');assert.equal(t.getStops(),1);assert.equal(t.getStarts(),2);t.sqlite.close();
});
test('lost restore acknowledgement resumes without another runtime or browser action',async()=>{
 const t=await fixture(),input=await t.request('up');t.loseStart();await assert.rejects(t.upgrade.run(input),/LOST_ACK/);assert.equal(t.upgrade.status()?.phase,'restoring');assert.equal(t.getStarts(),2);
 assert.equal((await createWorkspaceImageUpgrade(t.config).run(input)).phase,'accepted');assert.equal(t.getStarts(),2);t.sqlite.close();
});
test('same operation cannot change target scope; policy parsing rejects arbitrary images',async()=>{
 const t=await fixture(),input=await t.request('up');await t.upgrade.run(input);await assert.rejects(t.upgrade.run({...input,direction:'rollback'}),/IDEMPOTENCY/);
 assert.equal(imagePolicy(JSON.stringify(policy),oldImage)?.policyVersion,policy.policyVersion);assert.throws(()=>imagePolicy(JSON.stringify({...policy,targetImage:'latest'}),oldImage),/POLICY/);t.sqlite.close();
});
