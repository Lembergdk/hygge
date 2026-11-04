// Operator release step. Existing owners only; no reset, task dispatch, email or approval changes.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
const TARGET='registry.cloudflare.com/89a95a21e6a6b7c15bbd8e148a6c6242/hygge-workspace@sha256:1c7dcb73cd6ddd7bf9bea12fdbb8b4a7d6498bf87d95a772434797562f95b5f9';
const sql=q=>JSON.parse(execFileSync('npx',['wrangler','d1','execute','hygge-production','-c','wrangler.production.jsonc','--remote','--json','--command',q],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
const quote=value=>"'"+String(value).replaceAll("'","''")+"'";
const counts={upgraded:0,current:0,uninitialized:0,deferred:{},failed:0};
const deferred=new Set(['WORKSPACE_OWNER_BUSY','WORKSPACE_ADMISSION_BUSY','WORKSPACE_HAS_UNRESOLVED_ACTION','WORKSPACE_CAPTURE_OR_HUMAN_PENDING','WORKSPACE_NOT_READY','EXACT_INCARNATION_MISMATCH','LEGACY_BROWSER_ADOPTION_REQUIRED']);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const users=sql('SELECT id FROM users ORDER BY id').flatMap(r=>r.results??[]);
for(const {id} of users){
 const token=randomBytes(32).toString('base64url'),session=randomUUID();console.log(`::add-mask::${token}`);
 async function api(body){const r=await fetch('https://api.usehygge.app/sandbox/image-upgrade',{method:body?'POST':'GET',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(300000)});const data=await r.json();if(!r.ok){const e=Error(typeof data.error==='string'&&/^[A-Z_]+$/.test(data.error)?data.error:`UPGRADE_HTTP_${r.status}`);e.status=r.status;throw e;}return data;}
 try{
  sql(`INSERT INTO auth_sessions (id,user_id,token_hash,created_at,expires_at) VALUES (${quote(session)},${quote(id)},${quote(createHash('sha256').update(token).digest('hex'))},${quote(new Date().toISOString())},${quote(new Date(Date.now()+3600000).toISOString())})`);
  let state;for(let n=0;;n++){try{state=await api();break;}catch(e){if(e.status!==404||n>=24)throw e;await sleep(15000);}}
  if(!state.current){counts.uninitialized++;continue;}
  const pending=state.operations.find(o=>!['verified','aborted'].includes(o.phase));
  if(!pending&&state.current.desiredImageDigest===TARGET){counts.current++;continue;}
  if(!pending&&state.current.lifecycleState!=='ready'){counts.deferred.WORKSPACE_NOT_READY=(counts.deferred.WORKSPACE_NOT_READY??0)+1;continue;}
  const input=pending?{reviewed:true,operationId:pending.operationId,expectedGeneration:pending.expectedGeneration,targetImage:pending.targetImage}:{reviewed:true,operationId:`release_${createHash('sha256').update(id+TARGET).digest('hex').slice(0,32)}_${state.current.generation}`,expectedGeneration:state.current.generation,targetImage:TARGET};
  assert.equal(input.targetImage,TARGET);
  let result;for(let attempt=0;attempt<3;attempt++){try{result=await api(input);break;}catch(e){if(deferred.has(e.message)||attempt===2)throw e;await sleep(2000);}}
  assert.equal(result.operation.phase,'verified');assert.equal(result.current.desiredImageDigest,TARGET);counts.upgraded++;
 }catch(e){if(deferred.has(e.message))counts.deferred[e.message]=(counts.deferred[e.message]??0)+1;else{counts.failed++;console.error('::error::Workspace upgrade held; no reset or replay performed. Inspect the owner-private migration journal.');}}
 finally{sql(`DELETE FROM auth_sessions WHERE id=${quote(session)} AND user_id=${quote(id)}`);}
 console.log('Production workspace progress '+JSON.stringify(counts));
}
await fs.writeFile('production-workspace-release.json',JSON.stringify(counts,null,2)+'\n');
if(process.env.GITHUB_STEP_SUMMARY)await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,'\n### Production workspace activation\n\n```json\n'+JSON.stringify(counts,null,2)+'\n```\n');
if(Object.keys(counts.deferred).length)console.warn('::warning::Busy, unavailable or unresolved workspaces retain their existing image. Rerun the manual release after they become eligible; never clear uncertainty to force migration.');
if(counts.failed)process.exitCode=1;
console.log('Production workspace result '+JSON.stringify(counts));
