import type { WorkspaceIdentity } from './workspace-contract.ts';
import { SKILL_POLICY_VERSION, type AttestationIssuer, type AttestationVerifier, type OwnerEvidenceSource,
  type PublicationRequest, type PublicationResult, type PublishedSkill, type ServiceAuthorization,
  type SkillAdmission, type SkillRegistry } from './skill-contract.ts';
import { canonicalJson, opaqueId, skillDigest, SkillPolicyError, validateSkillBody } from './skill-policy.ts';

function sameOwner(a: WorkspaceIdentity, b: WorkspaceIdentity) {
  return a.environment === b.environment && a.userId === b.userId && a.workspaceId === b.workspaceId;
}
export type CandidatePreparation = { status: 'ready'; request: PublicationRequest }
  | { status: 'held'; reasonCodes: readonly string[] };
/** Trusted owner DO component. All evidence is read from canonical stores, never a caller count. */
export class PrivateSkillValidator {
  private evidence: OwnerEvidenceSource; private registry: SkillRegistry;
  private issuer?: AttestationIssuer; private now: () => number;
  constructor(evidence: OwnerEvidenceSource, registry: SkillRegistry, issuer?: AttestationIssuer, now = () => Date.now()) {
    this.evidence = evidence; this.registry = registry; this.issuer = issuer; this.now = now;
  }
  async prepare(owner: WorkspaceIdentity, capabilityToken: string, candidateId: string): Promise<CandidatePreparation> {
    try {
      if (!this.issuer || !await this.evidence.authorizeOwner(owner, capabilityToken)) return { status: 'held', reasonCodes: ['UNAUTHORIZED'] };
      opaqueId(candidateId);
      const candidate = await this.evidence.loadCandidate(owner, candidateId);
      if (!candidate || candidate.candidateId !== candidateId) return { status: 'held', reasonCodes: ['CANDIDATE_MISSING'] };
      const capsule = validateSkillBody(candidate.body, this.registry, candidate.privateKnownValues);
      const hash = await skillDigest(capsule);
      if (hash !== candidate.candidateBodyHash) return { status: 'held', reasonCodes: ['CANDIDATE_HASH'] };
      const site = this.registry.getSite(capsule.siteId)!;
      const runs = new Set<string>();
      for (const id of new Set(candidate.receiptIds)) {
        const r = await this.evidence.getCanonicalRunReceipt(owner, id);
        if (!r || r.receiptId !== id || !sameOwner(owner, r) || r.status !== 'succeeded'
            || r.candidateBodyHash !== hash || r.siteOrigin !== site.origin || r.outcome !== capsule.outcome
            || !['observed_postcondition', 'reviewed'].includes(r.verification.kind)
            || !r.verification.evidenceRef || !r.verification.policyVersion
            || !await this.evidence.verifyDurabilityCoverage(owner, r, candidate.requiredArtifactRefs)) {
          return { status: 'held', reasonCodes: ['EVIDENCE_INVALID'] };
        }
        runs.add(r.runId);
      }
      if (runs.size < 3) return { status: 'held', reasonCodes: ['INSUFFICIENT_DISTINCT_RUNS'] };
      // Historical committed receipts stay valid after replacement. Fresh signing authorization is current.
      if (!await this.evidence.authorizeOwner(owner, capabilityToken)) return { status: 'held', reasonCodes: ['UNAUTHORIZED'] };
      const idempotencyKey = crypto.randomUUID();
      const attestation = await this.issuer.issue({ audience: 'hygge-skill-publisher', environment: owner.environment,
        policyVersion: SKILL_POLICY_VERSION, capsuleHash: hash, distinctSuccessCount: runs.size,
        tokenId: crypto.randomUUID(), idempotencyKey, expiresAt: new Date(this.now() + 60_000).toISOString() });
      return { status: 'ready', request: { requestVersion: 1, idempotencyKey, capsule, capsuleHash: hash, attestation } };
    } catch (error) {
      return { status: 'held', reasonCodes: [error instanceof SkillPolicyError ? error.code : 'EVIDENCE_UNAVAILABLE'] };
    }
  }
}

/** Structural D1 types permit exercising identical SQL against SQLite offline. */
export interface SkillSqlStatement {
  bind(...values: unknown[]): SkillSqlStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}
