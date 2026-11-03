import type { WorkspaceSkills } from './workspace-skills.ts';

function response(body:unknown,status=200){return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});}
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('INVALID_REQUEST');return value as Record<string,unknown>;}
function keys(body:Record<string,unknown>,required:string[]){if(Object.keys(body).some(k=>!required.includes(k))||required.some(k=>!Object.hasOwn(body,k)))throw new Error('INVALID_REQUEST');}
function string(value:unknown){if(typeof value!=='string'||!value||value.length>4096)throw new Error('INVALID_REQUEST');return value;}
/** Root routes ONLY after authenticated user->owner DO resolution. No signing endpoint exists. */
export async function handleWorkspaceSkillRequest(request:Request,skills:WorkspaceSkills):Promise<Response>{
  const url=new URL(request.url);const op=url.pathname.replace(/\/$/,'').split('/').at(-1);
  try{
    if(request.method==='GET'&&op==='skills'){
      return response({selection:await skills.resolve(url.searchParams.get('origin')??'',url.searchParams.get('outcome')??'')});
    }
    if(request.method!=='POST')return response({error:'METHOD_NOT_ALLOWED'},405);
    const raw=await request.text();if(new TextEncoder().encode(raw).length>24_576)return response({error:'REQUEST_TOO_LARGE'},413);
    const b=object(JSON.parse(raw));
    const capabilityToken=string(request.headers.get('x-hygge-runtime-capability'));
    const mutation=()=>{
      const revision=b.expectedRevision;if(!Number.isSafeInteger(revision)||Number(revision)<0)throw new Error('INVALID_REQUEST');
      return {capabilityToken,requestId:string(b.requestId),expectedRevision:Number(revision)};
    };
    switch(op){
      case 'candidate':keys(b,['requestId','expectedRevision','candidateId','taskId','body']);return response(await skills.recordCandidate(mutation(),{candidateId:string(b.candidateId),taskId:string(b.taskId),body:b.body}));
      case 'outcome':keys(b,['requestId','expectedRevision','candidateId','receiptId']);return response(await skills.recordOutcome(mutation(),{candidateId:string(b.candidateId),receiptId:string(b.receiptId)}));
      case 'trace-candidate':keys(b,['requestId','expectedRevision','candidateId','receiptId','trace']);if(!Array.isArray(b.trace))throw new Error('INVALID_REQUEST');return response(await skills.captureTraceCandidate(mutation(),{candidateId:string(b.candidateId),receiptId:string(b.receiptId),trace:b.trace}));
      case 'publish':keys(b,['candidateId']);return response(await skills.publishCandidate(capabilityToken,string(b.candidateId)));
      case 'pin':keys(b,['requestId','expectedRevision','taskId','runId','skillId']);return response(await skills.pinRunSkill(mutation(),{taskId:string(b.taskId),runId:string(b.runId),skillId:string(b.skillId)}));
      case 'admit':keys(b,['admissionId','skillId','version','epoch','taskId']);return response({admission:await skills.admit(capabilityToken,{admissionId:string(b.admissionId),skillId:string(b.skillId),version:b.version as number,epoch:b.epoch as number,taskId:string(b.taskId)})});
      case 'consume':keys(b,['admissionId','effectId','taskId']);return response({consumed:await skills.consume(capabilityToken,{admissionId:string(b.admissionId),effectId:string(b.effectId),taskId:string(b.taskId)})});
      case 'usage':keys(b,['skillId','receiptId']);return response({recorded:await skills.usage(capabilityToken,{skillId:string(b.skillId),receiptId:string(b.receiptId)})});
      default:return response({error:'NOT_FOUND'},404);
    }
  }catch{return response({error:'SKILL_REQUEST_REJECTED'},409);}
}
