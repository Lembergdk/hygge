import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import {execFileSync} from 'node:child_process';
import {createWorkspaceExecution} from '../../src/workspace-execution.ts';
import {runMission} from '../../src/agent.ts';
import {sqliteWorkspace} from '../helpers/workspace-sqlite.mts';
import {createWorkspaceServer} from '../../container/server.mjs';

// Real Chromium + real SQLite + real capture/HMAC/checkpoints. The Cloudflare
// lifecycle and R2 network are explicit local adapters, never provider proof.
test('integrated mission commits real browser profile/evidence before task success and replays without browsing',async t=>{
 const executablePath=process.env.HYGGE_TEST_CHROME??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
 await fs.access(executablePath);
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'hygge-wave2-integrated-'));
 let node:any=null,starting:Promise<any>|null=null,labels:any=null,running=false;
 const cert=path.join(root,'cert.pem'),key=path.join(root,'key.pem');
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-subj','/CN=127.0.0.1','-days','1'],{stdio:'ignore'});
 const site=https.createServer({key:await fs.readFile(key),cert:await fs.readFile(cert)},(_req,res)=>{
  res.writeHead(200,{'content-type':'text/html'});res.end('<title>Synthetic jobs</title><a href="/listing">Software role listing</a>');
 });
 await new Promise<void>(r=>site.listen(0,'127.0.0.1',r));
 t.after(async()=>{if(starting)await starting;if(node)await node.close();site.closeAllConnections();await new Promise<void>(r=>site.close(()=>r()));await fs.rm(root,{recursive:true,force:true});});
 const url=`https://127.0.0.1:${(site.address() as any).port}/`;
 const {storage}=sqliteWorkspace();
 for(const sql of ["CREATE TABLE tasks(id TEXT PRIMARY KEY,task TEXT NOT NULL)","CREATE TABLE session_profiles(domain TEXT PRIMARY KEY,has_profile INTEGER)","CREATE TABLE credentials(id TEXT PRIMARY KEY,username TEXT)","CREATE TABLE profile(id TEXT PRIMARY KEY,payload TEXT)"]) storage.sql.exec(sql);
 let task:any={id:'synthetic-task',kind:'discover',target_url:url,goal:'Find listings',status:'running',drafted_payload:{},interaction_version:1,log:[]};
 const loadTask=(id:string)=>{const row=[...storage.sql.exec('SELECT task FROM tasks WHERE id=?',id)][0];return row?JSON.parse(String(row.task)):null;};
 const projectTask=(value:any)=>storage.sql.exec('INSERT INTO tasks(id,task) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET task=excluded.task',value.id,JSON.stringify(value));
 projectTask(task);
 const image='registry.example/hygge-test@sha256:'+'a'.repeat(64);
 const container:any={get running(){return running;},inspect:async()=>running?{image,labels}:null,
  start(options:any){labels=options.labels;running=true;starting=createWorkspaceServer({identity:JSON.parse(options.env.HYGGE_IDENTITY),secret:Uint8Array.from(Buffer.from(options.env.HYGGE_RPC_SECRET,'base64')),root:path.join(root,'workspace'),executablePath,allowLoopback:true,launchArgs:['--no-sandbox','--ignore-certificate-errors']}).then(async app=>{node=app;await app.listen();return app;});},
  setInactivityTimeout:async()=>{},interceptOutboundHttp:async()=>{},interceptOutboundHttps:async()=>{},monitor:async()=>{},destroy:async()=>{if(starting)await starting;if(node)await node.close();running=false;},
  getTcpPort(){return {fetch:async(request:Request)=>{await starting;const address=node.server.address();return fetch(`http://127.0.0.1:${address.port}${new URL(request.url).pathname}`,{method:request.method,headers:request.headers,body:request.body?await request.text():undefined});}};},
 };
 const blobs=new Map<string,Uint8Array>();
 const bucket:any={put:async(k:string,v:Uint8Array)=>{if(!blobs.has(k))blobs.set(k,Uint8Array.from(v));},get:async(k:string)=>{const value=blobs.get(k);return value?{arrayBuffer:async()=>Uint8Array.from(value).buffer}:null;}};
 const env:any={SELF:{fetch:async()=>new Response('denied',{status:403})},WORKSPACE_CHECKPOINTS:bucket,HYGGE_WORKSPACE_IMAGE:image,HYGGE_WORKSPACE_NAMESPACE:'hygge-test',HYGGE_ENV:'staging',DB:{prepare(){throw Error('No shared registry configured');}}};
 const workspace=createWorkspaceExecution({owner:{environment:'staging',userId:'synthetic-user',workspaceId:'synthetic-do'},env,storage,container,loadTask,projectTask});
 let decisions=0,missions=0;
 const mission=async(hooks:any,_run:string,scopedTask:any)=>{missions++;return runMission({browser:workspace.browser,task:scopedTask,workspaceHooks:hooks,decider:{simulated:false,decide:async()=>++decisions===1?{action:'extract',target:'listings'}:{action:'done'}}});};
 const result=await workspace.run(task,mission);
 assert.equal(result.status,'succeeded');assert.equal(loadTask(task.id).status,'succeeded');
 const run=workspace.foundation.persistence.get<any>('run',result.workspace_run_id)!.value;
 const receipt=await workspace.foundation.checkpoints.getCanonicalRunReceipt(workspace.foundation.persistence.owner,run.completionReceiptId);
 assert.ok(receipt);assert.equal(await workspace.foundation.checkpoints.verifyDurabilityCoverage(workspace.foundation.persistence.owner,receipt!,[]),true);
 const manifests=[...blobs.keys()].filter(k=>k.includes('/manifests/'));
 assert.ok(manifests.length>=3);
 const last=JSON.parse(new TextDecoder().decode(blobs.get(manifests.at(-1)!)!));
 assert.ok(last.files.some((f:any)=>f.path.includes('profile/')));assert.ok(Object.keys(last.artifacts).some(k=>k.endsWith('_completion')));
 assert.equal((await workspace.run(task,mission)).status,'succeeded');assert.equal(missions,1);
 // Document mirrors use byte bounds, owner admission, immutable revisions, and deletion tombstones.
 const notePath='synthetic-generation/notes/preferences.md',unicode=new TextEncoder().encode('世'.repeat(100000));
 const noteReceipt=await workspace.saveDocument(notePath,1,unicode);
 assert.ok(noteReceipt.coveredArtifactRefs.some(ref=>ref.startsWith('file_')));
 await workspace.eraseDocument(notePath,1);
 await assert.rejects(workspace.saveDocument(notePath,1,unicode),/REVISION_DELETED/);
 const corrected=await workspace.saveDocument(notePath,2,new TextEncoder().encode('Corrected note'));
 assert.ok(corrected.coveredArtifactRefs.some(ref=>ref.startsWith('file_')&&ref.endsWith('_2')));
 // A new DO composition reattaches to the exact live incarnation; no fresh disk.
 const reconstructed=createWorkspaceExecution({owner:workspace.foundation.persistence.owner,env,storage,container,loadTask,projectTask});
 await reconstructed.ensure();assert.ok(await reconstructed.browser.snapshot(result.session_id));
});
