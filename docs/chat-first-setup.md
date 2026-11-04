# Chat-first site setup

Home owns site suggestions, high-level work decisions, setup progress, and completed outcomes. Questions, verification, recovery, and within-process approval live in the existing conversation.

## Flow

- **Create my account:** the tap authorizes account creation. The agent uses known profile values, makes reversible setup decisions, generates a private password when needed, and explores/retries within a bounded run. Additional public/permanent/destructive actions require specific consent.
- **I have one:** connect an existing account, using a trusted session or saved login. Missing/rejected credentials produce a chat card opening the secure login sheet. Dismissing that sheet leaves setup waiting. Connecting never authorizes profile publication or creation of another account.
- **Not this site:** dismiss with Undo; no negative category preference is inferred.
- **Missing information:** a durable chat message proposes answers only from supplied profile references. Reply chips and the scoped chat composer answer one question at a time. The original task resumes when required answers are present; no second generic approval is added.
- **Verification:** chat opens the kept browser session, or the selected mail app. Continue re-observes the site and preserves checkpoint guards. Supported codes arriving in Hygge's own inbox can resume an already-authorized verification; scheduled scans cannot consume them.
- **Consequential action:** the exact proposed change is shown in chat. Consent is one-use and bound to task, request, browser session, URL, page labels, and draft. Changed context requires a fresh decision and approval. An LLM-supplied consent flag cannot authorize execution.
- **Completion:** backend persists account status and a journal milestone. Chat closes the request; Home shows the result.

## Beyond setup

Chat is not only for setup. Work asks in chat start real missions (model-led intent for work asks, with mail resolution), and mail triage lives in chat too (one mail, one event; outcomes routed to proposals or chat questions). The flame badge only promises what chat can actually resolve.

## Persistence and compatibility

New requests use interaction version 1. Task creation is idempotent on the native task UUID; continuation addresses that original task and a specific help ID. Running state is claimed before awaiting execution. Duplicate/stale replies return conflict instead of starting another run. Exceptions persist recovery; uncertain client responses reconcile the original task before retrying.

Requests are stored with task records and projected into persisted chat messages. Foreground synchronization restores task/help links on a second device. Existing snapshots without the optional fields still decode. Old API callers retain their task-level approval contract. No SQL migration is required.

## Verification

Core tests cover connection scope, one-question replies, explicit consent, stale replies, and backward-compatible cache decoding. Backend tests exercise the actual browser loop with deterministic browser/decider doubles: autonomous reversible actions, recovery, grounded suggestions, secret handoff, signed-in evidence, public-action interception, single-use consent, and invalidation when context changes.

Live third-party sites and email clients still need device acceptance testing. Model effect classification is supplemented by conservative guards for obvious consequential controls; unfamiliar site behavior remains an evaluation target. Long browser work uses the bounded executor, submitted through the durable job queue (docs/durable-jobs.md) so execution survives request and process termination.
