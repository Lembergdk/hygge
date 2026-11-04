import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {artifactStore,MAX_ARTIFACT_BYTES} from '../artifacts.mjs';
const CHUNK=256*1024;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'hygge-artifact-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const index={};let revision=0;const store=await artifactStore(root,index,()=>revision++,CHUNK);return{root,index,store,revision:()=>revision};}
async function put(store,ref,bytes){const manifest={ref,size:bytes.length,sha256:hash(bytes)};const begin=await store.begin(manifest);if(!begin.committed){for(let offset=0;offset<bytes.length;offset+=CHUNK)await store.chunk({uploadId:begin.uploadId,offset},bytes.subarray(offset,offset+CHUNK));}return{manifest,uploadId:begin.uploadId,result:await store.commit({...manifest,uploadId:begin.uploadId})};}
test('complete artifacts span chunk boundaries, observed screenshot size, and Unicode working files',async t=>{
 const f=await fixture(t);
 for(const size of [0,CHUNK-1,CHUNK,CHUNK+1,578754,3*1024*1024]){const bytes=Buffer.alloc(size,87),ref=`evidence_${size}`;await put(f.store,ref,bytes);assert.deepEqual(await fs.readFile(path.join(f.root,'artifacts',ref)),bytes);assert.equal(f.index[ref],`artifacts/${ref}`);}
 const unicode=Buffer.from('世'.repeat(100000));assert.ok(unicode.length>CHUNK);await put(f.store,'file_'+'a'.repeat(32)+'_1',unicode);
 const changes=f.revision();await put(f.store,'evidence_578754',Buffer.alloc(578754,87));assert.equal(f.revision(),changes,'lost commit acknowledgement is idempotent');
 await assert.rejects(put(f.store,'evidence_578754',Buffer.alloc(578754,88)),/CONFLICT/);
 await assert.rejects(f.store.begin({ref:'too_large',size:MAX_ARTIFACT_BYTES+1,sha256:hash('')}),/MANIFEST/);
});
test('partial, conflicting, reordered or corrupt writes never publish evidence',async t=>{
 const f=await fixture(t),bytes=Buffer.from('abcdef'),manifest={ref:'evidence',size:bytes.length,sha256:hash(bytes)};
 const {uploadId}=await f.store.begin(manifest);
 await assert.rejects(f.store.chunk({uploadId,offset:2},bytes.subarray(2)),/ORDER/);
 await f.store.chunk({uploadId,offset:0},bytes.subarray(0,3));await f.store.chunk({uploadId,offset:0},bytes.subarray(0,3));
 await assert.rejects(f.store.chunk({uploadId,offset:0},Buffer.from('xyz')),/CONFLICT/);
 await assert.rejects(f.store.commit({...manifest,uploadId}),/INCOMPLETE/);
 assert.equal(f.index.evidence,undefined);await assert.rejects(fs.stat(path.join(f.root,'artifacts','evidence')),/ENOENT/);
 await f.store.chunk({uploadId,offset:3},Buffer.from('xyz'));await assert.rejects(f.store.commit({...manifest,uploadId}),/INTEGRITY/);
 await f.store.abort({uploadId});assert.equal(f.store.active,0);
});
test('restart removes partial transfers and recovers publication before an indexing crash',async t=>{
 const f=await fixture(t),bytes=Buffer.from('committed');
 const {manifest,uploadId}=await put(f.store,'evidence',bytes);
 const partial=await f.store.begin({ref:'interrupted',size:10,sha256:hash('1234567890')});await f.store.chunk({uploadId:partial.uploadId,offset:0},Buffer.from('123'));
 const newIndex={},restarted=await artifactStore(f.root,newIndex,()=>{},CHUNK);
 assert.deepEqual(await fs.readdir(path.join(f.root,'.artifact-transfers')),[]);
 assert.equal((await restarted.commit({...manifest,uploadId})).committed,true);assert.equal(newIndex.evidence,'artifacts/evidence');
 assert.equal(newIndex.interrupted,undefined);
});
test('document deletion is content-guarded and cannot erase evidence',async t=>{
 const f=await fixture(t),bytes=Buffer.from('private note'),ref='file_'+'a'.repeat(32)+'_1';await put(f.store,ref,bytes);await put(f.store,'evidence',bytes);
 await assert.rejects(f.store.removeDocument({ref:'evidence',sha256:hash(bytes)}),/INVALID_DOCUMENT/);
 await assert.rejects(f.store.removeDocument({ref,sha256:hash('other')}),/VERSION_CONFLICT/);
 await f.store.removeDocument({ref,sha256:hash(bytes)});await f.store.removeDocument({ref,sha256:hash(bytes)});assert.equal(f.index[ref],undefined);assert.ok(f.index.evidence);
});
test('artifact publication refuses links and traversal',async t=>{
 const f=await fixture(t),bytes=Buffer.from('x');await fs.symlink('../.owner.json',path.join(f.root,'artifacts','linked'));
 await assert.rejects(put(f.store,'linked',bytes),/UNSAFE/);await assert.rejects(put(f.store,'../escape',bytes),/INVALID_ARTIFACT/);
});
