import {createRequire} from 'node:module';
import {writeFile,readFile,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
const require=createRequire(new URL('../package.json',import.meta.url));
const workspaceModule=fileURLToPath(new URL('../src/workspace-foundation.ts',import.meta.url));
const {build}=require('esbuild');const {Miniflare,convertV4MiniflareOptions}=require('miniflare');
const code=`import {DurableObject} from 'cloudflare:workers';
import {createWorkspaceFoundation} from ${JSON.stringify(workspaceModule)};
export class TestWorkspace extends DurableObject {
 async fetch(){
  const owner={environment:'staging',userId:'synthetic-worker',workspaceId:'synthetic-workspace'};
  const objects=new Map();let verify=true;
  const f=createWorkspaceFoundation({owner,storage:this.ctx.storage,signingKey:new Uint8Array(32).fill(21),
   objects:{async get(k){return objects.get(k)?.slice()??null;},async putImmutable(k,b){if(!objects.has(k))objects.set(k,b.slice());}},
   consent:{assertDispatchAllowed(){throw Error('unused');}},verifyOutcome:async()=>false,verifyCompletion:async()=>verify,
   provider:{async start(b){return{runtimeId:'r1',providerRuntimeId:'p1',incarnation:'i1',recoveredCheckpointId:b.recoveryPoint?.checkpointId??null};},async fence(){throw Error('unused');}},
   captureDriver:{async capture(l,r){return{snapshot:{incarnation:l.incarnation,generation:l.generation,filesystemRevision:r.filesystemRevision,browserProfileRevision:0,browserState:'absent',files:[{path:'evidence.txt',bytes:new TextEncoder().encode('synthetic postcondition')}],artifacts:{evidence:'evidence.txt'}},async release(){}};}}});
  await f.registry.initialize(owner,{...owner,provider:'cloudflare',namespaceId:'synthetic-hygge',providerWorkspaceId:'synthetic-private',ownerDigest:'digest',schemaVersion:1,incarnation:'',generation:0,runtimeId:null,providerRuntimeId:null,desiredImageDigest:'image',leaseExpiresAt:null,lifecycleState:'unprovisioned',revision:0,recoveryPoint:null,lastVerifiedAt:new Date().toISOString()});
  await f.registry.ensure(owner,owner,'start');
  const cap=await f.broker.issue(['checkpoint.commit','workspace.commit','task.complete'],{taskId:'task'});
  const ctx=(id,rev)=>({requestId:id,expectedRevision:rev,capabilityToken:cap});
  await f.checkpoints.startRun(ctx('begin',0),{taskId:'task',runId:'run',siteOrigin:'https://jobs.example.com',outcome:'discover',candidate:{kind:'ordinary'}});
  const binding=await f.registry.read(owner,owner);
  const saved=await f.save(cap,{writeId:'save',expectedRegistryRevision:binding.revision,filesystemRevision:1,browserProfileRevision:0,artifactRefs:['evidence']});
  const input={runId:'run',checkpoint:{...owner,schemaVersion:1,taskId:'task',runId:'run',filesystemRevision:1,browserProfileRevision:0,workspaceDurabilityReceiptId:saved.receiptId,privateArtifactRefs:['evidence'],helpId:null},candidateBodyHash:null,verification:{kind:'observed_postcondition',policyVersion:'test-v1',evidenceRef:'evidence'}};
  const receipt=await f.checkpoints.complete(ctx('finish',1),input);
  verify=false; // Committed retries must not depend on a fresh external verifier.
  const duplicate=await f.checkpoints.complete(ctx('finish',1),input);
  return Response.json({ok:receipt.receiptId===duplicate.receiptId,ordinaryCandidate:receipt.candidateBodyHash,checkpoint:saved.recoveryPoint.sequence});
 }
}
export default{fetch(request,env){return env.TEST.get(env.TEST.idFromName('synthetic-only')).fetch(request);}};`;
const dir=await mkdtemp(join(tmpdir(),'hygge-workspace-smoke-'));
const entry=join(dir,'entry.ts'),out=join(dir,'worker.mjs');
await writeFile(entry,code);await build({entryPoints:[entry],outfile:out,bundle:true,format:'esm',platform:'browser',external:['cloudflare:workers']});
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:await readFile(out,'utf8'),compatibilityDate:'2026-10-30',durableObjects:{TEST:{className:'TestWorkspace',useSQLite:true}},durableObjectsPersist:false}));
try{const res=await mf.dispatchFetch('https://synthetic.example/');const result=await res.text();console.log(JSON.stringify({status:res.status,result}));if(!res.ok||!JSON.parse(result).ok)process.exitCode=1;}finally{await mf.dispose();await rm(dir,{recursive:true,force:true});}
