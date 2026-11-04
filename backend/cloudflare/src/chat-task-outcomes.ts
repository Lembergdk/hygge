import type {ChatStore} from './chat-store.ts';

/** Invoke only from canonical workspace projection, in the same owner SQL transaction.
 * This is a separate history observation, never another output for an earlier native call.
 */
export function recordWorkspaceTaskOutcome(store:ChatStore,task:Record<string,any>){
 if(!store.db.get('meta')||!['succeeded','failed','needsHuman','rejected'].includes(task.status))return null;
 const value={kind:'task_outcome',source:'workspace_runtime',taskId:task.id,
  runId:task.workspace_run_id??null,sequence:task.workspace_sequence??0,status:task.status,
  pendingEffectId:task.workspace_pending_effect_id??null,helpKind:task.help?.kind??null,
  requiresReview:task.status==='needsHuman'||!!task.workspace_pending_effect_id,
 };
 const id=`task-outcome:${JSON.stringify([value.taskId,value.runId,value.sequence,value.status,value.pendingEffectId,task.help?.id??null])}`;
 return store.append('system',value,id);
}
