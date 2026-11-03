import type { WorkspaceIdentity, RuntimeLease, WorkspaceDurabilityReceipt, RecoveryPoint } from './workspace-contract.ts';
import { assertOwner, ownerKey, assertLease, WorkspaceRegistry } from './workspace-runtime.ts';
export interface PrivateObjectStore {
  putImmutable(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
}
/** R2 credential stays in trusted service; no agent receives bucket access. */
export function r2WorkspaceObjects(bucket: R2Bucket): PrivateObjectStore {
  return {
    async putImmutable(key, bytes) {
      await bucket.put(key, bytes, { onlyIf: { etagDoesNotMatch: '*' } });
      const read = await bucket.get(key);
      if (!read || await sha256(new Uint8Array(await read.arrayBuffer())) !== await sha256(bytes)) throw new Error('OBJECT_VERIFICATION_FAILED');
    },
    async get(key) { const obj = await bucket.get(key); return obj ? new Uint8Array(await obj.arrayBuffer()) : null; },
  };
}
export interface CaptureWrite {
  writeId: string;
  expectedRegistryRevision: number;
  filesystemRevision: number;
  browserProfileRevision: number;
  artifactRefs: readonly string[];
}
export interface NativeCapture {
  incarnation: string; generation: number;
  filesystemRevision: number; browserProfileRevision: number;
  browserState: 'absent' | 'quiesced';
  files: readonly { path: string; bytes: Uint8Array; mode?: number }[];
  directories?: readonly { path: string; mode: number }[];
  symlinks?: readonly { path: string; target: string }[];
  /** Private opaque artifact ID -> relative captured path, never external URLs. */
  artifacts: Readonly<Record<string, string>>;
}
export interface NativeCaptureDriver {
  /** Trusted bridge must exclude tools/human/browser mutations until release. */
  capture(lease: RuntimeLease, request: CaptureWrite): Promise<{ snapshot: NativeCapture; release(): Promise<void> }>;
}
export class UnsupportedNativeCapture implements NativeCaptureDriver {
  async capture(): Promise<never> { throw new Error('CONSISTENT_BROWSER_CAPTURE_ADAPTER_REQUIRED'); }
}
interface FileEntry { path: string; hash: string; size: number; mode: number }
interface DirectoryEntry { path: string; mode: number }
interface SymlinkEntry { path: string; target: string }
export interface CaptureLimits { maxEntries: number; maxBytes: number }
/** Interim bounded transport; not a product storage quota. Large-profile streaming is gated. */
export const DEFAULT_CAPTURE_LIMITS: Readonly<CaptureLimits> = Object.freeze({ maxEntries: 512, maxBytes: 16 * 1024 * 1024 });
interface Manifest extends WorkspaceIdentity {
  schemaVersion: 1; imageDigest: string; incarnation: string; generation: number;
  filesystemRevision: number; browserProfileRevision: number;
  sequence: number; files: FileEntry[]; directories: DirectoryEntry[]; symlinks: SymlinkEntry[]; artifacts: Record<string, string>;
}
const encoder = new TextEncoder();
export async function sha256(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(hash)].map(x => x.toString(16).padStart(2,'0')).join('');
}
function encode(value: unknown) { return encoder.encode(JSON.stringify(value)); }
function pathOK(path: string): boolean {
  return !!path && path.length <= 1024 && !path.startsWith('/') && !path.includes('\\') && !/[\x00-\x1f\x7f]/.test(path) && path.split('/').every(p => p !== '..' && p !== '.' && p.length > 0);
}
function modeOK(mode: number): boolean { return Number.isInteger(mode) && mode >= 0 && mode <= 0o777; }
function rawLinkTarget(target: string): string {
  if (!target || target.length > 1024 || target.startsWith('/') || target.includes('\\') || /[\x00-\x1f\x7f]/.test(target)) throw new Error('UNSAFE_SYMLINK');
  return target;
}
// Lexical realpath: '..' must apply AFTER substituting any intermediate
// symlink, or a chain through a shallower link escapes the captured tree.
function resolveLinkParts(rawLinks: ReadonlyMap<string, string>, initial: readonly string[]): string[] {
  const out: string[] = [];
  const queue = [...initial];
  const seen = new Set<string>();
  while (queue.length) {
    const part = queue.shift()!;
    if (!part || part === '.') continue;
    if (part === '..') { if (!out.length) throw new Error('UNSAFE_SYMLINK'); out.pop(); continue; }
    out.push(part);
    const joined = out.join('/');
    const target = rawLinks.get(joined);
    if (target !== undefined) {
      if (seen.has(joined)) throw new Error('SYMLINK_CYCLE');
      seen.add(joined); out.pop();
      queue.unshift(...target.split('/'));
    }
  }
  return out;
}
/** No archive extraction may traverse a file/symlink parent or escape the captured tree. */
function validateTree(files: readonly {path:string;mode:number}[], directories: readonly DirectoryEntry[], links: readonly SymlinkEntry[]): Set<string> {
  const entries = new Map<string, 'file'|'directory'|'symlink'>();
  for (const [kind, values] of [['file',files],['directory',directories],['symlink',links]] as const) for (const entry of values) {
    if (!pathOK(entry.path) || entries.has(entry.path) || ('mode' in entry && !modeOK(entry.mode))) throw new Error('UNSAFE_CAPTURE_PATH');
    entries.set(entry.path, kind);
  }
  for (const path of entries.keys()) {
    const parts = path.split('/'); parts.pop();
    while (parts.length) { if (entries.get(parts.join('/')) !== 'directory') throw new Error('UNSAFE_CAPTURE_PARENT'); parts.pop(); }
  }
  const rawLinks = new Map(links.map(link => [link.path, rawLinkTarget(link.target)]));
  for (const link of links) {
    const dest = resolveLinkParts(rawLinks, [...link.path.split('/').slice(0, -1), ...link.target.split('/')]).join('/');
    if (!dest || !entries.has(dest)) throw new Error('UNSAFE_SYMLINK');
  }
  return new Set(entries.keys());
}
function revision(value: number) { if (!Number.isSafeInteger(value) || value < 0) throw new Error('INVALID_REVISION'); }
export class WorkspaceCaptureService {
  readonly registry: WorkspaceRegistry; readonly objects: PrivateObjectStore; readonly driver: NativeCaptureDriver; readonly now: () => number; readonly limits: Readonly<CaptureLimits>;
  constructor(registry: WorkspaceRegistry, objects: PrivateObjectStore, driver: NativeCaptureDriver, now: () => number = Date.now, limits: CaptureLimits = DEFAULT_CAPTURE_LIMITS) { this.registry = registry; this.objects = objects; this.driver = driver; this.now = now; this.limits = Object.freeze({ ...limits }); if (!Number.isSafeInteger(limits.maxEntries) || limits.maxEntries < 1 || !Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1) throw new Error('INVALID_CAPTURE_LIMITS'); }
  private prefix(owner: WorkspaceIdentity) { return `hygge-workspaces/v1/${ownerKey(owner)}`; }
  private async requestDigest(request: CaptureWrite): Promise<string> {
    revision(request.expectedRegistryRevision); revision(request.filesystemRevision); revision(request.browserProfileRevision);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(request.writeId) || request.artifactRefs.length > 512 || new Set(request.artifactRefs).size !== request.artifactRefs.length || request.artifactRefs.some(x => !/^[A-Za-z0-9_-]{1,128}$/.test(x))) throw new Error('INVALID_CAPTURE_REQUEST');
    // expectedRegistryRevision intentionally included: retries must repeat the exact request.
    return sha256(encode({ v: 1, ...request, artifactRefs: [...request.artifactRefs].sort() }));
  }
  async commit(actor: WorkspaceIdentity, lease: RuntimeLease, request: CaptureWrite): Promise<WorkspaceDurabilityReceipt> {
    actor = structuredClone(actor); lease = structuredClone(lease); request = structuredClone(request);
    assertOwner(actor, lease);
    const digest = await this.requestDigest(request);
    const prior = await this.registry.saved(actor, lease, request.writeId);
    if (prior) { if (prior.digest !== digest) throw new Error('IDEMPOTENCY_CONFLICT'); return this.verifyReceipt(actor, lease, prior.receipt.receiptId); }
    const binding = await this.registry.read(actor, lease); assertLease(binding, lease, this.now(), await this.registry.readLease(actor, lease));
    if (binding.revision !== request.expectedRegistryRevision) throw new Error('REVISION_CONFLICT');
    if (binding.recoveryPoint) {
      const oldBytes = await this.objects.get(`${this.prefix(lease)}/manifests/${binding.recoveryPoint.manifestHash}`);
      if (!oldBytes || await sha256(oldBytes) !== binding.recoveryPoint.manifestHash) throw new Error('MANIFEST_VERIFICATION_FAILED');
      const old = JSON.parse(new TextDecoder().decode(oldBytes)) as Manifest;
      assertOwner(lease, old);
      if (request.filesystemRevision <= old.filesystemRevision || request.browserProfileRevision < old.browserProfileRevision) throw new Error('REVISION_REGRESSION');
    }
    const captured = await this.driver.capture(lease, request);
    try {
      const s = structuredClone(captured.snapshot); // detach every byte/metadata array before the first upload await
      if (s.incarnation !== lease.incarnation || s.generation !== lease.generation || s.filesystemRevision !== request.filesystemRevision || s.browserProfileRevision !== request.browserProfileRevision) throw new Error('CAPTURE_LINEAGE_MISMATCH');
      if ((s.browserProfileRevision > 0 && s.browserState !== 'quiesced') || (s.browserProfileRevision === 0 && s.browserState !== 'absent')) throw new Error('BROWSER_NOT_QUIESCED');
      const directories = [...(s.directories ?? [])].sort((a,b) => a.path.localeCompare(b.path));
      const symlinks = [...(s.symlinks ?? [])].sort((a,b) => a.path.localeCompare(b.path));
      const files = s.files.map(f => ({ ...f, mode: f.mode ?? 0o600 })).sort((a,b) => a.path.localeCompare(b.path));
      if (files.length + directories.length + symlinks.length > this.limits.maxEntries || files.some(f => !(f.bytes instanceof Uint8Array)) || files.reduce((n,f) => n + f.bytes.byteLength, 0) > this.limits.maxBytes) throw new Error('CAPTURE_LIMIT_EXCEEDED');
      const paths = validateTree(files, directories, symlinks);
      const entries: FileEntry[] = [];
      for (const file of files) {
        const hash = await sha256(file.bytes); const key = `${this.prefix(lease)}/blobs/${hash}`;
        await this.objects.putImmutable(key, file.bytes);
        const read = await this.objects.get(key);
        if (!read || await sha256(read) !== hash) throw new Error('OBJECT_VERIFICATION_FAILED');
        entries.push({ path: file.path, hash, size: file.bytes.byteLength, mode: file.mode });
      }
      const artifacts: Record<string, string> = Object.create(null);
      if (Object.keys(s.artifacts).length > 512) throw new Error('INVALID_ARTIFACT');
      for (const ref of Object.keys(s.artifacts).sort()) {
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(ref) || !paths.has(s.artifacts[ref])) throw new Error('INVALID_ARTIFACT');
        artifacts[ref] = s.artifacts[ref];
      }
      if (request.artifactRefs.some(ref => !Object.hasOwn(artifacts, ref))) throw new Error('ARTIFACT_NOT_CAPTURED');
      const manifest: Manifest = { schemaVersion: 1, environment: lease.environment, userId: lease.userId, workspaceId: lease.workspaceId,
        imageDigest: binding.desiredImageDigest, incarnation: lease.incarnation, generation: lease.generation,
        filesystemRevision: s.filesystemRevision, browserProfileRevision: s.browserProfileRevision,
        sequence: (binding.recoveryPoint?.sequence ?? 0) + 1, files: entries, directories, symlinks, artifacts };
      const bytes = encode(manifest); const hash = await sha256(bytes);
      const manifestKey = `${this.prefix(lease)}/manifests/${hash}`;
      await this.objects.putImmutable(manifestKey, bytes);
      const verified = await this.objects.get(manifestKey);
      if (!verified || await sha256(verified) !== hash) throw new Error('MANIFEST_VERIFICATION_FAILED');
      const point: RecoveryPoint = { environment: lease.environment, userId: lease.userId, workspaceId: lease.workspaceId,
        checkpointId: hash, sequence: manifest.sequence, sourceIncarnation: lease.incarnation,
        sourceGeneration: lease.generation, manifestHash: hash, storage: 'r2', policyVersion: 'hygge-workspace-v1' };
      const receipt: WorkspaceDurabilityReceipt = { environment: lease.environment, userId: lease.userId, workspaceId: lease.workspaceId,
        receiptId: request.writeId, writeId: request.writeId, incarnation: lease.incarnation, generation: lease.generation,
        filesystemRevision: s.filesystemRevision, browserProfileRevision: s.browserProfileRevision,
        coveredArtifactRefs: request.artifactRefs.slice().sort(), recoveryPoint: point, committedAt: new Date(this.now()).toISOString() };
      return await this.registry.commitRecovery(actor, lease, binding.revision, { digest, receipt, manifestKey });
    } finally { await captured.release(); }
  }
  /** Trusted verifier for C: resolves only durable private records, then verifies all covered bytes. */
  async verifyReceipt(actor: WorkspaceIdentity, owner: WorkspaceIdentity, receiptId: string): Promise<WorkspaceDurabilityReceipt> {
    assertOwner(actor, owner);
    const stored = await this.registry.saved(actor, owner, receiptId);
    if (!stored) throw new Error('RECEIPT_NOT_COMMITTED');
    const r = stored.receipt; const point = r.recoveryPoint;
    assertOwner(owner, r); assertOwner(owner, point);
    const expectedKey = `${this.prefix(owner)}/manifests/${point.manifestHash}`;
    if (point.storage !== 'r2' || point.checkpointId !== point.manifestHash || stored.manifestKey !== expectedKey) throw new Error('INVALID_RECOVERY_POINT');
    const bytes = await this.objects.get(expectedKey);
    if (!bytes || await sha256(bytes) !== point.manifestHash) throw new Error('MANIFEST_VERIFICATION_FAILED');
    const m = JSON.parse(new TextDecoder().decode(bytes)) as Manifest;
    assertOwner(owner, m);
    if (m.schemaVersion !== 1 || m.incarnation !== r.incarnation || m.generation !== r.generation || m.sequence !== point.sequence || m.filesystemRevision !== r.filesystemRevision || m.browserProfileRevision !== r.browserProfileRevision || point.sourceIncarnation !== m.incarnation || point.sourceGeneration !== m.generation) throw new Error('MANIFEST_LINEAGE_MISMATCH');
    const paths = validateTree(m.files, m.directories, m.symlinks);
    for (const f of m.files) {
      if (!Number.isSafeInteger(f.size) || f.size < 0 || !/^[a-f0-9]{64}$/.test(f.hash)) throw new Error('INVALID_MANIFEST');
      const data = await this.objects.get(`${this.prefix(owner)}/blobs/${f.hash}`);
      if (!data || data.byteLength !== f.size || await sha256(data) !== f.hash) throw new Error('OBJECT_VERIFICATION_FAILED');
    }
    if (r.coveredArtifactRefs.some(ref => !Object.hasOwn(m.artifacts, ref) || !paths.has(m.artifacts[ref]))) throw new Error('ARTIFACT_NOT_CAPTURED');
    return r;
  }
}
