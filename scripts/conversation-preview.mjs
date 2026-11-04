// Loopback-only iOS native conversation protocol fixture. No model or cloud traffic.
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
let generation=randomUUID(),activeTurn=null,failOnce=true;
const messages=[],turns=new Map();
let proposals=[{id:randomUUID(),generation,title:'Set your lowest rate to $35/hr?',operation:'change_floor',status:'pending',details:{'Current rate':'$25/hr','Proposed rate':'$35/hr'}}];
const state=()=>({conversationID:'local-ui-fixture',generation,activeTurn,proposals,cleanupPending:0});
const add=(id,text,fromAgent)=>{if(!messages.some(m=>m.id===id))messages.push({id,updatedAt:new Date().toISOString(),data:{id,text,fromAgent,createdAt:new Date().toISOString()}});};
createServer(async(req,res)=>{
 let raw='';for await(const c of req)raw+=c;const body=raw?JSON.parse(raw):{};const path=req.url;
 const json=(v,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(v));};
 console.log(`${req.method} ${path}`);
 if(path==='/chat/state')return json(state());
 if(path==='/state/export')return json({messages,counts:{},hasRealFeedItem:false});
 if(path==='/state/import')return json({hasRealFeedItem:false});
 if(path==='/tasks')return json({tasks:[]});
 if(path==='/chat/reset'){generation=randomUUID();messages.length=0;proposals=[];activeTurn=null;turns.clear();return json(state());}
 if(path.startsWith('/chat/proposals/')){proposals=[];const id=randomUUID();add(id,'That proposal was declined. Your current rate is unchanged.',true);return json({...state(),reply:messages.at(-1).data.text,replyMessageId:id});}
 if(path==='/chat/turn'){
  if(body.generation!==generation)return json({error:'CONVERSATION_CHANGED'},409);
  res.writeHead(200,{'content-type':'text/event-stream'});const send=e=>res.write(`data: ${JSON.stringify(e)}\n\n`);
  const id=body.id;if(turns.has(id)){send({type:'final',data:turns.get(id)});return res.end();}
  if(!activeTurn){activeTurn={id,text:body.text};add(id,body.text,false);}
  if(failOnce){failOnce=false;send({type:'error'});return res.end();}
  const reply='Your saved turn resumed successfully. Both signup drafts are ready for review; nothing has been submitted.';
  for(const text of ['Your saved turn ', 'resumed successfully. '])send({type:'reply-delta',text});
  const replyMessageId=randomUUID();add(replyMessageId,reply,true);activeTurn=null;const result={...state(),reply,replyMessageId};turns.set(id,result);send({type:'final',data:result});return res.end();
 }
 if(path==='/health')return json({ok:true});return json({items:[]});
}).listen(18769,'127.0.0.1',()=>console.log('Conversation preview http://127.0.0.1:18769'));
