import type { ChatServices } from './chat-agent.ts';
import type { ChatProposal, ChatEvent, ChatDocument } from './chat-store.ts';
import { lastChatMessageId } from './state.ts';
import { monthlyLoggedEarnings, FREE_MONTHLY_EARNINGS_LIMIT } from './scan.ts';
import { digest } from './workspace-persistence.ts';

export interface ChatServiceHost {
  rows(entity:string):Array<{id:string;data:any}>;
  get(entity:string,id:string):{data:any}|null;
  put(entity:string,id:string,data:any):void;
  remove(entity:string,id:string):void;
  tasks():any[];
  saveTask(task:any):void;
  enqueue(task:any):Promise<any>;
  hints(domain:string):any[];
  inbox():any[];
  plus():Promise<boolean>;
  signupContact?():Promise<{email:string;choice:string}>;
  credentialForDomain?(domain:string):string|undefined;
  mirror(doc:ChatDocument):Promise<void>;
  erase?(doc:ChatDocument):Promise<void>;
  deletedMessage(id:string):boolean;
  /// Push for an agent-written chat message (policy Nov 5, 2026:
  /// every chat message generates a push — no exceptions). Called
  /// only for assistant events, after the message row is written.
  /// The host owns the send (UserSandbox.schedulePush); this
  /// adapter only reports that a message was published. No
  /// foreground exception lives here: the app suppresses pushes
  /// while open, so the server must not build a second one.
  notifyChatMessage?(event:ChatEvent):void;
}
function safe(value:any):any {
  if(Array.isArray(value))return value.map(safe);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!/password|secret|token|code|credential/i.test(k)).map(([k,v])=>[k,safe(v)]));
  return value;
}
function target(task:any){return safe({id:task.id,title:task.title,kind:task.kind,status:task.status,siteId:task.mobile_task?.siteID,targetURL:task.target_url,draft:task.drafted_payload,help:task.help,execution:task.execution??null});}
function profileRow(host:ChatServiceHost){return host.get('profile','profile')?.data??{profile:{},isPaused:false};}
function site(host:ChatServiceHost,id:string){const row=host.get('sites',id);if(!row)throw new Error('SITE_NOT_FOUND');return {id,...row.data};}
function siteDomain(s:any){try{return new URL(s.startURLString).hostname.replace(/^www\./,'');}catch{return '';}}
function stableUUID(hash:string){return `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;}
export function chatServices(host:ChatServiceHost):ChatServices {
  const pendingStates=['awaiting_approval','needsHuman','approved','running'];
  async function draftSite(s:any,operationId:string){
    if(!await host.plus()&&monthlyLoggedEarnings(host.rows('journalEvents').map(r=>r.data),new Date())>=FREE_MONTHLY_EARNINGS_LIMIT)return {status:'plan_rested',message:'New setup work is resting until next month under the current plan.'};
    const state=host.get('accountStates',s.id)?.data?.state;
    if(['watching','profileLive','hasAccount'].includes(state))return {status:'already_tracking',siteId:s.id};
    if(['joining','needsVerification'].includes(state))return {status:'setup_pending',siteId:s.id};
    const pending=host.tasks().find(t=>t.kind==='signup'&&t.mobile_task?.siteID===s.id&&pendingStates.includes(t.status));
    if(pending)return {status:'setup_pending',siteId:s.id,taskId:pending.id};
    const task=await createTask('signup',s,operationId,`Get the user set up on ${s.name}. First check whether an existing saved login works or a new signup is needed. Handle safe reversible setup choices; use known draft/profile values and ask only for missing facts. Never ask for passwords or codes in chat. Do not publish a profile or make commitments without specific approval. Email verification follows the approved draft's email choice.`,true);
    return {status:'drafted',siteId:s.id,taskId:task.id,message:'Signup draft created; confirmation is required before external work.'};
  }
  async function createTask(kind:string,s:any,operationId:string,goal:string,approval:boolean){
    const id=stableUUID(await digest({operationId,kind,site:s.id}));
    const existing=host.tasks().find(t=>t.id===id);if(existing)return existing;
    const p=profileRow(host).profile??{};
    const contact=kind==='signup'?(await host.signupContact?.()??{email:p.email??'',choice:'own'}):null;
    const task={id,kind,title:kind==='signup'?`Join ${s.name}`:`Look for work on ${s.name}`,target_url:s.startURLString,goal,
      drafted_payload:kind==='signup'?{displayName:p.displayName??'',email:contact?.email??'',emailChoice:contact?.choice??'own',awaitingEmailVerification:contact?.choice==='hygge'?'true':'false',location:p.locationLabel??'',headline:p.headline??'',skills:(p.skills??[]).join(', '),hourlyRate:String(p.hourlyRateFloor??'')}: {},
      credential_id:host.credentialForDomain?.(siteDomain(s))??null,email_choice:contact?.choice??null,awaiting_email_verification:contact?.choice==='hygge',email_code_available:false,
      requires_approval:approval,status:approval?'awaiting_approval':'approved',interaction_version:1,log:[approval?'Drafted. Waiting for approval.':'Read-only search requested in conversation.'],browser_trace:[],extracted_items:[],information_requests:[],help:null,
      mobile_task:{id,kind,siteID:s.id,targetURLString:s.startURLString,title:kind==='signup'?`Join ${s.name}`:`Look for work on ${s.name}`,goal,draftedPayload:{},status:approval?'awaitingApproval':'approved',log:[],createdAt:Date.now()/1000-978307200}};
    // The wire projection must carry the actual approved draft, never an empty parallel copy.
    task.mobile_task.draftedPayload=task.drafted_payload;host.saveTask(task);return task;
  }
  return {
    async context(focus){
      const entities:Record<string,string>={site:'sites',opportunity:'opportunities',event:'journalEvents',mail:'messages'};
      const focused=focus ? focus.kind==='task' ? host.tasks().find(t=>t.id===focus.id.toLowerCase()) : entities[focus.kind] ? host.get(entities[focus.kind],focus.id.toLowerCase())?.data : null : null;
      return {focus:focused?safe(focused):focus?{status:'unavailable'}:null,profile:safe(profileRow(host)),sites:host.rows('sites').map(r=>({id:r.id,name:r.data.name,domain:siteDomain(r.data),state:host.get('accountStates',r.id)?.data?.state??'unknown'})),tasks:host.tasks().slice(-15).map(target),recentActivity:host.rows('journalEvents').slice(-8).map(r=>safe(r.data))};},
    async read(name,args){
      if(name==='read_profile')return {profile:safe(profileRow(host)),beliefs:host.rows('beliefs').map(r=>safe(r.data)),learning:host.rows('learningProfiles').map(r=>safe(r.data))};
      if(name==='list_sites')return {sites:host.rows('sites').map(r=>safe({id:r.id,...r.data,state:host.get('accountStates',r.id)?.data?.state??'unknown'})),proposals:host.rows('proposals').map(r=>safe(r.data))};
      if(name==='list_tasks')return {tasks:host.tasks().map(target)};
      if(name==='read_search_evidence')return {evidence:host.rows('searchEvidence').map(r=>safe(r.data))};
      if(name==='read_inbox')return {messages:host.inbox().filter(m=>m.kind==='other').map(safe)};
      if(name==='read_site_memory')return {hints:host.hints(args.domain).map(safe)};
      if(name==='read_activity'){const rows=host.rows('journalEvents').map(r=>safe(r.data)).sort((a,b)=>String(b.occurredAt).localeCompare(String(a.occurredAt)));const offset=Number(args.offset??0),limit=Number(args.limit??20);return {items:rows.slice(offset,offset+limit),total:rows.length,nextOffset:offset+limit<rows.length?offset+limit:null};}
      throw new Error('UNKNOWN_READ_TOOL');
    },
    async execute(name,args,operationId){
      const row=profileRow(host);
      if(name==='pause_work'||name==='resume_work'){host.put('profile','profile',{...row,isPaused:name==='pause_work'});return {status:'saved',paused:name==='pause_work'};}
      if(name==='add_site'){
        const domain=String(args.domain??'').trim().toLowerCase().replace(/^https?:\/\//,'').replace(/^www\./,'').split('/')[0];
        if(!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(domain))throw new Error('INVALID_SITE_DOMAIN');
        let s=host.rows('sites').map(r=>({id:r.id,...r.data})).find(s=>siteDomain(s)===domain);
        if(!s){const approved=host.rows('sites').filter(r=>['watching','profileLive','hasAccount'].includes(host.get('accountStates',r.id)?.data?.state)).length;if(!await host.plus()&&approved>=10)return {status:'site_limit',message:'Free supports up to 10 sites.'};s={id:domain,name:domain.split('.')[0],startURLString:`https://${domain}`,category:row.profile?.interests?.[0]??'localGig',goalTemplate:'Find work matching my profile.'};host.put('sites',s.id,s);host.put('accountStates',s.id,{siteID:s.id,state:'proposed'});}
        return draftSite(s,operationId);
      }
      if(name==='join_site')return draftSite(site(host,args.siteId),operationId);
      if(name==='scan_site'){
        const s=site(host,args.siteId),state=host.get('accountStates',s.id)?.data?.state;
        if(!await host.plus()&&monthlyLoggedEarnings(host.rows('journalEvents').map(r=>r.data),new Date())>=FREE_MONTHLY_EARNINGS_LIMIT)return {status:'plan_rested',message:'New searches are resting until next month under the current plan.'};
        if(row.isPaused)return {status:'paused',message:'Resume work before searching.'};
        if(!['watching','profileLive','hasAccount'].includes(state))return {status:'not_approved',message:'This site is not approved for searching yet.'};
        const same=host.tasks().find(t=>t.kind==='discover'&&siteDomain(s)===siteDomain({startURLString:t.target_url})&&['approved','running'].includes(t.status));
        if(same)return {status:'already_running',taskId:same.id};
        const task=await createTask('discover',s,operationId,`Find paid work matching this profile: ${JSON.stringify(safe(row.profile))}. Search criteria from this conversation: ${String(args.criteria??'').slice(0,4000)}. Read only; do not apply, message, join, book or submit.`,false);
        const result=await host.enqueue(task);return {status:result.status,taskId:task.id,message:'Search accepted; this is not evidence that it has finished.'};
      }
      throw new Error('UNKNOWN_ACTION_TOOL');
    },
    async prepare(operation,args){
      if(operation==='stop_site'){const s=site(host,args.siteId);return {title:`Stop watching ${s.name}?`,fingerprint:JSON.stringify({site:s,state:host.get('accountStates',s.id)?.data})};}
      if(operation==='change_floor'){if(typeof args.amount!=='number'||args.amount<=0||args.amount>=1000)throw new Error('INVALID_RATE');return {title:`Set your lowest rate to $${args.amount}/hr?`,fingerprint:JSON.stringify({current:profileRow(host).profile?.hourlyRateFloor,requested:args.amount})};}
      const task=host.tasks().find(t=>t.id===args.taskId);if(!task||task.status!=='awaiting_approval')throw new Error('DRAFT_NOT_PENDING');
      if(operation==='book_task'&&task.kind!=='bookCalendar')throw new Error('NOT_A_BOOKING');
      if(!['approve_task','book_task'].includes(operation))throw new Error('UNKNOWN_PROPOSAL');
      return {title:`Approve “${task.title}”?`,fingerprint:await digest({id:task.id,kind:task.kind,status:task.status,goal:task.goal,url:task.target_url,draft:task.drafted_payload,credential:task.credential_id??null}),details:Object.fromEntries(Object.entries({Destination:task.target_url,...safe(task.drafted_payload)}).map(([key,value])=>[key,String(value)]))};
    },
    async confirm(p,operationId){
      if(p.operation==='stop_site'){host.put('accountStates',p.args.siteId,{siteID:p.args.siteId,state:'stopped'});return {status:'stopped',siteId:p.args.siteId};}
      if(p.operation==='change_floor'){const row=profileRow(host);host.put('profile','profile',{...row,profile:{...row.profile,hourlyRateFloor:p.args.amount}});return {status:'saved',hourlyRateFloor:p.args.amount};}
      const task=host.tasks().find(t=>t.id===p.args.taskId);if(!task)throw new Error('TASK_NOT_FOUND');
      if(task.kind==='bookCalendar')return {status:'device_required',taskId:task.id,payload:task.drafted_payload};
      if(task.status==='needsHuman')throw new Error('ANSWER_CURRENT_TASK_HELP');
      task.status='running';task.log.push(`Approved in conversation (${operationId})`);host.saveTask(task);
      const result=await host.enqueue(task);return {status:result.status,taskId:task.id,message:'Mission accepted; consult task status for completion.'};
    },
    async deviceResult(proposal,success){
      const task=host.tasks().find(t=>t.id===proposal.args.taskId);if(!task||task.kind!=='bookCalendar')throw new Error('NOT_A_BOOKING');
      if(success){task.status='succeeded';task.log.push('Approved calendar event reported saved by the device.');host.saveTask(task);}
    },
    mirrorFile:doc=>host.mirror(doc),
    eraseFile:doc=>host.erase?host.erase(doc):host.mirror({...doc,content:''}),
    publishMessage(event:ChatEvent){
      // Strict previous_response_id policy (Nov 5, 2026): every
      // message written here — an assistant reply AND a user
      // message (recordMessage publishes both) — chains to the
      // previous last message in the transcript, resolved from
      // the live rows now, not from a cached id. The ChatAgent's
      // provider-side chain (meta.responseId) still advances only
      // on real agent turns; this field chains the transcript
      // itself, so the next turn's import keeps the order.
      host.put('messages',event.id,{id:event.id,fromAgent:event.kind==='assistant',text:String(event.value),createdAt:event.at,previousResponseId:lastChatMessageId(host.rows('messages'))});
      // An agent reply is a chat message, so it pushes — the one
      // push-per-message rule covers in-conversation replies too.
      // A push hook must never fail the turn that published the
      // reply, so a throwing notifier is swallowed here.
      if(event.kind==='assistant'){
        try{host.notifyChatMessage?.(event);}catch{/* push delivery must never fail user work */}
      }
    },
    legacyMessages(){return host.rows('messages').map(r=>({...r.data,id:r.id})).filter(m=>typeof m.text==='string'&&!host.deletedMessage(m.id)).sort((a,b)=>String(a.createdAt??'').localeCompare(String(b.createdAt??'')));},
    clearMessages(ids){for(const id of ids)host.remove('messages',id);},
  };
}
