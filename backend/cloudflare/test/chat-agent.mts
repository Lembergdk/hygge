import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ChatAgent,CHAT_AGENT_TOOLS,type ChatServices} from '../src/chat-agent.ts';
import {ChatStore,type ChatStorage} from '../src/chat-store.ts';
import {chatServices,type ChatServiceHost} from '../src/chat-services.ts';

class Memory implements ChatStorage {
  rows=new Map<string,any>();
  get<T>(key:string):T|undefined {const v=this.rows.get(key);return v===undefined?undefined:structuredClone(v);}
  put(key:string,v:any){this.rows.set(key,structuredClone(v));}
  remove(key:string){this.rows.delete(key);}
  list<T>(prefix:string){return [...this.rows].filter(([k])=>k.startsWith(prefix)).map(([key,value])=>({key,value:structuredClone(value) as T}));}
  atomic<T>(fn:()=>T):T {const before=structuredClone(this.rows);try{return fn();}catch(e){this.rows=before;throw e;}}
}
function setup(handler:(a:any,n:number)=>any,storage=new Memory(),overrides:Partial<ChatServices>={}){
 const store=new ChatStore(storage);let n=0;const requests:any[]=[],executed:any[]=[],deleted:string[]=[],published:any[]=[];
 const model={cfg:{modelStrong:'reasoner'},async agentTurn(a:any){requests.push(a);n++;return handler(a,n);},async complete(a:any){requests.push({summary:a});return 'Preserved decisions and pending offers.';},async deleteAgentResponse(id:string){deleted.push(id);}};
 const services:ChatServices={context:async()=>({}),read:async()=>({status:'read'}),execute:async(name,args,id)=>{executed.push({name,args,id});return {status:'queued',id};},prepare:async(operation,args)=>({title:`Confirm ${operation}`,fingerprint:JSON.stringify(args),details:{Target:'Exact draft'}}),confirm:async(p,id)=>{executed.push({proposal:p.id,id});return {status:'queued'};},publishMessage:e=>{published.push(e);},legacyMessages:()=>[],clearMessages:()=>{},...overrides};
 const agent=new ChatAgent(store,model,services);return {agent,store,model,services,storage,requests,executed,deleted,published};
}
const answer=(id:string,text='Done.')=>({id,text,calls:[],inputTokens:100});
const calls=(id:string,list:any[])=>({id,text:'',calls:list.map((v,i)=>({callId:`${id}-${i}`,name:v.name,arguments:v.args??{}})),inputTokens:100});
const turn=(s:ReturnType<typeof setup>,text='hello',id=crypto.randomUUID())=>s.agent.turn({id,generation:s.store.meta().generation,text});

test('one reasoning loop consumes both native results before replying; duplicate message does not execute again',async()=>{
 const s=setup((args,n)=>n===1?calls('r1',[{name:'add_site',args:{domain:'contra.com'}},{name:'add_site',args:{domain:'toptal.com'}}]):(()=>{
   assert.equal(args.previousResponseId,'r1');assert.equal(args.input.length,2);assert.ok(args.input.every((i:any)=>i.type==='function_call_output'));
   return answer('r2','Both setup drafts are ready.');})());
 const id=crypto.randomUUID();const first=await turn(s,'Add both',id);
 assert.equal(s.executed.length,2);assert.ok(first.replyMessageId);
 const second=await turn(s,'Add both',id);assert.deepEqual(second,first);assert.equal(s.requests.length,2);
 await assert.rejects(turn(s,'different message',id),/MESSAGE_ID_CONFLICT/);
});

test('persisted response pointer and full untruncated message survive a new agent instance',async()=>{
 const s=setup(()=>answer('previous','Which ones?'));await turn(s,'x'.repeat(12000));
 const next=setup(a=>{assert.equal(a.previousResponseId,'previous');assert.equal(a.input[0].content[0].text,'both');return answer('next');},s.storage);
 await turn(next,'both');assert.equal(s.store.events().find(e=>e.kind==='user')?.value.length,12000);
});

