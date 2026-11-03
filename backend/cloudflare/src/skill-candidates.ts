import type { MutationContext, WorkspaceIdentity } from './workspace-contract.ts';
import type { CompletionReader } from './runtime-checkpoints.ts';
import { WorkspacePersistence, sameOwner, fail, type RuntimeAuthority } from './workspace-persistence.ts';
import type { OwnerEvidenceSource, PrivateCandidate, SharedSkillBodyV2, SkillRegistry } from './skill-contract.ts';
import { opaqueId, skillDigest, validateSkillBody } from './skill-policy.ts';

export interface PrivateSkillContext { knownValues: readonly string[]; requiredArtifactRefs: readonly string[] }
interface StoredCandidate extends PrivateCandidate { taskId: string; runIds: readonly string[] }
export class SqliteSkillCandidates implements OwnerEvidenceSource {
  readonly db: WorkspacePersistence; readonly authority: RuntimeAuthority; readonly completions: CompletionReader;
  readonly registry: SkillRegistry; readonly loadContext: (taskId:string)=>Promise<PrivateSkillContext>;
  constructor(db:WorkspacePersistence, authority:RuntimeAuthority, completions:CompletionReader, registry:SkillRegistry,
    loadContext:(taskId:string)=>Promise<PrivateSkillContext>) { this.db=db;this.authority=authority;this.completions=completions;this.registry=registry;this.loadContext=loadContext; }
  async authorizeOwner(owner:WorkspaceIdentity, token:string):Promise<boolean> {
    try { const lease=await this.authority.authorize(token,'skill.candidate.submit'); if(!sameOwner(owner,this.db.owner)||!sameOwner(owner,lease)) return false; this.authority.assertCurrent(lease);return true; }
    catch { return false; }
  }
  async loadCandidate(owner:WorkspaceIdentity,id:string):Promise<PrivateCandidate|null> {
    if(!sameOwner(owner,this.db.owner)) fail('OWNER_MISMATCH');
    const c=this.db.get<StoredCandidate>('private_skill_candidate',id)?.value;
    return c ? structuredClone(c) : null;
  }
  getCanonicalRunReceipt(owner:WorkspaceIdentity,id:string) { return this.completions.getCanonicalRunReceipt(owner,id); }
  verifyDurabilityCoverage(owner:WorkspaceIdentity,receipt:Parameters<CompletionReader['verifyDurabilityCoverage']>[1],refs:readonly string[]) { return this.completions.verifyDurabilityCoverage(owner,receipt,refs); }
  async recordCandidate(context:MutationContext,input:{candidateId:string;taskId:string;body:unknown}):Promise<{candidateId:string;candidateBodyHash:string;revision:number}> {
    opaqueId(input.candidateId);opaqueId(input.taskId);
    const body=validateSkillBody(input.body,this.registry);
    const digest=await skillDigest(body);
    const replay=await this.db.authorizedReplay<{candidateId:string;candidateBodyHash:string;revision:number}>(this.authority,'skill.candidate.submit',input.taskId,context,{kind:'candidate',candidateId:input.candidateId,taskId:input.taskId,body});
    if(replay.found)return replay.result;
    const privateContext=await this.loadContext(input.taskId);
    if(!privateContext || !Array.isArray(privateContext.knownValues)||!privateContext.knownValues.every(v=>typeof v==='string')
      || !Array.isArray(privateContext.requiredArtifactRefs)||!privateContext.requiredArtifactRefs.every(v=>typeof v==='string'&&v)) fail('PRIVATE_CONTEXT_UNAVAILABLE');
    validateSkillBody(body,this.registry,privateContext.knownValues);
    return this.db.authorized(this.authority,'skill.candidate.submit',input.taskId,context,{kind:'candidate',candidateId:input.candidateId,taskId:input.taskId,body},()=>{
      if(context.expectedRevision!==0||this.db.get('private_skill_candidate',input.candidateId))fail('CANDIDATE_IMMUTABLE');
      const candidate:StoredCandidate={candidateId:input.candidateId,taskId:input.taskId,body,candidateBodyHash:digest,receiptIds:[],runIds:[],requiredArtifactRefs:[...privateContext.requiredArtifactRefs],privateKnownValues:[...privateContext.knownValues]};
      this.db.put('private_skill_candidate',input.candidateId,0,candidate);
      return {candidateId:input.candidateId,candidateBodyHash:digest,revision:1};
    });
  }
  async recordOutcome(context:MutationContext,input:{candidateId:string;receiptId:string}):Promise<{revision:number;distinctRuns:number}> {
    opaqueId(input.candidateId);opaqueId(input.receiptId);
    const receipt=await this.getCanonicalRunReceipt(this.db.owner,input.receiptId)??fail('RECEIPT_MISSING');
    const payload={kind:'outcome',...input};
    const replay=await this.db.authorizedReplay<{revision:number;distinctRuns:number}>(this.authority,'skill.candidate.submit',receipt.taskId,context,payload);
    if(replay.found)return replay.result;
    const current=this.db.get<StoredCandidate>('private_skill_candidate',input.candidateId)??fail('CANDIDATE_MISSING');
    const c=current.value;const body=validateSkillBody(c.body,this.registry);const site=this.registry.getSite(body.siteId)!;
    if(await skillDigest(body)!==c.candidateBodyHash)fail('CANDIDATE_HASH');
    if(receipt.status!=='succeeded'||receipt.candidateBodyHash!==c.candidateBodyHash||receipt.outcome!==body.outcome||receipt.siteOrigin!==site.origin)fail('EVIDENCE_INVALID');
    if(!await this.verifyDurabilityCoverage(this.db.owner,receipt,c.requiredArtifactRefs))fail('EVIDENCE_NOT_DURABLE');
    const privateContext=await this.loadContext(receipt.taskId);
    if(!privateContext||!Array.isArray(privateContext.knownValues)||!privateContext.knownValues.every(v=>typeof v==='string'))fail('PRIVATE_CONTEXT_UNAVAILABLE');
    validateSkillBody(body,this.registry,[...c.privateKnownValues,...privateContext.knownValues]);
    return this.db.authorized(this.authority,'skill.candidate.submit',receipt.taskId,context,payload,()=>{
      const saved=this.db.get<StoredCandidate>('private_skill_candidate',input.candidateId)??fail('CANDIDATE_MISSING');
      if(saved.revision!==context.expectedRevision)fail('REVISION_CONFLICT');
      const duplicate=saved.value.runIds.includes(receipt.runId);
      const updated={...saved.value,receiptIds:duplicate?saved.value.receiptIds:[...saved.value.receiptIds,receipt.receiptId],runIds:duplicate?saved.value.runIds:[...saved.value.runIds,receipt.runId],
        privateKnownValues:[...new Set([...saved.value.privateKnownValues,...privateContext.knownValues])]};
      const next=this.db.put('private_skill_candidate',input.candidateId,saved.revision,updated);
      return {revision:next,distinctRuns:updated.runIds.length};
    });
  }
}
