import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createWorkspaceExecution} from '../src/workspace-execution.ts';
import {sqliteWorkspace} from './helpers/workspace-sqlite.mts';
import {ownerKey} from '../src/workspace-runtime.ts';
import {digest} from '../src/workspace-container-protocol.ts';

// Invisible self-healing: a binding whose container is gone is rebound from
// the last verified checkpoint when the workspace is next started (app open,
// keepalive, mission start). No user-facing repair exists. These tests seed
// the exact wedged states from the Nov 4-5 production reports (Apple +
// main) against a fake container speaking the workspace RPC protocol, and
// prove the rebind, the image move, the keepalive, and the dead-session
// review.

const oldImage='registry.example/hygge@sha256:'+'a'.repeat(64);
const newImage='registry.example/hygge@sha256:'+'b'.repeat(64);
const owner={environment:'staging' as const,userId:'repair-user',workspaceId:'repair-do'};
const CHUNK=256*1024;

function fakeContainer(){
  let running=false,image='',labels:any=null,identity:any=null;
  let initialized=false,frozen=false,recoveredCheckpointId:string|null=null;
  let fsRevision=0,profileRevision=0;
  const files=new Map<string,Buffer>();
  const artifacts:Record<string,string>={};
  const uploads=new Map<string,{ref:string,size:number,sha256:string,bytes:Buffer}>();
  let restore:any=null,capture:any=null;
  const ops:string[]=[];
  let destroys=0,starts=0,failStartOnce=false;
  const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
  const b64=(b:Buffer)=>b.toString('base64');
  const unb64=(s:string)=>Buffer.from(s,'base64');
  function tree(){
    const fs=[...files.entries()].map(([path,bytes])=>({path,mode:0o600,size:bytes.length,hash:sha(bytes)})).sort((a,b)=>a.path<b.path?-1:1);
    return {files:fs,directories:fs.length?[{path:'artifacts',mode:0o700}]:[],symlinks:[],artifacts:{...artifacts}};
  }
  function status(){return {...identity,artifactProtocolVersion:1,maxArtifactBytes:8*1024*1024,initialized,recoveredCheckpointId,frozen,humanControlled:false,filesystemRevision:fsRevision,browserProfileRevision:profileRevision,nextFilesystemRevision:fsRevision+1,nextBrowserProfileRevision:profileRevision};}
  async function handle(op:string,a:any):Promise<any>{
    ops.push(op);
    if(op==='status')return status();
    if(op==='initialize'){if(initialized)return{recoveredCheckpointId};if(a.checkpointId!==null)throw Error('RESTORE_REQUIRED');initialized=true;recoveredCheckpointId=null;return{recoveredCheckpointId:null};}
    if(op==='lease.refresh')return{};
    if(op==='restore.begin'){if(initialized||restore)throw Error('RESTORE_NOT_ALLOWED');frozen=true;restore={checkpointId:a.checkpointId,tree:a.tree,received:new Map()};return{};}
    if(op==='restore.chunk'){if(!restore)throw Error('RESTORE_NOT_STARTED');const f=restore.tree.files.find((x:any)=>x.path===a.path);if(!f)throw Error('INVALID_RESTORE_CHUNK');const b=unb64(a.data);const prev=restore.received.get(a.path)??Buffer.alloc(0);if(a.offset!==prev.length||a.offset+b.length>f.size)throw Error('INVALID_RESTORE_CHUNK');restore.received.set(a.path,Buffer.concat([prev,b]));return{};}
    if(op==='restore.finish'){if(!restore)throw Error('RESTORE_NOT_STARTED');for(const f of restore.tree.files){const b=restore.received.get(f.path)??Buffer.alloc(0);if(b.length!==f.size||sha(b)!==f.hash)throw Error('RESTORE_INTEGRITY');}files.clear();for(const k of Object.keys(artifacts))delete artifacts[k];for(const f of restore.tree.files)files.set(f.path,restore.received.get(f.path));Object.assign(artifacts,restore.tree.artifacts);recoveredCheckpointId=restore.checkpointId;fsRevision=a.filesystemRevision;profileRevision=a.browserProfileRevision;restore=null;initialized=true;frozen=false;return{recoveredCheckpointId};}
    if(op==='capture.begin'){if(frozen)throw Error('WORKSPACE_FROZEN');if(a.filesystemRevision!==fsRevision+1||a.browserProfileRevision!==profileRevision)throw Error('CAPTURE_REVISION_MISMATCH');frozen=true;fsRevision=a.filesystemRevision;profileRevision=a.browserProfileRevision;const t=tree();capture={id:'cap-'+Math.random().toString(36).slice(2),tree:t};return{captureId:capture.id,tree:t,filesystemRevision:fsRevision,browserProfileRevision:profileRevision,browserState:profileRevision?'quiesced':'absent'};}
    if(op==='capture.chunk'){if(!capture||a.captureId!==capture.id)throw Error('CAPTURE_NOT_FOUND');const f=capture.tree.files.find((x:any)=>x.path===a.path);if(!f)throw Error('INVALID_CAPTURE_CHUNK');const bytes=files.get(f.path)!;return{data:b64(bytes.subarray(a.offset,Math.min(bytes.length,a.offset+CHUNK)))};}
    if(op==='capture.release'){if(!capture||a.captureId!==capture.id)throw Error('CAPTURE_NOT_FOUND');capture=null;frozen=false;return{};}
    if(op==='artifact.list')return Object.keys(artifacts);
    if(op==='artifact.begin'){const uploadId=sha(Buffer.from(`${a.ref}\0${a.size}\0${a.sha256}`));const existing=artifacts[a.ref];if(existing&&files.get(existing)?.length===a.size&&sha(files.get(existing)!)===a.sha256)return{uploadId,committed:true,received:a.size};const prior=uploads.get(uploadId);if(prior)return{uploadId,committed:false,received:prior.bytes.length};uploads.set(uploadId,{ref:a.ref,size:a.size,sha256:a.sha256,bytes:Buffer.alloc(0)});return{uploadId,committed:false,received:0};}
    if(op==='artifact.chunk'){const u=uploads.get(a.uploadId);if(!u)throw Error('ARTIFACT_TRANSFER_NOT_FOUND');const b=unb64(a.data);if(a.offset!==u.bytes.length)throw Error('ARTIFACT_CHUNK_ORDER');u.bytes=Buffer.concat([u.bytes,b]);return{received:u.bytes.length};}
    if(op==='artifact.commit'){const uploadId=sha(Buffer.from(`${a.ref}\0${a.size}\0${a.sha256}`));if(uploadId!==a.uploadId)throw Error('INVALID_ARTIFACT_MANIFEST');const u=uploads.get(uploadId);if(!u){if(artifacts[a.ref]&&sha(files.get(artifacts[a.ref])!)===a.sha256)return{committed:true,sha256:a.sha256,size:a.size};throw Error('ARTIFACT_TRANSFER_NOT_FOUND');}if(u.bytes.length!==a.size||sha(u.bytes)!==a.sha256)throw Error('ARTIFACT_INTEGRITY');const p=`artifacts/${a.ref}`;files.set(p,u.bytes);artifacts[a.ref]=p;uploads.delete(uploadId);return{committed:true,size:a.size,sha256:a.sha256};}
    if(op==='artifact.abort'){uploads.delete(a.uploadId);return{};}
    if(op==='artifact.write'){const r=await handle('artifact.begin',a);if(!r.committed){await handle('artifact.chunk',{uploadId:r.uploadId,offset:0,data:a.data});await handle('artifact.commit',{...a,uploadId:r.uploadId});}return{committed:true,size:a.size,sha256:a.sha256};}
    if(op==='artifact.deleteDocuments')return{removedThroughRevision:a.throughRevision};
    if(op==='browser.snapshot')throw Error('SESSION_NOT_FOUND');
    throw Error('UNKNOWN_OP:'+op);
  }
  const container:any={
    get running(){return running;},
    start(o:any){if(failStartOnce){failStartOnce=false;throw new Error('START_TRANSIENT');}starts++;running=true;image=o.image;labels=o.labels;identity=JSON.parse(o.env.HYGGE_IDENTITY);initialized=false;frozen=false;recoveredCheckpointId=null;fsRevision=0;profileRevision=0;files.clear();for(const k of Object.keys(artifacts))delete artifacts[k];},
    async inspect(){return running?{image,labels}:null;},
    async destroy(){destroys++;running=false;},
    async monitor(){},async setInactivityTimeout(){},async interceptOutboundHttp(){},async interceptOutboundHttps(){},
    getTcpPort(){return{fetch:async(req:any)=>{const q=JSON.parse(await req.text());try{return new Response(JSON.stringify({result:await handle(q.op,q.args??{})}));}catch(e){return new Response(JSON.stringify({error:e instanceof Error?e.message:String(e)}),{status:409});}}};},
  };
  return {container,ops,stats:()=>({destroys,starts}),
    // The platform reclaims the container out-of-band: no fence, no notice.
    kill(){running=false;},
    // A start that fails once, so a rebind can be left starting.
    failNextStart(){failStartOnce=true;},
    async plantOrphan(incarnation:string,generation:number){
      const ownerHash=(await digest(new TextEncoder().encode(ownerKey(owner)))).slice(0,32);
      running=true;image=oldImage;labels={owner:ownerHash,operation:'orphan',incarnation,generation:String(generation)};
    },
    async plantForeign(){
      running=true;image=oldImage;labels={owner:'0'.repeat(32),operation:'foreign',incarnation:'foreign-inc',generation:'1'};
    },
  };
}

