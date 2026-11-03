import type { RunCompletionReceipt, WorkspaceIdentity } from './workspace-contract.ts';

export const SKILL_POLICY_VERSION = 'hygge-public-skills-v2.1';
export const SKILL_OUTCOMES_V2 = ['signup', 'update_profile', 'apply', 'message', 'book', 'discover'] as const;
export type SkillOutcomeV2 = typeof SKILL_OUTCOMES_V2[number];
export const PARAM_REFS = ['profile.displayName', 'profile.email', 'profile.location', 'search.terms', 'search.rate',
  'application.resume', 'application.coverLetter', 'credential.username', 'credential.secret'] as const;
export type ParamRef = typeof PARAM_REFS[number];
export type SkillStep =
  | { op: 'navigate'; routeId: string }
  | { op: 'inspect' | 'click'; controlId: string }
  | { op: 'fill'; controlId: string; valueRef: ParamRef }
  | { op: 'upload'; controlId: string; valueRef: 'application.resume' }
  | { op: 'extract'; fieldSetId: string }
  | { op: 'checkpoint'; kind: 'captcha' | 'mfa' | 'identity' | 'payment' }
  | { op: 'complete'; outcome: SkillOutcomeV2 };
export interface SharedSkillBodyV2 {
  schemaVersion: 2;
  siteId: string;
  outcome: SkillOutcomeV2;
  steps: SkillStep[];
  pitfalls: Array<{ code: string; controlId?: string }>;
}
/** Constructed from reviewed application configuration, never from a runtime request. */
export interface ReviewedSite {
  siteId: string;
  origin: string;
  routes: Readonly<Record<string, string>>;
  controls: readonly string[];
  fieldSets: readonly string[];
  pitfalls: readonly string[];
  review: { policyVersion: string; reviewedRevision: string; source: 'developer_review' | 'independent_public_evidence' };
}
export interface SkillRegistry { getSite(siteId: string): ReviewedSite | undefined }
export interface PrivateCandidate {
  candidateId: string;
  body: unknown;
  candidateBodyHash: string;
  receiptIds: readonly string[];
  requiredArtifactRefs: readonly string[];
  /** Original and confirming values remain private; never passed to the publisher. */
  privateKnownValues: readonly string[];
}
/** Methods execute inside trusted owner-scoped backend code, not the model/VM. */
export interface OwnerEvidenceSource {
  authorizeOwner(owner: WorkspaceIdentity, capabilityToken: string): Promise<boolean>;
  loadCandidate(owner: WorkspaceIdentity, candidateId: string): Promise<PrivateCandidate | null>;
  getCanonicalRunReceipt(owner: WorkspaceIdentity, receiptId: string): Promise<RunCompletionReceipt | null>;
  verifyDurabilityCoverage(owner: WorkspaceIdentity, receipt: RunCompletionReceipt, refs: readonly string[]): Promise<boolean>;
}
export interface PublicationClaim {
  audience: 'hygge-skill-publisher';
  environment: WorkspaceIdentity['environment'];
  policyVersion: string;
  capsuleHash: string;
  distinctSuccessCount: number;
  tokenId: string;
  idempotencyKey: string;
  expiresAt: string;
}
export interface AttestationIssuer { issue(claim: PublicationClaim): Promise<string> }
/** Must authenticate signatures/issuer/audience; parsing a caller claim is not verification. */
export interface AttestationVerifier { verify(token: string): Promise<PublicationClaim | null> }
export interface PublicationRequest {
  requestVersion: 1;
  idempotencyKey: string;
  capsule: SharedSkillBodyV2;
  capsuleHash: string;
  attestation: string;
}
export type SkillStatusV2 = 'active' | 'needs_reverification' | 'quarantined' | 'deprecated';
export interface PublishedSkill {
  id: string; version: number; body: SharedSkillBodyV2; contentHash: string;
  policyVersion: string; status: SkillStatusV2; epoch: number; confidence: number; sourceRunCount: number;
}
export type PublicationResult =
  | { status: 'published' | 'existing'; skillId: string; version: number; contentHash: string; policyVersion: string; registryEpoch: number }
  | { status: 'held' | 'rejected'; reasonCodes: readonly string[] }
  | { status: 'retryable'; reasonCode: 'unavailable' };
export interface SkillAdmission { admissionId: string; skillId: string; version: number; epoch: number; expiresAt: string }
/** Validated trusted operation context; authenticated at service boundary. */
export interface ServiceAuthorization {
  /** Authenticate the trusted backend caller and bind authority to these exact arguments.
   * Usage requires canonical-run evidence; a general runtime/user capability is insufficient. */
  authorize(token: string, operation: 'publish' | 'usage' | 'quarantine' | 'admit' | 'consume', binding: Readonly<Record<string, unknown>>): Promise<boolean>;
}
