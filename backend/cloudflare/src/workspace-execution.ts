import {imagePolicy,lockedUpgrade,restoreAuthorized,fenceIntent} from './workspace-image-policy.ts';
import {createWorkspaceImageUpgrade} from './workspace-image-upgrade.ts';
import type { Env } from './env.ts';
import type { WorkspaceIdentity, RuntimeLease } from './workspace-contract.ts';
import type { WorkspaceSqlStorage } from './workspace-runtime.ts';
import { createWorkspaceFoundation } from './workspace-foundation.ts';
import { createContainerWorkspace, type WorkspaceContainer } from './workspace-container.ts';
import { r2WorkspaceObjects, sha256 } from './workspace-capture.ts';
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
  assertLifecycleIdle?:()=>void;
}
/** Installed once per verified owner DO. All tools stay behind this private broker. */
export function createWorkspaceExecution(options:WorkspaceExecutionOptions) {
  const {owner,env,storage}=options;
  if (!env.WORKSPACE_CHECKPOINTS || !env.HYGGE_WORKSPACE_IMAGE || !env.HYGGE_WORKSPACE_NAMESPACE || !options.container) throw new Error('WORKSPACE_DEPLOYMENT_BINDINGS_REQUIRED');
  const objects=r2WorkspaceObjects(env.WORKSPACE_CHECKPOINTS);
  const policy=imagePolicy(env.HYGGE_WORKSPACE_UPGRADE_POLICY,env.HYGGE_WORKSPACE_IMAGE);
  const allowedImages=policy?[policy.sourceImage,policy.targetImage]:[];
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
    if(lockedUpgrade(foundation.persistence))throw Error('IMAGE_UPGRADE_IN_PROGRESS');
    await (initialized ??= initialize().catch(error=>{initialized=undefined;throw error;}));
    const binding=await foundation.registry.ensure(owner,owner,'initial_start');
    if (binding.lifecycleState!=='ready') throw new Error('WORKSPACE_NOT_READY');
    const lease=await foundation.registry.readLease(owner,owner);
    await bridge.attach(binding);
    if(Date.parse(lease.expiresAt)<=Date.now())await foundation.registry.reattachVerified(owner,owner,binding.revision,b=>bridge.attach(b));
    else if (Date.parse(lease.expiresAt)-Date.now()<60_000) await foundation.registry.heartbeat(owner,lease);
  }
  const bridge=createContainerWorkspace({owner,container:options.container,image:env.HYGGE_WORKSPACE_IMAGE,denyFetcher:options.denyFetcher ?? env.SELF,
    allowedImages,fenceIntent:{read:id=>fenceIntent(foundation.persistence).read(id),record:(id,b)=>fenceIntent(foundation.persistence).record(id,b)},
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
  let upgradeFoundation:ReturnType<typeof createWorkspaceFoundation>;
  const upgradeBridge=createContainerWorkspace({owner,container:options.container,image:env.HYGGE_WORKSPACE_IMAGE,allowedImages,
    denyFetcher:options.denyFetcher??env.SELF,rpcSecret:workspaceSecret(storage,'container-rpc'),objects,
    namespaceId:env.HYGGE_WORKSPACE_NAMESPACE,providerWorkspaceId:owner.workspaceId,
    authorizeRestore:(point,image,binding)=>restoreAuthorized(foundation.persistence,point,image,binding),
    fenceIntent:fenceIntent(foundation.persistence),
    getLease:()=>upgradeFoundation.registry.readLease(owner,owner),
  });
  upgradeFoundation=createWorkspaceFoundation({owner,storage,objects,signingKey:workspaceSecret(storage,'capability'),
    provider:upgradeBridge.provider,captureDriver:upgradeBridge.captureDriver,captureLimits:{maxEntries:8192,maxBytes:16*1024*1024},leaseDurationMs:300_000,
    consent:{assertDispatchAllowed(){throw Error('LIFECYCLE_ACTION_FORBIDDEN');}},verifyOutcome:async()=>false,verifyCompletion:async()=>false,
  });
  const upgrade=createWorkspaceImageUpgrade({foundation:upgradeFoundation,bridge:upgradeBridge,policy,
    assertIdle(){
      if(!options.assertLifecycleIdle)throw Error('LIFECYCLE_IDLE_PROOF_REQUIRED');
      options.assertLifecycleIdle();
      if(foundation.persistence.get('runner_owner','active')||lineagePins.size)throw Error('WORKSPACE_ADMISSION_BUSY');
    },
    async capture(writeId){
      const old=await upgradeFoundation.registry.saved(owner,owner,writeId);if(old)return upgradeFoundation.verifyDurability(old.receipt.receiptId);
      let binding=await upgradeFoundation.registry.read(owner,owner);await upgradeBridge.attach(binding);
      let lease=await upgradeFoundation.registry.readLease(owner,owner);
      if(Date.parse(lease.expiresAt)<=Date.now())await upgradeFoundation.registry.reattachVerified(owner,owner,binding.revision,b=>upgradeBridge.attach(b));
      else if(Date.parse(lease.expiresAt)-Date.now()<120_000)await upgradeFoundation.registry.heartbeat(owner,lease);
      lease=await upgradeFoundation.registry.readLease(owner,owner);
      const status=await upgradeBridge.status();binding=await upgradeFoundation.registry.read(owner,owner);
      return upgradeFoundation.save(await upgradeFoundation.broker.issue(['workspace.commit'],{},lease),{
        writeId,expectedRegistryRevision:binding.revision,filesystemRevision:status.nextFilesystemRevision,browserProfileRevision:status.nextBrowserProfileRevision,artifactRefs:await upgradeBridge.listArtifacts(),
      });
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
  return {browser:bridge.browser,foundation,skills,runner,ensure,upgrade,
    async saveDocument(path:string,revision:number,bytes:Uint8Array){
      await ensure();
      return runner.withWorkspaceMutation('document-save',async lease=>{
        const pin=crypto.randomUUID();lineagePins.set(pin,lease);
        try{
          if((await bridge.status()).artifactProtocolVersion!==1)throw Error('ARTIFACT_PROTOCOL_UPGRADE_REQUIRED');
          const ref=`file_${(await sha256(new TextEncoder().encode(path))).slice(0,32)}_${revision}`;
          await bridge.writeArtifact(ref,bytes);
          return await save({expectedLease:lease,task:{id:'document-save',kind:'discover',target_url:'https://invalid.example',status:'running'},runId:'document-save',reason:'pause',evidence:[],requiresBrowserFreeze:true});
        }finally{lineagePins.delete(pin);}
      });
    },
    async eraseDocument(path:string,throughRevision:number){
      await ensure();
      return runner.withWorkspaceMutation('document-delete',async lease=>{
        const pin=crypto.randomUUID();lineagePins.set(pin,lease);
        try{
          if((await bridge.status()).artifactProtocolVersion!==1)throw Error('ARTIFACT_PROTOCOL_UPGRADE_REQUIRED');
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
