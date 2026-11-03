// Run inside the locally built image, on stdin, with --network none.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import {createWorkspaceServer} from './server.mjs';
import {signRpc,b64,unb64} from '../src/workspace-container-protocol.ts';
const owner={environment:'staging',userId:'synthetic-linux-user',workspaceId:'synthetic-linux-workspace'};
const secret=new Uint8Array(32).fill(19);let seed=true;
const site=http.createServer((_req,res)=>{
 const first=seed;seed=false;
 res.writeHead(200,{'content-type':'text/html',...(first?{'set-cookie':'linux_fixture=retained; Path=/; Max-Age=3600'}:{})});
 res.end('<title>Linux synthetic jobs</title><a href="/listing">Software role listing</a>'+(first?'<script>localStorage.setItem("linux_fixture","retained")</script>':''));
});
await new Promise(resolve=>site.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${site.address().port}/`;const apps=[];
async function start(name,generation){
 const identity={...owner,incarnation:name,generation},root=`/workspace/${name}`;
 await fs.mkdir(root,{recursive:true});
 const app=await createWorkspaceServer({identity,secret,root,executablePath:'/usr/bin/chromium',allowLoopback:true,launchArgs:['--no-sandbox','--disable-dev-shm-usage']});
 apps.push(app);await app.listen();
 return async(op,args={})=>{
  const body=JSON.stringify({op,args,leaseExpiresAt:Date.now()+300000});
  const token=await signRpc(secret,identity,'/rpc',body);
  const response=await fetch(`http://127.0.0.1:${app.server.address().port}/rpc`,{method:'POST',headers:{'x-hygge-rpc':token},body});
  const data=await response.json();if(!response.ok)throw Error(data.error);return data.result;
 };
}
try{
 const first=await start('first',1);await first('initialize',{checkpointId:null});
 const snap=await first('browser.create',{url,sessionId:'reserved-linux-effect'});assert.equal(snap.title,'Linux synthetic jobs');
 const status=await first('status'),capture=await first('capture.begin',{filesystemRevision:status.nextFilesystemRevision,browserProfileRevision:status.nextBrowserProfileRevision});
 assert.equal(capture.browserState,'quiesced');assert.ok(capture.tree.files.some(f=>f.path.includes('Cookies')));
 const files=new Map();for(const file of capture.tree.files){const bytes=new Uint8Array(file.size);for(let offset=0;offset<file.size;offset+=256*1024){const chunk=await first('capture.chunk',{captureId:capture.captureId,path:file.path,offset});bytes.set(unb64(chunk.data),offset);}files.set(file.path,bytes);}
 await first('capture.release',{captureId:capture.captureId});
 const second=await start('second',2);await second('restore.begin',{checkpointId:'synthetic-verified-checkpoint',tree:capture.tree});
 for(const[file,bytes]of files)for(let offset=0;offset<bytes.length;offset+=256*1024)await second('restore.chunk',{path:file,offset,data:b64(bytes.subarray(offset,offset+256*1024))});
 await second('restore.finish',{filesystemRevision:capture.filesystemRevision,browserProfileRevision:capture.browserProfileRevision});
 const restored=await second('browser.snapshot',{id:snap.sessionID});assert.equal(restored.title,'Linux synthetic jobs');assert.ok(restored.controlEpoch>snap.controlEpoch);
 const state=await second('browser.export',{id:snap.sessionID});assert.equal(state.localStorage.linux_fixture,'retained');assert.ok(state.cookies.some(c=>c.name==='linux_fixture'&&c.value==='retained'));
 console.log(JSON.stringify({ok:true,platform:process.platform,arch:process.arch,localDockerOnly:true,fullProfileColdRestore:true,files:capture.tree.files.length,bytes:capture.tree.files.reduce((sum,f)=>sum+f.size,0),providerAcceptance:false}));
}finally{for(const app of apps)await app.close();site.closeAllConnections();await new Promise(resolve=>site.close(resolve));}
