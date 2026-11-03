import type { RunCompletionReceipt } from './workspace-contract.ts';
import { WorkspacePersistence, canonical, fail, type WorkspaceStorage } from './workspace-persistence.ts';
import { StateStore, createSqliteStateDb, ensureStateSchema } from './state.ts';
export type WorkspaceTask = Record<string, any> & { id:string; status:string };
export interface TaskProjectionMeta { runId:string; requestId:string; completionReceiptId?:string }
export type TaskProjector = (task:WorkspaceTask,meta:TaskProjectionMeta)=>void;
/** Uses the existing tasks/state schema and the caller's SAME DO SQL transaction. */
export function createWorkspaceTaskProjection(storage:WorkspaceStorage,db:WorkspacePersistence,now=()=>new Date().toISOString()):TaskProjector {
  storage.transactionSync(()=>{
    storage.sql.exec("CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, task TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))");
    ensureStateSchema(sql=>{for(const statement of sql.split(';').map(s=>s.trim()).filter(Boolean))storage.sql.exec(statement);});
  });
  const store=new StateStore(createSqliteStateDb({exec:(sql,...values)=>storage.sql.exec(sql,...values.map(v=>typeof v==='string'||typeof v==='number'||v===null?v:fail('INVALID_SQL_VALUE')))}));
  return (input,meta)=>storage.transactionSync(()=>{
    const task=JSON.parse(JSON.stringify(input)) as WorkspaceTask;
    if(task.status==='succeeded'){
      const receipt=meta.completionReceiptId?db.get<RunCompletionReceipt>('completion',meta.completionReceiptId)?.value:null;
      if(!receipt||receipt.taskId!==task.id||receipt.runId!==meta.runId) fail('UNCOMMITTED_TASK_SUCCESS');
    }
    const key='projection/'+meta.requestId;
    const old=db.get<{digest:string}>('task_projection',key);
    const text=canonical(task);
    if(old){if(old.value.digest!==text)fail('IDEMPOTENCY_CONFLICT');return;}
    const timestamp=now(); task.updated_at=timestamp; task.updatedAt=timestamp;
    storage.sql.exec('INSERT INTO tasks (id,task) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET task=excluded.task',task.id,JSON.stringify(task));
    if(task.help&&task.mobile_task&&!store.get('messages',task.help.id))store.upsert('messages',task.help.id,{id:task.help.id,fromAgent:true,text:`${task.mobile_task.title}: ${task.help.message}`,taskID:task.mobile_task.id,helpID:task.help.id,createdAt:timestamp},timestamp);
    if(task.mobile_task?.siteID&&['signup','buildProfile'].includes(task.kind)){
      const siteID=task.mobile_task.siteID;
      const state=task.status==='succeeded'?(task.kind==='buildProfile'||task.drafted_payload?.setupMode==='connect'?'watching':'hasAccount'):['needsHuman','failed'].includes(task.status)?'needsVerification':null;
      if(state)store.upsert('accountStates',siteID,{siteID,state},timestamp);
      if(task.status==='succeeded'&&!store.get('journalEvents',task.id))store.upsert('journalEvents',task.id,{id:task.id,occurredAt:timestamp,kind:task.kind==='buildProfile'?'profileLive':'joinedSite',sentence:task.kind==='buildProfile'?'Your profile is live.':'Your account is ready.',detail:'',siteID,applicationID:null,grossAmount:null,currencyCode:'USD',listingsChecked:0},timestamp);
    }
    db.put('task_projection',key,0,{digest:text});
    db.put('task_projection_outbox',meta.requestId,0,{taskId:task.id,runId:meta.runId,status:task.status,updatedAt:timestamp});
  });
}