test('model failure after side effects resumes the same turn without replaying effects',async()=>{
 let fail=true;
 const s=setup((_args,n)=>{if(n===1)return calls('r1',[{name:'resume_work'}]);if(fail){fail=false;throw new Error('network');}return answer('r2');});
 const id=crypto.randomUUID();await assert.rejects(turn(s,'Resume',id),/network/);assert.equal(s.executed.length,1);
 await s.agent.turn({id,generation:s.store.meta().generation});assert.equal(s.executed.length,1);
});

test('an interrupted executing operation is reported uncertain and is never dispatched again',async()=>{
 const s=setup(()=>answer('r2','That action needs its outcome checked.'));const id=crypto.randomUUID(),generation=s.store.meta().generation;
 const call={callId:'old',name:'resume_work',arguments:{}};
 s.store.db.put(`turn:${id}`,{id,generation,text:'Resume',stage:'running',rounds:1,pending:{responseId:'r1',calls:[call]}});
 s.store.save({...s.store.meta(),activeTurn:id,responseId:'r1'});
 const {digest}=await import('../src/workspace-persistence.ts');const key=`execution:${id}:${await digest({name:call.name,args:call.arguments})}`;
 s.store.db.put(key,{status:'executing'});await s.agent.turn({id,generation});assert.equal(s.executed.length,0);
 assert.equal(s.requests[0].input.find((i:any)=>i.type==='function_call_output').output.includes('uncertain'),true);
});

test('pending confirmation survives restart, allows questions, requires exact unchanged target, and cannot be approved by a tool',async()=>{
 let revision=1;
 const services={prepare:async()=>({title:'Send exact draft?',fingerprint:String(revision),details:{Message:'Original'}})};
 const s=setup((_a,n)=>n===1?calls('proposal',[{name:'propose_action',args:{operation:'approve_task',taskId:'draft'}}]):answer('reply','Please confirm the draft.'),new Memory(),services);
 await turn(s,'Send it');const p=s.store.proposals()[0];assert.ok(p);assert.equal(s.executed.length,0);
 const next=setup(()=>answer('question','It sends the displayed text.'),s.storage,services);await turn(next,'What will that do?');assert.equal(next.executed.length,0);assert.equal(next.store.proposals()[0].id,p.id);
 revision=2;
 const result=await next.agent.decide({generation:next.store.meta().generation,proposalId:p.id,decision:'approve',id:crypto.randomUUID()});
 assert.equal(next.store.proposal(p.id)?.status,'stale');assert.equal(next.executed.length,0);assert.equal(result.proposals.length,0);
 assert.ok(!CHAT_AGENT_TOOLS.some(t=>/confirm|execute_approved/.test(t.name)));
});

test('one human approval executes once and records the real outcome in the ongoing chain',async()=>{
 const s=setup((_a,n)=>n===1?calls('proposal',[{name:'propose_action',args:{operation:'change_floor',amount:35}}]):answer(`reply-${n}`));
 await turn(s,'Set my rate');const p=s.store.proposals()[0];
 const body={generation:s.store.meta().generation,proposalId:p.id,decision:'approve' as const,id:crypto.randomUUID()};
 await s.agent.decide(body);await s.agent.decide(body);assert.equal(s.executed.length,1);
 assert.ok(s.store.events().some(e=>e.kind==='system'&&e.value.result?.status==='queued'));
});

test('invalid/junk native calls yield explicit results; never dispatch unknown tools',async()=>{
 const s=setup((_a,n)=>n===1?calls('bad',[{name:'shell',args:{command:'bad'}},{name:'scan_site',args:{siteId:'rover',surprise:true}},{name:'resume_work'}]):answer('final'));
 await turn(s);assert.equal(s.executed.length,1);const results=s.store.events().filter(e=>e.kind==='result');assert.equal(results.length,3);assert.equal(results[0].value.result.status,'failed');
});

