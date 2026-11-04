// Exact synthetic owner observed in acceptance run 41925418356. Never accepts arbitrary owner IDs.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
const id='bb827883-f30e-4dc7-8bd0-7e9cd7d68fbd',email=`workspace-upgrade-${id}@example.invalid`,session=randomUUID(),token=randomBytes(32).toString('base64url');
console.log(`::add-mask::${token}`);
const sql=q=>execFileSync('npx',['wrangler','d1','execute','hygge-staging','-c','wrangler.staging.jsonc','--remote','--command',q],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
async function api(path,body,method='POST'){
 const r=await fetch('https://api-staging.usehygge.app'+path,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(300000)});
 const text=await r.text();assert.equal(r.status,200,`${path}: ${r.status} ${text.slice(0,2000)}`);return JSON.parse(text);
}
try{
 // Only the known fixture ID can be reauthorized; existing rows are never replaced.
 sql(`INSERT OR IGNORE INTO users (id,do_instance,contact_email) VALUES ('${id}','${id}','${email}')`);
 sql(`INSERT INTO auth_sessions (id,user_id,token_hash,created_at,expires_at) SELECT '${session}',id,'${createHash('sha256').update(token).digest('hex')}','${new Date().toISOString()}','${new Date(Date.now()+3600000).toISOString()}' FROM users WHERE id='${id}' AND contact_email='${email}'`);
 let state;for(let attempt=0;attempt<28;attempt++){state=await api('/sandbox/image-upgrade',undefined,'GET');if(Object.hasOwn(state,'fixtureMarker'))break;if(attempt===0)console.log('Waiting for the owner to adopt deployed code (Cloudflare deferred update)');if(attempt===27)throw Error('DEPLOYED_OWNER_CODE_NOT_ACTIVE');await new Promise(resolve=>setTimeout(resolve,15000));}
 const describe=s=>({current:s.current,fixtureMarker:s.fixtureMarker,operations:s.operations.map(o=>({operationId:o.operationId,phase:o.phase,error:o.error,expectedGeneration:o.expectedGeneration,targetImage:o.targetImage,sourceReceiptId:o.sourceReceipt?.receiptId,targetReceiptId:o.targetReceipt?.receiptId}))});
 console.log('PRESERVED FIXTURE '+JSON.stringify(describe(state)));
 const pending=state.operations.find(o=>!['verified','aborted'].includes(o.phase));
 if(pending){console.log('PRESERVED FIXTURE left intact; rollback skipped at user request');}else{
 state=await api('/sandbox/image-upgrade',undefined,'GET');assert.ok(state.fixtureMarker);
 const retired=await api('/sandbox/image-upgrade/fixture',{reviewed:true,action:'retire',marker:state.fixtureMarker});assert.equal(retired.retired,true);
 console.log('PRESERVED FIXTURE retired '+JSON.stringify(describe(state)));
 }
}finally{
 sql(`DELETE FROM auth_sessions WHERE user_id='${id}'; DELETE FROM users WHERE id='${id}' AND contact_email='${email}' AND NOT EXISTS (SELECT 1 FROM auth_sessions WHERE user_id='${id}')`);
}
