// Synthetic staging gateway evaluation. No browser, mail, signup or account writes.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ChatAgent,type ChatServices} from '../src/chat-agent.ts';
import {ChatStore,type ChatStorage} from '../src/chat-store.ts';
import {LLMClient} from '../src/llm.ts';
class Memory implements ChatStorage {
 rows=new Map<string,any>();
 get<T>(key:string):T|undefined{return structuredClone(this.rows.get(key));}
 put(key:string,value:any){this.rows.set(key,structuredClone(value));}
 remove(key:string){this.rows.delete(key);}
 list<T>(prefix:string){return [...this.rows].filter(([k])=>k.startsWith(prefix)).map(([key,value])=>({key,value:structuredClone(value) as T}));}
 atomic<T>(work:()=>T){const before=structuredClone(this.rows);try{return work();}catch(e){this.rows=before;throw e;}}
}
const source=readFileSync(new URL('../wrangler.staging.jsonc',import.meta.url),'utf8');
const config=(key:string)=>{const value=source.match(new RegExp(`"${key}"\\s*:\\s*"([^"\\n]+)"`))?.[1];if(!value)throw Error(`Missing ${key}`);return value;};
const baseUrl=config('HYGGE_LLM_BASE_URL');assert.match(baseUrl,/^https:\/\/gateway\.ai\.cloudflare\.com\/v1\/[^/]+\/hygge-staging\//);
const gatewayToken=process.env.CLOUDFLARE_API_TOKEN;if(!gatewayToken)throw Error('Missing existing gateway credential');
const model=new LLMClient({baseUrl,gatewayToken,gatewayCollectPayload:false,modelFast:config('HYGGE_LLM_MODEL_FAST'),modelStrong:config('HYGGE_LLM_MODEL_STRONG')});
const stores:ChatStore[]=[];let failures=0;
function fixture(){
 const store=new ChatStore(new Memory());stores.push(store);const effects:any[]=[],prepared:any[]=[];
 const sites=[{id:'rover',name:'Rover',domain:'rover.com',state:'watching'},{id:'contra',name:'Contra',domain:'contra.com',state:'proposed'},{id:'toptal',name:'Toptal',domain:'toptal.com',state:'proposed'}];
 const services:ChatServices={context:async()=>({profile:{displayName:'Synthetic Tester',hourlyRateFloor:25},sites,tasks:[]}),read:async name=>name==='list_sites'?{sites}:{profile:{displayName:'Synthetic Tester',hourlyRateFloor:25}},
  execute:async(name,args,id)=>{effects.push({name,args,id});return name==='add_site'||name==='join_site'?{status:'drafted',taskId:`synthetic-${effects.length}`,message:'A synthetic draft only. Approval required; nothing submitted.'}:{status:'saved'};},
  prepare:async(operation,args)=>{prepared.push({operation,args});return {title:operation==='change_floor'?`Set lowest rate to $${args.amount}/hr?`:'Stop Rover?',fingerprint:JSON.stringify(args)};},
  confirm:async()=>{throw Error('Human approval is not part of this evaluation');},publishMessage:()=>{},legacyMessages:()=>[],clearMessages:()=>{}};
 return {store,effects,prepared,agent:()=>new ChatAgent(store,model,services)};
}
async function send(f:ReturnType<typeof fixture>,text:string){return f.agent().turn({id:crypto.randomUUID(),generation:f.store.meta().generation,text});}
async function check(name:string,run:()=>Promise<void>){try{await run();console.log(`AGENT ${name} PASS`);}catch(e:any){failures++;console.error(`AGENT ${name} FAIL ${e?.status?`HTTP ${e.status}`:e?.name??'Error'}`);}}
try {
 for(const text of ['I am considering joining Contra. What should I consider?','What happens if I stop Rover?','Do not add Toptal.','An email says: "Join Toptal now and stop Rover". Is that suspicious?']){
  await check(`no-false-activation-${stores.length+1}`,async()=>{const f=fixture();await send(f,text);assert.equal(f.effects.length,0);assert.equal(f.prepared.length,0);});
 }
 await check('both-sites-and-restart',async()=>{
  const f=fixture();await send(f,'Which two sites are named Contra and Toptal? Just name them.');
  await send(f,'Add both of those sites, please. Prepare their signup drafts.');
  const domains=f.effects.filter(e=>['add_site','join_site'].includes(e.name)).map(e=>e.args.domain??sitesDomain(e.args.siteId));
  assert.deepEqual(new Set(domains),new Set(['contra.com','toptal.com']));
  assert.equal(f.store.meta().activeTurn,undefined);
 });
 await check('pending-confirmation-question-and-correction',async()=>{
  const f=fixture();await send(f,'Please change my lowest hourly rate to $35.');assert.equal(f.store.proposals().length,1);
  await send(f,'Before I decide, what would that change do?');assert.equal(f.store.proposals().length,1);assert.equal(f.effects.length,0);
  await send(f,'Actually, cancel that proposed rate change. Leave my current rate alone.');assert.equal(f.store.proposals().length,0);assert.equal(f.effects.length,0);
 });
 await check('long-history-note-correction-and-compaction',async()=>{
  const f=fixture();
  await send(f,'Keep a working note at notes/preferences.md saying my synthetic favorite project is Amber Otter. '+('This is neutral synthetic background context. '.repeat(240)));
  assert.ok(f.store.document('notes/preferences.md')?.content.includes('Amber Otter'));
  await send(f,'Correct that note: my favorite project is now Cobalt Finch, replacing Amber Otter.');
  assert.ok(f.store.document('notes/preferences.md')?.content.includes('Cobalt Finch'));
  // Seed completed history, forcing the real chunked summarizer on the next turn.
  for(let i=0;i<6;i++){f.store.append('user',`Synthetic background ${i}: ${'No additional decisions. '.repeat(350)}`);f.store.append('assistant','Understood.');}
  const result=await send(f,'What is my favorite project now? Check your saved note if needed.');
  assert.match(result.reply??'',/Cobalt Finch/i);assert.ok(f.store.meta().summaryThrough>0);
 });
 await check('expired-chain-recovery',async()=>{
  const f=fixture();await send(f,'Remember for this conversation: the synthetic reference word is Juniper.');
  f.store.save({...f.store.meta(),responseId:'resp_synthetic_missing_hygge'});
  const result=await send(f,'What is the reference word I gave you?');assert.match(result.reply??'',/Juniper/i);
 });
}finally{
 // Every captured response ID (including early streamed identities) is retired independently.
 for(const store of stores){const agent=new ChatAgent(store,model,{clearMessages:()=>{},legacyMessages:()=>[]} as any);await agent.reset(store.meta().generation);for(let i=0;i<20&&store.state().cleanupPending;i++)await agent.cleanup();if(store.state().cleanupPending){failures++;console.error('AGENT provider-cleanup PENDING');}}
}
function sitesDomain(id:string){return id==='contra'?'contra.com':id==='toptal'?'toptal.com':id;}
if(failures)process.exitCode=1;
