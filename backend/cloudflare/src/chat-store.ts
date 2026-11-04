/** Owner-private durable conversation records. No provider state is the only copy. */
export interface ChatStorage {
  get<T>(key: string): T | undefined;
  put(key: string, value: unknown): void;
  remove(key: string): void;
  list<T>(prefix: string): Array<{ key: string; value: T }>;
  atomic<T>(work: () => T): T;
}
export interface ChatEvent { sequence: number; id: string; kind: 'user'|'assistant'|'system'|'call'|'result'; value: any; at: string }
export interface ChatMeta { id: string; generation: string; sequence: number; cursor: number; summaryThrough: number; summary: string; responseId?: string; activeTurn?: string; lastInputTokens?: number }
export interface ChatProposal { id: string; generation: string; title: string; operation: string; args: any; fingerprint: string; details?: Record<string,string>; status: 'pending'|'executing'|'completed'|'rejected'|'cancelled'|'stale'|'uncertain'; result?: any; createdAt: string }
export interface ChatDocument { generation: string; path: string; content: string; revision: number; kind: 'note'|'file'; provenance: { turnId: string; callId: string }; updatedAt: string; deleted?: boolean; mirrored?: boolean }
export interface ChatTurn { id: string; generation: string; text: string; focus?: {kind:string;id:string}; stage: 'running'|'completed'; rounds: number; toolCount?: number; pending?: { responseId: string; calls: Array<{callId: string; name: string; arguments: any}> }; reply?: string; replyMessageId?: string }
export class ChatStore {
  readonly db: ChatStorage;
  constructor(db: ChatStorage) { this.db=db; }
  meta(): ChatMeta {
    let meta = this.db.get<ChatMeta>('meta');
    if (!meta) { meta = { id: crypto.randomUUID(), generation: crypto.randomUUID(), sequence: 0, cursor: 0, summaryThrough: 0, summary: '' }; this.db.put('meta', meta); }
    return meta;
  }
  save(meta: ChatMeta) { this.db.put('meta', meta); }
  append(kind: ChatEvent['kind'], value: any, id: string = crypto.randomUUID()): ChatEvent {
    return this.db.atomic(() => {
      const meta = this.meta();
      const prior = this.db.get<ChatEvent>(`event-id:${id}`);
      if (prior) return prior;
      const event = { sequence: ++meta.sequence, id, kind, value, at: new Date().toISOString() };
      this.db.put(`event:${String(event.sequence).padStart(12, '0')}`, event);
      this.db.put(`event-id:${id}`, event); this.save(meta); return event;
    });
  }
  events(after = 0): ChatEvent[] { return this.db.list<ChatEvent>('event:').map(r => r.value).filter(e => e.sequence > after).sort((a,b) => a.sequence-b.sequence); }
  proposal(id: string) { return this.db.get<ChatProposal>(`proposal:${id}`); }
  proposals() { const g = this.meta().generation; return this.db.list<ChatProposal>('proposal:').map(r=>r.value).filter(p=>p.generation===g && (['pending','executing','uncertain'].includes(p.status)||p.result?.status==='device_required')); }
  document(path: string) { const d=this.db.get<ChatDocument>(`document:${path}`); return d && !d.deleted ? d : undefined; }
  documents() { return this.db.list<ChatDocument>('document:').map(r=>r.value).filter(d=>!d.deleted); }
  state() { const meta=this.meta(); const active=meta.activeTurn ? this.db.get<ChatTurn>(`turn:${meta.activeTurn}`) : undefined; return { conversationID: meta.id, generation: meta.generation, proposals: this.proposals(), activeTurn: active ? { id:active.id, text:active.text } : null, cleanupPending:this.db.list('cleanup:').length+this.db.list('file-cleanup:').length+this.db.list('file-sync:').length }; }
}
export function sqlChatStorage(storage: {sql: {exec(query:string,...bindings:any[]): Iterable<any>}; transactionSync<T>(fn:()=>T):T}): ChatStorage {
  storage.sql.exec('CREATE TABLE IF NOT EXISTS chat_agent_records (key TEXT PRIMARY KEY, payload TEXT NOT NULL)');
  return {
    get<T>(key:string):T|undefined { const row=[...storage.sql.exec('SELECT payload FROM chat_agent_records WHERE key=?',key)][0]; return row ? JSON.parse(row.payload) : undefined; },
    put(key,value) { storage.sql.exec('INSERT INTO chat_agent_records (key,payload) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload',key,JSON.stringify(value)); },
    remove(key) {storage.sql.exec('DELETE FROM chat_agent_records WHERE key=?',key);},
    list<T>(prefix:string) { return [...storage.sql.exec('SELECT key,payload FROM chat_agent_records WHERE substr(key,1,?)=? ORDER BY key',prefix.length,prefix)].map(r=>({key:String(r.key),value:JSON.parse(r.payload) as T})); },
    atomic<T>(fn:()=>T):T {return storage.transactionSync(fn);},
  };
}
