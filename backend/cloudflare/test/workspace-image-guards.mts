import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceRegistry} from '../src/workspace-runtime.ts';
import {WorkspaceCaptureService} from '../src/workspace-capture.ts';
import {A,B,NOW,binding,MemoryTransactions,FakeProvider} from './fixtures/workspace-foundation.ts';
import {structuredWorkspaceHash} from '../src/workspace-image-verification.ts';
import {sqliteWorkspace} from './helpers/workspace-sqlite.mts';
const OLD='registry.cloudflare.com/account/image@sha256:'+'a'.repeat(64),NEW=OLD.replace(/a{64}$/,'b'.repeat(64));
async function fixture(){
 const storage=new MemoryTransactions(),provider=new FakeProvider(),registry=new WorkspaceRegistry(storage,provider,()=>NOW);
 await registry.initialize(A,{...binding(),desiredImageDigest:OLD});const ready=await registry.ensure(A,A,'initial');
 const objects={data:new Map<string,Uint8Array>(),async putImmutable(k:string,b:Uint8Array){this.data.set(k,b.slice());},async get(k:string){return this.data.get(k)?.slice()??null;}};
 const service=new WorkspaceCaptureService(registry,objects,{capture:async(l,q)=>({snapshot:{incarnation:l.incarnation,generation:l.generation,filesystemRevision:q.filesystemRevision,browserProfileRevision:0,browserState:'absent',files:[{path:'note',bytes:new TextEncoder().encode('private')}],directories:[],symlinks:[],artifacts:{note:'note'}},release:async()=>{}})},()=>NOW);
 const receipt=await service.commit(A,await registry.readLease(A,A),{writeId:'source',expectedRegistryRevision:ready.revision,filesystemRevision:1,browserProfileRevision:0,artifactRefs:['note']});
 const proof=async()=>({receipt:await service.verifyReceipt(A,A,receipt.receiptId),imageDigest:OLD});
 return {registry,provider,objects,service,receipt,proof};
}
test('image selection requires stopped verified current checkpoint and exact owner',async()=>{
 const f=await fixture();const ready=await f.registry.read(A,A);
 await assert.rejects(f.registry.selectImage(A,A,'select',ready.revision,NEW,f.proof),/FENCED_CHECKPOINT/);
 const stopped=await f.registry.fence(A,A,ready.generation,'stop');
 await assert.rejects(f.registry.selectImage(B,A,'select',stopped.revision,NEW,f.proof),/OWNER_MISMATCH/);
 await assert.rejects(f.registry.selectImage(A,A,'select',stopped.revision,NEW,async()=>({...await f.proof(),imageDigest:NEW})),/UNVERIFIED/);
 const blob=[...f.objects.data.keys()].find(k=>k.includes('/blobs/'))!;f.objects.data.delete(blob);
 await assert.rejects(f.registry.selectImage(A,A,'select',stopped.revision,NEW,f.proof),/VERIFICATION_FAILED/);
 assert.equal((await f.registry.read(A,A)).desiredImageDigest,OLD);assert.equal(f.provider.starts,1);
});
test('compatible restore grant binds owner, checkpoint, source and target; replay cannot select another image',async()=>{
 const f=await fixture(),before=await f.registry.read(A,A),stopped=await f.registry.fence(A,A,before.generation,'stop');
 await f.registry.selectImage(A,A,'select',stopped.revision,NEW,f.proof);const current=await f.registry.ensure(A,A,'replacement');
 await f.registry.assertCompatibleRestore(A,current,OLD);
 await assert.rejects(f.registry.assertCompatibleRestore(B,current,OLD),/OWNER_MISMATCH/);
 await assert.rejects(f.registry.assertCompatibleRestore(A,current,NEW),/MISMATCH/);
 await assert.rejects(f.registry.assertCompatibleRestore(A,{...current,recoveryPoint:{...current.recoveryPoint!,checkpointId:'wrong'}},OLD),/MISMATCH/);
 await assert.rejects(f.registry.selectImage(A,A,'select',stopped.revision,OLD,f.proof),/IDEMPOTENCY_CONFLICT/);
 assert.equal((await f.registry.selectImage(A,A,'select',stopped.revision,NEW,f.proof)).incarnation,current.incarnation);
 await f.service.verifyReceipt(A,A,f.receipt.receiptId);
});
test('structured verification includes notes, approvals and effects while excluding lifecycle journals',async()=>{
 const {storage}=sqliteWorkspace();storage.sql.exec('CREATE TABLE workspace_registry (id TEXT,value TEXT)');storage.sql.exec('CREATE TABLE notes (id TEXT,value TEXT)');storage.sql.exec('CREATE TABLE hygge_workspace_records (scope TEXT,kind TEXT,id TEXT,value TEXT)');
 storage.sql.exec("INSERT INTO notes VALUES ('private','keep')");const before=await structuredWorkspaceHash(storage);
 storage.sql.exec("INSERT INTO workspace_registry VALUES ('owner','new generation')");storage.sql.exec("INSERT INTO hygge_workspace_records VALUES ('owner','image_capture_request','op','capture')");assert.equal(await structuredWorkspaceHash(storage),before);
 storage.sql.exec("INSERT INTO hygge_workspace_records VALUES ('owner','effect','pending','uncertain')");const effect=await structuredWorkspaceHash(storage);assert.notEqual(effect,before);
 storage.sql.exec("UPDATE notes SET value='lost'");assert.notEqual(await structuredWorkspaceHash(storage),effect);
});