function fixture(){
  const {storage}=sqliteWorkspace();
  for(const q of ['CREATE TABLE tasks(id TEXT PRIMARY KEY,task TEXT NOT NULL,created_at TEXT NOT NULL)','CREATE TABLE session_profiles(domain TEXT PRIMARY KEY,has_profile INTEGER)','CREATE TABLE credentials(id TEXT PRIMARY KEY,username TEXT)','CREATE TABLE profile(id TEXT PRIMARY KEY,payload TEXT)'])storage.sql.exec(q);
  const loadTask=(id:string)=>{const row=[...storage.sql.exec('SELECT task FROM tasks WHERE id=?',id)][0] as any;return row?JSON.parse(String(row.task)):null;};
  const projectTask=(value:any)=>storage.sql.exec('INSERT INTO tasks(id,task,created_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET task=excluded.task',value.id,JSON.stringify(value),new Date().toISOString());
  const blobs=new Map<string,Uint8Array>();
  const bucket:any={put:async(k:string,v:Uint8Array)=>{blobs.set(k,Uint8Array.from(v));},get:async(k:string)=>{const v=blobs.get(k);return v?{arrayBuffer:async()=>Uint8Array.from(v).buffer}:null;}};
  const env:any={SELF:{fetch:async()=>new Response('denied',{status:403})},WORKSPACE_CHECKPOINTS:bucket,HYGGE_WORKSPACE_IMAGE:newImage,HYGGE_WORKSPACE_NAMESPACE:'hygge-test',HYGGE_WORKSPACE_IMAGE_TRANSITIONS:JSON.stringify([{from:oldImage,to:newImage,policy:'workspace-filesystem-v1'},{from:newImage,to:oldImage,policy:'workspace-filesystem-v1'}]),HYGGE_ENV:'staging',DB:{prepare(){throw new Error('No shared registry configured');}}};
  const fake=fakeContainer();
  const make=()=>createWorkspaceExecution({owner,env,storage,container:fake.container,loadTask,projectTask});
  return {storage,env,blobs,bucket,fake,make,loadTask,projectTask};
}

