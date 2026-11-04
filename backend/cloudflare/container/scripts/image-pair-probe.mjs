// Executed on stdin inside each image with --network none. Fixture data is synthetic only.
import assert from 'node:assert/strict';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createWorkspaceServer} from '/srv/container/server.mjs';
import {signRpc,b64,unb64} from '/srv/src/workspace-container-protocol.ts';
const input=globalThis.__imageProbeInput;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const owner={environment:'staging',userId:'synthetic-image-canary',workspaceId:'synthetic-image-workspace'};
const identity={...owner,incarnation:`image-probe-${input.generation}`,generation:input.generation},secret=new Uint8Array(32).fill(23);
const prefix='file_'+'d'.repeat(32)+'_';
const site=http.createServer((_req,res)=>{
 res.writeHead(200,{'content-type':'text/html',...(input.generation===1?{'set-cookie':'image_fixture=retained; Path=/; Max-Age=3600'}:{})});
 res.end('<title>Synthetic image upgrade</title><input aria-label="Note"><script>document.querySelector("input").addEventListener("input",e=>localStorage.setItem("latest_work",e.target.value));'+(input.generation===1?'localStorage.setItem("image_fixture","retained");':'')+'</script>');
});
await new Promise(resolve=>site.listen(4321,'127.0.0.1',resolve));
const app=await createWorkspaceServer({identity,secret,root:'/workspace/image-probe',executablePath:'/usr/bin/chromium',allowLoopback:true,launchArgs:['--no-sandbox','--disable-dev-shm-usage']});
await app.listen();
async function call(op,args={}){
 const body=JSON.stringify({op,args,leaseExpiresAt:Date.now()+300000}),token=await signRpc(secret,identity,'/rpc',body);
 const response=await fetch(`http://127.0.0.1:${app.server.address().port}/rpc`,{method:'POST',headers:{'x-hygge-rpc':token},body,signal:AbortSignal.timeout(120000)});
 const result=await response.json();if(!response.ok)throw Error(result.error);return result.result;
}
try{
 if(input.snapshot){
  await call('restore.begin',{checkpointId:input.snapshot.checkpointId,tree:input.snapshot.tree});
  for(const file of input.snapshot.tree.files){const bytes=Buffer.from(input.snapshot.files[file.path],'base64');assert.equal(hash(bytes),file.hash);for(let offset=0;offset<bytes.length;offset+=256*1024)await call('restore.chunk',{path:file.path,offset,data:b64(bytes.subarray(offset,offset+256*1024))});}
  await call('restore.finish',{filesystemRevision:input.snapshot.filesystemRevision,browserProfileRevision:input.snapshot.browserProfileRevision});
 }else await call('initialize',{checkpointId:null});
 let snap=input.snapshot?await call('browser.snapshot',{id:'retained-session'}):await call('browser.create',{url:'http://127.0.0.1:4321/',sessionId:'retained-session'});
 assert.equal(snap.title,'Synthetic image upgrade');
 const state=await call('browser.export',{id:'retained-session'});
 assert.equal(state.localStorage.image_fixture,'retained');assert.ok(state.cookies.some(c=>c.name==='image_fixture'&&c.value==='retained'));
 if(input.snapshot)assert.ok(snap.controlEpoch>input.snapshot.controlEpoch);
 if(input.generation===1)await call('artifact.write',{ref:prefix+'1',data:b64(Buffer.from('original private note'))});
 const status=await call('status');
 if(input.expectProtocol1)assert.equal(status.artifactProtocolVersion,1);
 if(input.generation===2){
  const bytes=Buffer.alloc(578754,71),manifest={ref:'large-private-evidence',size:bytes.length,sha256:hash(bytes)};
  const {uploadId}=await call('artifact.begin',manifest);
  for(let offset=0;offset<bytes.length;offset+=256*1024)await call('artifact.chunk',{uploadId,offset,data:b64(bytes.subarray(offset,offset+256*1024))});
  await call('artifact.commit',{...manifest,uploadId});await call('artifact.deleteDocuments',{prefix,throughRevision:1});
  await call('artifact.write',{ref:prefix+'2',data:b64(Buffer.from('corrected private note'))});
  snap=await call('browser.act',{id:'retained-session',epoch:snap.controlEpoch,action:'type',target:'Note',value:'latest work after upgrade'});
 }
 if(input.generation>2){
  assert.equal(state.localStorage.latest_work,'latest work after upgrade');
  const refs=await call('artifact.list');assert.ok(refs.includes('large-private-evidence'));assert.ok(refs.includes(prefix+'2'));assert.ok(!refs.includes(prefix+'1'));
  if(input.expectProtocol1)await assert.rejects(call('artifact.begin',{ref:prefix+'1',size:1,sha256:hash('x')}),/REVISION_DELETED/);
 }
 const latest=await call('status'),capture=await call('capture.begin',{filesystemRevision:latest.nextFilesystemRevision,browserProfileRevision:latest.nextBrowserProfileRevision});
 const files={};for(const file of capture.tree.files){const bytes=Buffer.alloc(file.size);for(let offset=0;offset<file.size;offset+=256*1024){const c=await call('capture.chunk',{captureId:capture.captureId,path:file.path,offset});bytes.set(unb64(c.data),offset);}assert.equal(hash(bytes),file.hash);files[file.path]=bytes.toString('base64');}
 await call('capture.release',{captureId:capture.captureId});
 if(input.generation>1){assert.equal(hash(Buffer.from(files['artifacts/large-private-evidence'],'base64')),hash(Buffer.alloc(578754,71)));assert.ok(files['.artifact-tombstones.json']);}
 const snapshot={checkpointId:hash(JSON.stringify(capture.tree)),tree:capture.tree,files,filesystemRevision:capture.filesystemRevision,browserProfileRevision:capture.browserProfileRevision,controlEpoch:snap.controlEpoch};
 console.log(JSON.stringify({ok:true,chromium:execFileSync('/usr/bin/chromium',['--version'],{encoding:'utf8'}).trim(),protocol:status.artifactProtocolVersion??0,snapshot}));
}finally{await app.close();site.closeAllConnections();await new Promise(resolve=>site.close(resolve));}
