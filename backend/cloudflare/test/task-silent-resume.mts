// Silent-pause resume, end to end through the HTTP endpoints (PR #116
// Blocker 1 + Blocker 2): a needsHuman task with no help resumes
// through POST /tasks/{id}/continue and /run, the queue consumer
// auto-resumes it within a per-effect budget, and a session-ended
// task goes silent (no recovery prompt) and auto-resumes on GET
// /tasks. Runs UserSandbox in Node with an in-memory DO SQLite
// (see register-cloudflare-stub.mjs) and a stubbed workspace +
// queue; the browser/LLM are never invoked. The stub workspace's
// run records the resume flag the runner receives, so these tests
// prove the endpoint actually triggers a resume — not just that
// runner.run(resume:true) works when called directly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { UserSandbox } from "../src/user-sandbox.ts";
import { enqueueMissionJob } from "../src/jobs.ts";

function fakeCtx() {
  const sqlite = new DatabaseSync(":memory:");
  const kv = new Map<string, unknown>();
  let serial = 0;
  const waitUntil: Promise<unknown>[] = [];
  const sql = {
    exec(query: string, ...args: unknown[]) {
      const trimmed = query.trim();
      if (/^(SELECT|PRAGMA|WITH)\b/i.test(trimmed)) return sqlite.prepare(query).all(...args);
      if (args.length) { sqlite.prepare(query).run(...args); return []; }
      sqlite.exec(query);
      return [];
    },
  };
  const storage = {
    sql,
    transactionSync<T>(fn: () => T): T {
      const sp = `t${serial++}`;
      sqlite.exec(`SAVEPOINT ${sp}`);
      try { const v = fn(); sqlite.exec(`RELEASE ${sp}`); return v; }
      catch (e) { sqlite.exec(`ROLLBACK TO ${sp}`); sqlite.exec(`RELEASE ${sp}`); throw e; }
    },
    get: async (key: string) => kv.get(key),
    put: async (key: string, value: unknown) => { kv.set(key, value); },
    delete: async (key: string) => kv.delete(key),
    setAlarm: async () => {},
  };
  return {
    sqlite,
    waitUntil,
    ctx: {
      storage,
      container: undefined,
      id: { toString: () => "test-do-id" },
      waitUntil: (p: Promise<unknown>) => { waitUntil.push(p); },
      blockConcurrencyWhile: (fn: () => unknown) => fn(),
    },
  };
}