// Provision on the OLD image (main's state), write a document, and wedge
// the workspace the way production wedged: container gone, binding ready.
async function wedgedMain(){
  const f=fixture();
  // Start on the old image: the pinned env image is new, so point the
  // fixture at old first, then flip the pin to new before the rebind.
  f.env.HYGGE_WORKSPACE_IMAGE=oldImage;
  const w=f.make();
  await w.ensure();
  await w.saveDocument('generation/notes/plan.md',1,new TextEncoder().encode('Initial note'));
  const before=await w.foundation.registry.read(owner,owner);
  assert.equal(before.generation,1);
  assert.equal(before.desiredImageDigest,oldImage);
  assert.ok(before.recoveryPoint);
  f.env.HYGGE_WORKSPACE_IMAGE=newImage;
  f.fake.kill();
  return {f,w,before};
}

test('a dead container is rebound from the checkpoint and moves to the pinned image',async()=>{
  const {f,w,before}=await wedgedMain();
  await w.ensure();
  const after=await w.foundation.registry.read(owner,owner);
  assert.equal(after.generation,2);
  assert.notEqual(after.incarnation,before.incarnation);
  assert.equal(after.lifecycleState,'ready');
  assert.equal(after.desiredImageDigest,newImage);
  assert.equal(after.recoveryPoint?.checkpointId,before.recoveryPoint!.checkpointId);
  const diag:any=await w.diagnostics();
  assert.equal(diag.ensure.ok,true);
  assert.equal(diag.container.ok,true);
  assert.equal(diag.container.recoveredCheckpointId,before.recoveryPoint!.checkpointId);
  assert.equal(diag.binding.generation,2);
  assert.equal(diag.binding.desiredImageDigest,newImage);
  assert.equal(diag.binding.recoveryPoint.checkpointId,before.recoveryPoint!.checkpointId);
  // The rebound container accepts writes and captures: the checkpoint's
  // files survive into the next manifest.
  await w.saveDocument('generation/notes/after.md',1,new TextEncoder().encode('After the rebind.'));
  const after2=await w.foundation.registry.read(owner,owner);
  assert.ok(after2.recoveryPoint!.sequence>before.recoveryPoint!.sequence);
  const manifestBytes=await (await f.bucket.get(`hygge-workspaces/v1/${ownerKey(owner)}/manifests/${after2.recoveryPoint!.manifestHash}`))!.arrayBuffer();
  const manifest=JSON.parse(new TextDecoder().decode(manifestBytes));
  const planRef=`file_${createHash('sha256').update('generation/notes/plan.md').digest('hex').slice(0,32)}_1`;
  const afterRef=`file_${createHash('sha256').update('generation/notes/after.md').digest('hex').slice(0,32)}_1`;
  assert.ok(manifest.files.some((x:any)=>x.path.endsWith(planRef)),'original document survives the rebind');
  assert.ok(manifest.files.some((x:any)=>x.path.endsWith(afterRef)),'new document captured after the rebind');
});

