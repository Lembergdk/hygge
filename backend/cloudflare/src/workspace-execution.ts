import {structuredWorkspaceHash,verifyImageFiles} from './workspace-image-verification.ts';
import {createWorkspaceImageUpgrade,type ImageUpgrade} from './workspace-image-upgrade.ts';
import {ownerKey} from './workspace-runtime.ts';
import type { Env } from './env.ts';
import type { WorkspaceIdentity, RuntimeLease } from './workspace-contract.ts';
import type { WorkspaceSqlStorage } from './workspace-runtime.ts';
import { createWorkspaceFoundation } from './workspace-foundation.ts';
import { createContainerWorkspace, type WorkspaceContainer } from './workspace-container.ts';
import { WorkspaceCaptureService, r2WorkspaceObjects, sha256 } from './workspace-capture.ts';
import { workspaceSecret } from './workspace-owner.ts';
import { createWorkspaceTaskRunner, type WorkspaceSaveInput } from './workspace-task-runner.ts';
import { createWorkspaceSkills } from './workspace-skills.ts';
import { assertWorkspaceActionConsent, reviewedCompletionRules, verifyObservedMission } from './workspace-postconditions.ts';
import { outcomeForTaskKind } from './skills.ts';
import { digest } from './workspace-persistence.ts';

