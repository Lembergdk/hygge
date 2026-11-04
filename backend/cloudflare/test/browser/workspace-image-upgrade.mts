import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import {execFileSync} from 'node:child_process';
import {sqliteWorkspace} from '../helpers/workspace-sqlite.mts';
import {createWorkspaceExecution} from '../../src/workspace-execution.ts';
import {createWorkspaceServer} from '../../container/server.mjs';
import {structuredWorkspaceHash} from '../../src/workspace-image-policy.ts';

test('real root upgrades populated SQLite/profile state, recovers partial restore, and rolls back latest work',{timeout:300000},async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'hygge-image-migration-'));
 const executablePath=process.env.HYGGE_TEST_CHROME??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
 const cert=path.join(root,'cert.pem'),key=path.join(root,'key.pem');
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-subj','/CN=127.0.0.1','-days','1'],{stdio:'ignore'});
 const site=https.createServer({key:await fs.readFile(key),cert:await fs.readFile(cert)},(req,res)=>{
  const cookie=String(req.headers.cookie??'').includes('image_fixture=kept');
  res.writeHead(200,{'content-type':'text/html',...(!cookie?{'set-cookie':'image_fixture=kept; Path=/; Max-Age=3600'}:{})});
  res.end(`<title>${cookie?'Retained login':'First visit'}</title><input aria-label="Note"><script>localStorage.setItem('image_fixture',localStorage.getItem('image_fixture')||'kept');document.querySelector('input').addEventListener('input',e=>localStorage.setItem('latest_work',e.target.value));</script>`);
 });
 await new Promise<void>(r=>site.listen(0,'127.0.0.1',r));
 const repository='registry.cloudflare.com/'+'a'.repeat(32)+'/hygge-workspace@sha256:',oldImage=repository+'1'.repeat(64),newImage=repository+'2'.repeat(64);
 const owner={environment:'staging' as const,userId:'canary',workspaceId:'private-canary'};
 let app:any=null,starting:Promise<any>|null=null,labels:any=null,running=false,image=oldImage,starts=0,loseChunk=false;
 const workspaceRoot=path.join(root,'workspace');
 const container:any={get running(){return running;},inspect:async()=>running?{image,labels}:null,
  start(options:any){image=options.image;labels=options.labels;running=true;starts++;
   starting=createWorkspaceServer({identity:JSON.parse(options.env.HYGGE_IDENTITY),secret:Uint8Array.from(Buffer.from(options.env.HYGGE_RPC_SECRET,'base64')),root:workspaceRoot,executablePath,allowLoopback:true,launchArgs:['--no-sandbox','--ignore-certificate-errors']}).then(async a=>{app=a;await a.listen();return a;});
  },
  setInactivityTimeout:async()=>{},interceptOutboundHttp:async()=>{},monitor:async()=>{},
  destroy:async()=>{await starting;await app.close();app=null;running=false;await fs.rm(workspaceRoot,{recursive:true,force:true});},
  getTcpPort(){return{fetch:async(request:Request)=>{
   await starting;const body=request.body?await request.text():undefined;
   const response=await fetch(`http://127.0.0.1:${app.server.address().port}${new URL(request.url).pathname}`,{method:request.method,headers:request.headers,body,signal:request.signal});
   if(loseChunk&&JSON.parse(body??'{}').op==='restore.chunk'){loseChunk=false;await response.text();throw Error('RESTORE_CHUNK_REPLY_LOST');}
   return response;
  }};},
 };
 const sql=sqliteWorkspace(),blobs=new Map<string,Uint8Array>();
 t.after(async()=>{await starting;if(app)await app.close();site.closeAllConnections();await new Promise<void>(r=>site.close(()=>r()));sql.sqlite.close();await fs.rm(root,{recursive:true,force:true});});
 for(const statement of ['CREATE TABLE tasks(id TEXT PRIMARY KEY,task TEXT NOT NULL)','CREATE TABLE session_profiles(domain TEXT PRIMARY KEY,has_profile INTEGER)','CREATE TABLE credentials(id TEXT PRIMARY KEY,username TEXT)','CREATE TABLE profile(id TEXT PRIMARY KEY,payload TEXT)','CREATE TABLE chat_agent_records(key TEXT PRIMARY KEY,payload TEXT NOT NULL)'])sql.storage.sql.exec(statement);
 sql.storage.sql.exec('INSERT INTO chat_agent_records VALUES (?,?)','private-note',JSON.stringify({content:'canonical note',revision:1}));
 const env:any={SELF:{fetch:async()=>new Response('denied',{status:403})},WORKSPACE_CHECKPOINTS:{put:async(k:string,v:Uint8Array)=>{if(!blobs.has(k))blobs.set(k,Uint8Array.from(v));},get:async(k:string)=>{const b=blobs.get(k);return b?{arrayBuffer:async()=>b.slice().buffer}:null;}},HYGGE_WORKSPACE_IMAGE:oldImage,HYGGE_WORKSPACE_NAMESPACE:'hygge-test',HYGGE_ENV:'staging',DB:{prepare(){throw Error('unused');}},
  HYGGE_WORKSPACE_UPGRADE_POLICY:JSON.stringify({schemaVersion:1,policyVersion:'synthetic-pair',sourceImage:oldImage,targetImage:newImage,canaryUserIds:[owner.userId],allowRollback:true}),
 };
 const options={owner,env,storage:sql.storage,container,loadTask:()=>null,projectTask:()=>{},assertLifecycleIdle:()=>{}};
 let workspace=createWorkspaceExecution(options);await workspace.ensure();
 const url=`https://127.0.0.1:${(site.address() as any).port}/`;
 const snapshot=await workspace.browser.createSession(url);await workspace.saveDocument('generation/notes/z.md',1,new TextEncoder().encode('private z'));await workspace.saveDocument('generation/notes/a.md',1,new TextEncoder().encode('private a'));
 workspace.foundation.persistence.put('effect','pending-action',0,{status:'uncertain',intentHash:'unchanged-approved-intent',approvalId:'consumed'});
 const before=await structuredWorkspaceHash(sql.storage),effect=workspace.foundation.persistence.get('effect','pending-action');
 const request=async(operationId:string,direction:'upgrade'|'rollback')=>{const b=await workspace.foundation.registry.read(owner,owner);return{operationId,direction,expectedGeneration:b.generation,expectedCheckpointId:b.recoveryPoint?.checkpointId??null,confirm:true as const};};
 const input=await request('upgrade','upgrade');loseChunk=true;
 await assert.rejects(workspace.upgrade.run(input),/CHUNK_REPLY_LOST/);assert.equal(workspace.upgrade.status()?.phase,'restoring');
 await assert.rejects(workspace.ensure(),/UPGRADE_IN_PROGRESS/);
 workspace=createWorkspaceExecution(options);
 assert.equal((await workspace.upgrade.run(input)).phase,'accepted');assert.equal(starts,3,'partial uninitialized target is retired before the successful replacement');
 assert.equal(await structuredWorkspaceHash(sql.storage),before);assert.deepEqual(workspace.foundation.persistence.get('effect','pending-action'),effect);
 assert.equal((await workspace.browser.snapshot(snapshot.sessionID))?.title,'Retained login');
 const state=await workspace.browser.exportState(snapshot.sessionID);assert.equal(state?.localStorage?.image_fixture,'kept');assert.ok(state?.cookies?.some(c=>c.name==='image_fixture'));
 await workspace.saveDocument('generation/notes/z.md',2,new TextEncoder().encode('latest work after upgrade'));
 sql.storage.sql.exec('UPDATE chat_agent_records SET payload=? WHERE key=?',JSON.stringify({content:'latest canonical note',revision:2}),'private-note');
 const latest=await structuredWorkspaceHash(sql.storage);
 assert.equal((await workspace.upgrade.run(await request('rollback','rollback'))).phase,'accepted');assert.equal(image,oldImage);assert.equal(await structuredWorkspaceHash(sql.storage),latest);assert.deepEqual(workspace.foundation.persistence.get('effect','pending-action'),effect);
 assert.equal((await workspace.browser.snapshot(snapshot.sessionID))?.title,'Retained login');
});
