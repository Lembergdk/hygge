import type { WorkspaceIdentity } from './workspace-contract.ts';
import { canonicalJson } from './workspace-security.ts';
export interface ContainerIdentity extends WorkspaceIdentity { incarnation: string; generation: number }
export interface RpcClaim extends ContainerIdentity { path: string; bodyHash: string; expiresAt: number; nonce: string }
export const RPC_MAX_BYTES = 2 * 1024 * 1024;
export const CHUNK_BYTES = 256 * 1024;
// Bounded current in-memory Worker transport; never silently evict user files beyond this cap.
export const CAPTURE_MAX_BYTES = 16 * 1024 * 1024;
export const CAPTURE_MAX_ENTRIES = 8192;
export function b64(bytes: Uint8Array): string { let s=''; for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(s); }
export function unb64(value:string): Uint8Array { if(value.length>CHUNK_BYTES*2 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))throw Error('INVALID_CHUNK');return Uint8Array.from(atob(value),c=>c.charCodeAt(0)); }
export async function digest(bytes:Uint8Array):Promise<string>{return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes as BufferSource))].map(x=>x.toString(16).padStart(2,'0')).join('');}
async function hmacKey(secret:Uint8Array){if(secret.length<32)throw Error('RPC_KEY_REQUIRED');return crypto.subtle.importKey('raw',secret as BufferSource,{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);}
export async function signRpc(secret:Uint8Array, identity:ContainerIdentity,path:string,body:string,now=Date.now()):Promise<string>{const claim:RpcClaim={...identity,path,bodyHash:await digest(new TextEncoder().encode(body)),expiresAt:now+30_000,nonce:crypto.randomUUID()};const data=new TextEncoder().encode(canonicalJson(claim));return b64(data)+'.'+b64(new Uint8Array(await crypto.subtle.sign('HMAC',await hmacKey(secret),data)));}
export async function verifyRpc(secret:Uint8Array,identity:ContainerIdentity,path:string,body:string,token:string,now=Date.now()):Promise<RpcClaim>{const [a,b,...rest]=token.split('.');if(!a||!b||rest.length||token.length>8192)throw Error('UNAUTHORIZED');const data=unb64(a),sig=unb64(b);if(!await crypto.subtle.verify('HMAC',await hmacKey(secret),sig as BufferSource,data as BufferSource))throw Error('UNAUTHORIZED');const c=JSON.parse(new TextDecoder().decode(data)) as RpcClaim;for(const key of ['environment','userId','workspaceId','incarnation','generation'] as const)if(c[key]!==identity[key])throw Error('OWNER_OR_INCARCATION_MISMATCH');if(c.path!==path||c.bodyHash!==await digest(new TextEncoder().encode(body))||!Number.isFinite(c.expiresAt)||c.expiresAt<=now-300_000||c.expiresAt>now+330_000||!/^[a-f0-9-]{36}$/.test(c.nonce))throw Error('UNAUTHORIZED');return c;}
export interface TreeFile {path:string;mode:number;size:number;hash:string}
export interface TreeDirectory {path:string;mode:number}
export interface TreeSymlink {path:string;target:string}
export interface TreeMetadata {files:TreeFile[];directories:TreeDirectory[];symlinks:TreeSymlink[];artifacts:Record<string,string>}
export function safePath(path:string):boolean{return typeof path==='string'&&!!path&&path.length<=1024&&!path.startsWith('/')&&!path.includes('\\')&&!/[\x00-\x1f\x7f]/.test(path)&&path.split('/').every(p=>p!=='.'&&p!=='..'&&!!p);}
export function validateTree(tree:TreeMetadata){if(tree.files.length+tree.directories.length+tree.symlinks.length>CAPTURE_MAX_ENTRIES||tree.files.reduce((n,f)=>n+f.size,0)>CAPTURE_MAX_BYTES)throw Error('CAPTURE_LIMIT');const types=new Map<string,string>();for(const [type,list]of [['file',tree.files],['directory',tree.directories],['symlink',tree.symlinks]]as const)for(const f of list){if(!safePath(f.path)||types.has(f.path)||('mode'in f&&(!Number.isInteger(f.mode)||f.mode<0||f.mode>0o777)))throw Error('UNSAFE_TREE');types.set(f.path,type);}for(const path of types.keys()){const parts=path.split('/');parts.pop();while(parts.length){if(types.get(parts.join('/'))!=='directory')throw Error('UNSAFE_PARENT');parts.pop();}}for(const f of tree.files)if(!Number.isSafeInteger(f.size)||f.size<0||!/^[a-f0-9]{64}$/.test(f.hash))throw Error('UNSAFE_FILE');const rawLinks=new Map<string,string>();
for(const link of tree.symlinks){if(typeof link.target!=='string'||!link.target||link.target.length>1024||link.target.startsWith('/')||link.target.includes('\\')||/[\x00-\x1f\x7f]/.test(link.target))throw Error('UNSAFE_LINK');rawLinks.set(link.path,link.target);}
// Lexical realpath: '..' must apply AFTER substituting any intermediate
// symlink, or a chain through a shallower link escapes the tree.
const resolveParts=(initial:string[]):string[]=>{
  const out:string[]=[];const queue=[...initial];const seen=new Set<string>();
  while(queue.length){
    const part=queue.shift()!;
    if(!part||part==='.')continue;
    if(part==='..'){if(!out.length)throw Error('UNSAFE_LINK');out.pop();continue;}
    out.push(part);
    const joined=out.join('/');
    const target=rawLinks.get(joined);
    if(target!==undefined){
      if(seen.has(joined))throw Error('LINK_CYCLE');seen.add(joined);out.pop();
      queue.unshift(...target.split('/'));
    }
  }
  return out;
};
for(const link of tree.symlinks){
  const dest=resolveParts([...link.path.split('/').slice(0,-1),...link.target.split('/')]).join('/');
  if(!dest||!types.has(dest))throw Error('DANGLING_LINK');
}
for(const [ref,path]of Object.entries(tree.artifacts))if(!/^[A-Za-z0-9_-]{1,128}$/.test(ref)||types.get(path)!=='file')throw Error('UNSAFE_ARTIFACT');}
