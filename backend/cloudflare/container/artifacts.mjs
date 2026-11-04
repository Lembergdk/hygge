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
 const uploads=new Map();
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
   await expire();target(ref);
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