test('an orphan container is destroyed and the workspace is rebound',async()=>{
  const {f,w,before}=await wedgedMain();
  await f.fake.plantOrphan('orphan-inc',1);
  await w.ensure();
  const after=await w.foundation.registry.read(owner,owner);
  assert.equal(f.fake.stats().destroys,1);
  assert.equal(after.generation,2);
  assert.notEqual(after.incarnation,before.incarnation);
  assert.notEqual(after.incarnation,'orphan-inc');
  const diag:any=await w.diagnostics();
  assert.equal(diag.ensure.ok,true);
  assert.equal(diag.container.recoveredCheckpointId,before.recoveryPoint!.checkpointId);
});

test('a foreign container is never destroyed and the rebind refuses',async()=>{
  const {f,w,before}=await wedgedMain();
  await f.fake.plantForeign();
  await assert.rejects(w.ensure(),/FENCE_UNCONFIRMED/);
  assert.equal(f.fake.stats().destroys,0);
  const stalled=await w.foundation.registry.read(owner,owner);
  assert.equal(stalled.lifecycleState,'fencing');
  assert.equal(stalled.incarnation,before.incarnation);
  // Once the foreign container is gone, the next start resumes the same
  // rebind (deterministic operation ids) and succeeds.
  f.fake.kill();
  await w.ensure();
  const after=await w.foundation.registry.read(owner,owner);
  assert.equal(after.generation,2);
  assert.equal(after.lifecycleState,'ready');
});

test('keepalive warms a cold workspace and renews the lease while warm',async()=>{
  const {f,w,before}=await wedgedMain();
  const cold=await w.keepalive();
  assert.equal(cold.ok,true);
  assert.equal(cold.rebound,true);
  assert.equal(cold.generation,2);
  assert.equal(cold.recoveryPoint?.checkpointId,before.recoveryPoint!.checkpointId);
  assert.ok(f.fake.ops.includes('lease.refresh'));
  const lease1=await w.foundation.registry.readLease(owner,owner);
  const warm=await w.keepalive();
  assert.equal(warm.ok,true);
  assert.equal(warm.rebound,false);
  assert.equal(warm.generation,2);
  const lease2=await w.foundation.registry.readLease(owner,owner);
  assert.ok(Date.parse(lease2.expiresAt)>=Date.parse(lease1.expiresAt));
});

