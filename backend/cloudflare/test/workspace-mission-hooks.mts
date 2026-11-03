import test from 'node:test';
import assert from 'node:assert/strict';
import {runMission} from '../src/agent.ts';
import {actionFingerprint} from '../src/task-help.ts';
const snapshot={sessionID:'session',currentURLString:'https://jobs.example',title:'Jobs',elements:[{label:'Password',inputType:'password'}],humanControlled:false,controlEpoch:0};
function fixture(){
 let created=0,acted=0,decisions=0;const calls:any[]=[];
 const browser={mode:'test',createSession:async()=>{created++;return snapshot;},snapshot:async()=>snapshot,controlState:()=>({human:false,epoch:0}),act:async()=>{acted++;},agentStep:async(_id:any,_epoch:any,op:any)=>op()};
 const hooks={onActionBefore:async(input:any)=>{calls.push(['before',input]);return {effectId:String(calls.length),input};},onActionAfter:async(_ticket:any,observation:any)=>{calls.push(['after',observation]);}};
 const task:any={id:'t',kind:'signup',target_url:snapshot.currentURLString,goal:'Connect',status:'approved',interaction_version:1,drafted_payload:{setupMode:'signup'}};
 const decider={simulated:false,decide:async()=>{decisions++;return decisions===1 ? {action:'type',target:'Password',valueRef:'credential.secret',effect:'reversible'} : {action:'done'};}};
 return {browser,hooks,task,decider,calls,counts:()=>({created,acted,decisions})};
}
test('hooks cover initial navigation and private nested credential fill exactly once',async()=>{
 const f=fixture();await runMission({...f,workspaceHooks:f.hooks as any,fillCredentialValue:async()=>f.browser.act()});
 assert.deepEqual(f.counts(),{created:1,acted:1,decisions:2});
 assert.deepEqual(f.calls.map(c=>c[0]),['before','after','before','after']);
 assert.equal(f.calls[0][1].snapshot,null);
});
test('lost tool response stops the mission and cannot enter the generic retry loop',async()=>{
 const f=fixture();f.hooks.onActionAfter=async(_ticket,observation)=>{f.calls.push(['after',observation]);if(f.calls.length===4)throw new Error('WORKSPACE_ACTION_UNCERTAIN');};
 await assert.rejects(runMission({...f,workspaceHooks:f.hooks as any,fillCredentialValue:async()=>f.browser.act()}),/UNCERTAIN/);
 assert.equal(f.counts().acted,1);assert.equal(f.counts().decisions,1);assert.equal(f.calls.length,4);
});
test('exact private approval proof survives consumption for the durable policy hook',async()=>{
 const f=fixture(),decision={action:'click',target:'Delete account',effect:'destructive'};
 f.task.authorized_action={decision,fingerprint:actionFingerprint(decision,snapshot,f.task.drafted_payload)};
 f.task.session_id='session';
 await runMission({...f,existingSessionID:'session',maxSteps:1,workspaceHooks:f.hooks as any});
 assert.deepEqual(f.calls[0][1].approvedActionProof.decision,decision);
 assert.equal(f.task.authorized_action,undefined);
});
test('V2 navigation learning records the observed destination after redirect',async()=>{
 const f=fixture();let page={...snapshot},step=0;
 f.browser.snapshot=async()=>page;
 f.browser.act=async()=>{page={...snapshot,currentURLString:'https://jobs.example/search'};};
 f.decider.decide=async()=>++step===1 ? {action:'navigate',target:'https://jobs.example/redirect',effect:'reversible'} as any : {action:'done'} as any;
 const result=await runMission({...f,workspaceHooks:f.hooks as any});
 assert.equal(result.trace[0].urlString,'https://jobs.example/search');
});
