/** Google Cloud is optional. When selected, all runtime resources must be in a dedicated Hygge project. */
export interface DedicatedHyggeProject {
  readonly projectId: string;
  readonly projectNumber: string;
  /** Get BOB organization and its intended billing account are deliberately shared. */
  readonly organizationId: string;
  readonly billingAccountId: string;
  /** Complete reviewed project denylist; live project/IAM inventory is a deployment prerequisite. */
  readonly getBobProjectIds: readonly string[];
  readonly getBobProjectNumbers: readonly string[];
}
export class ProjectIsolationError extends Error {
  constructor() { super('HYGGE_PROJECT_ISOLATION_REQUIRED'); this.name = 'ProjectIsolationError'; }
}
function fail(): never { throw new ProjectIsolationError(); }
/** Called with trusted deployment config, never user input or ambient GOOGLE_CLOUD_PROJECT. */
export function dedicatedHyggeProject(config: DedicatedHyggeProject): Readonly<DedicatedHyggeProject> {
  if (!config || !/^hygge-[a-z0-9-]{0,22}[a-z0-9]$/.test(config.projectId) || config.projectId.includes('getbob') ||
      !/^[1-9][0-9]{5,19}$/.test(config.projectNumber) || !Array.isArray(config.getBobProjectIds) || config.getBobProjectIds.length === 0 ||
      !/^[1-9][0-9]{5,19}$/.test(config.organizationId) || typeof config.billingAccountId !== 'string' || !/^[A-Za-z0-9-]{6,80}$/.test(config.billingAccountId) ||
      !Array.isArray(config.getBobProjectNumbers) || config.getBobProjectNumbers.length === 0 ||
      config.getBobProjectIds.some(value => !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(value)) ||
      config.getBobProjectNumbers.some(value => !/^[1-9][0-9]{5,19}$/.test(value)) ||
      config.getBobProjectIds.includes(config.projectId) || config.getBobProjectNumbers.includes(config.projectNumber)) fail();
  return Object.freeze({ ...config, getBobProjectIds: Object.freeze([...config.getBobProjectIds]), getBobProjectNumbers: Object.freeze([...config.getBobProjectNumbers]) });
}
/** Resource project numbers must come from authenticated provider metadata, not labels supplied by an agent. */
export function assertHyggeResourceProject(policy: Readonly<DedicatedHyggeProject>, metadata: { projectId: string; projectNumber: string }): void {
  dedicatedHyggeProject(policy);
  if (!metadata || metadata.projectId !== policy.projectId || metadata.projectNumber !== policy.projectNumber) fail();
}
/** Organization ancestry and billing linkage come from authenticated provider readback. */
export function assertHyggeProjectPlacement(policy: Readonly<DedicatedHyggeProject>, metadata: {
  projectId: string; projectNumber: string; organizationId: string; billingAccountId: string;
}): void {
  assertHyggeResourceProject(policy, metadata);
  if (metadata.organizationId !== policy.organizationId || metadata.billingAccountId !== policy.billingAccountId) fail();
}
/** No cross-project bucket, key, network, VM, service-account or workload-identity resource references. */
export function assertHyggeGoogleResource(policy: Readonly<DedicatedHyggeProject>, resource: string): void {
  dedicatedHyggeProject(policy);
  if (typeof resource !== 'string' || /[%?#\\]|(?:^|\/)\.\.(?:\/|$)/.test(resource)) fail();
  let path = resource;
  if (resource.startsWith('https://')) {
    const url = new URL(resource);
    if (!['compute.googleapis.com', 'www.googleapis.com', 'cloudkms.googleapis.com', 'iam.googleapis.com'].includes(url.hostname) || url.username || url.password || url.port || url.search || url.hash) fail();
    path = url.pathname.replace(/^\/(?:compute\/v1|v1)\//, '');
  }
  const match = /^projects\/([^/]+)\/(.+)$/.exec(path);
  if (!match || ![policy.projectId, policy.projectNumber].includes(match[1]) || match[2].includes('getbob')) fail();
  // Nested foreign project references are never accepted.
  if (/(?:^|\/)projects\//.test(match[2])) fail();
}
export function assertHyggeServiceAccount(policy: Readonly<DedicatedHyggeProject>, email: string): void {
  dedicatedHyggeProject(policy);
  const parts = typeof email === 'string' ? email.split('@') : [];
  if (parts.length !== 2 || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(parts[0]) || parts[1] !== policy.projectId + '.iam.gserviceaccount.com') fail();
}
