# Durable mission jobs

Approved work used to run inside the request that approved it: a
client disconnect or an isolate termination orphaned the mission
until some later request happened to re-drive it. Missions now run
from a durable job queue.

## Flow

1. **Submit** — `approve` / `run` / `continue` (and the two
   server-side continuations: inbox-code resume and browser
   handback) record a job in the owner's Durable Object
   (`mission_jobs` ledger in `backend/cloudflare/src/jobs.ts`) and
   send one Cloudflare Queue message. The API returns the task at
   once, still `running`/`approved`.
2. **Deliver** — the worker's queue consumer (`queue()` in
   `src/index.ts`) forwards the ids to that user's object at
   `POST /internal/jobs/run`. The object claims the job and runs
   the existing mission path (`runInteractiveTask`): same consent
   gates, same checkpoints, same orphan-resume code.
3. **Settle** — when the mission reaches a resting state
   (succeeded, failed, or waiting for the user) the job is marked
   `done` and the message acked. A thrown run answers 500, the
   queue retries (3 attempts, 60 s apart), and redelivery resumes
   the task from its durable state.

Messages carry ids only — `{v, jobId, userId, taskId, enqueuedAt}`
— never drafts, payloads, or secrets. Everything a mission needs
already lives in the owner's object. The consumer marker header
(`x-hygge-job-consumer`) follows the existing server-side trust
pattern: set only by the consumer, stripped from outside requests
in `index.ts`.

## Guarantees and limits

- **At-least-once, deduplicated.** One active job per task:
  a duplicate submission returns the job already in flight.
  Terminal jobs claimed again answer as themselves, so a
  redelivery after completion acks without re-running.
- **No replayed consent.** A job is a re-drive of work the user
  already approved; it mints no new approval. Uncertain outcomes
  keep the existing rule — one-shot authorized actions are
  cleared, never replayed.
- **Exhaustion is visible.** After the retry budget, messages land
  in the dead-letter queue; its consumer calls
  `/internal/jobs/dead`, which closes the job as `failed` and
  ends a stranded task with recovery help — never a silent hang.
- **Queue outage falls back, honestly.** If the queue send itself
  fails, the job is closed as failed with the error recorded and
  the mission runs inline (the pre-queue behavior). Environments
  without the binding (local/unit) always run inline.
  `/health` reports the mode as `jobs: "queued" | "inline"`.
- **Not step-sliced.** A mission still executes as one delivery;
  termination mid-mission retries the delivery and resumes from
  task checkpoints, it does not continue mid-action.
- **Scans are separate.** Scheduled scanning remains cron-driven
  (Brief 05); this queue carries user-approved missions and their
  continuations only.

## Operations

Queues per environment: `hygge-missions-<env>` plus its `-dlq`.
They must exist before a deploy that references them; CI ensures
them before each deploy (`wrangler queues list | grep || create`).
Job history per user is inspectable only inside that user's
object (`mission_jobs` table) — there is no fleet-wide job API
and no user data in queue messages or consumer logs (ids of
malformed messages are never printed; only the queue name).
