import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeBrowserDecision,runMission} from '../src/agent.ts';
import {canonical,digest,InvalidWorkspacePayload} from '../src/workspace-persistence.ts';
import {actionFingerprint} from '../src/task-help.ts';
test('supported decisions normalize optional absence before fingerprint and hashing',async()=>{
 for(const action of ['navigate','click','type','upload','select','check','press','hover','scroll','back','forward','wait','extract','askUser','done','needsHuman']){
  const target=['click','type','upload','select','check','press','hover'].includes(action)?'ref-1':undefined;
  const normalized=normalizeBrowserDecision({action,target,value:undefined,reason:undefined});
  assert.equal(typeof normalized.target,'string');assert.ok(!Object.hasOwn(normalized,'value'));
  assert.equal(await digest(normalized),await digest(normalizeBrowserDecision(normalized)));
  assert.equal(actionFingerprint(normalized,{sessionID:"s",currentURLString:"https://jobs.example",elements:[],title:"Jobs"},{}),actionFingerprint(normalizeBrowserDecision(normalized),{sessionID:"s",currentURLString:"https://jobs.example",elements:[],title:"Jobs"},{}));
 }
});
test('malformed decisions and unsupported values fail strictly without exposing values or custom keys',()=>{
 for(const input of [{action:'click'},{action:'type',target:3},{action:'unknown'},{action:'scroll',value:NaN},{action:'wait',value:100},{action:'scroll',unexpected:undefined}])assert.throws(()=>normalizeBrowserDecision(input));
 for(const value of [undefined,NaN,Infinity,()=>{},1n,new Date(),new Array(2)])assert.throws(()=>canonical(value),InvalidWorkspacePayload);
 const cycle:any={};cycle.loop=cycle;assert.throws(()=>canonical(cycle),InvalidWorkspacePayload);
 assert.throws(()=>canonical({decision:{targetLabel:undefined}}),(e:any)=>e.code==='INVALID_PAYLOAD'&&e.path==='$.decision.targetLabel'&&e.valueType==='undefined');
 assert.throws(()=>canonical({'confidential@example.test':undefined}),(e:any)=>!JSON.stringify(e).includes('confidential')&&e.path==='$[property:0]');
 assert.equal(canonical({z:2,a:[null,true,'x']}),'{"a":[null,true,"x"],"z":2}');
});
test('real mission targetless scroll/wait decisions reach strict durable hooks with JSON-safe evidence',async()=>{
 const snapshot={sessionID:'s',currentURLString:'https://jobs.example',title:'Jobs',elements:[],humanControlled:false,controlEpoch:0};
 let decisions=0,actions=0,validated=0;
 const browser:any={mode:'test',createSession:async()=>snapshot,snapshot:async()=>snapshot,controlState:()=>({human:false,epoch:0}),act:async()=>{actions++;return snapshot;},agentStep:async(_id:any,_epoch:any,fn:any)=>fn()};
 const decider={decide:async()=>[{action:'scroll',value:'down'},{action:'wait',value:'100'},{action:'done'}][decisions++]};
 await runMission({browser,decider,task:{id:'t',kind:'discover',target_url:snapshot.currentURLString,goal:'Read jobs',drafted_payload:{},log:[]},workspaceHooks:{
  onActionBefore:async(input:any)=>{await digest({decision:input.decision,snapshot:input.snapshot,sessionID:input.sessionID});validated++;return {input} as any;},
  onActionAfter:async()=>{},
 }} as any);
 assert.equal(actions,2);assert.equal(validated,3);assert.equal(decisions,3);
});
