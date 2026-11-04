import fs from 'node:fs/promises';
import {createReadStream,constants} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

export const ARTIFACT_PROTOCOL_VERSION = 1;
export const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const refPattern = /^[A-Za-z0-9_-]{1,128}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const hashBytes = bytes => createHash('sha256').update(bytes).digest('hex');
async function fileHash(file) {
 const hash = createHash('sha256');
 for await (const bytes of createReadStream(file)) hash.update(bytes);
 return hash.digest('hex');
}
async function directory(file) {
 await fs.mkdir(file, {recursive:true,mode:0o700});
 const info=await fs.lstat(file);
 if(!info.isDirectory()||info.isSymbolicLink())throw Error('UNSAFE_ARTIFACT_DIRECTORY');
}

/** Called only inside the server's authenticated, lease-checked serial RPC queue. */
export async function artifactStore(root, artifacts, changed, chunkBytes, now=Date.now) {
 const folder=path.join(root,'artifacts'),temporary=path.join(root,'.artifact-transfers');
 await directory(folder);await directory(temporary);
 // Incomplete uploads are never capture candidates. Restart discards only this reserved staging area.
 for(const name of await fs.readdir(temporary)) {
  if(/^[a-f0-9]{64}\.part$/.test(name))await fs.unlink(path.join(temporary,name));
 }
 const uploads=new Map(),tombstones=Object.create(null),tombstoneFile=path.join(root,'.artifact-tombstones.json');
 try{
  const info=await fs.lstat(tombstoneFile);if(!info.isFile()||info.isSymbolicLink())throw Error('INVALID_DOCUMENT_TOMBSTONES');
  const saved=JSON.parse(await fs.readFile(tombstoneFile,'utf8'));
  for(const [prefix,revision] of Object.entries(saved)){
   if(!/^file_[a-f0-9]{32}_$/.test(prefix)||!Number.isSafeInteger(revision)||revision<1)throw Error('INVALID_DOCUMENT_TOMBSTONES');
   tombstones[prefix]=revision;
  }
 }catch(e){if(e.code!=='ENOENT')throw e;}
 function assertNotDeleted(ref){const match=/^(file_[a-f0-9]{32}_)([1-9][0-9]*)$/.exec(ref);if(match&&Number(match[2])<=(tombstones[match[1]]??0))throw Error('DOCUMENT_REVISION_DELETED');}
 async function saveTombstones(){
  const temp=path.join(temporary,'tombstones.part');
  const handle=await fs.open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_TRUNC|constants.O_NOFOLLOW,0o600);
  try{await handle.writeFile(JSON.stringify(tombstones));await handle.sync();}finally{await handle.close();}
  await fs.rename(temp,tombstoneFile);
  const dir=await fs.open(root,'r');try{await dir.sync();}finally{await dir.close();}
 }

 const target=ref=>{if(!refPattern.test(ref))throw Error('INVALID_ARTIFACT');return path.join(folder,ref);};
 async function existing(ref,size,hash) {
  const file=target(ref);let info;
  try{info=await fs.lstat(file);}catch(e){if(e.code==='ENOENT')return false;throw e;}
  if(!info.isFile()||info.isSymbolicLink())throw Error('UNSAFE_ARTIFACT');
  if(info.size!==size||await fileHash(file)!==hash)throw Error('ARTIFACT_IDEMPOTENCY_CONFLICT');
  // A process can stop after atomic publication but before indexing the committed file.
  if(artifacts[ref]!==`artifacts/${ref}`){artifacts[ref]=`artifacts/${ref}`;changed();}
  return true;
 }
 async function expire(){
  for(const [id,upload] of uploads)if(now()-upload.touched>300_000){await fs.unlink(upload.file);uploads.delete(id);}
 }
 const api={
  expire,
  async begin({ref,size,sha256}) {
   await expire();target(ref);assertNotDeleted(ref);
   if(!Number.isSafeInteger(size)||size<0||size>MAX_ARTIFACT_BYTES||!hashPattern.test(sha256))throw Error('INVALID_ARTIFACT_MANIFEST');
   const uploadId=hashBytes(`${ref}\0${size}\0${sha256}`);
   if(await existing(ref,size,sha256))return{uploadId,committed:true,received:size};
   const prior=uploads.get(uploadId);if(prior)return{uploadId,committed:false,received:prior.received};
   if(uploads.size>=4)throw Error('ARTIFACT_TRANSFER_LIMIT');
   if([...uploads.values()].some(u=>u.ref===ref))throw Error('ARTIFACT_IDEMPOTENCY_CONFLICT');
   const file=path.join(temporary,`${uploadId}.part`);
   const handle=await fs.open(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);await handle.close();
   uploads.set(uploadId,{ref,size,sha256,file,received:0,touched:now()});
   return{uploadId,committed:false,received:0};
  },
  async chunk({uploadId,offset},bytes) {
   const upload=uploads.get(uploadId);if(!upload)throw Error('ARTIFACT_TRANSFER_NOT_FOUND');
   if(!Number.isSafeInteger(offset)||offset<0||!bytes.length||bytes.length>chunkBytes||offset+bytes.length>upload.size)throw Error('INVALID_ARTIFACT_CHUNK');
   upload.touched=now();
   const handle=await fs.open(upload.file,constants.O_RDWR|constants.O_NOFOLLOW);
   try{
    if(offset<upload.received){
     if(offset+bytes.length>upload.received)throw Error('ARTIFACT_CHUNK_CONFLICT');
     const prior=Buffer.alloc(bytes.length);const read=await handle.read(prior,0,prior.length,offset);
     if(read.bytesRead!==bytes.length||!prior.equals(Buffer.from(bytes)))throw Error('ARTIFACT_CHUNK_CONFLICT');
     return{received:upload.received};
    }
    if(offset!==upload.received)throw Error('ARTIFACT_CHUNK_ORDER');
    let written=0;while(written<bytes.length){const result=await handle.write(bytes,written,bytes.length-written,offset+written);if(!result.bytesWritten)throw Error('ARTIFACT_WRITE_FAILED');written+=result.bytesWritten;}
    upload.received+=bytes.length;return{received:upload.received};
   }finally{await handle.close();}
  },
  async commit({uploadId,ref,size,sha256}) {
   assertNotDeleted(ref);
   if(!hashPattern.test(uploadId)||uploadId!==hashBytes(`${ref}\0${size}\0${sha256}`))throw Error('INVALID_ARTIFACT_MANIFEST');
   const upload=uploads.get(uploadId);
   if(!upload){if(await existing(ref,size,sha256))return{committed:true,sha256,size};throw Error('ARTIFACT_TRANSFER_NOT_FOUND');}
   if(upload.ref!==ref||upload.size!==size||upload.sha256!==sha256)throw Error('ARTIFACT_IDEMPOTENCY_CONFLICT');
   if(upload.received!==size)throw Error('ARTIFACT_TRANSFER_INCOMPLETE');
   if(await fileHash(upload.file)!==sha256)throw Error('ARTIFACT_INTEGRITY');
   const handle=await fs.open(upload.file,'r');try{await handle.sync();}finally{await handle.close();}
   // link is an atomic no-overwrite publication; a lost acknowledgement can safely retry.
   try{await fs.link(upload.file,target(ref));}catch(e){if(e.code!=='EEXIST')throw e;await existing(ref,size,sha256);}
   const published=await fs.open(folder,'r');try{await published.sync();}finally{await published.close();}
   await fs.unlink(upload.file);uploads.delete(uploadId);
   artifacts[ref]=`artifacts/${ref}`;changed();
   return{committed:true,sha256,size};
  },
  async abort({uploadId}) {const u=uploads.get(uploadId);if(u){await fs.unlink(u.file);uploads.delete(uploadId);}return{};},
  async deleteDocuments({prefix,throughRevision}) {
   if(!/^file_[a-f0-9]{32}_$/.test(prefix)||!Number.isSafeInteger(throughRevision)||throughRevision<1)throw Error('INVALID_DOCUMENT_ARTIFACT');
   tombstones[prefix]=Math.max(tombstones[prefix]??0,throughRevision);
   await saveTombstones();changed();
   for(const [id,u] of uploads)if(u.ref.startsWith(prefix)&&Number(u.ref.slice(prefix.length))<=tombstones[prefix])await api.abort({uploadId:id});
   // Directory enumeration also covers a process stop after publication but before index update.
   for(const ref of await fs.readdir(folder))if(new RegExp('^'+prefix+'[1-9][0-9]*$').test(ref)&&Number(ref.slice(prefix.length))<=tombstones[prefix]){
    const info=await fs.lstat(target(ref));if(!info.isFile()||info.isSymbolicLink())throw Error('UNSAFE_ARTIFACT');
    await api.removeDocument({ref,sha256:await fileHash(target(ref))});
   }
   return{removedThroughRevision:tombstones[prefix]};
  },
  async removeDocument({ref,sha256}) {
   // Versioned working documents have a separate deletion API. Evidence can never be erased here.
   if(!/^file_[a-f0-9]{32}_[1-9][0-9]*$/.test(ref)||!hashPattern.test(sha256))throw Error('INVALID_DOCUMENT_ARTIFACT');
   let info;try{info=await fs.lstat(target(ref));}catch(e){if(e.code==='ENOENT'){if(artifacts[ref]){delete artifacts[ref];changed();}return{removed:true};}throw e;}
   if(!info.isFile()||info.isSymbolicLink()||await fileHash(target(ref))!==sha256)throw Error('DOCUMENT_VERSION_CONFLICT');
   if([...uploads.values()].some(u=>u.ref===ref))throw Error('ARTIFACT_TRANSFER_ACTIVE');
   await fs.unlink(target(ref));delete artifacts[ref];changed();return{removed:true};
  },
  get active(){return uploads.size;},
 };
 return api;
}