test('a dead-session effect resolves through the task review, and the gate clears',async()=>{
  const {f,w,before}=await wedgedMain();
  const db=w.foundation.persistence;
  const task:any={id:'task-fiverr',kind:'discover',target_url:'https://fiverr.example',goal:'Scan',status:'needsHuman',drafted_payload:{},interaction_version:1,log:[],session_id:'fx_run1_0',help:{kind:'recovery'}};
  f.projectTask(task);
  db.put('runner_task','task-fiverr',0,{taskId:'task-fiverr',runId:'run-1',sequence:1,pendingEffectId:null,status:'needsHuman',task});
  const base={...db.owner,intentHash:'h',approvalId:null,approvalScopeHash:null,incarnation:before.incarnation,generation:1};
  db.put('effect','fx_3',0,{...base,effectId:'fx_3',taskId:'task-fiverr',runId:'run-1',status:'uncertain',revision:1});
  db.put('effect','fx_done',0,{...base,effectId:'fx_done',taskId:'task-fiverr',runId:'run-1',status:'confirmed',revision:1});
  const diagBefore:any=await w.diagnostics();
  assert.equal(diagBefore.wouldBlockNewMission,true);
  // The review itself rebinds (reconcile calls ensure) and then resolves
  // with dead-session evidence: the session is gone and the effect belongs
  // to the incarnation that no longer runs.
  const reviewed=await w.reconcile('task-fiverr','fx_3','not_applied');
  assert.equal(reviewed.status,'needsHuman');
  const effect=db.get<any>('effect','fx_3')!.value;
  assert.equal(effect.status,'not_applied');
  const diagAfter:any=await w.diagnostics();
  assert.deepEqual(diagAfter.effects.unresolved,[]);
  assert.equal(diagAfter.wouldBlockNewMission,false);
});

test('a task whose session id was already cleared still resolves through the review',async()=>{
  const {f,w,before}=await wedgedMain();
  const db=w.foundation.persistence;
  // The real Apple task: needsHuman, no help at all, and the session id
  // already cleared by the task poll after the in-memory session map was
  // lost. The review must still resolve it from the session-gone evidence.
  const task:any={id:'task-apple',kind:'discover',target_url:'https://fiverr.example',goal:'Scan',status:'needsHuman',drafted_payload:{},interaction_version:1,log:[],session_id:null,help:null};
  f.projectTask(task);
  db.put('runner_task','task-apple',0,{taskId:'task-apple',runId:'run-2abf',sequence:1,pendingEffectId:null,status:'needsHuman',task});
  const base={...db.owner,intentHash:'h',approvalId:null,approvalScopeHash:null,incarnation:before.incarnation,generation:1};
  db.put('effect','fx_apple_3',0,{...base,effectId:'fx_apple_3',taskId:'task-apple',runId:'run-2abf',status:'uncertain',revision:1});
  const reviewed=await w.reconcile('task-apple','fx_apple_3','not_applied');
  assert.equal(reviewed.status,'needsHuman');
  const effect=db.get<any>('effect','fx_apple_3')!.value;
  assert.equal(effect.status,'not_applied');
  const evidence=db.list<any>('runner_evidence').map((e:any)=>e.value);
  assert.ok(evidence.some((p:any)=>p.sessionGone===true && p.sessionId===null && p.effectId==='fx_apple_3'),'review records session-gone evidence with no session id');
  const diagAfter:any=await w.diagnostics();
  assert.deepEqual(diagAfter.effects.unresolved,[]);
  assert.equal(diagAfter.wouldBlockNewMission,false);
});

