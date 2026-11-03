import { DatabaseSync } from 'node:sqlite';
import type { WorkspaceStorage } from '../../src/workspace-persistence.ts';
export function sqliteWorkspace() {
  const sqlite=new DatabaseSync(':memory:'); let serial=0;
  const storage:WorkspaceStorage={sql:{exec(query,...args){return sqlite.prepare(query).all(...args) as Record<string,unknown>[];}}, transactionSync<T>(fn:()=>T):T {
    const savepoint='workspace_'+serial++; sqlite.exec('SAVEPOINT '+savepoint);
    try { const value=fn(); sqlite.exec('RELEASE '+savepoint); return value; }
    catch(error){sqlite.exec('ROLLBACK TO '+savepoint);sqlite.exec('RELEASE '+savepoint);throw error;}
  }};
  return {sqlite,storage};
}
