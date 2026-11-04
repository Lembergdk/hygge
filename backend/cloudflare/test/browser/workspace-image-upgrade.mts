import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import {execFileSync} from 'node:child_process';
import {createWorkspaceServer} from '../../container/server.mjs';
import {createWorkspaceExecution} from '../../src/workspace-execution.ts';
import {sqliteWorkspace} from '../helpers/workspace-sqlite.mts';
const oldImage='registry.example/hygge@sha256:'+'a'.repeat(64),newImage='registry.example/hygge@sha256:'+'b'.repeat(64);
const owner={environment:'staging' as const,userId:'upgrade-synthetic',workspaceId:'upgrade-do'};
async function fixture(t:any){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'hygge-upgrade-'));
 const cert=path.join(root,'cert'),key=path.join(root,'key');execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-subj','/CN=127.0.0.1','-days','1'],{stdio:'ignore'});
 let seeded=false;const site=https.createServer({key:await fs.readFile(key),cert:await fs.readFile(cert)},(_q,r)=>{const first=!seeded;seeded=true;r.writeHead(200,{'content-type':'text/html',...(first?{'set-cookie':'upgrade_fixture=retained; Path=/; Max-Age=3600'}:{})});r.end('<title>Upgrade fixture</title>'+(first?'<script>localStorage.setItem("upgrade_fixture","retained")</script>':''));});
 await new Promise<void>(r=>site.listen(0,'127.0.0.1',r));const url=`https://127.0.0.1:${(site.address() as any).port}/`;
 const {storage}=sqliteWorkspace();for(const q of ['CREATE TABLE tasks(id TEXT PRIMARY KEY,task TEXT NOT NULL)','CREATE TABLE session_profiles(domain TEXT PRIMARY KEY,has_profile INTEGER)','CREATE TABLE credentials(id TEXT PRIMARY KEY,username TEXT)','CREATE TABLE profile(id TEXT PRIMARY KEY,payload TEXT)'])storage.sql.exec(q);
 storage.sql.exec("INSERT INTO tasks VALUES ('paused',?)",JSON.stringify({id:'paused',status:'needsHuman',help:{kind:'information'},drafted_payload:{private:'keep'},log:['paused']}));
 storage.sql.exec("INSERT INTO profile VALUES ('profile',?)",JSON.stringify({profile:{displayName:'Synthetic owner',hourlyRateFloor:25}}));
 let node:any=null,starting:Promise<any>|null=null,running=false,labels:any=null,image='';let starts=0,destroys=0,failDestroy=false,failRestore=false,objectFailure=false;
 const container:any={get running(){return running;},inspect:async()=>running?{image,labels}:null,
  start(o:any){starts++;image=o.image;labels=o.labels;running=true;const dir=path.join(root,o.labels.incarnation);starting=createWorkspaceServer({identity:JSON.parse(o.env.HYGGE_IDENTITY),secret:Uint8Array.from(Buffer.from(o.env.HYGGE_RPC_SECRET,'base64')),root:dir,executablePath:process.env.HYGGE_TEST_CHROME??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',allowLoopback:true,launchArgs:['--no-sandbox','--ignore-certificate-errors']}).then(async app=>{node=app;await app.listen();return app;});},
  async destroy(){if(starting)await starting;if(node)await node.close();node=null;running=false;destroys++;if(failDestroy){failDestroy=false;throw Error('SYNTHETIC_FENCE_ACK_LOST');}},
  monitor:async()=>{},setInactivityTimeout:async()=>{},interceptOutboundHttp:async()=>{},
  getTcpPort(){return {fetch:async(req:Request)=>{await starting;const body=req.body?await req.text():undefined;
   if(failRestore&&body&&JSON.parse(body).op==='restore.chunk'){failRestore=false;throw Error('SYNTHETIC_RESTORE_INTERRUPTED');}
   return fetch(`http://127.0.0.1:${node.server.address().port}${new URL(req.url).pathname}`,{method:req.method,headers:req.headers,body,signal:req.signal});}};},
 };
 const blobs=new Map<string,Uint8Array>();const bucket:any={put:async(k:string,b:Uint8Array)=>{if(objectFailure)throw Error('SYNTHETIC_OBJECT_STORE_DOWN');if(!blobs.has(k))blobs.set(k,Uint8Array.from(b));},get:async(k:string)=>{const b=blobs.get(k);return b?{arrayBuffer:async()=>Uint8Array.from(b).buffer}:null;}};
 const env:any={HYGGE_ENV:'staging',HYGGE_WORKSPACE_IMAGE:oldImage,HYGGE_WORKSPACE_NAMESPACE:'test',HYGGE_WORKSPACE_IMAGE_TRANSITIONS:JSON.stringify([{from:oldImage,to:newImage,policy:'workspace-filesystem-v1'},{from:newImage,to:oldImage,policy:'workspace-filesystem-v1'}]),WORKSPACE_CHECKPOINTS:bucket,SELF:{fetch:async()=>new Response('deny',{status:403})},DB:{prepare(){return {bind(){return {first:async()=>({contact_email:'workspace-upgrade-synthetic@example.invalid'})};}};}}};
 const make=()=>createWorkspaceExecution({owner,storage,env,container,loadTask:()=>null,projectTask:()=>{throw Error('Migration must not rewrite a task');}});
 t.after(async()=>{if(starting)await starting;if(node)await node.close();site.closeAllConnections();await new Promise<void>(r=>site.close(()=>r()));await fs.rm(root,{recursive:true,force:true});});
 return {root,url,storage,env,blobs,make,stats:()=>({starts,destroys}),loseFenceAck(){failDestroy=true;},interruptRestore(){failRestore=true;},objectFailure(value:boolean){objectFailure=value;}};
}

test('populated compatible upgrade and latest-state rollback preserve real profile, files, paused SQL and revoke old leases',{timeout:450000},async t=>{
 const f=await fixture(t);let w=f.make();await w.ensure();const beforeTask=[...f.storage.sql.exec('SELECT task FROM tasks')][0].task;
 const snap=await w.browser.createSession(f.url,null,'stable-session');await w.saveDocument('generation/notes/plan.md',1,new TextEncoder().encode('Initial note'));
 const initial=await w.foundation.registry.read(owner,owner),oldLease=await w.foundation.registry.readLease(owner,owner),token=await w.foundation.broker.issue(['state.read']);
 const upgrade=await w.imageUpgrade.run({operationId:'upgrade_one',expectedGeneration:initial.generation,targetImage:newImage});
 assert.equal(upgrade.operation.phase,'verified');assert.equal(upgrade.current.desiredImageDigest,newImage);assert.equal(upgrade.current.generation,initial.generation+1);
 assert.notEqual(upgrade.current.incarnation,initial.incarnation);assert.equal(f.stats().destroys,1);
 await assert.rejects(w.foundation.broker.authorize(token,'state.read'),/STALE|lease|LEASE|GENERATION/);
 await assert.rejects(w.foundation.registry.heartbeat(owner,oldLease),/STALE/);
 assert.equal([...f.storage.sql.exec('SELECT task FROM tasks')][0].task,beforeTask);
 const source=upgrade.operation.sourceReceipt!,target=upgrade.operation.targetReceipt!;
 await w.foundation.verifyDurability(source.receiptId);await w.foundation.verifyDurability(target.receiptId);
 assert.ok(target.recoveryPoint.sequence>source.recoveryPoint.sequence);
 const restored=await w.browser.snapshot(snap.sessionID);assert.equal(restored?.sessionID,snap.sessionID);assert.ok(restored!.controlEpoch>snap.controlEpoch);
 const state=await w.browser.exportState(snap.sessionID);assert.equal(state?.localStorage.upgrade_fixture,'retained');assert.ok(state?.cookies.some(c=>c.name==='upgrade_fixture'&&c.value==='retained'));
 const bytes=new TextEncoder().encode('New state written AFTER upgrade. '.repeat(10000));await w.saveDocument('generation/notes/after.md',1,bytes);
 const filesBefore=new Set([...f.blobs.values()].map(b=>Buffer.from(b).toString('hex')));assert.ok(filesBefore.has(Buffer.from(bytes).toString('hex')));
 // Reconstruct the root controller before rollback: journal/restore permission must be durable.
 w=f.make();const current=await w.foundation.registry.read(owner,owner);
 const rollback=await w.imageUpgrade.run({operationId:'rollback_one',expectedGeneration:current.generation,targetImage:oldImage});
 assert.equal(rollback.operation.phase,'verified');assert.equal(rollback.current.desiredImageDigest,oldImage);assert.ok(rollback.operation.sourceReceipt!.recoveryPoint.sequence>target.recoveryPoint.sequence);
 assert.ok(rollback.operation.targetReceipt!.coveredArtifactRefs.some(ref=>ref.startsWith('file_')));
 const after=await w.browser.exportState(snap.sessionID);assert.equal(after?.localStorage.upgrade_fixture,'retained');assert.ok(after?.cookies.some(c=>c.name==='upgrade_fixture'));
 assert.equal([...f.storage.sql.exec('SELECT task FROM tasks')][0].task,beforeTask);
 // Replaying an old completed upgrade returns current placement, not historic readiness.
 const replay=await w.imageUpgrade.run({operationId:'upgrade_one',expectedGeneration:initial.generation,targetImage:newImage});assert.equal(replay.current.desiredImageDigest,oldImage);assert.equal(f.stats().destroys,2);
});

test('failed final capture keeps old runtime; abort releases only maintenance, never state',{timeout:180000},async t=>{
 const f=await fixture(t),w=f.make();await w.ensure();await w.saveDocument('notes/retained',1,new TextEncoder().encode('retained before failed upgrade'));const source=await w.foundation.registry.read(owner,owner);f.objectFailure(true);
 await assert.rejects(w.imageUpgrade.run({operationId:'capture_failure',expectedGeneration:source.generation,targetImage:newImage}),/OBJECT_STORE_DOWN/);
 assert.equal(f.stats().destroys,0);assert.equal((await w.foundation.registry.read(owner,owner)).incarnation,source.incarnation);
 await assert.rejects(w.ensure(),/UPGRADE_PENDING/);await assert.rejects(w.saveDocument('notes/later',1,new Uint8Array()),/UPGRADE_PENDING/);
 f.objectFailure(false);await w.imageUpgrade.abort('capture_failure');await w.ensure();assert.equal((await w.foundation.registry.read(owner,owner)).incarnation,source.incarnation);assert.equal(f.stats().destroys,0);
});

test('fence acknowledgement loss resumes from durable intent without re-capture or admission theft',{timeout:240000},async t=>{
 const f=await fixture(t);let w=f.make();await w.ensure();await w.saveDocument('notes/sentinel',1,new TextEncoder().encode('keep'));const source=await w.foundation.registry.read(owner,owner);f.loseFenceAck();
 const input={operationId:'fence_loss',expectedGeneration:source.generation,targetImage:newImage};await assert.rejects(w.imageUpgrade.run(input),/FENCE_ACK_LOST/);
 assert.equal((await w.foundation.registry.read(owner,owner)).lifecycleState,'fencing');assert.equal(f.stats().destroys,1);
 w=f.make();const result=await w.imageUpgrade.run(input);assert.equal(result.operation.phase,'verified');assert.equal(f.stats().destroys,1);
});

test('interrupted uninitialized restore re-proves source before replacing only its partial target',{timeout:240000},async t=>{
 const f=await fixture(t);let w=f.make();await w.ensure();await w.saveDocument('notes/sentinel',1,new TextEncoder().encode('keep'));const source=await w.foundation.registry.read(owner,owner);f.interruptRestore();
 const input={operationId:'partial_restore',expectedGeneration:source.generation,targetImage:newImage};await assert.rejects(w.imageUpgrade.run(input),/RESTORE_INTERRUPTED/);
 assert.equal((await w.foundation.registry.read(owner,owner)).lifecycleState,'starting');await assert.rejects(w.imageUpgrade.abort(input.operationId),/CANNOT_ABORT/);
 w=f.make();const result=await w.imageUpgrade.run(input);assert.equal(result.operation.phase,'verified');assert.equal(f.stats().destroys,2);await w.foundation.verifyDurability(result.operation.sourceReceipt!.receiptId);
});