test('a session that vanished inside the live container still needs a live page',async()=>{
  const f=fixture();
  const w=f.make();
  await w.ensure();
  await w.saveDocument('generation/notes/plan.md',1,new TextEncoder().encode('Initial note'));
  const binding=await w.foundation.registry.read(owner,owner);
  const task:any={id:'task-live',kind:'discover',target_url:'https://fiverr.example',goal:'Scan',status:'needsHuman',drafted_payload:{},interaction_version:1,log:[],session_id:'fx_run2_0',help:{kind:'recovery'}};
  f.projectTask(task);
  w.foundation.persistence.put('runner_task','task-live',0,{taskId:'task-live',runId:'run-2',sequence:1,pendingEffectId:null,status:'needsHuman',task});
  const base={...w.foundation.persistence.owner,intentHash:'h',approvalId:null,approvalScopeHash:null,incarnation:binding.incarnation,generation:binding.generation};
  w.foundation.persistence.put('effect','fx_live',0,{...base,effectId:'fx_live',taskId:'task-live',runId:'run-2',status:'uncertain',revision:1});
  await assert.rejects(w.reconcile('task-live','fx_live','not_applied'),/CURRENT_PAGE_REQUIRED/);
  assert.equal(w.foundation.persistence.get<any>('effect','fx_live')!.value.status,'uncertain');
});

test('a binding with no recovery point refuses instead of starting empty',async()=>{
  const f=fixture();
  const w=f.make();
  await w.ensure();
  // Wedge before any capture: generation 1, no checkpoint.
  const before=await w.foundation.registry.read(owner,owner);
  assert.equal(before.recoveryPoint,null);
  f.fake.kill();
  await assert.rejects(w.ensure(),/RECOVERY_POINT_REQUIRED/);
  const stalled=await w.foundation.registry.read(owner,owner);
  assert.equal(stalled.lifecycleState,'ready');
  assert.equal(stalled.incarnation,before.incarnation);
});

test('a rebind stopped after its fence resumes at select/start and moves to the pinned image',async()=>{
  const {f,w,before}=await wedgedMain();
  // Drive the fence step by hand: the container is already gone, so the
  // fence completes and leaves the binding stopped with this rebind's
  // fence op recorded — the state a crash between fence and start leaves.
  const fenced=await w.foundation.registry.fence(owner,owner,before.generation,`rebind-${before.incarnation}-fence`);
  assert.equal(fenced.lifecycleState,'stopped');
  const completed=await w.foundation.registry.completedOperation(owner,owner,`rebind-${before.incarnation}-fence`);
  assert.equal(completed?.kind,'fence');
  await w.ensure();
  const after=await w.foundation.registry.read(owner,owner);
  assert.equal(after.generation,2);
  assert.equal(after.lifecycleState,'ready');
  assert.equal(after.desiredImageDigest,newImage);
  assert.equal(after.recoveryPoint?.checkpointId,before.recoveryPoint!.checkpointId);
  const diag:any=await w.diagnostics();
  assert.equal(diag.ensure.ok,true);
  assert.equal(diag.container.recoveredCheckpointId,before.recoveryPoint!.checkpointId);
});

test('a rebind whose start failed transiently resumes its start and moves to the pinned image',async()=>{
  const {f,w,before}=await wedgedMain();
  await w.foundation.registry.fence(owner,owner,before.generation,`rebind-${before.incarnation}-fence`);
  const stalled=await w.foundation.registry.read(owner,owner);
  assert.equal(stalled.lifecycleState,'stopped');
  // The start fails once mid-rebind: the binding is left starting with
  // this rebind's start op pending — the state a crash during start leaves.
  f.fake.failNextStart();
  await assert.rejects(w.ensure(),/START_TRANSIENT/);
  const mid=await w.foundation.registry.read(owner,owner);
  assert.equal(mid.lifecycleState,'starting');
  // The retry resumes the same start op instead of fencing again, and
  // lands on the new image with the checkpoint restored.
  await w.ensure();
  const after=await w.foundation.registry.read(owner,owner);
  assert.equal(after.generation,2);
  assert.equal(after.lifecycleState,'ready');
  assert.equal(after.desiredImageDigest,newImage);
  assert.equal(after.recoveryPoint?.checkpointId,before.recoveryPoint!.checkpointId);
  const diag:any=await w.diagnostics();
  assert.equal(diag.ensure.ok,true);
  assert.equal(diag.container.recoveredCheckpointId,before.recoveryPoint!.checkpointId);
});