test('file revisions, provenance, complete chunk reads, corrections and approved deletion',async()=>{
 let stage=0;
 const s=setup((_a,n)=>{stage++;if(stage===1)return calls('write',[{name:'write_file',args:{path:'notes/preferences.md',content:'Morning work. '+ 'z'.repeat(20000),kind:'note',expectedRevision:0}}]);if(stage===2)return answer('w');if(stage===3)return calls('read',[{name:'read_file',args:{path:'notes/preferences.md',offset:16000,limit:16000}}]);if(stage===4)return answer('r');if(stage===5)return calls('delete',[{name:'propose_action',args:{operation:'delete_file',path:'notes/preferences.md'}}]);return answer(`final-${n}`);});
 await turn(s,'Remember mornings');const doc=s.store.document('notes/preferences.md')!;assert.equal(doc.revision,1);assert.ok(doc.provenance.turnId);
 await turn(s,'Read later part');assert.ok(s.store.events().some(e=>e.kind==='result'&&e.value.result.offset===16000&&e.value.result.content.length>0));
 await turn(s,'Delete that note');const p=s.store.proposals()[0];assert.ok(s.store.document(doc.path));
 await s.agent.decide({generation:s.store.meta().generation,proposalId:p.id,decision:'approve',id:crypto.randomUUID()});assert.equal(s.store.document(doc.path),undefined);
});

test('history retrieval can access text beyond the old transcript and per-event preview limits',async()=>{
 const s=setup((_a,n)=>n===1?answer('old'):n===2?calls('history',[{name:'read_history',args:{eventId:'old-message',offset:20000,charLimit:12000}}]):answer('new'));
 s.store.append('user','a'.repeat(22000)+'OLDER DETAIL','old-message');await turn(s);
 await turn(s,'Find older detail');const result=s.store.events().filter(e=>e.kind==='result')[0].value.result;assert.match(result.text,/OLDER DETAIL/);
});

test('all historical text is processed during chunked compaction; cleanup is observable and history remains retrievable',async()=>{
 const s=setup(()=>answer('new'));for(let i=0;i<70;i++){s.store.append(i%2?'assistant':'user',`MARKER-${i}:`+'x'.repeat(900));}
 await turn(s);const chunks=s.requests.filter(r=>r.summary).map(r=>r.summary.user).join('');assert.match(chunks,/MARKER-0/);assert.match(chunks,/MARKER-65/);
 assert.ok(s.store.meta().summaryThrough>0);assert.equal(s.store.events().filter(e=>String(e.value).includes('MARKER')).length,70);
});

test('compaction failure keeps the previous chain and summary; other HTTP 400 is not treated as context overflow',async()=>{
 const s=setup(()=>{throw Object.assign(new Error('bad schema'),{status:400});});for(let i=0;i<60;i++)s.store.append(i%2?'assistant':'user','x'.repeat(1000));
 s.store.save({...s.store.meta(),responseId:'existing',summary:'important',cursor:1});s.model.complete=async()=>{throw new Error('summary failed');};
 await assert.rejects(turn(s),/bad schema/);assert.equal(s.store.meta().responseId,'existing');assert.equal(s.store.meta().summary,'important');assert.equal(s.requests.filter(r=>!r.summary).length,1);
});

test('expired provider chain reconstructs from owned history without dropping the conversation',async()=>{
 const s=setup((_a,n)=>{if(n===1)throw Object.assign(new Error('expired'),{chainExpired:true});return answer('recovered');});s.store.append('user','earlier important fact');s.store.save({...s.store.meta(),responseId:'expired',cursor:1});
 await turn(s,'Remember?');assert.equal(s.requests[1].previousResponseId,undefined);assert.ok(JSON.stringify(s.requests[1].input).includes('earlier important fact'));
});

test('reset prevents resurrection, invalidates old generations and keeps failed provider deletions observable',async()=>{
 const old={id:'legacy',fromAgent:false,text:'old fact'};
 const s=setup(()=>answer('provider'),new Memory(),{legacyMessages:()=>[old]});await turn(s);const before=s.store.meta();
 s.model.deleteAgentResponse=async()=>{throw new Error('unavailable');};const state=await s.agent.reset(before.generation);assert.equal(state.cleanupPending,1);
 s.agent.importMessages();assert.equal(s.store.events().length,0);assert.equal(s.store.db.get('deleted-message:legacy'),true);
 await assert.rejects(s.agent.turn({id:crypto.randomUUID(),generation:before.generation,text:'old'}),/CONVERSATION_CHANGED/);
});

