// Finish only the known upgrade fixtures from run 41929037013; no new migration or rollback.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
const owners=['f1be7865-1a4b-435c-a4ca-f8320779308c','46117391-ba70-4ecf-abb1-13efc3bf829e'].map(id=>({id,token:randomBytes(32).toString('base64url'),session:randomUUID()}));
const sql=q=>execFileSync('npx',['wrangler','d1','execute','hygge-staging','-c','wrangler.staging.jsonc','--remote','--command',q],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
async function api(o,path,body,method='POST'){
 for(let n=0;;n++){
  let r;try{r=await fetch('https://api-staging.usehygge.app'+path,{method,headers:{authorization:`Bearer ${o.token}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(300000)});}catch(e){if(n<1&&['ECONNRESET','UND_ERR_SOCKET'].includes(e.cause?.code)){console.log('Retrying identical synthetic request after connection reset');continue;}throw e;}
  const text=await r.text();assert.equal(r.status,200,`${path}: ${r.status} ${text.slice(0,1000)}`);return JSON.parse(text);
 }
}
try{
 for(const o of owners){console.log(`::add-mask::${o.token}`);const email=`workspace-upgrade-${o.id}@example.invalid`;
  sql(`INSERT OR IGNORE INTO users (id,do_instance,contact_email) VALUES ('${o.id}','${o.id}','${email}')`);
  sql(`INSERT INTO auth_sessions (id,user_id,token_hash,created_at,expires_at) SELECT '${o.session}',id,'${createHash('sha256').update(o.token).digest('hex')}','${new Date().toISOString()}','${new Date(Date.now()+3600000).toISOString()}' FROM users WHERE id='${o.id}' AND contact_email='${email}'`);
 }
 const [a,b]=owners,state=await api(a,'/sandbox/image-upgrade',undefined,'GET');assert.equal(state.current.generation,2);assert.ok(state.current.desiredImageDigest.endsWith('1c7dcb73cd6ddd7bf9bea12fdbb8b4a7d6498bf87d95a772434797562f95b5f9'));
 assert.ok(state.operations.some(op=>op.phase==='verified'));assert.ok(state.fixtureMarker);
 const fixture=action=>api(a,'/sandbox/image-upgrade/fixture',{reviewed:true,marker:state.fixtureMarker,action});
 const result=await fixture('write-latest');for(const key of ['cookie','localStorage','source','latest'])assert.equal(result[key],true);assert.ok(result.latestBytes>262144);console.log('STAGING upgraded profile and large file durability PASS');
 const other=await api(b,'/sandbox/image-upgrade',undefined,'GET');assert.equal(other.current.generation,1);assert.ok(other.current.desiredImageDigest.endsWith('ae26f5d92b203d94f18bc13f1c121975459053c3b34d9ee2ea664d68f01d55ff'));assert.equal(other.current.lifecycleState,'stopped');console.log('STAGING second owner retained original image/generation and retired PASS');
 assert.equal((await fixture('retire')).retired,true);console.log('STAGING upgraded synthetic container retired PASS');
 console.log('STAGING upgrade-only acceptance PASS; rollback skipped; original upgrade run 41929037013');
}finally{for(const o of owners)sql(`DELETE FROM auth_sessions WHERE user_id='${o.id}'; DELETE FROM users WHERE id='${o.id}' AND contact_email='workspace-upgrade-${o.id}@example.invalid'`);console.log('STAGING synthetic authentication cleanup PASS');}
