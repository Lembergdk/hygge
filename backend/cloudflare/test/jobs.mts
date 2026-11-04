import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseMissionJobMessage, enqueueMissionJob, claimMissionJob,
  finishMissionJob, getMissionJob, jobAckDecision,
} from "../src/jobs.ts";
import { sqliteWorkspace } from "./helpers/workspace-sqlite.mts";

const NOW = "2026-11-04T03:00:00.000Z";
const LATER = "2026-11-04T03:01:00.000Z";

test("queue messages carry ids only and parse strictly", () => {
  const good = { v: 1, jobId: "j1", userId: "u1", taskId: "t1", enqueuedAt: NOW };
  assert.deepEqual(parseMissionJobMessage(good), good);
  // Anything beyond ids + version + timestamp is corruption, not
  // a message to improvise around.
  assert.equal(parseMissionJobMessage(null), null);
  assert.equal(parseMissionJobMessage("j1"), null);
  assert.equal(parseMissionJobMessage({ ...good, v: 2 }), null);
  assert.equal(parseMissionJobMessage({ ...good, jobId: "" }), null);
  assert.equal(parseMissionJobMessage({ ...good, userId: 7 }), null);
  assert.equal(parseMissionJobMessage({ ...good, enqueuedAt: "not a date" }), null);
  assert.equal(parseMissionJobMessage({ ...good, payload: "secret" }), null);
});

test("one active job per task: duplicate submission reuses it", () => {
  const { storage } = sqliteWorkspace();
  const first = enqueueMissionJob(storage as any, "t1", NOW, "j1");
  assert.equal(first.created, true);
  assert.equal(first.job.state, "queued");
  assert.equal(first.job.attempts, 0);

  const again = enqueueMissionJob(storage as any, "t1", LATER, "j2");
  assert.equal(again.created, false);
  assert.equal(again.job.jobId, "j1", "double approve cannot double-dispatch");

  const other = enqueueMissionJob(storage as any, "t2", LATER, "j3");
  assert.equal(other.created, true);
});

test("claim counts attempts; terminal jobs claim as themselves", () => {
  const { storage } = sqliteWorkspace();
  enqueueMissionJob(storage as any, "t1", NOW, "j1");
  const claimed = claimMissionJob(storage as any, "j1", LATER);
  assert.equal(claimed?.state, "running");
  assert.equal(claimed?.attempts, 1);

  // At-least-once redelivery after termination: the same job is
  // handed back terminal so the consumer acks instead of re-running.
  finishMissionJob(storage as any, "j1", "done", LATER);
  const redelivered = claimMissionJob(storage as any, "j1", LATER);
  assert.equal(redelivered?.state, "done");
  assert.equal(redelivered?.attempts, 1, "terminal claims do not count attempts");
  assert.equal(claimMissionJob(storage as any, "unknown", LATER), null);
});

test("finish is first-wins idempotent; a finished task can be submitted again", () => {
  const { storage } = sqliteWorkspace();
  enqueueMissionJob(storage as any, "t1", NOW, "j1");
  claimMissionJob(storage as any, "j1", NOW);
  finishMissionJob(storage as any, "j1", "failed", LATER, "queue send failed");
  finishMissionJob(storage as any, "j1", "done", LATER);
  const row = getMissionJob(storage as any, "j1");
  assert.equal(row?.state, "failed");
  assert.equal(row?.lastError, "queue send failed");

  const next = enqueueMissionJob(storage as any, "t1", LATER, "j2");
  assert.equal(next.created, true, "terminal jobs never block a new submission");
  assert.equal(next.job.jobId, "j2");
});

test("consumer ack decision: poison and completed ack, transient retries", () => {
  assert.equal(jobAckDecision(200), "ack");
  assert.equal(jobAckDecision(404), "ack", "unknown job is poison, never retry it forever");
  assert.equal(jobAckDecision(400), "ack");
  assert.equal(jobAckDecision(409), "retry");
  assert.equal(jobAckDecision(500), "retry");
  assert.equal(jobAckDecision(0), "retry", "no response at all retries");
});

test('latest delivery metadata distinguishes a replacement job even with an identical creation timestamp',async()=>{
 const {latestMissionJob}=await import('../src/jobs.ts');const f=sqliteWorkspace();
 enqueueMissionJob(f.storage,'task',NOW,'old');finishMissionJob(f.storage,'old','failed',LATER);
 enqueueMissionJob(f.storage,'task',NOW,'new');assert.equal(latestMissionJob(f.storage,'task')?.jobId,'new');
 assert.equal(getMissionJob(f.storage,'old')?.state,'failed');f.sqlite.close();
});
