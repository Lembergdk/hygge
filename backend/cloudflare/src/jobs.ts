import type { WorkspaceSqlStorage } from "./workspace-runtime.ts";

/// Durable mission jobs (durable job queue): approving work records
/// a job in the owner's Durable Object and submits it to a
/// Cloudflare Queue; the consumer hands it back to the same object
/// to run. Execution therefore survives the approving request, a
/// client disconnect, and an isolate termination: an unacked
/// message is redelivered and the object resumes the orphaned task
/// through the existing checkpoint path. Messages carry ids only —
/// never payloads, drafts, or secrets — because everything a
/// mission needs already lives in the owner's object.

export interface MissionJobMessage {
  v: 1;
  jobId: string;
  userId: string;
  taskId: string;
  enqueuedAt: string;
}

const MESSAGE_KEYS = new Set(["v", "jobId", "userId", "taskId", "enqueuedAt"]);

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

/// Strict parse: the queue only ever carries messages this worker
/// minted, so anything misshapen is corruption to drop, never a
/// shape to improvise around.
export function parseMissionJobMessage(raw: unknown): MissionJobMessage | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const keys = Object.keys(raw as Record<string, unknown>);
  if (keys.length !== MESSAGE_KEYS.size || keys.some((k) => !MESSAGE_KEYS.has(k))) return null;
  const m = raw as Record<string, unknown>;
  if (m.v !== 1 || !isId(m.jobId) || !isId(m.userId) || !isId(m.taskId)) return null;
  if (typeof m.enqueuedAt !== "string" || Number.isNaN(Date.parse(m.enqueuedAt))) return null;
  return Object.freeze({
    v: 1, jobId: m.jobId, userId: m.userId, taskId: m.taskId, enqueuedAt: m.enqueuedAt,
  });
}

export type MissionJobState = "queued" | "running" | "done" | "failed";

export interface MissionJobRow {
  jobId: string;
  taskId: string;
  state: MissionJobState;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  lastError: string | null;
}

const ACTIVE_STATES = new Set<MissionJobState>(["queued", "running"]);

export function isTerminalJobState(state: MissionJobState): boolean {
  return !ACTIVE_STATES.has(state);
}

export function ensureMissionJobsTable(storage: WorkspaceSqlStorage): void {
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS mission_jobs (
      job_id TEXT PRIMARY KEY, task_id TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS mission_jobs_task ON mission_jobs(task_id, state);
  `);
}

function rowFrom(r: Record<string, unknown>): MissionJobRow {
  return {
    jobId: String(r.job_id), taskId: String(r.task_id),
    state: String(r.state) as MissionJobState,
    attempts: Number(r.attempts ?? 0),
    createdAt: String(r.created_at), updatedAt: String(r.updated_at),
    lastError: r.last_error == null ? null : String(r.last_error),
  };
}

export function getMissionJob(storage: WorkspaceSqlStorage, jobId: string): MissionJobRow | null {
  ensureMissionJobsTable(storage);
  const rows = [...storage.sql.exec("SELECT * FROM mission_jobs WHERE job_id = ?", jobId)];
  return rows.length ? rowFrom(rows[0]) : null;
}

/** Metadata only: broad task status does not prove a delivery has started. */
export function latestMissionJob(storage:WorkspaceSqlStorage,taskId:string):MissionJobRow|null {
  ensureMissionJobsTable(storage);
  const rows=[...storage.sql.exec('SELECT * FROM mission_jobs WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',taskId)];
  return rows.length?rowFrom(rows[0]):null;
}

/// One active job per task: a duplicate submission (double approve,
/// retried request) returns the job already in flight instead of
/// minting a second dispatch. A terminal job never blocks a new
/// submission for the same task.
export function enqueueMissionJob(
  storage: WorkspaceSqlStorage, taskId: string, nowIso: string, newJobId: string,
): { job: MissionJobRow; created: boolean } {
  return storage.transactionSync(() => {
    ensureMissionJobsTable(storage);
    const active = [...storage.sql.exec(
      "SELECT * FROM mission_jobs WHERE task_id = ? AND state IN ('queued','running') ORDER BY created_at LIMIT 1",
      taskId)];
    if (active.length) return { job: rowFrom(active[0]), created: false };
    storage.sql.exec(
      "INSERT INTO mission_jobs (job_id, task_id, state, attempts, created_at, updated_at) VALUES (?, ?, 'queued', 0, ?, ?)",
      newJobId, taskId, nowIso, nowIso);
    return {
      job: {
        jobId: newJobId, taskId, state: "queued" as const, attempts: 0,
        createdAt: nowIso, updatedAt: nowIso, lastError: null,
      },
      created: true,
    };
  });
}

/// Claim for one delivery attempt. Terminal rows come back as
/// themselves so a redelivery after completion acks without
/// re-running; unknown ids return null (poison — ack, never retry).
export function claimMissionJob(
  storage: WorkspaceSqlStorage, jobId: string, nowIso: string,
): MissionJobRow | null {
  return storage.transactionSync(() => {
    const job = getMissionJob(storage, jobId);
    if (!job || isTerminalJobState(job.state)) return job;
    storage.sql.exec(
      "UPDATE mission_jobs SET state = 'running', attempts = attempts + 1, updated_at = ? WHERE job_id = ?",
      nowIso, jobId);
    return { ...job, state: "running" as const, attempts: job.attempts + 1, updatedAt: nowIso };
  });
}

/// Terminal transition, first finish wins: a late duplicate finish
/// can never rewrite the recorded outcome.
export function finishMissionJob(
  storage: WorkspaceSqlStorage, jobId: string,
  outcome: "done" | "failed", nowIso: string, error?: string | null,
): MissionJobRow | null {
  return storage.transactionSync(() => {
    const job = getMissionJob(storage, jobId);
    if (!job || isTerminalJobState(job.state)) return job;
    storage.sql.exec(
      "UPDATE mission_jobs SET state = ?, updated_at = ?, last_error = ? WHERE job_id = ?",
      outcome, nowIso, error ? String(error).slice(0, 500) : job.lastError, jobId);
    return { ...job, state: outcome, updatedAt: nowIso, lastError: error ? String(error).slice(0, 500) : job.lastError };
  });
}

/// Consumer delivery decision from the owner's answer. Completed
/// and poison messages ack; only transient failures retry (and the
/// queue's own retry budget then routes them to the dead-letter
/// queue, where the job is marked failed visibly).
export function jobAckDecision(doStatus: number): "ack" | "retry" {
  if (doStatus === 200 || doStatus === 400 || doStatus === 404) return "ack";
  return "retry";
}