export interface WorkspaceExecutionOptions {
  owner: WorkspaceIdentity;
  env: Env;
  storage: WorkspaceSqlStorage;
  container: WorkspaceContainer;
  loadTask(id:string):any;
  projectTask(task:any):void;
  denyFetcher?:Fetcher;
  assertOwnerIdle?:()=>void;
}
/** Installed once per verified owner DO. All tools stay behind this private broker. */
export function createWorkspaceExecution(options:WorkspaceExecutionOptions) {
  const {owner,env,storage}=options;
  if (!env.WORKSPACE_CHECKPOINTS || !env.HYGGE_WORKSPACE_IMAGE || !env.HYGGE_WORKSPACE_NAMESPACE || !options.container) throw new Error('WORKSPACE_DEPLOYMENT_BINDINGS_REQUIRED');
  const objects=r2WorkspaceObjects(env.WORKSPACE_CHECKPOINTS);
  const transitions:Array<{from:string;to:string;policy:string}>=env.HYGGE_WORKSPACE_IMAGE_TRANSITIONS?JSON.parse(env.HYGGE_WORKSPACE_IMAGE_TRANSITIONS):[];
  if(!Array.isArray(transitions)||transitions.some(p=>!p||p.policy!=='workspace-filesystem-v1'||p.from===p.to||![p.from,p.to].every(x=>typeof x==='string'&&/@sha256:[a-f0-9]{64}$/.test(x))))throw Error('INVALID_IMAGE_TRANSITION_POLICY');
  const allowedImages=[env.HYGGE_WORKSPACE_IMAGE,...transitions.flatMap(p=>[p.from,p.to])];
  let initialized:Promise<void>|undefined;
  const lineagePins=new Map<string,RuntimeLease>();
  function assertLineage(expected:RuntimeLease,current:RuntimeLease){
    if(['environment','userId','workspaceId','runtimeId','incarnation','generation','leaseId'].some(key=>(expected as any)[key]!==(current as any)[key]))throw new Error('STALE_MISSION_LINEAGE');
  }
  // Verified reattach to the SAME incarnation rotates only the leaseId.
  // Long missions outlive one 5-minute lease; that rotation is not a
  // replacement and must not orphan the run. Fencing/replacement still
  // changes incarnation or generation and fails here.
  function assertSameIncarnation(expected:RuntimeLease,current:RuntimeLease){
    if(['environment','userId','workspaceId','runtimeId','incarnation','generation'].some(key=>(expected as any)[key]!==(current as any)[key]))throw new Error('STALE_MISSION_LINEAGE');
  }
  let foundation:ReturnType<typeof createWorkspaceFoundation>;
  // The registry is authoritative even when the container/DO process restarts.
  async function ensure() {
    if(foundation.persistence.get('image_upgrade_lock','active'))throw Error('WORKSPACE_IMAGE_UPGRADE_PENDING');
    await (initialized ??= initialize().catch(error=>{initialized=undefined;throw error;}));
    if(foundation.persistence.get('image_upgrade_lock','active'))throw Error('WORKSPACE_IMAGE_UPGRADE_PENDING');
    const binding=await foundation.registry.ensure(owner,owner,'initial_start');
    if(foundation.persistence.get('image_upgrade_lock','active'))throw Error('WORKSPACE_IMAGE_UPGRADE_PENDING');
    if (binding.lifecycleState!=='ready') throw new Error('WORKSPACE_NOT_READY');
    const lease=await foundation.registry.readLease(owner,owner);
    await bridge.attach(binding);
    if(foundation.persistence.get('image_upgrade_lock','active'))throw Error('WORKSPACE_IMAGE_UPGRADE_PENDING');
    if(Date.parse(lease.expiresAt)<=Date.now())await foundation.registry.reattachVerified(owner,owner,binding.revision,b=>bridge.attach(b));
    else if (Date.parse(lease.expiresAt)-Date.now()<60_000) await foundation.registry.heartbeat(owner,lease);
  }
  const imagePolicy={allowedImages,allowIncompleteRestoreRetry:transitions.length>0,authorizeImageRestore:(binding:import('./workspace-contract.ts').WorkspaceBinding,sourceImage:string)=>foundation.registry.assertCompatibleRestore(owner,binding,sourceImage),
    fenceJournal:{get:(key:string)=>foundation.persistence.get('image_fence',key)?.value,put:(key:string,value:any)=>{const old=foundation.persistence.get('image_fence',key);foundation.persistence.put('image_fence',key,old?.revision??0,value);}}};
  const bridge=createContainerWorkspace({...imagePolicy,owner,container:options.container,image:env.HYGGE_WORKSPACE_IMAGE,denyFetcher:options.denyFetcher ?? env.SELF,
    rpcSecret:workspaceSecret(storage,'container-rpc'),objects,namespaceId:env.HYGGE_WORKSPACE_NAMESPACE,
    providerWorkspaceId:owner.workspaceId,getLease:async()=>{await ensure();const lease=await foundation.registry.readLease(owner,owner);for(const pin of lineagePins.values())assertSameIncarnation(pin,lease);return lease;}});
  const rules=reviewedCompletionRules(env.HYGGE_WORKSPACE_POSTCONDITIONS);
  foundation=createWorkspaceFoundation({owner,storage,objects,signingKey:workspaceSecret(storage,'capability'),provider:bridge.provider,captureDriver:bridge.captureDriver,
    captureLimits:{maxEntries:8192,maxBytes:16*1024*1024},leaseDurationMs:300_000,
    consent:{assertDispatchAllowed(effect){
      const grant=foundation.persistence.get<any>('dispatch_grant',effect.approvalId??'')?.value;
      const task=options.loadTask(effect.taskId);
      if(!grant || grant.effectId!==effect.effectId || grant.intentHash!==effect.intentHash || grant.scope!==effect.approvalScopeHash
        || !task || !['running','approved'].includes(task.status) || grant.draftHash!==JSON.stringify(task.drafted_payload)) throw new Error('CONSENT_SCOPE_CHANGED');
    }},
    verifyOutcome:async(effect,status,ref)=>{
      const proof=foundation.persistence.get<any>('runner_evidence',ref)?.value;
      return !!proof && proof.effectId===effect.effectId && proof.intentHash===effect.intentHash && proof.status===status;
    },
    verifyCompletion:async(run,input)=>{
      const verification=input.verification;
      const proof=foundation.persistence.get<any>('runner_evidence',verification.evidenceRef)?.value;
      return !!proof && proof.policyVersion===verification.policyVersion && proof.verified===true && proof.runId===run.runId && proof.taskId===run.taskId;
    },
  });
  async function initialize() {
    try { await foundation.registry.read(owner,owner); return; }
    catch(error) {if(!(error instanceof Error) || error.message!=='WORKSPACE_NOT_INITIALIZED')throw error;}
    // A legacy remote profile cannot silently become an empty "restored" disk.
    const profiles=[...storage.sql.exec('SELECT domain FROM session_profiles WHERE has_profile=1')];
    const active=[...storage.sql.exec('SELECT task FROM tasks')].map(r=>JSON.parse(String(r.task))).some(t=>t.session_id);
    if(profiles.length || active)throw new Error('LEGACY_BROWSER_ADOPTION_REQUIRED');
    await foundation.registry.initialize(owner,{...owner,provider:'cloudflare',namespaceId:env.HYGGE_WORKSPACE_NAMESPACE!,providerWorkspaceId:owner.workspaceId,
      ownerDigest:await sha256(new TextEncoder().encode(JSON.stringify(owner))),schemaVersion:1,incarnation:'',generation:0,runtimeId:null,providerRuntimeId:null,
      desiredImageDigest:env.HYGGE_WORKSPACE_IMAGE!,leaseExpiresAt:null,lifecycleState:'unprovisioned',revision:0,recoveryPoint:null,lastVerifiedAt:new Date().toISOString()});
  }
  async function save(input:WorkspaceSaveInput) {
    await ensure();
    const pinId=crypto.randomUUID(),lease=await foundation.registry.readLease(owner,owner);
    if(input.expectedLease)assertSameIncarnation(input.expectedLease,lease);
    lineagePins.set(pinId,lease);
    try{
    for(const item of input.evidence) await bridge.writeArtifact(item.ref,new TextEncoder().encode(JSON.stringify(item.payload)));
    const status=await bridge.status();
    const binding=await foundation.registry.read(owner,owner);
    const token=await foundation.broker.issue(['workspace.commit'],{},lease);
    return await foundation.save(token,{writeId:crypto.randomUUID(),expectedRegistryRevision:binding.revision,
      filesystemRevision:status.nextFilesystemRevision,browserProfileRevision:status.nextBrowserProfileRevision,artifactRefs:await bridge.listArtifacts()});
    }finally{lineagePins.delete(pinId);}
  }
  const skills=createWorkspaceSkills({owner,persistence:foundation.persistence,authority:foundation.authority,completions:foundation.checkpoints,
    sharedDatabase:env.DB,registryConfig:env.HYGGE_SKILL_REGISTRY ? JSON.parse(env.HYGGE_SKILL_REGISTRY) : undefined,secret:workspaceSecret(storage,'skill-publication'),
    maintainerAuthorize:async(token)=>isMaintainerToken(token,env.HYGGE_MAINTAINER_SECRET),
    loadPrivateContext:async(taskId)=>{
      const task=options.loadTask(taskId);if(!task)throw new Error('TASK_MISSING');
      const knownValues:string[]=[];
      function values(value:unknown){if(typeof value==='string' && value)knownValues.push(value);else if(value && typeof value==='object')Object.values(value).forEach(values);}
      values(task.drafted_payload);
      // Personal source facts, not public DOM labels or trace verbs ("click",
      // "navigate"), are the comparison set for the privacy gate.
      for(const row of storage.sql.exec('SELECT username FROM credentials'))values(row.username);
      for(const row of storage.sql.exec("SELECT payload FROM profile WHERE id='profile'")) {
        try {values(JSON.parse(String(row.payload)));}catch{throw new Error('PRIVATE_CONTEXT_UNAVAILABLE');}
      }
      return {knownValues,requiredArtifactRefs:[]};
    },
  });
  const runner=createWorkspaceTaskRunner({owner,storage,foundation,saveWorkspace:save,projectTask:(task)=>options.projectTask(task),
    assertWorkspaceReady:async task=>{
      await ensure();const status=await bridge.status();if(status.frozen || status.humanControlled)throw new Error('WORKSPACE_CAPTURE_OR_HUMAN_PENDING');
      if(foundation.persistence.list<any>('effect').some(e=>e.value.taskId!==task.id && ['prepared','dispatching','uncertain'].includes(e.value.status)))throw new Error('WORKSPACE_HAS_UNRESOLVED_ACTION');
      // Node also enforces global control/freeze for every agent mutation.
    },
    authorizeAction:async(task,input)=>{
      await ensure();assertWorkspaceActionConsent(options.loadTask(task.id),input,task);
      const approvalId=crypto.randomUUID(),scope=await digest({taskId:task.id,effectId:input.effectId,intentHash:input.intentHash});
      foundation.persistence.storage.transactionSync(()=>foundation.persistence.put('dispatch_grant',approvalId,0,{effectId:input.effectId,intentHash:input.intentHash,scope,draftHash:JSON.stringify(task.drafted_payload)}));
      return {approvalId,approvalScopeHash:scope,refreshesReviewedConsent:!!input.approvedActionProof};
    },
    verifyActionOutcome:async({ticket,observation})=>({
      status:!observation.error && observation.result?.succeeded===true && observation.snapshot ? 'confirmed' : 'uncertain',
      // A successful authenticated browser RPC acknowledges this local input;
      // final external success requires the separate postcondition below.
      evidence:{decision:ticket.input.decision,page:observation.snapshot??null},
    }),
    verifyMissionCompletion:async({task,runId,result})=>{
      const snapshot=result.sessionID ? await bridge.browser.snapshot(result.sessionID) : null;
      const policy=verifyObservedMission(task,result,snapshot,outcomeForTaskKind(task.kind),rules);
      if(!policy)return null;
      const ref=`ev_${runId.replaceAll('-','')}_completion`;
      const candidate=foundation.persistence.get<any>('run',runId)?.value.candidate;
      return {verification:{kind:'observed_postcondition',policyVersion:policy,evidenceRef:ref},evidence:{verified:true,taskId:task.id,runId,policyVersion:policy,snapshot,extractedItems:result.extractedItems??[]},candidateBodyHash:candidate?.kind==='confirming'?candidate.bodyHash:null};
    },
    verifyReviewedOutcome:async input=>{
      const proof=foundation.persistence.get<any>('runner_evidence',input.evidenceRef)?.value;
      return !!proof && proof.reviewedBy===owner.userId && proof.taskId===input.taskId && proof.effectId===input.effectId && proof.status===input.status && !!proof.currentSnapshot;
    },
  });
  // This private bridge can work under the maintenance lock; normal runtime RPCs
  // always pass ensure() and are denied until the verified cutover is complete.
  const migrationBridge=createContainerWorkspace({...imagePolicy,owner,container:options.container,image:env.HYGGE_WORKSPACE_IMAGE,
    denyFetcher:options.denyFetcher??env.SELF,rpcSecret:workspaceSecret(storage,'container-rpc'),objects,
    namespaceId:env.HYGGE_WORKSPACE_NAMESPACE,providerWorkspaceId:owner.workspaceId,
    getLease:async()=>{if(!foundation.persistence.get('image_upgrade_lock','active'))throw Error('IMAGE_UPGRADE_LOCK_REQUIRED');return foundation.registry.readLease(owner,owner);}});
  const migrationCapture=new WorkspaceCaptureService(foundation.registry,objects,migrationBridge.captureDriver,Date.now,{maxEntries:8192,maxBytes:16*1024*1024});
  const images=createWorkspaceImageUpgrade({db:foundation.persistence,
    allowed:(from,to)=>env.HYGGE_ENV==='staging'&&transitions.some(p=>p.from===from&&p.to===to),
    prepare:async()=>{await ensure();const status=await bridge.status();if(status.humanControlled||status.frozen)throw Error('WORKSPACE_CAPTURE_OR_HUMAN_PENDING');return foundation.registry.read(owner,owner);},
    structuredHash:()=>structuredWorkspaceHash(storage),verifyFiles:(source,target)=>verifyImageFiles(objects,owner,source,target),
    assertIdle(){options.assertOwnerIdle?.();if(lineagePins.size||foundation.persistence.get('runner_owner','active'))throw Error('WORKSPACE_ADMISSION_BUSY');
      if(foundation.persistence.list<any>('effect').some(e=>['prepared','dispatching','uncertain'].includes(e.value.status)))throw Error('WORKSPACE_HAS_UNRESOLVED_ACTION');},
    async capture(record,target){
      const writeId=`${record.operationId}_${target?'target':'source'}`;
      const prior=await foundation.registry.saved(owner,owner,writeId);if(prior)return foundation.verifyDurability(prior.receipt.receiptId);
      let binding=await foundation.registry.read(owner,owner);const expected=target?record.target!:record.source;
      if(binding.lifecycleState!=='ready'||binding.generation!==expected.generation||binding.incarnation!==expected.incarnation||binding.desiredImageDigest!==expected.desiredImageDigest)throw Error('UPGRADE_SOURCE_CHANGED');
      await migrationBridge.attach(binding);let lease=await foundation.registry.readLease(owner,owner);
      if(Date.parse(lease.expiresAt)<=Date.now())await foundation.registry.reattachVerified(owner,owner,binding.revision,b=>migrationBridge.attach(b));
      else if(Date.parse(lease.expiresAt)-Date.now()<60_000)await foundation.registry.heartbeat(owner,lease);
      lease=await foundation.registry.readLease(owner,owner);
      const status=await migrationBridge.status();if(status.frozen||status.humanControlled)throw Error('UPGRADE_CAPTURE_RECOVERY_REQUIRED');
      binding=await foundation.registry.read(owner,owner);
      let saved=foundation.persistence.get<import('./workspace-capture.ts').CaptureWrite>('image_capture_request',writeId);
      if(!saved){const request={writeId,expectedRegistryRevision:binding.revision,filesystemRevision:status.nextFilesystemRevision,browserProfileRevision:status.nextBrowserProfileRevision,artifactRefs:await migrationBridge.listArtifacts()};
        foundation.persistence.put('image_capture_request',writeId,0,request);saved=foundation.persistence.get('image_capture_request',writeId);}
      return migrationCapture.commit(owner,lease,saved!.value);
    },
    async verify(receipt){const verified=await foundation.verifyDurability(receipt.receiptId);if(await digest(verified)!==await digest(receipt))throw Error('UPGRADE_RECEIPT_MISMATCH');},
    async fence(record){
      const binding=await foundation.registry.read(owner,owner),receipt=record.sourceReceipt!;
      if(binding.generation!==record.source.generation||binding.incarnation!==record.source.incarnation||binding.desiredImageDigest!==record.source.desiredImageDigest||binding.recoveryPoint?.checkpointId!==receipt.recoveryPoint.checkpointId)throw Error('UPGRADE_SOURCE_CHANGED');
      if(binding.lifecycleState==='ready'){
        await migrationBridge.attach(binding);const lease=await foundation.registry.readLease(owner,owner);
        if(Date.parse(lease.expiresAt)<=Date.now())await foundation.registry.reattachVerified(owner,owner,binding.revision,b=>migrationBridge.attach(b));
        const status=await migrationBridge.status();
        // A committed, independently verified final capture may still hold its native freeze after a lost release request.
        if(status.humanControlled||status.filesystemRevision!==receipt.filesystemRevision||status.browserProfileRevision!==receipt.browserProfileRevision)throw Error('UPGRADE_SOURCE_CHANGED');
      }
      return foundation.registry.fence(owner,owner,record.source.generation,`${record.operationId}_fence`);
    },
    async select(record){await foundation.registry.selectImage(owner,owner,`${record.operationId}_select`,record.fencedRevision!,record.targetImage,async binding=>{
      const receipt=await foundation.verifyDurability(record.sourceReceipt!.receiptId);
      const bytes=await objects.get(`hygge-workspaces/v1/${ownerKey(owner)}/manifests/${receipt.recoveryPoint.manifestHash}`);
      if(!bytes||await sha256(bytes)!==receipt.recoveryPoint.manifestHash)throw Error('MANIFEST_VERIFICATION_FAILED');
      const manifest=JSON.parse(new TextDecoder().decode(bytes));
      if(!transitions.some(p=>p.from===manifest.imageDigest&&p.to===record.targetImage)||binding.desiredImageDigest!==manifest.imageDigest)throw Error('UNREVIEWED_IMAGE_TRANSITION');
      return {receipt,imageDigest:manifest.imageDigest};
    });},
    async restore(record){const binding=await foundation.registry.ensure(owner,owner,`${record.operationId}_start`);const status=await migrationBridge.attach(binding);if(binding.desiredImageDigest!==env.HYGGE_WORKSPACE_IMAGE&&status.artifactProtocolVersion!==1)throw Error('UPGRADE_PROTOCOL_MISMATCH');return binding;},
    current:()=>foundation.registry.read(owner,owner),
    async abortCheck(record){const binding=await foundation.registry.read(owner,owner);
      if(binding.lifecycleState!=='ready'||binding.generation!==record.source.generation||binding.incarnation!==record.source.incarnation||binding.desiredImageDigest!==record.source.desiredImageDigest)throw Error('UPGRADE_CANNOT_ABORT_AFTER_FENCE');
      await migrationBridge.attach(binding);if((await migrationBridge.status()).frozen)throw Error('UPGRADE_CAPTURE_RECOVERY_REQUIRED');
    },
  });
  async function saveDocument(path:string,revision:number,bytes:Uint8Array){
      await ensure();
      return runner.withWorkspaceMutation('document-save',async lease=>{
        if((await bridge.status()).artifactProtocolVersion!==1)throw Error('ARTIFACT_PROTOCOL_UPGRADE_REQUIRED');
        const pin=crypto.randomUUID();lineagePins.set(pin,lease);
        try{
          const ref=`file_${(await sha256(new TextEncoder().encode(path))).slice(0,32)}_${revision}`;
          await bridge.writeArtifact(ref,bytes);
          return await save({expectedLease:lease,task:{id:'document-save',kind:'discover',target_url:'https://invalid.example',status:'running'},runId:'document-save',reason:'pause',evidence:[],requiresBrowserFreeze:true});
        }finally{lineagePins.delete(pin);}
      });
    }
  return {browser:bridge.browser,foundation,skills,runner,ensure,
    imageUpgrade:{run:async(input:{operationId:string;expectedGeneration:number;targetImage:string})=>{if(env.HYGGE_ENV!=='staging'||!transitions.length)throw Error('IMAGE_UPGRADE_DISABLED');if(!transitions.some(p=>p.to===input.targetImage))throw Error('UNREVIEWED_IMAGE_TRANSITION');const account=await env.DB.prepare('SELECT contact_email FROM users WHERE id=?').bind(owner.userId).first<{contact_email:string}>();if(!/^workspace-upgrade-[a-z0-9-]+@example\.invalid$/.test(account?.contact_email??''))throw Error('SYNTHETIC_UPGRADE_ACCOUNT_REQUIRED');return images.run(input);},
      locked:()=>!!foundation.persistence.get('image_upgrade_lock','active'),
      abort:(id:string)=>{if(env.HYGGE_ENV!=='staging')throw Error('IMAGE_UPGRADE_DISABLED');return images.abort(id);},
      async status(){let current=null;try{current=await foundation.registry.read(owner,owner);}catch(error){if(!(error instanceof Error)||error.message!=='WORKSPACE_NOT_INITIALIZED')throw error;}return {current,operations:images.status(),fixtureMarker:foundation.persistence.get<{marker:string}>('image_fixture','active')?.value.marker??null};}},
    /** Synthetic-account route only; no arbitrary URL, script, file or owner input. */
    async imageUpgradeFixture(action:string,marker:string){
      if(env.HYGGE_ENV!=='staging'||!transitions.length||!/^[a-f0-9-]{36}$/.test(marker))throw Error('INVALID_UPGRADE_FIXTURE');
      const account=await env.DB.prepare('SELECT contact_email FROM users WHERE id=?').bind(owner.userId).first<{contact_email:string}>();
      if(!/^workspace-upgrade-[a-z0-9-]+@example\.invalid$/.test(account?.contact_email??''))throw Error('SYNTHETIC_UPGRADE_ACCOUNT_REQUIRED');
      const origin='https://hygge-wave4-jobs.lemberg-89a.workers.dev',path=`upgrade-validation/${marker}/source`,latestPath=`upgrade-validation/${marker}/latest`;
      const source=new TextEncoder().encode(`Source ${marker}`),latest=new TextEncoder().encode(`Latest ${marker}. `.repeat(11000));
      const sessionId=`upgrade-${marker}`,stored=foundation.persistence.get<{marker:string}>('image_fixture','active');
      if(stored&&stored.value.marker!==marker)throw Error('FIXTURE_MARKER_CONFLICT');
      if(action==='seed'){
        if(stored)throw Error('FIXTURE_ALREADY_SEEDED');
        await ensure();
        await bridge.browser.createSession(origin+'/listings',{origin,savedAt:new Date().toISOString(),cookies:[{name:'hygge_upgrade',value:marker,domain:new URL(origin).hostname,path:'/',secure:true,httpOnly:true,expires:Math.floor(Date.now()/1000)+86400}],localStorage:{hygge_upgrade:marker}},sessionId);
        await runner.withWorkspaceMutation('fixture-seed',async lease=>{
          const ref=`file_${(await sha256(new TextEncoder().encode(path))).slice(0,32)}_1`;await bridge.writeArtifact(ref,source);
          await save({expectedLease:lease,task:{id:'fixture-seed',kind:'discover',target_url:origin,status:'running'},runId:'fixture-seed',reason:'pause',evidence:[],requiresBrowserFreeze:true});
        });foundation.persistence.put('image_fixture','active',0,{marker});
      }else if(!stored&&action!=='retire')throw Error('FIXTURE_NOT_SEEDED');
      if(action==='write-latest')await saveDocument(latestPath,1,latest);
      if(action==='retire'){
        let existing;try{existing=await foundation.registry.read(owner,owner);}catch(error){if(error instanceof Error&&error.message==='WORKSPACE_NOT_INITIALIZED')return {retired:true,receiptId:null};throw error;}
        if(existing.lifecycleState==='stopped')return {retired:true,receiptId:null};
        if(existing.lifecycleState!=='ready')throw Error('FIXTURE_RECOVERY_PENDING');
        const receipt=await save({task:{id:'fixture-cleanup',kind:'discover',target_url:origin,status:'running'},runId:'fixture-cleanup',reason:'pause',evidence:[],requiresBrowserFreeze:true});
        await foundation.verifyDurability(receipt.receiptId);const binding=await foundation.registry.read(owner,owner);
        const stopped=await foundation.registry.fence(owner,owner,binding.generation,`fixture_${marker}_retire`);return {retired:stopped.lifecycleState==='stopped',receiptId:receipt.receiptId};
      }
      if(!['seed','write-latest','check'].includes(action))throw Error('INVALID_FIXTURE_ACTION');
      await ensure();const state=await bridge.browser.exportState(sessionId),binding=await foundation.registry.read(owner,owner);
      if(!binding.recoveryPoint)throw Error('FIXTURE_CHECKPOINT_REQUIRED');
      const manifestBytes=await objects.get(`hygge-workspaces/v1/${ownerKey(owner)}/manifests/${binding.recoveryPoint.manifestHash}`);
      if(!manifestBytes||await sha256(manifestBytes)!==binding.recoveryPoint.manifestHash)throw Error('FIXTURE_MANIFEST_INVALID');
      const manifest=JSON.parse(new TextDecoder().decode(manifestBytes));
      async function artifactMatches(logical:string,expected:Uint8Array){
        const ref=`file_${(await sha256(new TextEncoder().encode(logical))).slice(0,32)}_1`;
        const file=manifest.files.find((f:any)=>f.path.endsWith('/'+ref)||f.path===ref);
        if(!file)return false;const bytes=await objects.get(`hygge-workspaces/v1/${ownerKey(owner)}/blobs/${file.hash}`);
        return !!bytes&&bytes.length===expected.length&&await sha256(bytes)===await sha256(expected);
      }
      return {cookie:!!state?.cookies.some((c:any)=>c.name==='hygge_upgrade'&&c.value===marker),localStorage:state?.localStorage.hygge_upgrade===marker,
        source:await artifactMatches(path,source),latest:await artifactMatches(latestPath,latest),latestBytes:latest.length,generation:binding.generation,image:binding.desiredImageDigest,sessionId};
    },
    saveDocument,
    async eraseDocument(path:string,throughRevision:number){
      await ensure();
      return runner.withWorkspaceMutation('document-delete',async lease=>{
        const pin=crypto.randomUUID();lineagePins.set(pin,lease);
        try{
          const prefix=`file_${(await sha256(new TextEncoder().encode(path))).slice(0,32)}_`;
          await bridge.deleteDocumentArtifacts(prefix,throughRevision);
          return await save({expectedLease:lease,task:{id:'document-delete',kind:'discover',target_url:'https://invalid.example',status:'running'},runId:'document-delete',reason:'pause',evidence:[],requiresBrowserFreeze:true});
        }finally{lineagePins.delete(pin);}
      });
    },
    /** Maintainer-only shared-library kill switch; secret-gated, never agent-callable. */
    async quarantineSkill(token:string,input:{operationId:string;skillId:string;reason:'privacy'|'unsafe_guidance'|'integrity'}){return skills.quarantine(token,input);},
    /** Called only by the already verified owner route. The person's review
     * resolves one uncertain outcome; it never dispatches or retries an action. */
    async reconcile(taskId:string,effectId:string,status:'confirmed'|'not_applied') {
      if(!['confirmed','not_applied'].includes(status))throw new Error('INVALID_REVIEW');
      await ensure();
      const task=options.loadTask(taskId),effect=foundation.effects.require(effectId);
      // A lost response can leave the effect 'dispatching' when the
      // uncertain-note itself never landed; the ledger resolve transition
      // accepts dispatching or uncertain with the same reviewed evidence.
      if(!task || task.status!=='needsHuman' || effect.taskId!==taskId || !['uncertain','dispatching','prepared'].includes(effect.status) || !task.session_id)throw new Error('REVIEW_UNAVAILABLE');
      const snapshot=await bridge.browser.snapshot(task.session_id);
      if(!snapshot)throw new Error('CURRENT_PAGE_REQUIRED');
      const ref=`review_${crypto.randomUUID().replaceAll('-','')}`;
      const payload={taskId,effectId,intentHash:effect.intentHash,status,reviewedBy:owner.userId,currentSnapshot:snapshot};
      foundation.persistence.storage.transactionSync(()=>foundation.persistence.put('runner_evidence',ref,0,payload));
      await save({task,runId:effect.runId,reason:'pause',evidence:[{ref,payload}],requiresBrowserFreeze:true});
      return runner.reconcile({taskId,effectId,status,evidenceRef:ref});
    },
    /** Renew only while a user mission/live connection is active. Expiry never grants a replacement. */
    async run(task:any,mission:Parameters<typeof runner.run>[0]['mission'],resume=false) {
      runner.waiting(task.id);
      try{await ensure();}catch(error){runner.unavailable(task.id);throw error;}
      let renewalError:unknown;
      const timer=setInterval(()=>{void ensure().catch(error=>{renewalError=error;});},15_000);
      try {
        const site=new URL(task.target_url).origin,outcome=outcomeForTaskKind(task.kind);
        const selection=await skills.resolve(site,outcome).catch(()=>null);
        const candidate=selection ? null : await skills.candidateForTask(site,outcome).catch(()=>null);
        const result=await runner.run({task,resume,candidate:candidate ? {kind:'confirming',bodyHash:candidate.candidateBodyHash} : {kind:'ordinary'},
          mission:async(hooks,runId,scopedTask)=>{
            const missionPin=crypto.randomUUID();lineagePins.set(missionPin,await foundation.registry.readLease(owner,owner));
            try{
            scopedTask._workspace_skill=null;scopedTask._workspace_candidate=candidate?{body:candidate.body}:null;
            let pinned=selection;
            if(pinned){
              const token=await foundation.broker.issue(['skill.read'],{taskId:task.id});
              pinned=await skills.pinRunSkill({capabilityToken:token,requestId:`${runId}:skill-pin`,expectedRevision:0},{taskId:task.id,runId,skillId:pinned.skillId});
              scopedTask._workspace_skill=pinned?.skill??null;
            }
            return await mission({
              onActionBefore:async input=>{
                const ticket=await hooks.onActionBefore(input);
                if(pinned){
                  const token=await foundation.broker.issue(['skill.read','action.dispatch'],{taskId:task.id});
                  const admissionId=crypto.randomUUID();
                  const admitted=await skills.admit(token,{admissionId,skillId:pinned.skillId,version:pinned.version,epoch:pinned.epoch,taskId:task.id});
                  if(!admitted || !await skills.consume(token,{admissionId,effectId:ticket.effectId,taskId:task.id}))throw new Error('SHARED_SKILL_REVOKED');
                }
                return ticket;
              },onActionAfter:hooks.onActionAfter,onSession:hooks.onSession,
            },runId,scopedTask);
            }finally{lineagePins.delete(missionPin);}
          },
        });
        if(renewalError && result.status==='succeeded')throw renewalError;
        // Publication/usage is downstream of canonical success. Failures hold
        // learning and cannot change a committed user-task result.
        if(result.status==='succeeded')try{
          const run=foundation.persistence.get<any>('run',String(result.workspace_run_id))?.value;
          if(run?.completionReceiptId){
            const token=await foundation.broker.issue(['skill.candidate.submit'],{taskId:task.id});
            const context={capabilityToken:token,requestId:`${run.runId}:candidate`,expectedRevision:0};
            if(candidate){
              const stored=foundation.persistence.get<{receiptIds:string[]}>('private_skill_candidate',candidate.candidateId);
              if(stored && !stored.value.receiptIds.includes(run.completionReceiptId)) await skills.recordOutcome({...context,expectedRevision:stored.revision},{candidateId:candidate.candidateId,receiptId:run.completionReceiptId});
              await skills.publishCandidate(token,candidate.candidateId);
            }else if(!selection){
              await skills.captureTraceCandidate(context,{candidateId:`candidate_${run.runId.replaceAll('-','')}`,receiptId:run.completionReceiptId,trace:result.browser_trace??[]});
            }else await skills.usage(token,{skillId:selection.skillId,receiptId:run.completionReceiptId});
          }
        }catch{/* Candidate remains private until all evidence/policy checks pass. */}
        return result;
      }
      finally {clearInterval(timer);}
    },
    async save(){return save({task:{id:'manual-save',kind:'discover',target_url:'https://invalid.example',status:'running'},runId:'manual-save',reason:'pause',evidence:[],requiresBrowserFreeze:true});},
  };
}
/** Constant-time maintainer check; unset/short secrets authorize nothing. */
export async function isMaintainerToken(token:string,secret:string|undefined):Promise<boolean>{
  if(!secret||secret.length<32||!token)return false;
  const enc=new TextEncoder();
  const [a,b]=await Promise.all([crypto.subtle.digest('SHA-256',enc.encode(token)),crypto.subtle.digest('SHA-256',enc.encode(secret))]);
  const x=new Uint8Array(a),y=new Uint8Array(b);let diff=0;for(let i=0;i<x.length;i++)diff|=x[i]^y[i];return diff===0;
}
export type WorkspaceExecution=ReturnType<typeof createWorkspaceExecution>;