export interface SkillSqlDatabase {
  prepare(sql: string): SkillSqlStatement;
  batch(statements: SkillSqlStatement[]): Promise<Array<{ results?: Record<string, unknown>[] }>>;
}
function rowSkill(row: Record<string, unknown>): PublishedSkill {
  const body = JSON.parse(String(row.body));
  if (row.site_id !== body?.siteId || row.outcome !== body?.outcome) throw new SkillPolicyError('STORED_METADATA_MISMATCH');
  return { id: String(row.id), version: Number(row.version), body,
    contentHash: String(row.content_hash), policyVersion: String(row.policy_version), status: row.status as PublishedSkill['status'],
    epoch: Number(row.epoch), confidence: Number(row.confidence), sourceRunCount: Number(row.source_run_count) };
}
/** Sole shared-store write adapter. Every multi-step mutation is one atomic D1 batch. */
export class D1SkillPublicationRepository {
  private db: SkillSqlDatabase;
  constructor(db: SkillSqlDatabase | D1Database) { this.db = db as SkillSqlDatabase; }
  private s(sql: string, ...values: unknown[]) { return this.db.prepare(sql).bind(...values); }
  private async atomic(statements: SkillSqlStatement[]) {
    try { return await this.db.batch(statements); }
    catch (e) {
      if (/NOT NULL constraint failed: skill_(?:publications|usage|quarantines|admissions)_v2\.payload_hash/.test(String((e as Error)?.message))) {
        throw new SkillPolicyError('IDEMPOTENCY_CONFLICT');
      }
      throw e;
    }
  }
  async publish(request: PublicationRequest, tokenId: string, successes: number): Promise<PublicationResult> {
    const hash = request.capsuleHash; const key = request.idempotencyKey;
    const id = crypto.randomUUID();
    const result = await this.atomic([
      this.s(`INSERT OR IGNORE INTO skill_publications_v2(request_key,payload_hash,token_id) VALUES (?,?,?)`, key, hash, tokenId),
      // NOT NULL guard aborts the whole transaction on key reuse with changed payload or token reuse under another key.
      this.s(`UPDATE skill_publications_v2 SET payload_hash = CASE WHEN payload_hash=? AND token_id=? THEN payload_hash ELSE NULL END WHERE request_key=?`, hash, tokenId, key),
      this.s(`INSERT INTO public_skills_v2(id,site_id,outcome,version,body,content_hash,policy_version,source_run_count)
        SELECT ?,?,?,COALESCE((SELECT MAX(version) FROM public_skills_v2 WHERE site_id=? AND outcome=?),0)+1,?,?,?,?
        WHERE EXISTS(SELECT 1 FROM skill_publications_v2 WHERE request_key=? AND token_id=?)
        ON CONFLICT(content_hash,policy_version) DO NOTHING`, id, request.capsule.siteId, request.capsule.outcome,
        request.capsule.siteId, request.capsule.outcome, canonicalJson(request.capsule), hash, SKILL_POLICY_VERSION, successes, key, tokenId),
      this.s(`UPDATE skill_publications_v2 SET skill_id=(SELECT id FROM public_skills_v2 WHERE content_hash=? AND policy_version=?) WHERE request_key=?`, hash, SKILL_POLICY_VERSION, key),
      this.s(`SELECT s.*, CASE WHEN s.id=? THEN 'published' ELSE 'existing' END AS publication_status FROM public_skills_v2 s JOIN skill_publications_v2 p ON p.skill_id=s.id WHERE p.request_key=?`, id, key),
    ]);
    const row = result.at(-1)?.results?.[0];
    if (!row) throw new SkillPolicyError('IDEMPOTENCY_CONFLICT');
    if (row.status !== 'active') return { status: 'held', reasonCodes: ['SKILL_INACTIVE'] };
    return { status: row.publication_status as 'published' | 'existing', skillId: String(row.id), version: Number(row.version),
      contentHash: hash, policyVersion: SKILL_POLICY_VERSION, registryEpoch: Number(row.epoch) };
  }
  async resolve(siteId: string, outcome: string): Promise<PublishedSkill | null> {
    // New D1 sessions should use first-primary when read replicas are configured; see activation docs.
    const row = await this.s(`SELECT * FROM public_skills_v2 WHERE site_id=? AND outcome=? AND status='active' ORDER BY version DESC LIMIT 1`, siteId, outcome).first();
    return row ? rowSkill(row) : null;
  }
  async read(skillId: string): Promise<PublishedSkill | null> {
    const row = await this.s(`SELECT * FROM public_skills_v2 WHERE id=?`, skillId).first();
    return row ? rowSkill(row) : null;
  }
  async findByContentHash(contentHash: string): Promise<PublishedSkill[]> {
    const result = await this.db.batch([this.s(`SELECT * FROM public_skills_v2 WHERE content_hash=?`, contentHash)]);
    return (result[0]?.results ?? []).map(rowSkill);
  }
  async readAdmission(admissionId: string): Promise<SkillAdmission | null> {
    const row = await this.s(`SELECT * FROM skill_admissions_v2 WHERE admission_id=?`, admissionId).first();
    return row ? { admissionId, skillId: String(row.skill_id), version: Number(row.version), epoch: Number(row.epoch), expiresAt: String(row.expires_at) } : null;
  }
  async usage(usageId: string, skillId: string, succeeded: boolean, implicated: boolean): Promise<void> {
    const digest = await skillDigest({ skillId, succeeded, implicated }, 'hygge:skill-usage:v1');
    await this.atomic([
      this.s(`INSERT OR IGNORE INTO skill_usage_v2(usage_id,payload_hash,skill_id,succeeded,implicated) VALUES(?,?,?,?,?)`, usageId, digest, skillId, Number(succeeded), Number(implicated)),
      this.s(`UPDATE skill_usage_v2 SET payload_hash=CASE WHEN payload_hash=? THEN payload_hash ELSE NULL END WHERE usage_id=?`, digest, usageId),
      this.s(`UPDATE public_skills_v2 SET confidence=MIN(1,MAX(0,confidence+?)),source_run_count=source_run_count+1,
        status=CASE WHEN status='active' AND ?=1 THEN 'needs_reverification' ELSE status END,
        epoch=epoch+CASE WHEN status='active' AND ?=1 THEN 1 ELSE 0 END
        WHERE id=? AND EXISTS(SELECT 1 FROM skill_usage_v2 WHERE usage_id=? AND applied=0)`, succeeded ? .05 : -.1, Number(!succeeded && implicated), Number(!succeeded && implicated), skillId, usageId),
      this.s(`UPDATE skill_usage_v2 SET applied=1 WHERE usage_id=?`, usageId),
    ]);
  }
  async quarantine(operationId: string, skillId: string, reason: 'privacy' | 'unsafe_guidance' | 'integrity'): Promise<void> {
    const hash = await skillDigest({ skillId, reason }, 'hygge:skill-quarantine:v1');
    await this.atomic([
      this.s(`INSERT OR IGNORE INTO skill_quarantines_v2(operation_id,payload_hash,skill_id,reason_code) VALUES(?,?,?,?)`, operationId, hash, skillId, reason),
      this.s(`UPDATE skill_quarantines_v2 SET payload_hash=CASE WHEN payload_hash=? THEN payload_hash ELSE NULL END WHERE operation_id=?`, hash, operationId),
      this.s(`UPDATE public_skills_v2 SET status='quarantined',epoch=epoch+1 WHERE id=? AND status!='quarantined'
        AND EXISTS(SELECT 1 FROM skill_quarantines_v2 WHERE operation_id=? AND applied=0)`, skillId, operationId),
      this.s(`UPDATE skill_quarantines_v2 SET applied=1 WHERE operation_id=?`, operationId),
    ]);
  }
  async admit(admissionId: string, skillId: string, version: number, epoch: number, expiresAt: string, validated: PublishedSkill): Promise<SkillAdmission | null> {
    const hash = await skillDigest({ skillId, version, epoch }, 'hygge:skill-admission:v1');
    const expectedBody = canonicalJson(validated.body);
    const rows = await this.atomic([
      this.s(`INSERT INTO skill_admissions_v2(admission_id,payload_hash,skill_id,version,epoch,expires_at)
        SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM public_skills_v2 WHERE id=? AND version=? AND epoch=? AND status='active' AND content_hash=? AND policy_version=? AND body=?)
        ON CONFLICT(admission_id) DO NOTHING`, admissionId, hash, skillId, version, epoch, expiresAt, skillId, version, epoch, validated.contentHash, validated.policyVersion, expectedBody),
      this.s(`UPDATE skill_admissions_v2 SET payload_hash=CASE WHEN payload_hash=? THEN payload_hash ELSE NULL END WHERE admission_id=?`, hash, admissionId),
      this.s(`SELECT a.* FROM skill_admissions_v2 a JOIN public_skills_v2 s ON s.id=a.skill_id WHERE a.admission_id=? AND s.status='active' AND s.epoch=a.epoch AND a.consumed_by IS NULL AND s.content_hash=? AND s.policy_version=? AND s.body=?`, admissionId, validated.contentHash, validated.policyVersion, expectedBody),
    ]);
    const r = rows.at(-1)?.results?.[0];
    return r ? { admissionId, skillId, version, epoch, expiresAt: String(r.expires_at) } : null;
  }
  /** Caller is the trusted owner DO. Opaque effect binding is not private action content. */
  async consume(admissionId: string, effectBinding: string, now: string, validated: PublishedSkill): Promise<boolean> {
    const expectedBody = canonicalJson(validated.body);
    const rows = await this.atomic([
      this.s(`UPDATE skill_admissions_v2 SET consumed_by=?,consumed_at=? WHERE admission_id=? AND expires_at>?
        AND (consumed_by IS NULL OR consumed_by=?) AND EXISTS(SELECT 1 FROM public_skills_v2 s
          WHERE s.id=skill_admissions_v2.skill_id AND s.version=skill_admissions_v2.version AND s.status='active' AND s.epoch=skill_admissions_v2.epoch AND s.content_hash=? AND s.policy_version=? AND s.body=?)`, effectBinding, now, admissionId, now, effectBinding, validated.contentHash, validated.policyVersion, expectedBody),
      this.s(`SELECT 1 AS granted FROM skill_admissions_v2 a JOIN public_skills_v2 s ON s.id=a.skill_id
        WHERE a.admission_id=? AND a.consumed_by=? AND a.expires_at>? AND s.status='active' AND s.version=a.version AND s.epoch=a.epoch AND s.content_hash=? AND s.policy_version=? AND s.body=?`, admissionId, effectBinding, now, validated.contentHash, validated.policyVersion, expectedBody),
    ]);
    return !!rows.at(-1)?.results?.length;
  }
}

