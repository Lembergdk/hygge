import type {WorkspaceIdentity,WorkspaceBinding,RuntimeLease,RecoveryPoint,RuntimeFenceEvidence} from './workspace-contract.ts';
import type {RuntimeProvider,RuntimeStart} from './workspace-runtime.ts';
import type {PrivateObjectStore,NativeCaptureDriver,CaptureWrite,NativeCapture} from './workspace-capture.ts';
import {assertOwner,ownerKey} from './workspace-runtime.ts';
import {WorkspaceBrowser} from './workspace-browser.ts';
import {signRpc,digest,b64,unb64,validateTree,CHUNK_BYTES,RPC_MAX_BYTES,type ContainerIdentity,type TreeMetadata} from './workspace-container-protocol.ts';
export interface WorkspaceContainer {
 readonly running:boolean;
 start(options:{image:string;enableInternet:boolean;instance?:'standard-2';env:Record<string,string>;labels:Record<string,string>}):void;
 inspect():Promise<{image:string;labels:Record<string,string>}|null>;
 destroy():Promise<void>;monitor():Promise<void>;
 setInactivityTimeout(ms:number):Promise<void>;
 getTcpPort(port:number):{fetch(request:Request):Promise<Response>};
 interceptOutboundHttp(target:string,handler:Fetcher):Promise<void>;
}
export interface ContainerWorkspaceOptions {
 owner:WorkspaceIdentity;container:WorkspaceContainer;image:string;rpcSecret:Uint8Array;objects:PrivateObjectStore;
 namespaceId:string;providerWorkspaceId:string;getLease:()=>Promise<RuntimeLease>;now?:()=>number;
 /** Trusted deployment policy only; a model/request cannot extend these pins. */
 allowedImages?:readonly string[];
 allowIncompleteRestoreRetry?:boolean;
 authorizeImageRestore?:(binding:WorkspaceBinding,sourceImage:string)=>Promise<void>;
 fenceJournal?:{get(key:string):any;put(key:string,value:any):void};
 /** Real service-binding Fetcher that receives (and thus blocks) private-range outbound HTTP. */
 denyFetcher?:Fetcher;
}
interface Status extends ContainerIdentity {artifactProtocolVersion?:number;maxArtifactBytes?:number;initialized:boolean;recoveredCheckpointId:string|null;filesystemRevision:number;browserProfileRevision:number;nextFilesystemRevision:number;nextBrowserProfileRevision:number;humanControlled:boolean;humanControlledSessions?:{sessionID:string;url:string}[];frozen:boolean}
interface Manifest extends TreeMetadata,WorkspaceIdentity {schemaVersion:number;imageDigest:string;incarnation:string;generation:number;sequence:number;filesystemRevision:number;browserProfileRevision:number}
/** Owner-bound factory. Root must authenticate routes/capture and configure a private container binding. */
export function createContainerWorkspace(options:ContainerWorkspaceOptions){
 const owner=Object.freeze(structuredClone(options.owner));assertOwner(owner,owner);const secret=Uint8Array.from(options.rpcSecret);if(secret.length<32||!options.namespaceId||!options.providerWorkspaceId||!options.image||!/@sha256:[a-f0-9]{64}$/.test(options.image))throw Error('PINNED_HYGGE_IMAGE_AND_RPC_KEY_REQUIRED');
 async function boundedResponse(response:Response):Promise<string>{if(Number(response.headers.get('content-length')??0)>RPC_MAX_BYTES)throw Error('RPC_RESPONSE_LIMIT');if(!response.body)return '';const reader=response.body.getReader();const decoder=new TextDecoder();let total=0,text='';try{while(true){const part=await reader.read();if(part.done)break;total+=part.value.byteLength;if(total>RPC_MAX_BYTES){await reader.cancel();throw Error('RPC_RESPONSE_LIMIT');}text+=decoder.decode(part.value,{stream:true});}return text+decoder.decode();}finally{reader.releaseLock();}}
 const now=options.now??Date.now;let active:ContainerIdentity|null=null;
 const allowed=new Set([options.image,...(options.allowedImages??[])]);
 if([...allowed].some(image=>!/@sha256:[a-f0-9]{64}$/.test(image)))throw Error('INVALID_IMAGE_POLICY');
 function imageFor(binding:WorkspaceBinding){if(!allowed.has(binding.desiredImageDigest))throw Error('PLACEMENT_OR_IMAGE_MISMATCH');return binding.desiredImageDigest;}
 const prefix=`hygge-workspaces/v1/${ownerKey(owner)}`;
 function assertActive(expected:ContainerIdentity){assertOwner(owner,expected);if(!active||active.incarnation!==expected.incarnation||active.generation!==expected.generation)throw Error('STALE_GENERATION');}
 async function current(){const lease=await options.getLease();assertOwner(owner,lease);if(!active||lease.incarnation!==active.incarnation||lease.generation!==active.generation||Date.parse(lease.expiresAt)<=now())throw Error('STALE_GENERATION');return lease;}
 async function raw(op:string,args:Record<string,unknown>={},leaseExpiresAt?:number,expected?:ContainerIdentity,timeoutMs=120_000){
  if(!active)throw Error('RUNTIME_NOT_STARTED');
  const identity=Object.freeze(structuredClone(expected??active));assertActive(identity);
  const body=JSON.stringify({op,args,...(leaseExpiresAt?{leaseExpiresAt}:{})});
  if(new TextEncoder().encode(body).length>RPC_MAX_BYTES)throw Error('RPC_BODY_LIMIT');
  const token=await signRpc(secret,identity,'/rpc',body,now());assertActive(identity);
  try{
   const response=await options.container.getTcpPort(8080).fetch(new Request('http://container/rpc',{
    method:'POST',headers:{'content-type':'application/json','x-hygge-rpc':token},body,signal:AbortSignal.timeout(timeoutMs),
   }));
   const text=await boundedResponse(response);assertActive(identity);
   const result=JSON.parse(text);
   if(!response.ok||result.error)throw Error(result.error??'CONTAINER_RPC_FAILED');
   return result.result;
  }catch(error){if(error instanceof Error&&error.name==='TimeoutError')throw Error('CONTAINER_RPC_TIMEOUT');throw error;}
 }
 async function call<T>(op:string,args:Record<string,unknown>={}):Promise<T>{const lease=await current();const expected=Object.freeze({...owner,incarnation:lease.incarnation,generation:lease.generation});return raw(op,args,Date.parse(lease.expiresAt),expected);}
 async function recovery(point:RecoveryPoint,binding:WorkspaceBinding):Promise<{manifest:Manifest;bytes:Map<string,Uint8Array>}>{assertOwner(owner,point);if(point.storage!=='r2'||point.checkpointId!==point.manifestHash||!/[a-f0-9]{64}/.test(point.manifestHash))throw Error('INVALID_RECOVERY_POINT');const data=await options.objects.get(`${prefix}/manifests/${point.manifestHash}`);if(!data||await digest(data)!==point.manifestHash)throw Error('MANIFEST_VERIFICATION_FAILED');const m=JSON.parse(new TextDecoder().decode(data))as Manifest;assertOwner(owner,m);validateTree(m);if(m.schemaVersion!==1||m.incarnation!==point.sourceIncarnation||m.generation!==point.sourceGeneration||m.sequence!==point.sequence)throw Error('RECOVERY_IMAGE_OR_LINEAGE_MISMATCH');if(m.imageDigest!==imageFor(binding)){if(!options.authorizeImageRestore)throw Error('RECOVERY_IMAGE_OR_LINEAGE_MISMATCH');await options.authorizeImageRestore(binding,m.imageDigest);}const bytes=new Map<string,Uint8Array>();for(const f of m.files){const b=await options.objects.get(`${prefix}/blobs/${f.hash}`);if(!b||b.length!==f.size||await digest(b)!==f.hash)throw Error('RESTORE_INTEGRITY');bytes.set(f.path,b);}return{manifest:m,bytes};}
 async function attach(binding:WorkspaceBinding){
  assertOwner(owner,binding);const selectedImage=imageFor(binding);
  if(binding.provider!=='cloudflare'||binding.namespaceId!==options.namespaceId||binding.providerWorkspaceId!==options.providerWorkspaceId||binding.desiredImageDigest!==selectedImage||binding.lifecycleState!=='ready'||!binding.runtimeId||binding.providerRuntimeId!==binding.incarnation)throw Error('PLACEMENT_OR_INCARNATION_MISMATCH');
  const info=await options.container.inspect();const ownerHash=(await digest(new TextEncoder().encode(ownerKey(owner)))).slice(0,32);
  if(!info||info.image!==selectedImage||info.labels.owner!==ownerHash||info.labels.incarnation!==binding.incarnation||info.labels.generation!==String(binding.generation))throw Error('EXACT_INCARNATION_MISMATCH');
  active={...owner,incarnation:binding.incarnation,generation:binding.generation};
  try{const status=await raw('status') as Status;assertOwner(owner,status);if(!status.initialized||status.incarnation!==binding.incarnation||status.generation!==binding.generation)throw Error('EXACT_INCARNATION_MISMATCH');return status;}catch(e){active=null;throw e;}
 }
 async function startRuntime(binding:WorkspaceBinding,operationId:string,repairAttempt=0):Promise<RuntimeStart>{assertOwner(owner,binding);const selectedImage=imageFor(binding);if(binding.provider!=='cloudflare'||binding.namespaceId!==options.namespaceId||binding.providerWorkspaceId!==options.providerWorkspaceId||binding.desiredImageDigest!==selectedImage)throw Error('PLACEMENT_OR_IMAGE_MISMATCH');const ownerHash=(await digest(new TextEncoder().encode(ownerKey(owner)))).slice(0,32);const operationHash=(await digest(new TextEncoder().encode(`${operationId}:${binding.generation}`))).slice(0,32);let info: Awaited<ReturnType<WorkspaceContainer['inspect']>>; try{info=await options.container.inspect();}catch(e){throw new Error(`CONTAINER_INSPECT:${e instanceof Error?e.message:String(e)}`);}
  if(info){if(info.labels.owner!==ownerHash||info.labels.operation!==operationHash||info.labels.generation!==String(binding.generation)||!info.labels.incarnation||info.image!==selectedImage)throw Error('EXACT_INCARNATION_MISMATCH');active={...owner,incarnation:info.labels.incarnation,generation:binding.generation};}
  else{if(!options.denyFetcher||typeof options.denyFetcher.fetch!=='function')throw Error('OUTBOUND_DENY_FETCHER_REQUIRED');active={...owner,incarnation:crypto.randomUUID(),generation:binding.generation};const deny=options.denyFetcher;try{options.container.start({image:selectedImage,enableInternet:true,instance:'standard-2',env:{HYGGE_IDENTITY:JSON.stringify(active),HYGGE_RPC_SECRET:b64(secret),HOME:'/workspace'},labels:{owner:ownerHash,operation:operationHash,generation:String(binding.generation),incarnation:active.incarnation}});}catch(e){throw new Error(`CONTAINER_START:${e instanceof Error?e.message:String(e)}`);}for(const cidr of ['127.0.0.0/8','10.0.0.0/8','172.16.0.0/12','192.168.0.0/16','169.254.0.0/16','0.0.0.0/8','::1/128','fc00::/7','fe80::/10'])await options.container.interceptOutboundHttp(cidr,deny).catch(e=>{throw new Error(`CONTAINER_INTERCEPT:${cidr}:${e instanceof Error?e.message:String(e)}`);});}
  let status:Status|undefined;let last:unknown;let monitorError:unknown;void options.container.monitor().catch(e=>{monitorError=e;});const startupDeadline=Date.now()+120_000;for(let attempt=0;attempt<120&&Date.now()<startupDeadline;attempt++){if(monitorError)throw new Error(`CONTAINER_MONITOR:${monitorError instanceof Error?monitorError.message:String(monitorError)}`);try{status=await raw('status',{},undefined,undefined,Math.max(1,Math.min(5_000,startupDeadline-Date.now())));break;}catch(e){last=e;await new Promise(r=>setTimeout(r,500));}}if(!status&&monitorError)throw new Error(`CONTAINER_MONITOR:${monitorError instanceof Error?monitorError.message:String(monitorError)}`);if(!status)throw last??Error('CONTAINER_START_TIMEOUT');await options.container.setInactivityTimeout(6*60*60*1000);assertOwner(owner,status);if(status.incarnation!==active.incarnation||status.generation!==binding.generation)throw Error('EXACT_INCARNATION_MISMATCH');
  if(!status.initialized&&status.frozen&&binding.recoveryPoint&&options.allowIncompleteRestoreRetry&&repairAttempt<1){
   // A never-admitted partial restore contains no new business writes. Re-prove
   // the independent source before retiring only this exact uninitialized attempt.
   await recovery(binding.recoveryPoint,binding);
   const incomplete=await options.container.inspect();
   if(!incomplete||incomplete.image!==selectedImage||incomplete.labels.owner!==ownerHash||incomplete.labels.operation!==operationHash
     ||incomplete.labels.generation!==String(binding.generation)||incomplete.labels.incarnation!==active.incarnation)throw Error('EXACT_INCARNATION_MISMATCH');
   options.fenceJournal?.put(`partial-restore:${operationId}:${active.incarnation}`,{generation:binding.generation,incarnation:active.incarnation,checkpointId:binding.recoveryPoint.checkpointId});
   await options.container.destroy();await options.container.monitor();if(options.container.running||await options.container.inspect()!==null)throw Error('FENCE_UNCONFIRMED');active=null;
   return startRuntime(binding,operationId,repairAttempt+1);
  }
  if(!status.initialized){if(binding.recoveryPoint){const {manifest:m,bytes}=await recovery(binding.recoveryPoint,binding);await raw('restore.begin',{checkpointId:binding.recoveryPoint.checkpointId,tree:{files:m.files,directories:m.directories,symlinks:m.symlinks,artifacts:m.artifacts}});for(const f of m.files){const b=bytes.get(f.path)!;for(let offset=0;offset<b.length;offset+=CHUNK_BYTES)await raw('restore.chunk',{path:f.path,offset,data:b64(b.subarray(offset,offset+CHUNK_BYTES))});}await raw('restore.finish',{filesystemRevision:m.filesystemRevision,browserProfileRevision:m.browserProfileRevision});}else await raw('initialize',{checkpointId:null});}
  status=await raw('status');if(!status!.initialized||status!.recoveredCheckpointId!==(binding.recoveryPoint?.checkpointId??null))throw Error('RESTORE_NOT_VERIFIED');const inspect=await options.container.inspect();if(inspect?.labels.incarnation!==active.incarnation)throw Error('EXACT_INCARNATION_MISMATCH');return{runtimeId:options.providerWorkspaceId,providerRuntimeId:active.incarnation,incarnation:active.incarnation,recoveredCheckpointId:status!.recoveredCheckpointId};}
 const provider:RuntimeProvider={start:startRuntime,
 async fence(binding:WorkspaceBinding,operationId:string):Promise<RuntimeFenceEvidence>{assertOwner(owner,binding);const key=`${operationId}:${binding.incarnation}:${binding.generation}`,info=await options.container.inspect();
  const ownerHash=(await digest(new TextEncoder().encode(ownerKey(owner)))).slice(0,32);
  let result:'exact_incarnation_stopped'|'exact_incarnation_absent'='exact_incarnation_stopped';
  let destroyed=false;
  let previousIncarnation=binding.incarnation,previousGeneration=binding.generation,requestId=`destroy:${operationId}:${binding.incarnation}`,orphanIncarnation:string|undefined;
  if(!info){
   // The container is already gone: nothing to destroy. A prior fence intent
   // (destroy happened, its ack was lost) keeps the stronger 'stopped'
   // result; without one the evidence records the absence itself.
   const intent=options.fenceJournal?.get(key);
   if(!(intent&&intent.incarnation===binding.incarnation&&intent.generation===binding.generation&&intent.image===binding.desiredImageDigest)){result='exact_incarnation_absent';requestId=`inspect:${operationId}:${binding.incarnation}`;}
  }else if(info.labels.owner===ownerHash&&info.labels.incarnation!==binding.incarnation&&Number.isSafeInteger(Number(info.labels.generation))&&Number(info.labels.generation)<=binding.generation){
   // Orphan: a container of this workspace (the owner label proves it) from
   // an earlier incarnation that was never fenced. Destroy it; the evidence
   // names the orphan so the registry can tell it from the exact case. A
   // foreign owner label, or a generation newer than the binding, refuses.
   previousIncarnation=info.labels.incarnation;previousGeneration=Number(info.labels.generation);orphanIncarnation=info.labels.incarnation;requestId=`destroy:${operationId}:${info.labels.incarnation}`;
   options.fenceJournal?.put(key,{incarnation:info.labels.incarnation,generation:Number(info.labels.generation),image:info.image});await options.container.destroy();destroyed=true;
  }else{
   if(info.image!==imageFor(binding)||info.labels.owner!==ownerHash||info.labels.incarnation!==binding.incarnation||binding.providerRuntimeId!==binding.incarnation||info.labels.generation!==String(binding.generation))throw Error('FENCE_UNCONFIRMED');
   options.fenceJournal?.put(key,{incarnation:binding.incarnation,generation:binding.generation,image:binding.desiredImageDigest});await options.container.destroy();destroyed=true;
  }
 // monitor() settles when a destroyed container stops, but throws when
 // this instance has no container at all. When nothing was destroyed the
 // container was already absent, so there is nothing to wait for: the
 // null inspect() in the confirmation below is the evidence.
 if(destroyed)await options.container.monitor();if(options.container.running||await options.container.inspect()!==null)throw Error('FENCE_UNCONFIRMED');active=null;return{...owner,provider:'cloudflare',previousRuntimeId:binding.runtimeId!,previousIncarnation,previousGeneration,providerRuntimeId:binding.providerRuntimeId!,browserRetired:true,result,verifiedAt:new Date(now()).toISOString(),providerRequestIds:[requestId],...(orphanIncarnation?{orphanIncarnation}:{})};}};
 const captureDriver:NativeCaptureDriver={async capture(lease:RuntimeLease,request:CaptureWrite){assertOwner(owner,lease);const live=await current();if(live.leaseId!==lease.leaseId)throw Error('STALE_LEASE');const begin=await call<any>('capture.begin',{filesystemRevision:request.filesystemRevision,browserProfileRevision:request.browserProfileRevision});try{validateTree(begin.tree);const files=[];for(const f of begin.tree.files){const bytes=new Uint8Array(f.size);for(let offset=0;offset<f.size;offset+=CHUNK_BYTES){const chunk=await call<{data:string}>('capture.chunk',{captureId:begin.captureId,path:f.path,offset});const b=unb64(chunk.data);if(b.length!==Math.min(CHUNK_BYTES,f.size-offset))throw Error('CAPTURE_CHUNK_MISMATCH');bytes.set(b,offset);}if(await digest(bytes)!==f.hash)throw Error('CAPTURE_INTEGRITY');files.push({path:f.path,mode:f.mode,bytes});}const snapshot:NativeCapture={incarnation:lease.incarnation,generation:lease.generation,filesystemRevision:begin.filesystemRevision,browserProfileRevision:begin.browserProfileRevision,browserState:begin.browserState,files,directories:begin.tree.directories,symlinks:begin.tree.symlinks,artifacts:begin.tree.artifacts};return{snapshot,release:async()=>{await call('capture.release',{captureId:begin.captureId});}};}catch(e){await call('capture.release',{captureId:begin.captureId}).catch(()=>{});throw e;}}};
 const browser=new WorkspaceBrowser({call,async stream(id){const lease=await current();const expected=Object.freeze({...owner,incarnation:lease.incarnation,generation:lease.generation});assertActive(expected);const path=`/live?session=${encodeURIComponent(id)}&expires=${Date.parse(lease.expiresAt)}`;const token=await signRpc(secret,expected,path,'',now());assertActive(expected);return options.container.getTcpPort(8080).fetch(new Request(`http://container${path}`,{headers:{Upgrade:'websocket','x-hygge-rpc':token}}));}});
 async function writeArtifact(ref:string,bytes:Uint8Array){
  const first=await current();
  const expected=Object.freeze({...owner,incarnation:first.incarnation,generation:first.generation});
  // A transfer may renew its lease, but must never cross an incarnation or generation.
  async function transfer<T>(op:string,args:Record<string,unknown>={}):Promise<T>{
   const lease=await current();
   if(lease.incarnation!==expected.incarnation||lease.generation!==expected.generation)throw Error('STALE_GENERATION');
   const result=await raw(op,args,Date.parse(lease.expiresAt),expected);await current();assertActive(expected);return result;
  }
  const status=await transfer<Status>('status');
  if(status.artifactProtocolVersion!==1){
   if(bytes.length>CHUNK_BYTES)throw Error('ARTIFACT_PROTOCOL_UPGRADE_REQUIRED');
   return transfer('artifact.write',{ref,data:b64(bytes)});
  }
  if(bytes.length>Math.min(status.maxArtifactBytes??0,8*1024*1024))throw Error('ARTIFACT_SIZE_LIMIT');
  const manifest={ref,size:bytes.length,sha256:await digest(bytes)};
  const upload=await transfer<{uploadId:string;committed:boolean;received:number}>('artifact.begin',manifest);
  if(upload.committed)return{committed:true,size:manifest.size,sha256:manifest.sha256};
  try{
   if(!Number.isSafeInteger(upload.received)||upload.received<0||upload.received>bytes.length)throw Error('ARTIFACT_TRANSFER_INVALID');
   for(let offset=upload.received;offset<bytes.length;offset+=CHUNK_BYTES){
    const chunk=bytes.subarray(offset,offset+CHUNK_BYTES);
    const result=await transfer<{received:number}>('artifact.chunk',{uploadId:upload.uploadId,offset,data:b64(chunk)});
    if(result.received!==offset+chunk.length)throw Error('ARTIFACT_TRANSFER_INVALID');
   }
   const result=await transfer<{committed:boolean;size:number;sha256:string}>('artifact.commit',{...manifest,uploadId:upload.uploadId});
   if(!result.committed||result.size!==manifest.size||result.sha256!==manifest.sha256)throw Error('ARTIFACT_INTEGRITY');
   return result;
  }catch(error){await transfer('artifact.abort',{uploadId:upload.uploadId}).catch(()=>{});throw error;}
 }
 return{provider,captureDriver,browser,attach,listArtifacts:()=>call<string[]>('artifact.list'),status:()=>call<Status>('status'),writeArtifact,
  // Renews the container lease without touching any business state. The
  // keepalive calls this after ensure(); status() is one of the ops the
  // container server excludes from renewal, so it cannot do this job.
  async refreshLease(){await call('lease.refresh');},
  async deleteDocumentArtifacts(prefix:string,throughRevision:number){return call('artifact.deleteDocuments',{prefix,throughRevision});},
 };
}