test('owner stores cannot search another user conversation or working file',async()=>{
 const a=setup(()=>answer('a')),b=setup(()=>answer('b'));a.store.append('user','private to A');a.store.db.put('document:notes/private',{path:'notes/private',content:'A',kind:'note',revision:1});assert.equal(b.store.events().length,0);assert.equal(b.store.documents().length,0);
});

function hostFixture(){
 const rows=new Map<string,any>(),tasks:any[]=[];
 const host:ChatServiceHost={rows:e=>[...rows].filter(([k])=>k.startsWith(e+':')).map(([k,data])=>({id:k.slice(e.length+1),data})),get:(e,id)=>rows.has(`${e}:${id}`)?{data:rows.get(`${e}:${id}`)}:null,put:(e,id,v)=>{rows.set(`${e}:${id}`,v);},remove:(e,id)=>{rows.delete(`${e}:${id}`);},tasks:()=>tasks,saveTask:t=>{const i=tasks.findIndex(v=>v.id===t.id);if(i<0)tasks.push(t);else tasks[i]=t;},enqueue:async t=>({...t,status:'queued'}),hints:()=>[],inbox:()=>[],plus:async()=>false,mirror:async()=>{},deletedMessage:()=>false};
 host.put('profile','profile',{profile:{displayName:'Synthetic',interests:['freelance'],hourlyRateFloor:25},isPaused:false});return {host,rows,tasks,services:chatServices(host)};
}
test('real service adapter adds both drafts idempotently without external signup; uses exact tasks for approval',async()=>{
 const h=hostFixture();const first=await h.services.execute('add_site',{domain:'contra.com'},'operation');await h.services.execute('add_site',{domain:'contra.com'},'other-operation');await h.services.execute('add_site',{domain:'toptal.com'},'toptal');assert.equal(h.tasks.length,2);assert.equal(h.tasks[0].status,'awaiting_approval');assert.equal(h.host.rows('sites').length,2);
 const p=await h.services.prepare('approve_task',{taskId:first.taskId});assert.match(p.title,/contra/);assert.ok(p.details?.displayName);h.tasks[0].drafted_payload.displayName='Changed';const changed=await h.services.prepare('approve_task',{taskId:first.taskId});assert.notEqual(changed.fingerprint,p.fingerprint);
});
test('service adapter enforces approved site, pause and free-plan rest for discovery',async()=>{
 const h=hostFixture();h.host.put('sites','rover',{id:'rover',name:'Rover',startURLString:'https://rover.com'});
 assert.equal((await h.services.execute('scan_site',{siteId:'rover'},'scan')).status,'not_approved');h.host.put('accountStates','rover',{state:'watching'});
 h.host.put('profile','profile',{profile:{},isPaused:true});assert.equal((await h.services.execute('scan_site',{siteId:'rover'},'scan')).status,'paused');h.host.put('profile','profile',{profile:{},isPaused:false});
 h.host.put('journalEvents','earned',{kind:'workCompleted',grossAmount:100,occurredAt:new Date().toISOString()});assert.equal((await h.services.execute('scan_site',{siteId:'rover'},'scan')).status,'plan_rested');
});

test('removed approval target becomes stale, with no execution',async()=>{
 let removed=false;const s=setup((_a,n)=>n===1?calls('r1',[{name:'propose_action',args:{operation:'change_floor',amount:30}}]):answer(`r${n}`),undefined,{prepare:async()=>{if(removed)throw new Error('DRAFT_NOT_PENDING');return {title:'Approve?',fingerprint:'v1'};}});
 await turn(s);const p=s.store.proposals()[0];removed=true;
 await s.agent.decide({generation:s.store.meta().generation,proposalId:p.id,decision:'approve',id:crypto.randomUUID()});
 assert.equal(s.store.proposal(p.id)?.status,'stale');assert.equal(s.executed.length,0);
});