/** No public routes are activated by constructing this module. Transport/auth wiring is Wave 2. */
export class SharedSkillPublisher {
  private repo: D1SkillPublicationRepository; private registry: SkillRegistry;
  private environment: WorkspaceIdentity['environment']; private authorization?: ServiceAuthorization;
  private verifier?: AttestationVerifier; private now: () => number;
  constructor(repo: D1SkillPublicationRepository, registry: SkillRegistry,
    environment: WorkspaceIdentity['environment'], authorization?: ServiceAuthorization,
    verifier?: AttestationVerifier, now = () => Date.now()) {
    this.repo = repo; this.registry = registry; this.environment = environment;
    this.authorization = authorization; this.verifier = verifier; this.now = now;
  }
  private async allowed(token: string, op: Parameters<ServiceAuthorization['authorize']>[1], binding: Readonly<Record<string, unknown>> = {}) {
    return !!this.authorization && await this.authorization.authorize(token, op, binding);
  }
  async publish(token: string, input: unknown): Promise<PublicationResult> {
    try {
      if (!await this.allowed(token, 'publish') || !this.verifier) return { status: 'held', reasonCodes: ['UNAUTHORIZED'] };
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new SkillPolicyError('SCHEMA_OBJECT');
      const r = input as PublicationRequest;
      if (Object.keys(r).sort().join(',') !== ['requestVersion', 'idempotencyKey', 'capsule', 'capsuleHash', 'attestation'].sort().join(',') || r.requestVersion !== 1) throw new SkillPolicyError('SCHEMA_KEYS');
      opaqueId(r.idempotencyKey);
      if (typeof r.attestation !== 'string' || r.attestation.length > 8192) throw new SkillPolicyError('ATTESTATION_INVALID');
      const capsule = validateSkillBody(r.capsule, this.registry);
      const hash = await skillDigest(capsule);
      const c = await this.verifier.verify(r.attestation);
      if (!c || c.audience !== 'hygge-skill-publisher' || c.environment !== this.environment || c.policyVersion !== SKILL_POLICY_VERSION
          || c.capsuleHash !== hash || r.capsuleHash !== hash || c.idempotencyKey !== r.idempotencyKey
          || !Number.isSafeInteger(c.distinctSuccessCount) || c.distinctSuccessCount < 3
          || !Number.isFinite(Date.parse(c.expiresAt)) || Date.parse(c.expiresAt) <= this.now()) return { status: 'held', reasonCodes: ['ATTESTATION_INVALID'] };
      opaqueId(c.tokenId);
      return await this.repo.publish({ ...r, capsule }, c.tokenId, c.distinctSuccessCount);
    } catch (e) {
      return e instanceof SkillPolicyError ? { status: 'rejected', reasonCodes: [e.code] } : { status: 'retryable', reasonCode: 'unavailable' };
    }
  }
  async resolve(siteId: string, outcome: string): Promise<PublishedSkill | null> {
    try {
      opaqueId(siteId);
      const stored = await this.repo.resolve(siteId, outcome);
      const validated = stored ? await this.validateStored(stored) : null;
      return validated && validated.body.siteId === siteId && validated.body.outcome === outcome ? validated : null;
    } catch { return null; }
  }
  private async validateStored(skill: PublishedSkill): Promise<PublishedSkill | null> {
    if (skill.status !== 'active' || skill.policyVersion !== SKILL_POLICY_VERSION
        || !Number.isSafeInteger(skill.version) || skill.version < 1 || !Number.isSafeInteger(skill.epoch) || skill.epoch < 1) return null;
    const body = validateSkillBody(skill.body, this.registry);
    if (await skillDigest(body) !== skill.contentHash) return null;
    return { ...skill, body };
  }
  async readValidated(skillId: string): Promise<PublishedSkill | null> {
    try { opaqueId(skillId); const stored = await this.repo.read(skillId); return stored ? await this.validateStored(stored) : null; }
    catch { return null; }
  }
  /** Private fallback cannot evade a global quarantine via a second owner's identical candidate. */
  async isBodyReusable(input: unknown): Promise<boolean> {
    try {
      const body=validateSkillBody(input,this.registry);
      const hash=await skillDigest(body);
      const matches=await this.repo.findByContentHash(hash);
      // Missing publication is distinct from an unavailable registry/database (caught -> false).
      for(const stored of matches) if(!await this.validateStored(stored)) return false;
      return true;
    } catch { return false; }
  }
  async usage(token: string, usageId: string, skillId: string, succeeded: boolean, implicated: boolean) {
    if (!await this.allowed(token, 'usage', { usageId, skillId, succeeded, implicated }) || typeof succeeded !== 'boolean' || typeof implicated !== 'boolean') return false;
    opaqueId(usageId); opaqueId(skillId); await this.repo.usage(usageId, skillId, succeeded, implicated); return true;
  }
  async quarantine(token: string, operationId: string, skillId: string, reason: 'privacy' | 'unsafe_guidance' | 'integrity') {
    if (!await this.allowed(token, 'quarantine', { operationId, skillId, reason }) || !['privacy', 'unsafe_guidance', 'integrity'].includes(reason)) return false;
    opaqueId(operationId); opaqueId(skillId); await this.repo.quarantine(operationId, skillId, reason); return true;
  }
  async admit(token: string, admissionId: string, skillId: string, version: number, epoch: number) {
    if (!await this.allowed(token, 'admit', { admissionId, skillId, version, epoch }) || !Number.isSafeInteger(version) || version < 1 || !Number.isSafeInteger(epoch) || epoch < 1) return null;
    opaqueId(admissionId); opaqueId(skillId);
    const skill = await this.readValidated(skillId);
    if (!skill || skill.version !== version || skill.epoch !== epoch) return null;
    const receipt = await this.repo.admit(admissionId, skillId, version, epoch, new Date(this.now() + 10_000).toISOString(), skill);
    return receipt && Date.parse(receipt.expiresAt) > this.now() ? receipt : null;
  }
  async consume(token: string, admissionId: string, effectBinding: string) {
    if (!await this.allowed(token, 'consume', { admissionId, effectBinding })) return false;
    opaqueId(admissionId); opaqueId(effectBinding);
    const admission = await this.repo.readAdmission(admissionId);
    const skill = admission ? await this.readValidated(admission.skillId) : null;
    if (!admission || !skill || skill.version !== admission.version || skill.epoch !== admission.epoch) return false;
    return this.repo.consume(admissionId, effectBinding, new Date(this.now()).toISOString(), skill);
  }
}
