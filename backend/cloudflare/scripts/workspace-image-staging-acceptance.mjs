// Explicit staging-only synthetic acceptance. No real account, mission or submission.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
const API='https://api-staging.usehygge.app';
const base='registry.cloudflare.com/89a95a21e6a6b7c15bbd8e148a6c6242/hygge-workspace@sha256:';
const OLD=base+'ae26f5d92b203d94f18bc13f1c121975459053c3b34d9ee2ea664d68f01d55ff';
const NEW=base+'1c7dcb73cd6ddd7bf9bea12fdbb8b4a7d6498bf87d95a772434797562f95b5f9';
const sql=command=>execFileSync('npx',['wrangler','d1','execute','hygge-staging','-c','wrangler.staging.jsonc','--remote','--command',command],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
const owners=[0,1].map(()=>({id:randomUUID(),token:randomBytes(32).toString('base64url'),marker:randomUUID(),seeded:false,created:false}));
async function api(o,path,body,method='POST'){
 const r=await fetch(API+path,{method,headers:{authorization:`Bearer ${o.token}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(300000)});
 const text=await r.text();assert.equal(r.status,200,`${path}: ${r.status} ${text.slice(0,500)}`);return JSON.parse(text);
}
const fixture=(o,action)=>api(o,'/sandbox/image-upgrade/fixture',{reviewed:true,action,marker:o.marker});
const status=o=>api(o,'/sandbox/image-upgrade',undefined,'GET');
async function change(o,targetImage,label){
 const before=(await status(o)).current;const request={reviewed:true,operationId:randomUUID(),expectedGeneration:before.generation,targetImage};
 // An interrupted response resumes exactly this operation; never creates another replacement.
 let result,error;for(let n=0;n<3;n++){try{result=await api(o,'/sandbox/image-upgrade',request);break;}catch(e){error=e;console.log(`${label} interrupted; retrying same operation`);}}
 if(!result)throw error;
 assert.equal(result.operation.phase,'verified');assert.equal(result.current.desiredImageDigest,targetImage);assert.equal(result.current.generation,before.generation+1);
 assert.notEqual(result.current.incarnation,before.incarnation);assert.ok(result.operation.sourceReceipt);assert.ok(result.operation.targetReceipt);
 assert.notEqual(result.operation.sourceReceipt.recoveryPoint.checkpointId,result.operation.targetReceipt.recoveryPoint.checkpointId);
 const repeat=await api(o,'/sandbox/image-upgrade',request);assert.equal(repeat.current.incarnation,result.current.incarnation);
 console.log(`${label} PASS generation=${result.current.generation} operation=${request.operationId}`);return result;
}
function populated(value,latest=false){assert.equal(value.cookie,true);assert.equal(value.localStorage,true);assert.equal(value.source,true);if(latest){assert.ok(value.latestBytes>262144);assert.equal(value.latest,true);}}
try{
 for(const o of owners){
  console.log(`::add-mask::${o.token}`);
  sql(`INSERT INTO users (id,do_instance,contact_email) VALUES ('${o.id}','${o.id}','workspace-upgrade-${o.id}@example.invalid')`);o.created=true;
  sql(`INSERT INTO auth_sessions (id,user_id,token_hash,created_at,expires_at) VALUES ('${randomUUID()}','${o.id}','${createHash('sha256').update(o.token).digest('hex')}','${new Date().toISOString()}','${new Date(Date.now()+7200000).toISOString()}')`);
  const seed=await fixture(o,'seed');o.seeded=true;populated(seed);assert.equal(seed.image,OLD);
 }
 const [a,b]=owners;const untouched=(await status(b)).current;
 await change(a,NEW,'STAGING real old-to-new upgrade');populated(await fixture(a,'check'));
 populated(await fixture(a,'write-latest'),true);
 await change(a,OLD,'STAGING latest-state rollback');populated(await fixture(a,'check'),true);
 const other=(await status(b)).current;assert.equal(other.incarnation,untouched.incarnation);assert.equal(other.generation,untouched.generation);assert.equal(other.desiredImageDigest,OLD);populated(await fixture(b,'check'));
 console.log('STAGING second-owner isolation PASS');
 await change(a,NEW,'STAGING repeat compatible upgrade');populated(await fixture(a,'check'),true);
 await change(b,NEW,'STAGING second populated owner upgrade');populated(await fixture(b,'check'));
 console.log('STAGING populated image gate PASS; synthetic workspaces only; production unchanged');
}finally{
 let failed=false;
 for(const o of owners){
  if(!o.created)continue;
  try{if(o.seeded){const retired=await fixture(o,'retire');assert.equal(retired.retired,true);console.log(`STAGING synthetic container retired user=${o.id}`);}}catch(e){failed=true;console.error(`STAGING retirement pending user=${o.id}: ${e.message}`);}
  try{sql(`DELETE FROM auth_sessions WHERE user_id='${o.id}'; DELETE FROM users WHERE id='${o.id}'`);}catch{failed=true;}
 }
 console.log(`STAGING cleanup ${failed?'FAIL':'PASS'}; immutable synthetic DO/R2 evidence retained, auth/users removed`);if(failed)process.exitCode=1;
}
