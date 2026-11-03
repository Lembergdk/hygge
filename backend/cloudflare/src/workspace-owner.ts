import type { WorkspaceIdentity } from './workspace-contract.ts';
import type { WorkspaceSqlStorage } from './workspace-runtime.ts';

/** Pin the verified routing identity permanently; never rebind an existing DO. */
export function bindWorkspaceOwner(storage: WorkspaceSqlStorage, userId: string, environment: string, workspaceId: string): WorkspaceIdentity {
  if (!userId || userId.length > 256 || !workspaceId || !['staging', 'production'].includes(environment)) throw new Error('INVALID_OWNER');
  return storage.transactionSync(() => {
    storage.sql.exec('CREATE TABLE IF NOT EXISTS workspace_owner (id INTEGER PRIMARY KEY CHECK(id=1), environment TEXT NOT NULL, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL)');
    const row = [...storage.sql.exec('SELECT environment,user_id,workspace_id FROM workspace_owner WHERE id=1')][0];
    if (row && (row.environment !== environment || row.user_id !== userId || row.workspace_id !== workspaceId)) throw new Error('OWNER_MISMATCH');
    if (!row) storage.sql.exec('INSERT INTO workspace_owner(id,environment,user_id,workspace_id) VALUES (1,?,?,?)', environment, userId, workspaceId);
    return Object.freeze({ environment: environment as WorkspaceIdentity['environment'], userId, workspaceId });
  });
}

/** Independent private keys remain in owner DO SQL; never put them in an API response. */
export function workspaceSecret(storage: WorkspaceSqlStorage, purpose: 'capability' | 'container-rpc' | 'skill-publication'): Uint8Array {
  return storage.transactionSync(() => {
    storage.sql.exec('CREATE TABLE IF NOT EXISTS workspace_secrets (purpose TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const row = [...storage.sql.exec('SELECT value FROM workspace_secrets WHERE purpose=?', purpose)][0];
    if (row) {
      const value = String(row.value);
      if (!/^[0-9a-f]{64}$/.test(value)) throw new Error('INVALID_WORKSPACE_SECRET');
      return Uint8Array.from(value.match(/../g)!, s => parseInt(s, 16));
    }
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    storage.sql.exec('INSERT INTO workspace_secrets(purpose,value) VALUES (?,?)', purpose, Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''));
    return bytes;
  });
}

export function workspaceMode(value: string | undefined): 'legacy' | 'retained-v2' {
  if (value === undefined || value === 'legacy') return 'legacy';
  if (value === 'retained-v2') return value;
  throw new Error('INVALID_WORKSPACE_MODE');
}
