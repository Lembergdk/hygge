import type { MutationContext, WorkspaceIdentity } from './workspace-contract.ts';
import type { CompletionReader } from './runtime-checkpoints.ts';
import type { EffectRecord } from './workspace-contract.ts';
import type { SharedSkill } from './skills.ts';
import type { PublicationClaim, PublishedSkill, SkillAdmission } from './skill-contract.ts';
import { createSkillAttestationBroker, createSkillServiceBroker } from './skill-brokers.ts';
import { D1SkillPublicationRepository, PrivateSkillValidator, SharedSkillPublisher, type SkillSqlDatabase } from './skill-publication.ts';
import { canonicalJson, opaqueId, skillDigest, validateSkillBody } from './skill-policy.ts';
import { WorkspacePersistence, sameOwner, fail, type RuntimeAuthority } from './workspace-persistence.ts';
import { loadReviewedSkillRegistry, type WorkspaceSkillRegistry } from './skill-registry.ts';
import { SqliteSkillCandidates, type PrivateSkillContext } from './skill-candidates.ts';
import { candidateFromReviewedTrace, type PrivateBrowserTraceEntry } from './skill-trace.ts';

export interface WorkspaceSkillsOptions {
  owner:WorkspaceIdentity; persistence:WorkspacePersistence; authority:RuntimeAuthority; completions:CompletionReader;
  sharedDatabase:D1Database|SkillSqlDatabase; registryConfig?:unknown; secret:Uint8Array;
  loadPrivateContext:(taskId:string)=>Promise<PrivateSkillContext>;
  maintainerAuthorize?:(token:string,operationId:string,skillId:string,reason:string)=>Promise<boolean>;
  now?:()=>number;
}
export interface MissionSkillSelection { skill:SharedSkill; skillId:string;version:number;epoch:number;contentHash:string }
/** Render reviewed typed operations as advice only; no returned text is evaluated or executed. */
export function toAdvisorySkill(published:PublishedSkill,registry:WorkspaceSkillRegistry):SharedSkill {
  const body=validateSkillBody(published.body,registry);const site=registry.getSite(body.siteId)!;
  const steps=body.steps.map(s=>{
    switch(s.op){
      case 'navigate':return `Inspect the public ${new URL(site.routes[s.routeId],site.origin).href} entry point.`;
      case 'inspect':return `Inspect the reviewed ${s.controlId} control on the live page.`;
      case 'click':return `Consider the reviewed ${s.controlId} control; apply current task consent before acting.`;
      case 'fill':return `Fill the reviewed ${s.controlId} field through the private ${s.valueRef} reference.`;
      case 'upload':return `Use the approved local resume with the reviewed ${s.controlId} upload control.`;
      case 'extract':return `Inspect the reviewed ${s.fieldSetId} fields on the live page.`;
      case 'checkpoint':return `At a ${s.kind} checkpoint, stop for the existing human verification flow.`;
      case 'complete':return `Verify the ${s.outcome} outcome from current evidence before completion.`;
    }
  });
  return {id:published.id,site:new URL(site.origin).hostname,outcome:body.outcome,version:published.version,
    body:{summary:`Generic ${body.outcome} guidance for ${new URL(site.origin).hostname}.`,steps,
      pitfalls:body.pitfalls.map(p=>`Reviewed caution ${p.code}${p.controlId?` for ${p.controlId}`:''}; inspect the current page.`),
      notes:'Advisory only. User values remain private. Consent and human verification policy are enforced independently.'},
    confidence:published.confidence,sourceRunCount:published.sourceRunCount,lastVerifiedAt:null,status:'active'};
}
/** Construct only inside trusted owner DO; no raw signing, D1 or evidence adapters escape this closure. */
export function createWorkspaceSkills(options:WorkspaceSkillsOptions){
  const {owner,persistence:db,authority,completions,secret}=options;const now=options.now??Date.now;
  if(!sameOwner(owner,db.owner))fail('OWNER_MISMATCH');
  const registry=loadReviewedSkillRegistry(options.registryConfig);
  const candidates=new SqliteSkillCandidates(db,authority,completions,registry,options.loadPrivateContext);
  const repository=new D1SkillPublicationRepository(options.sharedDatabase);
  const verifyOnly=createSkillAttestationBroker(secret,owner.environment,now).verifier;
  // Authorization approvals exist only around a verified operation below, never from an HTTP body.
  const approvals=new Set<string>();
  const serviceBroker=createSkillServiceBroker(secret,owner.environment,async(op,binding)=>approvals.has(canonicalJson({op,binding})),now);
  const publisher=new SharedSkillPublisher(repository,registry,owner.environment,serviceBroker.authorization,verifyOnly,now);
  async function current(token:string,taskId?:string,op:'skill.read'|'skill.candidate.submit'|'action.dispatch'='skill.candidate.submit'){
    const lease=await authority.authorize(token,op,taskId);if(!sameOwner(owner,lease))fail('OWNER_MISMATCH');authority.assertCurrent(lease);return lease;
  }
  async function grant(op:Parameters<typeof serviceBroker.issue>[0],binding:Record<string,unknown>,token:string,taskId?:string,scope:'skill.read'|'skill.candidate.submit'|'action.dispatch'='skill.candidate.submit'){
    await current(token,taskId,scope);const id=canonicalJson({op,binding});approvals.add(id);
    try{return await serviceBroker.issue(op,binding);}finally{approvals.delete(id);}
  }
  async function privateBinding(value:unknown,purpose:string){
    const key=await crypto.subtle.importKey('raw',Uint8Array.from(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
    const bytes=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(canonicalJson({purpose,value})));
    return [...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,'0')).join('');
  }
  return {
    recordCandidate:(context:MutationContext,input:{candidateId:string;taskId:string;body:unknown})=>candidates.recordCandidate(context,input),
    recordOutcome:(context:MutationContext,input:{candidateId:string;receiptId:string})=>candidates.recordOutcome(context,input),
    async captureTraceCandidate(context:MutationContext,input:{candidateId:string;receiptId:string;trace:readonly PrivateBrowserTraceEntry[]}){
      const receipt=await completions.getCanonicalRunReceipt(owner,input.receiptId);
      if(!receipt||receipt.candidateBodyHash!==null||!await completions.verifyDurabilityCoverage(owner,receipt,[]))return {status:'held' as const,reasonCodes:['ORDINARY_COMPLETION_REQUIRED']};
      const body=candidateFromReviewedTrace(receipt.siteOrigin,receipt.outcome,input.trace,registry);
      if(!body)return {status:'held' as const,reasonCodes:['UNREVIEWED_TRAJECTORY']};
      const result=await candidates.recordCandidate(context,{candidateId:input.candidateId,taskId:receipt.taskId,body});
      // This ordinary run cannot corroborate a candidate hash not declared when it began.
      return {status:'candidate' as const,...result};
    },
    async candidateForTask(siteOrigin:string,outcome:string){
      const siteId=registry.siteIdForOrigin(siteOrigin);if(!siteId)return null;
      for(const saved of db.list<{candidateId:string;body:unknown;candidateBodyHash:string}>('private_skill_candidate')){
        try{
          const body=validateSkillBody(saved.value.body,registry);
          if(body.siteId!==siteId||body.outcome!==outcome||await skillDigest(body)!==saved.value.candidateBodyHash)continue;
          if(!await publisher.isBodyReusable(body))continue;
          const publication=db.get<{skillId:string}>('private_skill_publication_state',saved.value.candidateId)?.value;
          if(publication&&!await publisher.readValidated(publication.skillId))continue;
          const advisory=toAdvisorySkill({id:saved.value.candidateId,version:0,body,contentHash:saved.value.candidateBodyHash,policyVersion:'private-candidate',status:'active',epoch:1,confidence:0,sourceRunCount:0},registry).body;
          return {candidateId:saved.value.candidateId,candidateBodyHash:saved.value.candidateBodyHash,revision:saved.revision,body:advisory};
        }catch{}
      }
      return null;
    },
    async publishCandidate(capabilityToken:string,candidateId:string){
      await current(capabilityToken);const original=await candidates.loadCandidate(owner,candidateId);
      if(!original)return {status:'held' as const,reasonCodes:['CANDIDATE_MISSING']};
      // Only PrivateSkillValidator can call this private issuer after canonical receipt/coverage checks.
      const broker=createSkillAttestationBroker(secret,owner.environment,now,async(claim:Readonly<PublicationClaim>)=>{
        await current(capabilityToken);
        const latest=await candidates.loadCandidate(owner,candidateId);
        return !!latest&&latest.candidateBodyHash===claim.capsuleHash&&latest.candidateBodyHash===original.candidateBodyHash;
      });
      const validator=new PrivateSkillValidator(candidates,registry,broker.issuer,now);
      const prepared=await validator.prepare(owner,capabilityToken,candidateId);
      if(prepared.status!=='ready')return prepared;
      const token=await grant('publish',{},capabilityToken);
      const result=await publisher.publish(token,prepared.request);
      if(result.status==='published'||result.status==='existing'){
        // Trusted private bookkeeping only; shared status is always re-read before fallback reuse.
        const lease=await current(capabilityToken);
        db.storage.transactionSync(()=>{authority.assertCurrent(lease);const prior=db.get('private_skill_publication_state',candidateId);db.put('private_skill_publication_state',candidateId,prior?.revision??0,{skillId:result.skillId});});
      }
      return result;
    },
    async resolve(siteOrigin:string,outcome:string):Promise<MissionSkillSelection|null>{
      const siteId=registry.siteIdForOrigin(siteOrigin);if(!siteId)return null;
      const found=await publisher.resolve(siteId,outcome);if(!found)return null;
      return {skill:toAdvisorySkill(found,registry),skillId:found.id,version:found.version,epoch:found.epoch,contentHash:found.contentHash};
    },
    async pinRunSkill(context:MutationContext,input:{taskId:string;runId:string;skillId:string}):Promise<MissionSkillSelection>{
      const skill=await publisher.readValidated(input.skillId)??fail('SKILL_UNAVAILABLE');
      return db.authorized(authority,'skill.read',input.taskId,context,input,()=>{
        const run=db.get<{taskId:string;completed:boolean;siteOrigin:string;outcome:string}>('run',input.runId)?.value;
        const site=registry.getSite(skill.body.siteId)!;
        if(!run||run.completed||run.taskId!==input.taskId||run.siteOrigin!==site.origin||run.outcome!==skill.body.outcome)fail('RUN_UNAVAILABLE');
        if(context.expectedRevision!==0||db.get('private_skill_selection',input.runId))fail('SELECTION_IMMUTABLE');
        db.put('private_skill_selection',input.runId,0,{skillId:skill.id,version:skill.version,contentHash:skill.contentHash});
        return {skill:toAdvisorySkill(skill,registry),skillId:skill.id,version:skill.version,epoch:skill.epoch,contentHash:skill.contentHash};
      });
    },
    async admit(capabilityToken:string,input:{admissionId:string;skillId:string;version:number;epoch:number;taskId:string}):Promise<SkillAdmission|null>{
      opaqueId(input.taskId);const {taskId,...binding}=input;
      const token=await grant('admit',binding,capabilityToken,taskId,'skill.read');
      return publisher.admit(token,binding.admissionId,binding.skillId,binding.version,binding.epoch);
    },
    async consume(capabilityToken:string,input:{admissionId:string;effectId:string;taskId:string}):Promise<boolean>{
      const lease=await current(capabilityToken,input.taskId,'action.dispatch');
      const effect=db.get<EffectRecord>('effect',input.effectId)?.value;
      if(!effect||effect.taskId!==input.taskId||effect.status!=='dispatching'||!sameOwner(owner,effect)||effect.generation!==lease.generation||effect.incarnation!==lease.incarnation)return false;
      // HMAC, not an enumerable hash of a private intent. Raw owner/effect/intent never enter shared storage.
      const effectBinding=await privateBinding({owner,effectId:effect.effectId,intentHash:effect.intentHash,generation:lease.generation,incarnation:lease.incarnation},'hygge-private-effect-binding-v1');
      const token=await grant('consume',{admissionId:input.admissionId,effectBinding},capabilityToken,input.taskId,'action.dispatch');
      return publisher.consume(token,input.admissionId,effectBinding);
    },
    async usage(capabilityToken:string,input:{skillId:string;receiptId:string}){
      const r=await completions.getCanonicalRunReceipt(owner,input.receiptId);
      if(!r||!await completions.verifyDurabilityCoverage(owner,r,[]))return false;
      const skill=await publisher.readValidated(input.skillId);if(!skill)return false;
      const pin=db.get<{skillId:string;version:number;contentHash:string}>('private_skill_selection',r.runId)?.value;
      if(!pin||pin.skillId!==skill.id||pin.version!==skill.version||pin.contentHash!==skill.contentHash)return false;
      const site=registry.getSite(skill.body.siteId)!;
      if(r.siteOrigin!==site.origin||r.outcome!==skill.body.outcome)return false;
      // Successful terminal receipts only. Failure implication requires a separate trusted evidence adapter.
      const usageId=await privateBinding({owner,receiptId:r.receiptId,skillId:skill.id},'hygge-private-usage-key-v1');
      const binding={usageId,skillId:skill.id,succeeded:true,implicated:false};
      const token=await grant('usage',binding,capabilityToken,r.taskId);
      return publisher.usage(token,usageId,skill.id,true,false);
    },
    async quarantine(maintainerToken:string,input:{operationId:string;skillId:string;reason:'privacy'|'unsafe_guidance'|'integrity'}){
      if(!options.maintainerAuthorize||!await options.maintainerAuthorize(maintainerToken,input.operationId,input.skillId,input.reason))return false;
      const binding={...input};const id=canonicalJson({op:'quarantine',binding});approvals.add(id);
      try {const token=await serviceBroker.issue('quarantine',binding);return publisher.quarantine(token,input.operationId,input.skillId,input.reason);}finally{approvals.delete(id);}
    },
  };
}
export type WorkspaceSkills=ReturnType<typeof createWorkspaceSkills>;
