// Authenticated synthetic account only. Creates drafts, never executes external missions.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
const API='https://api-staging.usehygge.app',userID=randomUUID(),token=randomBytes(32).toString('base64url');
console.log(`::add-mask::${token}`);
const sql=command=>execFileSync('npx',['wrangler','d1','execute','hygge-staging','-c','wrangler.staging.jsonc','--remote','--command',command],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
async function api(path,body,method='POST'){
 const response=await fetch(API+path,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(240000)});
 assert.equal(response.status,200,`${path}: status ${response.status}`);return response.json();
}
let generation;const sites=['contra.com','toptal.com'];
try {
 sql(`INSERT INTO users (id,do_instance,contact_email) VALUES ('${userID}','${userID}','agent-acceptance-${userID}@example.invalid')`);
 sql(`INSERT INTO auth_sessions (id,user_id,token_hash,created_at,expires_at) VALUES ('${randomUUID()}','${userID}','${createHash('sha256').update(token).digest('hex')}','${new Date().toISOString()}','${new Date(Date.now()+3600000).toISOString()}')`);
 await api('/profile/profile',{profile:{displayName:'Synthetic Tester',interests:['freelance'],skills:['software engineering'],hourlyRateFloor:25},hasOnboarded:true,isPaused:true});
 for(const id of sites)await api(`/sites/${id}`,{id,name:id==='contra.com'?'Contra':'Toptal',startURLString:`https://${id}`,category:'freelance'});
 generation=(await api('/chat/state',undefined,'GET')).generation;
 const turn=async(text,id=randomUUID())=>api('/chat/turn',{generation,id,text});
 await turn('I am considering joining Contra. What should I consider? Do not create anything yet.');
 let tasks=await api('/tasks',undefined,'GET');assert.equal(tasks.tasks?.length??tasks.length,0);console.log('STAGING no-false-activation PASS');
 await turn('Name the two sites I have: Contra and Toptal. Just name them for now.');
 const id=randomUUID();const result=await turn('Add both of those sites and prepare their signup drafts, please.',id);assert.ok(result.reply);
 const repeat=await turn('Add both of those sites and prepare their signup drafts, please.',id);assert.equal(repeat.replyMessageId,result.replyMessageId);
 tasks=await api('/tasks',undefined,'GET');const rows=tasks.tasks??tasks;
 assert.equal(rows.length,2);assert.ok(rows.every(t=>t.status==='awaiting_approval'));assert.deepEqual(new Set(rows.map(t=>t.mobile_task.siteID)),new Set(sites));console.log('STAGING both-drafts-and-idempotent-retry PASS');
 await turn('Change my lowest hourly rate to $35.');let state=await api('/chat/state',undefined,'GET');const p=state.proposals.find(p=>p.operation==='change_floor');assert.ok(p);
 await turn('Before I decide, explain what that would mean.');state=await api('/chat/state',undefined,'GET');assert.ok(state.proposals.some(x=>x.id===p.id));
 await api(`/chat/proposals/${p.id}`,{generation,id:randomUUID(),decision:'reject'});state=await api('/chat/state',undefined,'GET');assert.ok(!state.proposals.some(x=>x.id===p.id));console.log('STAGING durable-proposal-question-and-rejection PASS');
 const beforeReset=generation;state=await api('/chat/reset',{generation});generation=state.generation;assert.notEqual(generation,beforeReset);
 const stale=await fetch(API+'/chat/turn',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({generation:beforeReset,id:randomUUID(),text:'old'})});assert.notEqual(stale.status,200);
 const exported=await api('/state/export',undefined,'GET');assert.equal(exported.messages.length,0);console.log('STAGING reset-and-generation-boundary PASS');
}finally{
 let failed=false;
 try {if(generation){await api('/chat/reset',{generation});for(let n=0;n<20;n++){const state=await api('/chat/state',undefined,'GET');if(!state.cleanupPending)break;if(n===19)throw Error('Provider cleanup still pending');await new Promise(r=>setTimeout(r,1000));}}}catch{failed=true;console.error('STAGING conversation cleanup PENDING');}
 try {const tasks=await api('/tasks',undefined,'GET');for(const task of tasks.tasks??tasks)await api(`/tasks/${task.id}/reject`,{});}catch{failed=true;console.error('STAGING task cleanup FAIL');}
 for(const id of sites)try{await api(`/sites/${id}`,undefined,'DELETE');await api(`/account-states/${id}`,undefined,'DELETE');}catch{failed=true;}
 try {await api('/profile/profile',undefined,'DELETE');sql(`DELETE FROM auth_sessions WHERE user_id='${userID}'; DELETE FROM users WHERE id='${userID}'`);}catch{failed=true;}
 console.log(`STAGING cleanup ${failed?'FAIL':'PASS'} user=${userID}; rejected synthetic draft records remain in the now-unreachable test object`);if(failed)process.exitCode=1;
}
