import type { WorkspaceIdentity, WorkspaceBinding, RuntimeLease, RuntimeFenceEvidence, WorkspaceDurabilityReceipt } from './workspace-contract.ts';

/** Internal services only: root broker authenticates the caller before resolving actor. */
export function assertOwner(actor: WorkspaceIdentity, owner: WorkspaceIdentity): void {
  if (!actor || actor.environment !== owner.environment || actor.userId !== owner.userId || actor.workspaceId !== owner.workspaceId) throw new Error('OWNER_MISMATCH');
  for (const value of [owner.userId, owner.workspaceId]) if (typeof value !== 'string' || !value || value.length > 256) throw new Error('INVALID_OWNER');
  if (!['staging', 'production'].includes(owner.environment)) throw new Error('INVALID_OWNER');
}
export function ownerKey(owner: WorkspaceIdentity): string {
  assertOwner(owner, owner);
  return [owner.environment, owner.userId, owner.workspaceId].map(encodeURIComponent).join('/');
}
export interface WorkspaceTransaction {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
}
export interface WorkspaceStorage {
  transaction<T>(fn: (tx: WorkspaceTransaction) => T): Promise<T>;
}
export interface WorkspaceSqlStorage {
  sql: { exec(query: string, ...bindings: (string | number | null)[]): Iterable<Record<string, unknown>> };
  transactionSync<T>(fn: () => T): T;
}
/** SQL is authoritative, not a cached lease mirror. C uses this same DO SQL store. */
export function sqliteWorkspaceRegistryStorage(storage: WorkspaceSqlStorage): WorkspaceStorage & { readCurrentLease(owner: WorkspaceIdentity): RuntimeLease } {
  storage.sql.exec('CREATE TABLE IF NOT EXISTS workspace_registry (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const tx: WorkspaceTransaction = {
    get<T>(key: string) { const row = [...storage.sql.exec('SELECT value FROM workspace_registry WHERE key = ?', key)][0]; return row ? JSON.parse(String(row.value)) as T : undefined; },
    put<T>(key: string, value: T) { storage.sql.exec('INSERT INTO workspace_registry (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(value)); },
  };
  return {
    async transaction<T>(fn: (tx: WorkspaceTransaction) => T) { return storage.transactionSync(() => { const result = fn(tx); if (result && typeof (result as any).then === 'function') throw new Error('ASYNC_SQL_TRANSACTION_FORBIDDEN'); return result; }); },
    readCurrentLease(owner) { const r = tx.get<RegistryRecord>(`workspace/${ownerKey(owner)}`); if (!r?.lease || r.binding.lifecycleState !== 'ready') throw new Error('STALE_GENERATION'); assertOwner(owner, r.binding); return r.lease; },
  };
}
/** Real DO SQLite transaction adapter (same table is synchronously readable by ledgers). */
export function durableObjectWorkspaceStorage(storage: DurableObjectStorage) {
  return sqliteWorkspaceRegistryStorage({ sql: storage.sql, transactionSync: fn => storage.transactionSync(fn) });
}
export interface RuntimeStart {
  runtimeId: string; providerRuntimeId: string; incarnation: string;
  /** Independent recovery must finish before a replacement can be ready. */
  recoveredCheckpointId: string | null;
}
export interface RuntimeProvider {
  /** Adapter is trusted; must reconcile repeated operationId before provisioning. */
  start(binding: WorkspaceBinding, operationId: string): Promise<RuntimeStart>;
  fence(binding: WorkspaceBinding, operationId: string): Promise<RuntimeFenceEvidence>;
}
export class UnsupportedRuntimeProvider implements RuntimeProvider {
  async start(): Promise<RuntimeStart> { throw new Error('BROWSER_PROVIDER_FEASIBILITY_REQUIRED'); }
  async fence(): Promise<RuntimeFenceEvidence> { throw new Error('EXACT_INCARNATION_FENCE_ADAPTER_REQUIRED'); }
}
export function assertLease(binding: WorkspaceBinding, lease: RuntimeLease, now: number, current?: RuntimeLease): void {
  assertOwner(lease, binding);
  if (!current || current.leaseId !== lease.leaseId || current.runtimeId !== lease.runtimeId || current.incarnation !== lease.incarnation || current.generation !== lease.generation) throw new Error('STALE_LEASE');
  if (binding.lifecycleState !== 'ready' || binding.generation !== lease.generation || binding.incarnation !== lease.incarnation || binding.runtimeId !== lease.runtimeId) throw new Error('STALE_GENERATION');
  if (!Number.isFinite(Date.parse(lease.expiresAt)) || Date.parse(lease.expiresAt) <= now || !binding.leaseExpiresAt || Date.parse(binding.leaseExpiresAt) <= now) throw new Error('LEASE_EXPIRED');
}
interface RegistryRecord { binding: WorkspaceBinding; lease?: RuntimeLease; pending?: { id: string; kind: 'start' | 'fence' }; completed: Record<string, { kind: 'start' | 'fence'; generation: number }> }
export interface StoredWorkspaceReceipt { digest: string; receipt: WorkspaceDurabilityReceipt; manifestKey: string }
export class WorkspaceRegistry {
  readonly storage: WorkspaceStorage; readonly provider: RuntimeProvider; readonly now: () => number; readonly leaseDurationMs: number;
  constructor(storage: WorkspaceStorage, provider: RuntimeProvider, now: () => number = Date.now, options: {leaseDurationMs?: number} = {}) { this.storage = storage; this.provider = provider; this.now = now; this.leaseDurationMs = options.leaseDurationMs ?? 60_000; if (!Number.isSafeInteger(this.leaseDurationMs) || this.leaseDurationMs < 1000 || this.leaseDurationMs > 300_000) throw new Error('INVALID_LEASE_DURATION'); }
  private key(owner: WorkspaceIdentity) { return `workspace/${ownerKey(owner)}`; }
  async initialize(actor: WorkspaceIdentity, binding: WorkspaceBinding): Promise<WorkspaceBinding> {
    assertOwner(actor, binding);
    if (binding.provider !== 'cloudflare') throw new Error('GCP_ALTERNATIVE_UNSELECTED');
    if (binding.generation !== 0 || binding.runtimeId !== null || binding.providerRuntimeId !== null || binding.recoveryPoint !== null || binding.lifecycleState !== 'unprovisioned') throw new Error('INVALID_INITIALIZATION');
    return this.storage.transaction(tx => {
      if (tx.get(this.key(binding))) throw new Error('WORKSPACE_ALREADY_INITIALIZED');
      tx.put(this.key(binding), { binding, completed: {} } satisfies RegistryRecord);
      return binding;
    });
  }
  async read(actor: WorkspaceIdentity, owner: WorkspaceIdentity): Promise<WorkspaceBinding> {
    assertOwner(actor, owner);
    return this.storage.transaction(tx => (this.record(tx, owner)).binding);
  }
  private record(tx: WorkspaceTransaction, owner: WorkspaceIdentity): RegistryRecord {
    const record = tx.get<RegistryRecord>(this.key(owner));
    if (!record) throw new Error('WORKSPACE_NOT_INITIALIZED');
    assertOwner(owner, record.binding);
    return record;
  }
  /** Start only a new identity or one with verified recovery. Persistent reservation survives process loss. */
  async ensure(actor: WorkspaceIdentity, owner: WorkspaceIdentity, operationId: string): Promise<WorkspaceBinding> {
    assertOwner(actor, owner); this.operationId(operationId);
    const prepared = await this.storage.transaction(tx => {
      const r = this.record(tx, owner);
      if (r.completed['op:' + operationId]) { if (r.completed['op:' + operationId].kind !== 'start') throw new Error('IDEMPOTENCY_CONFLICT'); return { done: r.binding }; }
      if (r.binding.lifecycleState === 'ready') return { done: r.binding };
      if (r.pending && (r.pending.id !== operationId || r.pending.kind !== 'start')) throw new Error('LIFECYCLE_OPERATION_PENDING');
      if (!r.pending) {
        if (!['unprovisioned','stopped'].includes(r.binding.lifecycleState)) throw new Error('FENCE_UNCONFIRMED');
        if (r.binding.generation > 0 && !r.binding.recoveryPoint) throw new Error('RECOVERY_POINT_REQUIRED');
        r.binding = { ...r.binding, lifecycleState: 'starting', generation: r.binding.generation + 1, revision: r.binding.revision + 1, leaseExpiresAt: null };
        r.pending = { id: operationId, kind: 'start' };
        tx.put(this.key(owner), r);
      }
      return { start: r.binding };
    });
    if (prepared.done) return prepared.done;
    const started = await this.provider.start(prepared.start!, operationId);
    if (!started.incarnation || !started.runtimeId || !started.providerRuntimeId) throw new Error('INVALID_PROVIDER_START');
    if (started.recoveredCheckpointId !== (prepared.start!.recoveryPoint?.checkpointId ?? null)) throw new Error('RESTORE_NOT_VERIFIED');
    return this.storage.transaction(tx => {
      const r = this.record(tx, owner);
      if (r.completed['op:' + operationId]) { if (r.completed['op:' + operationId].kind !== 'start') throw new Error('IDEMPOTENCY_CONFLICT'); return r.binding; }
      if (r.pending?.id !== operationId || r.pending.kind !== 'start' || r.binding.generation !== prepared.start!.generation) throw new Error('STALE_GENERATION');
      if (r.binding.incarnation && r.binding.incarnation === started.incarnation) throw new Error('INCARNATION_REUSED');
      r.binding = { ...r.binding, runtimeId: started.runtimeId, providerRuntimeId: started.providerRuntimeId, incarnation: started.incarnation, lifecycleState: 'ready', leaseExpiresAt: new Date(this.now() + this.leaseDurationMs).toISOString(), revision: r.binding.revision + 1, lastVerifiedAt: new Date(this.now()).toISOString() };
      r.lease = { environment: owner.environment, userId: owner.userId, workspaceId: owner.workspaceId, runtimeId: r.binding.runtimeId!, incarnation: r.binding.incarnation, generation: r.binding.generation, leaseId: crypto.randomUUID(), expiresAt: r.binding.leaseExpiresAt! };
      r.completed['op:' + operationId] = { kind: 'start', generation: r.binding.generation }; delete r.pending;
      tx.put(this.key(owner), r); return r.binding;
    });
  }
  async readLease(actor: WorkspaceIdentity, owner: WorkspaceIdentity): Promise<RuntimeLease> {
    assertOwner(actor, owner);
    return this.storage.transaction(tx => { const r = this.record(tx, owner); if (!r.lease || r.binding.lifecycleState !== 'ready') throw new Error('STALE_GENERATION'); return r.lease; });
  }
  /** Trusted lifecycle callback proves exact retained incarnation; no guest-supplied proof. */
  async reattachVerified(actor: WorkspaceIdentity, owner: WorkspaceIdentity, expectedRevision: number, verifyExact: (binding: WorkspaceBinding) => Promise<unknown>): Promise<WorkspaceBinding> {
    assertOwner(actor, owner);
    if (typeof verifyExact !== 'function') throw new Error('EXACT_INCARNATION_VERIFICATION_REQUIRED');
    const before = await this.read(actor, owner);
    if (before.revision !== expectedRevision || before.lifecycleState !== 'ready' || !before.runtimeId || !before.providerRuntimeId) throw new Error('REVISION_CONFLICT');
    await verifyExact(structuredClone(before));
    return this.storage.transaction(tx => {
      const r = this.record(tx, owner);
      if (r.binding.revision !== expectedRevision || r.binding.lifecycleState !== 'ready' || r.pending || r.binding.incarnation !== before.incarnation || r.binding.runtimeId !== before.runtimeId || r.binding.providerRuntimeId !== before.providerRuntimeId || r.binding.generation !== before.generation) throw new Error('REVISION_CONFLICT');
      if (r.lease && Date.parse(r.lease.expiresAt) > this.now()) return r.binding;
      const expiresAt = new Date(this.now() + this.leaseDurationMs).toISOString();
      r.binding = { ...r.binding, leaseExpiresAt: expiresAt, revision: r.binding.revision + 1, lastVerifiedAt: new Date(this.now()).toISOString() };
      r.lease = { environment: owner.environment, userId: owner.userId, workspaceId: owner.workspaceId, runtimeId: r.binding.runtimeId!, incarnation: r.binding.incarnation, generation: r.binding.generation, leaseId: crypto.randomUUID(), expiresAt };
      tx.put(this.key(owner), r); return r.binding;
    });
  }
  async heartbeat(actor: WorkspaceIdentity, lease: RuntimeLease): Promise<WorkspaceBinding> {
    assertOwner(actor, lease);
    return this.storage.transaction(tx => {
      const r = this.record(tx, lease); assertLease(r.binding, lease, this.now(), r.lease);
      r.binding = { ...r.binding, leaseExpiresAt: new Date(this.now() + this.leaseDurationMs).toISOString(), revision: r.binding.revision + 1 };
      r.lease = { ...r.lease!, expiresAt: r.binding.leaseExpiresAt! };
      tx.put(this.key(lease), r); return r.binding;
    });
  }
  /** Revokes before external provider call. Unknown stop remains fencing; retry same operation reconciles. */
  async fence(actor: WorkspaceIdentity, owner: WorkspaceIdentity, generation: number, operationId: string): Promise<WorkspaceBinding> {
    assertOwner(actor, owner); this.operationId(operationId);
    const previous = await this.storage.transaction(tx => {
      const r = this.record(tx, owner);
      if (r.completed['op:' + operationId]) { if (r.completed['op:' + operationId].kind !== 'fence' || r.completed['op:' + operationId].generation !== generation) throw new Error('IDEMPOTENCY_CONFLICT'); return { done: r.binding }; }
      if (r.binding.generation !== generation) throw new Error('STALE_GENERATION');
      if (r.pending && (r.pending.id !== operationId || r.pending.kind !== 'fence')) throw new Error('LIFECYCLE_OPERATION_PENDING');
      if (!r.binding.runtimeId || !r.binding.providerRuntimeId || !['ready','fencing'].includes(r.binding.lifecycleState)) throw new Error('INVALID_FENCE_STATE');
      delete r.lease;
      r.binding = { ...r.binding, lifecycleState: 'fencing', leaseExpiresAt: null, revision: r.binding.revision + 1 };
      r.pending = { id: operationId, kind: 'fence' }; tx.put(this.key(owner), r);
      return { binding: r.binding };
    });
    if (previous.done) return previous.done;
    const evidence = await this.provider.fence(previous.binding!, operationId);
    this.validateFence(previous.binding!, evidence);
    return this.storage.transaction(tx => {
      const r = this.record(tx, owner);
      if (r.completed['op:' + operationId]) { if (r.completed['op:' + operationId].kind !== 'fence' || r.completed['op:' + operationId].generation !== generation) throw new Error('IDEMPOTENCY_CONFLICT'); return r.binding; }
      if (r.pending?.id !== operationId || r.pending.kind !== 'fence' || r.binding.generation !== generation || r.binding.incarnation !== previous.binding!.incarnation) throw new Error('STALE_GENERATION');
      r.binding = { ...r.binding, lifecycleState: 'stopped', runtimeId: null, providerRuntimeId: null, revision: r.binding.revision + 1 };
      r.completed['op:' + operationId] = { kind: 'fence', generation }; delete r.pending;
      tx.put(`fence/${ownerKey(owner)}/${operationId}`, evidence);
      tx.put(this.key(owner), r); return r.binding;
    });
  }
  private validateFence(b: WorkspaceBinding, e: RuntimeFenceEvidence): void {
    assertOwner(e, b);
    if (e.provider !== b.provider || e.previousRuntimeId !== b.runtimeId || e.previousIncarnation !== b.incarnation || e.previousGeneration !== b.generation || e.browserRetired !== true || !e.providerRequestIds.length || !Number.isFinite(Date.parse(e.verifiedAt)) || Date.parse(e.verifiedAt) < Date.parse(b.lastVerifiedAt) || Date.parse(e.verifiedAt) > this.now()) throw new Error('FENCE_UNCONFIRMED');
    if (e.provider !== 'cloudflare' || e.providerRuntimeId !== b.providerRuntimeId || e.result !== 'exact_incarnation_stopped') throw new Error('FENCE_UNCONFIRMED');
  }
  async saved(actor: WorkspaceIdentity, owner: WorkspaceIdentity, writeId: string): Promise<StoredWorkspaceReceipt | undefined> {
    assertOwner(actor, owner); this.operationId(writeId);
    return this.storage.transaction(tx => tx.get(`receipt/${ownerKey(owner)}/${writeId}`));
  }
  /** Atomic registry CAS and receipt insertion; invoked only after object verification. */
  async commitRecovery(actor: WorkspaceIdentity, lease: RuntimeLease, expectedRevision: number, value: StoredWorkspaceReceipt): Promise<WorkspaceDurabilityReceipt> {
    assertOwner(actor, lease); assertOwner(lease, value.receipt); assertOwner(lease, value.receipt.recoveryPoint);
    this.operationId(value.receipt.writeId);
    return this.storage.transaction(tx => {
      const key = `receipt/${ownerKey(lease)}/${value.receipt.writeId}`;
      const existing = tx.get<StoredWorkspaceReceipt>(key);
      if (existing) { if (existing.digest !== value.digest) throw new Error('IDEMPOTENCY_CONFLICT'); return existing.receipt; }
      const r = this.record(tx, lease); assertLease(r.binding, lease, this.now(), r.lease);
      if (r.binding.revision !== expectedRevision) throw new Error('REVISION_CONFLICT');
      const point = value.receipt.recoveryPoint;
      if (point.sequence !== (r.binding.recoveryPoint?.sequence ?? 0) + 1 || point.sourceIncarnation !== lease.incarnation || point.sourceGeneration !== lease.generation || value.receipt.incarnation !== lease.incarnation || value.receipt.generation !== lease.generation) throw new Error('INVALID_RECOVERY_LINEAGE');
      r.binding = { ...r.binding, recoveryPoint: point, revision: r.binding.revision + 1 };
      tx.put(key, value); tx.put(this.key(lease), r); return value.receipt;
    });
  }
  private operationId(id: string) { if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('INVALID_OPERATION_ID'); }
}
