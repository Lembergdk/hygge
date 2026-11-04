// One-time recovery of the synthetic owner from failed acceptance run 41909790242.
// Fixed test UUID from that run's receipt; never a real customer account.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
const userID='8a7f16d3-02f2-4bdb-865d-c6a1ca485603',token=randomBytes(32).toString('base64url');
const email=`agent-acceptance-${userID}@example.invalid`;
console.log(`::add-mask::${token}`);
const sql=command=>execFileSync('npx',['wrangler','d1','execute','hygge-staging','-c','wrangler.staging.jsonc','--remote','--command',command],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
async function api(path,body,method='POST'){
 const res=await fetch('https://api-staging.usehygge.app'+path,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(90000)});
 assert.equal(res.status,200,`${path}: ${res.status}`);return res.json();
}
let created=false;
try{
 // A conflicting existing user aborts the recovery instead of borrowing its authority.
 sql(`INSERT INTO users (id,do_instance,contact_email) VALUES ('${userID}','${userID}','${email}')`);created=true;
 sql(`INSERT INTO auth_sessions (id,user_id,token_hash,created_at,expires_at) VALUES ('${randomUUID()}','${userID}','${createHash('sha256').update(token).digest('hex')}','${new Date().toISOString()}','${new Date(Date.now()+900000).toISOString()}')`);
 const before=await api('/chat/state',undefined,'GET');await api('/chat/reset',{generation:before.generation});
 let remaining=0;
 for(let n=0;n<30;n++){const s=await api('/chat/state',undefined,'GET');remaining=s.cleanupPending;if(!remaining)break;await new Promise(r=>setTimeout(r,1000));}
 assert.equal(remaining,0,'Known provider response cleanup must finish');
 const state=await api('/state/export',undefined,'GET');assert.equal(state.messages.length,0);
 console.log(`RECOVERY conversation-and-provider-cleanup PASS user=${userID}`);
}finally{
 if(created){sql(`DELETE FROM auth_sessions WHERE user_id='${userID}'; DELETE FROM users WHERE id='${userID}' AND contact_email='${email}'`);console.log('RECOVERY temporary-auth-removed PASS');}
}
