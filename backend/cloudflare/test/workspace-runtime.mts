import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceRegistry, UnsupportedRuntimeProvider, durableObjectWorkspaceStorage } from '../src/workspace-runtime.ts';
import { A,B,NOW,binding,lease,MemoryTransactions,FakeProvider } from './fixtures/workspace-foundation.ts';
const setup=async()=>{const storage=new MemoryTransactions(),provider=new FakeProvider(),registry=new WorkspaceRegistry(storage,provider,()=>NOW);await registry.initialize(A,binding());return {storage,provider,registry};};
test('owner boundary rejects cross-user registry reads and lifecycle before provider calls',async()=>{
 const {registry,provider}=await setup();await assert.rejects(registry.read(B,A),/OWNER_MISMATCH/);await assert.rejects(registry.ensure(B,A,'start'),/OWNER_MISMATCH/);assert.equal(provider.starts,0);
 await registry.initialize(B,binding(B));const a=await registry.ensure(A,A,'start'),b=await registry.ensure(B,B,'start');assert.notEqual(a.incarnation,b.incarnation);assert.notEqual(a.providerRuntimeId,b.providerRuntimeId);
});
test('single lifecycle reservation persists through provider uncertainty and blocks other start',async()=>{
 const {registry,provider}=await setup();const a=await registry.ensure(A,A,'start');const originalLease=await registry.readLease(A,A);provider.stopUnknown=true;
 await assert.rejects(registry.fence(A,A,a.generation,'stop'),/STOP_UNKNOWN/);
 assert.equal((await registry.read(A,A)).lifecycleState,'fencing');await assert.rejects(registry.heartbeat(A,originalLease),/STALE_GENERATION|STALE_LEASE/);
 await assert.rejects(registry.ensure(A,A,'replacement'),/PENDING/);provider.stopUnknown=false;
 const stopped=await registry.fence(A,A,a.generation,'stop');assert.equal(stopped.lifecycleState,'stopped');
 await assert.rejects(registry.ensure(A,A,'replacement'),/RECOVERY_POINT_REQUIRED/);
});
test('wrong exact incarnation cannot establish stop evidence',async()=>{
 const {registry,provider}=await setup();const b=await registry.ensure(A,A,'start');provider.badIncarnation=true;
 await assert.rejects(registry.fence(A,A,b.generation,'stop'),/FENCE_UNCONFIRMED/);assert.equal((await registry.read(A,A)).lifecycleState,'fencing');
});
test('expired leases cannot renew; duplicate initialization cannot reset persisted state',async()=>{
 const {storage,provider,registry}=await setup();const b=await registry.ensure(A,A,'start');const originalLease=await registry.readLease(A,A);
 const later=new WorkspaceRegistry(storage,provider,()=>NOW+120_000);await assert.rejects(later.heartbeat(A,originalLease),/LEASE_EXPIRED/);
 await assert.rejects(registry.initialize(A,binding()),/ALREADY_INITIALIZED/);assert.equal((await registry.read(A,A)).generation,1);
});
test('concurrent ensure is provider-idempotent and conflicting operation cannot race',async()=>{
 const {registry,provider}=await setup();const result=await Promise.all([registry.ensure(A,A,'same'),registry.ensure(A,A,'same')]);assert.equal(result[0].incarnation,result[1].incarnation);assert.equal(provider.starts,1);
});
test('unsupported provider stays closed and never claims a runtime',async()=>{
 const r=new WorkspaceRegistry(new MemoryTransactions(),new UnsupportedRuntimeProvider(),()=>NOW);await r.initialize(A,binding());await assert.rejects(r.ensure(A,A,'start'),/FEASIBILITY_REQUIRED/);assert.equal((await r.read(A,A)).lifecycleState,'starting');
});
test('real DO SQL adapter exposes authoritative synchronous lease reads',async()=>{
 const {DatabaseSync}=await import('node:sqlite'); const db=new DatabaseSync(':memory:');
 const persistence={sql:{exec:(query:string,...args:any[])=>db.prepare(query).all(...args)},transactionSync<T>(fn:()=>T):T{db.exec('BEGIN');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}};
 const store=durableObjectWorkspaceStorage(persistence as any);const registry=new WorkspaceRegistry(store,new FakeProvider(),()=>NOW);await registry.initialize(A,binding());await registry.ensure(A,A,'start');
 const current=await registry.readLease(A,A);assert.equal(store.readCurrentLease(A).leaseId,current.leaseId);await assert.rejects(registry.heartbeat(A,{...current,leaseId:'forged'}),/STALE_LEASE/);
 await registry.fence(A,A,current.generation,'stop');assert.throws(()=>store.readCurrentLease(A),/STALE_GENERATION/);
});
test('operation IDs matching JS prototype names remain ordinary idempotency keys',async()=>{const {registry,provider}=await setup();const b=await registry.ensure(A,A,'__proto__');assert.equal(b.lifecycleState,'ready');assert.equal(provider.starts,1);});

test('old ensure operation replay returns current stopped binding, never historic readiness',async()=>{const {registry}=await setup();const b=await registry.ensure(A,A,'start');await registry.fence(A,A,b.generation,'stop');assert.equal((await registry.ensure(A,A,'start')).lifecycleState,'stopped');});
test('lifecycle operation IDs cannot be reused for another action',async()=>{const {registry}=await setup();const b=await registry.ensure(A,A,'operation');await assert.rejects(registry.fence(A,A,b.generation,'operation'),/IDEMPOTENCY_CONFLICT/);assert.equal((await registry.read(A,A)).lifecycleState,'ready');});
test('idle exact retained reattach rotates expired lease without new runtime or generation',async()=>{const {registry,storage,provider}=await setup();const ready=await registry.ensure(A,A,'start'),old=await registry.readLease(A,A);const later=new WorkspaceRegistry(storage,provider,()=>NOW+120_000,{leaseDurationMs:300_000});let proved=false;const current=await later.reattachVerified(A,A,ready.revision,async b=>{assert.equal(b.incarnation,ready.incarnation);proved=true;});const live=await later.readLease(A,A);assert.equal(proved,true);assert.notEqual(live.leaseId,old.leaseId);assert.equal(live.generation,old.generation);assert.equal(live.incarnation,old.incarnation);assert.equal(Date.parse(live.expiresAt),NOW+420_000);assert.equal(provider.starts,1);await assert.rejects(later.heartbeat(A,old),/STALE_LEASE/);});
test('idle reattach rejects stale revision and unknown provider without lease resurrection',async()=>{const {registry,storage,provider}=await setup();const ready=await registry.ensure(A,A,'start'),old=await registry.readLease(A,A);const later=new WorkspaceRegistry(storage,provider,()=>NOW+120_000);await assert.rejects(later.reattachVerified(A,A,ready.revision,async()=>{throw Error('PROVIDER_UNAVAILABLE');}),/PROVIDER_UNAVAILABLE/);assert.equal((await later.readLease(A,A)).leaseId,old.leaseId);await assert.rejects(later.reattachVerified(A,A,ready.revision-1,async()=>{}),/REVISION_CONFLICT/);await assert.rejects(later.reattachVerified(A,A,ready.revision,async()=>{await registry.fence(A,A,ready.generation,'stop-during-proof');}),/REVISION_CONFLICT/);});