test('late workspace mirror cannot resurrect an old note after reset',async()=>{
 let release!:()=>void;const wait=new Promise<void>(r=>release=r);
 const s=setup((_a,n)=>n===1?calls('r1',[{name:'write_file',args:{path:'notes/plan.md',content:'old',expectedRevision:0,kind:'note'}}]):answer('r2'),undefined,{mirrorFile:async()=>wait});
 await turn(s);const cleanup=s.agent.cleanup();await s.agent.reset(s.store.meta().generation);release();await cleanup;
 assert.equal(s.store.document('notes/plan.md'),undefined);assert.equal(s.store.documents().length,0);
});

test('tool budget survives retry and deferred calls get explicit results',async()=>{
 let fail=true;const s=setup((_a,n)=>{if(n===1)return calls('r1',Array.from({length:14},(_,i)=>({name:'scan_site',args:{siteId:String(i)}})));if(fail){fail=false;throw Error('disconnect');}return answer('r2');});
 const id=crypto.randomUUID();await assert.rejects(turn(s,'Search',id));assert.equal(s.executed.length,12);
 await s.agent.turn({id,generation:s.store.meta().generation});assert.equal(s.executed.length,12);
 assert.equal(s.store.events().filter(e=>e.kind==='result'&&e.value.result.status==='deferred_budget').length,2);
});

test('calendar approval is claimed by one device and requires its authenticated outcome',async()=>{
 let projections=0;const s=setup((_a,n)=>n===1?calls('r1',[{name:'propose_action',args:{operation:'book_task',taskId:'calendar-task'}}]):answer(`r${n}`),undefined,{confirm:async()=>({status:'device_required',taskId:'calendar-task',payload:{eventTitle:'Synthetic',eventStartISO8601:'2026-11-10T10:00:00Z'}}),deviceResult:async()=>{projections++;}});
 await turn(s);const proposal=s.store.proposals()[0],generation=s.store.meta().generation;
 await s.agent.decide({generation,proposalId:proposal.id,decision:'approve',id:crypto.randomUUID()});
 const deviceID=crypto.randomUUID(),other=crypto.randomUUID();
 assert.equal(s.agent.claimDevice({generation,proposalId:proposal.id,deviceID}).claimed,true);
 assert.throws(()=>s.agent.claimDevice({generation,proposalId:proposal.id,deviceID:other}),/CLAIMED_ELSEWHERE/);
 await assert.rejects(s.agent.deviceResult({generation,proposalId:proposal.id,id:crypto.randomUUID(),success:true,deviceID:other}),/NOT_CLAIMED/);
 assert.equal(projections,0);const id=crypto.randomUUID();
 const result=await s.agent.deviceResult({generation,proposalId:proposal.id,id,success:true,deviceID});
 assert.equal(projections,1);assert.equal(s.store.proposal(proposal.id)?.result.status,'succeeded');
 assert.deepEqual(await s.agent.deviceResult({generation,proposalId:proposal.id,id,success:true,deviceID}),result);assert.equal(projections,1);
});

test('decision IDs cannot authorize a different proposal or conflict with an existing message',async()=>{
 const s=setup((_a,n)=>n===1?calls('r1',[{name:'propose_action',args:{operation:'change_floor',amount:30}},{name:'propose_action',args:{operation:'change_floor',amount:40}}]):answer(`r${n}`));
 await turn(s);const [a,b]=s.store.proposals(),generation=s.store.meta().generation,id=crypto.randomUUID();
 await s.agent.decide({generation,proposalId:a.id,decision:'approve',id});
 await assert.rejects(s.agent.decide({generation,proposalId:b.id,decision:'approve',id}),/MESSAGE_ID_CONFLICT/);
 assert.equal(s.executed.length,1);assert.equal(s.store.proposal(b.id)?.status,'pending');
});
