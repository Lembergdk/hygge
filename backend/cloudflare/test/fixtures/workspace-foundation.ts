import type { WorkspaceIdentity, WorkspaceBinding, RuntimeLease, RuntimeFenceEvidence } from '../../src/workspace-contract.ts';
import type { WorkspaceStorage, WorkspaceTransaction, RuntimeProvider } from '../../src/workspace-runtime.ts';
export const A: WorkspaceIdentity = { environment:'staging', userId:'alice', workspaceId:'ws-a' };
export const B: WorkspaceIdentity = { environment:'staging', userId:'bob', workspaceId:'ws-b' };
export const NOW = Date.parse('2026-11-03T12:00:00Z');
export function binding(owner=A): WorkspaceBinding { return { ...owner, provider:'cloudflare', namespaceId:'hygge-staging', providerWorkspaceId:owner.workspaceId,
 ownerDigest:'private-owner-marker', schemaVersion:1, incarnation:'', generation:0, runtimeId:null, providerRuntimeId:null,
 desiredImageDigest:'sha256:image', leaseExpiresAt:null, lifecycleState:'unprovisioned', revision:0, recoveryPoint:null, lastVerifiedAt:new Date(NOW).toISOString() }; }
export function lease(b:WorkspaceBinding):RuntimeLease { return { environment:b.environment,userId:b.userId,workspaceId:b.workspaceId,runtimeId:b.runtimeId!,incarnation:b.incarnation,generation:b.generation,leaseId:'lease',expiresAt:b.leaseExpiresAt! }; }
export class MemoryTransactions implements WorkspaceStorage {
 data = new Map<string,unknown>(); private queue:Promise<unknown> = Promise.resolve();
 async transaction<T>(fn:(tx:WorkspaceTransaction)=>T):Promise<T> {
   const run=this.queue.then(()=> { const next=structuredClone(this.data); const result=fn({get:<T>(k:string)=>structuredClone(next.get(k)) as T|undefined,put:(k,v)=>{ next.set(k,structuredClone(v)); }}); this.data=next; return result; });
   this.queue=run.catch(()=>{}); return run;
 }
}
export class FakeProvider implements RuntimeProvider {
 starts=0; stopUnknown=false; badIncarnation=false;
 private results=new Map<string,{runtimeId:string;providerRuntimeId:string;incarnation:string;recoveredCheckpointId:string|null}>();
 async start(b:WorkspaceBinding,id:string){const key=`${b.userId}:${id}`;if(!this.results.has(key)){this.starts++;this.results.set(key,{runtimeId:`r-${b.userId}-${this.starts}`,providerRuntimeId:`p-${b.userId}-${this.starts}`,incarnation:`i-${b.userId}-${this.starts}`,recoveredCheckpointId:b.recoveryPoint?.checkpointId??null});}return this.results.get(key)!;}
 async fence(b:WorkspaceBinding):Promise<RuntimeFenceEvidence> {if(this.stopUnknown) throw Error('STOP_UNKNOWN'); return {...b,provider:'cloudflare', previousRuntimeId:b.runtimeId!,previousIncarnation:this.badIncarnation?'stale':b.incarnation,previousGeneration:b.generation,browserRetired:true,verifiedAt:new Date(NOW).toISOString(),providerRequestIds:['provider-proof'],providerRuntimeId:b.providerRuntimeId!,result:'exact_incarnation_stopped'};}
}