function makeSandbox() {
  const { ctx, sqlite } = fakeCtx();
  const sent: any[] = [];
  const env: any = {
    HYGGE_LLM_API_KEY: "test-key",
    HYGGE_LLM_BASE_URL: "https://llm.test",
    HYGGE_LLM_MODEL_FAST: "m-fast",
    HYGGE_LLM_MODEL_STRONG: "m-strong",
    HYGGE_ENV: "staging",
    HYGGE_WORKSPACE_MODE: "retained-v2",
    DB: { prepare: () => ({ bind: () => ({ first: async () => null, run: async () => ({}) }) }) },
    MISSION_QUEUE: { send: async (msg: any) => { sent.push(msg); } },
  };
  const sandbox = new UserSandbox(ctx as any, env as any);
  // Skip the schema/DEK preflight: the tests exercise the task
  // endpoints, not credential migration, and there is no D1 here.
  (sandbox as any).schemaReady = Promise.resolve();
  // Stub workspace: run records the resume flag and persists its
  // result the way the runner's projectTask would, so a later
  // delivery loads the paused state. The browser is dead by
  // construction (hasSession false) for the session-ended test.
  let runImpl: (task: any, resume: boolean) => any = (task) => ({ ...task, status: "succeeded", help: null });
  const runs: Array<{ taskId: string; resume: boolean }> = [];
  const reconciles: Array<{ taskId: string; effectId: string }> = [];
  const stubWorkspace: any = {
    imageUpgrade: { locked: () => false },
    runner: { progress: () => null },
    browser: { hasSession: () => false, closeSession: async () => true },
    run: async (task: any, _mission: any, resume: boolean) => {
      runs.push({ taskId: task.id, resume });
      const result = runImpl(task, resume);
      (sandbox as any).saveTask(result);
      return result;
    },
    reconcile: async (taskId: string, effectId: string) => {
      reconciles.push({ taskId, effectId });
      // The real runner persists the reconciled task (including a
      // preserved help and the auto-resume counters) and returns
      // it; merge the stored row so the stub does the same.
      const stored = taskRow(taskId) ?? { id: taskId };
      return { ...stored, status: "needsHuman", help: stored.help ?? null, workspace_pending_effect_id: null };
    },
  };
  (sandbox as any).workspace = () => stubWorkspace;
  const taskRow = (id: string) => {
    const rows = [...sqlite.prepare("SELECT task FROM tasks WHERE id = ?").all(id)] as any[];
    return rows.length ? JSON.parse(String(rows[0].task)) : null;
  };
  const seedTask = (task: any) => {
    sqlite.prepare("INSERT INTO tasks (id, task) VALUES (?, ?)").run(task.id, JSON.stringify(task));
  };
  const call = async (path: string, opts: { method?: string; body?: any; headers?: Record<string, string> } = {}) => {
    const res = await (sandbox as any).fetch(new Request(`https://api.test${path}`, {
      method: opts.method ?? "GET",
      headers: { "x-hygge-user-id": "user-1", "content-type": "application/json", ...(opts.headers ?? {}) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }));
    const text = await res.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: res.status, body, text };
  };
  const waitForSent = async (n: number) => {
    const start = Date.now();
    while (sent.length < n) {
      if (Date.now() - start > 2000) throw new Error(`queue stuck at ${sent.length}, wanted ${n}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  const settle = async (ms = 100) => { await new Promise((r) => setTimeout(r, ms)); };
  const messages = () => (sandbox as any).stateStore().list("messages");
  return { sandbox, ctx, sent, runs, reconciles, taskRow, seedTask, call, waitForSent, settle, messages,
    setRunImpl: (fn: (task: any, resume: boolean) => any) => { runImpl = fn; } };
}

const SILENT_TASK = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "discover",
  target_url: "https://fiverr.example/search",
  goal: "Scan Fiverr",
  title: "Scan Fiverr",
  drafted_payload: {},
  interaction_version: 1,
  status: "needsHuman",
  help: null,
  workspace_pending_effect_id: "fx_1",
  session_id: null,
  browser_trace: [],
  extracted_items: [],
  information_requests: [],
  log: [],
};

test("POST /tasks/{id}/continue resumes a silent pause end to end, through the queue", async () => {
  const t = makeSandbox();
  t.seedTask({ ...SILENT_TASK });
  const continued = await t.call(`/tasks/${SILENT_TASK.id}/continue`, { method: "POST", body: {} });
  assert.equal(continued.status, 200, "a silent pause does not 409 on /continue");
  assert.equal(continued.body.status, "running");
  assert.equal(t.sent.length, 1, "the resume is enqueued");
  assert.equal(t.sent[0].taskId, SILENT_TASK.id);
  // Deliver the queued job: the consumer runs the mission.
  const delivered = await t.call("/internal/jobs/run", {
    method: "POST", body: t.sent[0], headers: { "x-hygge-job-consumer": "1" },
  });
  assert.equal(delivered.status, 200);
  assert.equal(t.runs.length, 1, "the mission ran");
  assert.equal(t.runs[0].taskId, SILENT_TASK.id);
  assert.equal(t.runs[0].resume, true, "the mission ran as a resume");
  assert.equal(delivered.body.taskStatus, "succeeded");
  assert.equal(t.taskRow(SILENT_TASK.id).status, "succeeded");
});

test("a needsHuman task handed to the queue consumer resumes with resume=true", async () => {
  // This isolates the runTask fix: the task is still needsHuman
  // (not flipped to running by /continue) when the consumer runs
  // it, so resume=true can only come from the needsHuman+help:null
  // branch. Without that branch the runner would refuse and the
  // task would stay needsHuman.
  const t = makeSandbox();
  t.seedTask({ ...SILENT_TASK });
  const { job } = enqueueMissionJob(t.ctx.storage, SILENT_TASK.id, new Date().toISOString(), crypto.randomUUID());
  const delivered = await t.call("/internal/jobs/run", {
    method: "POST",
    body: { v: 1, jobId: job.jobId, userId: "user-1", taskId: SILENT_TASK.id, enqueuedAt: new Date().toISOString() },
    headers: { "x-hygge-job-consumer": "1" },
  });
  assert.equal(delivered.status, 200);
  assert.equal(t.runs.length, 1);
  assert.equal(t.runs[0].resume, true, "needsHuman + help:null resumes");
  assert.equal(delivered.body.taskStatus, "succeeded");
});

test("POST /tasks/{id}/run resumes a silent pause; a help-bearing pause still 409s", async () => {
  const t = makeSandbox();
  t.seedTask({ ...SILENT_TASK });
  const ran = await t.call(`/tasks/${SILENT_TASK.id}/run`, { method: "POST", body: {} });
  assert.equal(ran.status, 200, "a silent pause does not 409 on /run");
  assert.equal(t.sent.length, 1);
  // A pause with a live request still needs the user to reply.
  const withHelp = {
    ...SILENT_TASK,
    id: "22222222-2222-4222-8222-222222222222",
    help: { id: "33333333-3333-4333-8333-333333333333", kind: "verification", message: "Finish the check.", questions: [], actionLabel: "Complete check", deadline: null },
  };
  t.seedTask(withHelp);
  const runBlocked = await t.call(`/tasks/${withHelp.id}/run`, { method: "POST", body: {} });
  assert.equal(runBlocked.status, 409, "/run still 409s when a request is live");
  assert.match(String(runBlocked.body.error), /Reply to the current request/);
  const continueBlocked = await t.call(`/tasks/${withHelp.id}/continue`, { method: "POST", body: {} });
  assert.equal(continueBlocked.status, 409, "/continue still 409s without a matching reply");
  assert.equal(t.sent.length, 1, "no resume was enqueued for the help-bearing pause");
});

test("the queue consumer auto-resumes a silent pause, bounded to three per effect", async () => {
  const t = makeSandbox();
  // Every mission run pauses silently on the same effect: the
  // agent re-observes, cannot confirm it, and pauses again.
  t.setRunImpl((task) => ({ ...task, status: "needsHuman", help: null, workspace_pending_effect_id: "fx_1" }));
  t.seedTask({ ...SILENT_TASK });
  const { job } = enqueueMissionJob(t.ctx.storage, SILENT_TASK.id, new Date().toISOString(), crypto.randomUUID());
  const deliver = async (msg: any) => {
    const res = await t.call("/internal/jobs/run", {
      method: "POST", body: msg, headers: { "x-hygge-job-consumer": "1" },
    });
    assert.equal(res.status, 200);
    return res;
  };
  await deliver({ v: 1, jobId: job.jobId, userId: "user-1", taskId: SILENT_TASK.id, enqueuedAt: new Date().toISOString() });
  await t.waitForSent(1);
  assert.equal(t.taskRow(SILENT_TASK.id).auto_resume_count, 1);
  await deliver(t.sent[0]);
  await t.waitForSent(2);
  assert.equal(t.taskRow(SILENT_TASK.id).auto_resume_count, 2);
  await deliver(t.sent[1]);
  await t.waitForSent(3);
  assert.equal(t.taskRow(SILENT_TASK.id).auto_resume_count, 3);
  // The budget is spent: the fourth delivery pauses and stays paused.
  await deliver(t.sent[2]);
  await t.settle();
  assert.equal(t.sent.length, 3, "no fourth auto-resume once the budget is spent");
  assert.equal(t.taskRow(SILENT_TASK.id).auto_resume_count, 3);
  assert.equal(t.taskRow(SILENT_TASK.id).status, "needsHuman");
  assert.equal(t.taskRow(SILENT_TASK.id).help, null);
});

test("GET /tasks: a session-ended task goes silent and auto-resumes, with no recovery prompt", async () => {
  const t = makeSandbox();
  t.seedTask({
    ...SILENT_TASK,
    id: "44444444-4444-4444-8444-444444444444",
    status: "running",
    session_id: "dead-session",
    workspace_pending_effect_id: "fx_9",
  });
  const first = await t.call("/tasks");
  assert.equal(first.status, 200);
  const row = first.body.tasks.find((x: any) => x.id === "44444444-4444-4444-8444-444444444444");
  assert.ok(row, "the task is listed");
  assert.equal(row.mobile_task.help, null, "no recovery prompt is surfaced");
  assert.equal(row.mobile_task.pendingEffectID, "fx_9");
  const stored = t.taskRow("44444444-4444-4444-8444-444444444444");
  assert.equal(stored.status, "needsHuman");
  assert.equal(stored.help, null, "no recovery help is stored");
  assert.equal(stored.session_id, null);
  assert.equal(stored.failure.code, "session_ended");
  assert.equal(t.messages().length, 0, "a silent pause composes no chat message and no push");
  await t.waitForSent(1);
  assert.equal(t.sent[0].taskId, "44444444-4444-4444-8444-444444444444");
  assert.equal(stored.auto_resume_count, 1);
  // A second poll does not re-enqueue: the session is already cleared.
  await t.call("/tasks");
  await t.settle();
  assert.equal(t.sent.length, 1, "the session-end auto-resume fires once");
});

test("POST /tasks/{id}/reconcile drops reviewed:true and ignores a client-supplied status", async () => {
  const t = makeSandbox();
  t.seedTask({ ...SILENT_TASK });
  // No reviewed flag at all: the endpoint must not require one.
  const plain = await t.call(`/tasks/${SILENT_TASK.id}/reconcile`, { method: "POST", body: { effectId: "fx_1" } });
  assert.equal(plain.status, 200);
  assert.equal(plain.body.status, "needsHuman");
  assert.deepEqual(t.reconciles, [{ taskId: SILENT_TASK.id, effectId: "fx_1" }]);
  // A client-supplied status (and reviewed:true) must not steer the
  // outcome: the server determines it from the page.
  const withStatus = await t.call(`/tasks/${SILENT_TASK.id}/reconcile`, {
    method: "POST", body: { effectId: "fx_1", reviewed: true, status: "confirmed" },
  });
  assert.equal(withStatus.status, 200);
  assert.equal(withStatus.body.status, "needsHuman", "the client-supplied status is ignored");
  assert.equal(t.reconciles.length, 2);
  // effectId is still required.
  const missing = await t.call(`/tasks/${SILENT_TASK.id}/reconcile`, { method: "POST", body: {} });
  assert.equal(missing.status, 400);
  const unknown = await t.call("/tasks/55555555-5555-4555-8555-555555555555/reconcile", { method: "POST", body: { effectId: "fx_1" } });
  assert.equal(unknown.status, 404);
});

test("POST /tasks/{id}/reconcile resumes a silent pause instead of leaving it stuck", async () => {
  // Round-2 finding 1: reconcile clears the pending effect, so no
  // other path resumes the task afterward (GET /tasks only
  // auto-resumes on a session end; the queue consumer only after a
  // run). The endpoint must trigger the resume itself.
  const t = makeSandbox();
  t.seedTask({ ...SILENT_TASK });
  const res = await t.call(`/tasks/${SILENT_TASK.id}/reconcile`, { method: "POST", body: { effectId: "fx_1" } });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "needsHuman");
  assert.equal(t.sent.length, 1, "reconcile schedules a resume — nothing else resumes the task");
  assert.equal(t.sent[0].taskId, SILENT_TASK.id);
  assert.equal(t.taskRow(SILENT_TASK.id).auto_resume_count, 1);
  assert.equal(t.taskRow(SILENT_TASK.id).auto_resume_total, 1);
  // Deliver the queued job: the mission runs as a resume and completes.
  const delivered = await t.call("/internal/jobs/run", {
    method: "POST", body: t.sent[0], headers: { "x-hygge-job-consumer": "1" },
  });
  assert.equal(delivered.status, 200);
  assert.equal(t.runs.length, 1);
  assert.equal(t.runs[0].resume, true, "the reconciled task resumes");
  assert.equal(t.taskRow(SILENT_TASK.id).status, "succeeded");
});

test("POST /tasks/{id}/reconcile preserves a legitimate help and does not auto-resume", async () => {
  // Round-2 finding 1 (second half): the app only calls this
  // endpoint while a help is live, so the reachable case is a task
  // with both a help and a pending effect. Reconcile must not
  // destroy the request the user is meant to answer, and a
  // help-bearing pause is a real stop — no auto-resume.
  const t = makeSandbox();
  const help = { id: "33333333-3333-4333-8333-333333333333", kind: "verification", message: "Finish the check.", questions: [], actionLabel: "Complete check", deadline: null };
  const id = "66666666-6666-4666-8666-666666666666";
  t.seedTask({ ...SILENT_TASK, id, help });
  const res = await t.call(`/tasks/${id}/reconcile`, { method: "POST", body: { effectId: "fx_1" } });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "needsHuman");
  assert.equal(res.body.help?.id, help.id, "the help survives reconcile");
  assert.equal(t.sent.length, 0, "a help-bearing pause is never auto-resumed");
  const stored = t.taskRow(id);
  assert.equal(stored.status, "needsHuman");
  assert.equal(stored.help?.id, help.id);
});

test("the queue consumer auto-resumes across new effects, bounded to nine total", async () => {
  // Round-2 finding 2: every mission run pauses silently on a NEW
  // effect, so the per-effect budget resets each time and only the
  // per-task total can stop the loop. A persistently-failing task
  // must stop after nine auto-resumes and stay paused and visible.
  const t = makeSandbox();
  let effect = 0;
  t.setRunImpl((task) => ({ ...task, status: "needsHuman", help: null, workspace_pending_effect_id: `fx_${++effect}` }));
  t.seedTask({ ...SILENT_TASK });
  const { job } = enqueueMissionJob(t.ctx.storage, SILENT_TASK.id, new Date().toISOString(), crypto.randomUUID());
  const deliver = async (msg: any) => {
    const res = await t.call("/internal/jobs/run", {
      method: "POST", body: msg, headers: { "x-hygge-job-consumer": "1" },
    });
    assert.equal(res.status, 200);
    return res;
  };
  await deliver({ v: 1, jobId: job.jobId, userId: "user-1", taskId: SILENT_TASK.id, enqueuedAt: new Date().toISOString() });
  // Nine auto-resumes, one per new effect: deliver each queued message in turn.
  for (let i = 0; i < 9; i++) {
    await t.waitForSent(i + 1);
    await deliver(t.sent[i]);
  }
  await t.settle();
  assert.equal(t.sent.length, 9, "no tenth auto-resume once the total budget is spent");
  assert.equal(t.taskRow(SILENT_TASK.id).auto_resume_total, 9);
  assert.equal(t.taskRow(SILENT_TASK.id).auto_resume_count, 1, "the per-effect count resets on every new effect — it alone never stops the loop");
  assert.equal(t.taskRow(SILENT_TASK.id).status, "needsHuman");
  assert.equal(t.taskRow(SILENT_TASK.id).help, null);
});
