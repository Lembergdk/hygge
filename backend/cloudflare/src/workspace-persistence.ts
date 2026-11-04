import type { MutationContext, RuntimeLease, RuntimeOperation, WorkspaceIdentity } from './workspace-contract.ts';

export interface SqlCursor extends Iterable<Record<string, unknown>> {}
export interface WorkspaceStorage {
  sql: { exec(query: string, ...bindings: (string | number | null)[]): SqlCursor };
  transactionSync<T>(operation: () => T): T;
}
export class WorkspaceError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code=code; this.name = 'WorkspaceError'; }
}
export const fail = (code: string): never => { throw new WorkspaceError(code); };
export function ownerKey(owner: WorkspaceIdentity): string {
  if (!['staging', 'production'].includes(owner.environment) || !owner.userId || !owner.workspaceId) fail('OWNER_MISMATCH');
  return JSON.stringify([owner.environment, owner.userId, owner.workspaceId]);
}
export function sameOwner(a: WorkspaceIdentity, b: WorkspaceIdentity): boolean { return ownerKey(a) === ownerKey(b); }
export function revision(n: number): number { if (!Number.isSafeInteger(n) || n < 0) fail('INVALID_REVISION'); return n; }
export function nonempty(s: string): string { if (typeof s !== 'string' || !s.trim() || s.length > 4096) fail('INVALID_ID'); return s; }
/** Diagnostics contain schema keys/indices and types, never rejected values or user-defined keys. */
export class InvalidWorkspacePayload extends WorkspaceError {
  readonly path:string;readonly valueType:string;
  constructor(path:string,valueType:string){super('INVALID_PAYLOAD');this.path=path;this.valueType=valueType;}
}
const diagnosticKeys=new Set(['decision','snapshot','sessionID','action','target','targetLabel','targetSensitive','value','valueRef','reason','effect','preview','tier','model','questions','userMessage','skillDraft','taskId','runId','sequence','args','input','result']);
export function canonical(value: unknown): string {
  const ancestors=new Set<object>();
  function visit(item:unknown,path:string,depth:number):string {
    const invalid=(type:string):never=>{throw new InvalidWorkspacePayload(path,type);};
    if(depth>64)return invalid('depth');
    if(item===null||typeof item==='string'||typeof item==='boolean')return JSON.stringify(item);
    if(typeof item==='number')return Number.isFinite(item)?JSON.stringify(item):invalid('non-finite-number');
    if(typeof item!=='object')return invalid(typeof item);
    if(ancestors.has(item))return invalid('cycle');
    if(!Array.isArray(item)&&Object.getPrototypeOf(item)!==Object.prototype&&Object.getPrototypeOf(item)!==null)return invalid('non-json-object');
    ancestors.add(item);
    try{
      if(Array.isArray(item))return '['+Array.from({length:item.length},(_,i)=>visit(item[i],`${path}[${i}]`,depth+1)).join(',')+']';
      return '{'+Object.keys(item).sort().map((key,i)=>JSON.stringify(key)+':'+visit((item as Record<string,unknown>)[key],diagnosticKeys.has(key)?`${path}.${key}`:`${path}[property:${i}]`,depth+1)).join(',')+'}';
    }finally{ancestors.delete(item);}
  }
  return visit(value,'$',0);
}
export async function digest(value: unknown): Promise<string> {
  const data = new TextEncoder().encode(canonical(value));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), b => b.toString(16).padStart(2, '0')).join('');
}
export interface RuntimeAuthority {
  authorize(token: string, operation: RuntimeOperation, taskId?: string): Promise<RuntimeLease>;
  /** Must read current trusted registry synchronously inside the DO transaction. */
  assertCurrent(lease: RuntimeLease): void;
}
export interface Saved<T> { revision: number; value: T }
/** Owner-private SQLite adapter. Async external work must finish before atomic(). */
export class WorkspacePersistence {
  readonly scope: string;
  readonly storage: WorkspaceStorage; readonly owner: WorkspaceIdentity;
  constructor(storage: WorkspaceStorage, owner: WorkspaceIdentity) {
    this.storage=storage; this.owner=owner;
    this.scope = ownerKey(owner);
    storage.transactionSync(() => {
      storage.sql.exec('CREATE TABLE IF NOT EXISTS hygge_workspace_records (scope TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(scope, kind, id))');
      storage.sql.exec('CREATE TABLE IF NOT EXISTS hygge_workspace_requests (scope TEXT NOT NULL, operation TEXT NOT NULL, request_id TEXT NOT NULL, digest TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(scope, operation, request_id))');
    });
  }
  get<T>(kind: string, id: string): Saved<T> | null {
    const row = [...this.storage.sql.exec('SELECT revision, payload FROM hygge_workspace_records WHERE scope = ? AND kind = ? AND id = ?', this.scope, kind, id)][0];
    return row ? { revision: Number(row.revision), value: JSON.parse(String(row.payload)) } : null;
  }
  list<T>(kind: string): Saved<T>[] {
    return [...this.storage.sql.exec('SELECT revision, payload FROM hygge_workspace_records WHERE scope = ? AND kind = ?', this.scope, kind)]
      .map(row => ({ revision: Number(row.revision), value: JSON.parse(String(row.payload)) }));
  }
  put<T>(kind: string, id: string, expected: number, value: T): number {
    revision(expected);
    const prior = this.get<T>(kind, id);
    if ((prior?.revision ?? 0) !== expected) fail('REVISION_CONFLICT');
    const next = expected + 1;
    this.storage.sql.exec('INSERT INTO hygge_workspace_records (scope, kind, id, revision, payload) VALUES (?, ?, ?, ?, ?) ON CONFLICT(scope, kind, id) DO UPDATE SET revision=excluded.revision, payload=excluded.payload', this.scope, kind, id, next, canonical(value));
    return next;
  }
  /** Called inside the trusted DO execution boundary; record result with its mutation. */
  atomic<T>(operation: string, requestId: string, payloadDigest: string, action: () => T): T {
    nonempty(requestId);
    return this.storage.transactionSync(() => {
      const old = [...this.storage.sql.exec('SELECT digest, result FROM hygge_workspace_requests WHERE scope = ? AND operation = ? AND request_id = ?', this.scope, operation, requestId)][0];
      if (old) {
        if (old.digest !== payloadDigest) fail('IDEMPOTENCY_CONFLICT');
        return JSON.parse(String(old.result));
      }
      const result = action();
      this.storage.sql.exec('INSERT INTO hygge_workspace_requests (scope, operation, request_id, digest, result) VALUES (?, ?, ?, ?, ?)', this.scope, operation, requestId, payloadDigest, canonical(result));
      return result;
    });
  }
  /** Authenticated historical result read; never invokes current external proof dependencies. */
  async authorizedReplay<T>(authority: RuntimeAuthority, operation: RuntimeOperation, taskId: string, context: MutationContext, payload: unknown): Promise<{ found: false } | { found: true; result: T }> {
    revision(context.expectedRevision); nonempty(context.requestId);
    const hash = await digest({ expectedRevision: context.expectedRevision, payload });
    const lease = await authority.authorize(context.capabilityToken, operation, taskId);
    if (!sameOwner(this.owner, lease)) fail('OWNER_MISMATCH');
    return this.storage.transactionSync(() => {
      authority.assertCurrent(lease);
      const old = [...this.storage.sql.exec('SELECT digest, result FROM hygge_workspace_requests WHERE scope = ? AND operation = ? AND request_id = ?', this.scope, operation, context.requestId)][0];
      if (!old) return { found: false };
      if (old.digest !== hash) return fail('IDEMPOTENCY_CONFLICT');
      return { found: true, result: JSON.parse(String(old.result)) as T };
    });
  }
  async authorized<T>(authority: RuntimeAuthority, operation: RuntimeOperation, taskId: string, context: MutationContext, payload: unknown, action: (lease: RuntimeLease) => T): Promise<T> {
    revision(context.expectedRevision);
    const hash = await digest({ expectedRevision: context.expectedRevision, payload });
    const lease = await authority.authorize(context.capabilityToken, operation, taskId);
    if (!sameOwner(this.owner, lease)) fail('OWNER_MISMATCH');
    return this.storage.transactionSync(() => {
      authority.assertCurrent(lease);
      return this.atomic(operation, context.requestId, hash, () => action(lease));
    });
  }
}

/** readCurrentLeaseSync MUST read the authoritative registry in this same DO SQLite transaction. */
export function runtimeAuthority(
  authorize: RuntimeAuthority['authorize'],
  readCurrentLeaseSync: (owner: WorkspaceIdentity) => RuntimeLease | null,
  now: () => number = Date.now,
): RuntimeAuthority {
  return { authorize, assertCurrent(lease) {
    const resolved=readCurrentLeaseSync(lease);
    if(!resolved) return fail('STALE_GENERATION');
    const current=resolved;
    if( !sameOwner(current,lease) || current.runtimeId!==lease.runtimeId || current.incarnation!==lease.incarnation || current.generation!==lease.generation || current.leaseId!==lease.leaseId) fail('STALE_GENERATION');
    if(!Number.isFinite(Date.parse(current.expiresAt)) || Date.parse(current.expiresAt)<=now() || !Number.isFinite(Date.parse(lease.expiresAt)) || Date.parse(lease.expiresAt)<=now()) fail('LEASE_EXPIRED');
  }};
}
