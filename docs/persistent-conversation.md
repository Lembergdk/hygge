# Persistent conversational agent

Authenticated `ConversationView` uses `/chat/state`, `/chat/turn` (SSE), `/chat/proposals/:id`, `/chat/device-result` and `/chat/reset`. Each route is behind the existing verified-user routing into one owner Durable Object. There is one reasoning loop, with native tools and actual results. No intent preflight or parser fallback is used by this client path. Scripted onboarding and older clients keep their existing routes; their persisted messages seed the canonical history.

## Ownership and recovery

`chat_agent_records` stores ordered conversation events, provider response pointers, exact proposals, execution records and versioned notes/files. New turns carry a stable UUID and generation. Completed responses and native call IDs are persisted before execution; each actual result is persisted before continuation. Only completed streamed tool arguments execute. One active turn is serialized per owner. Retrying a completed ID returns the saved reply; retrying an interrupted turn consumes saved outcomes. An interrupted side effect with no confirmed result is uncertain and is not automatically repeated. Existing mission job and consent guards still apply.

The client caches a pending outgoing message and generation. Native conversation writes are cache-only; full-cache imports are fenced while canonical agent changes need reconciliation. A successful explicit conversation pull releases the fence. Ordinary background pulls do not release it. An interrupted message survives app restart and can be retried with its original ID.

## Human decisions

Native consequential tools return an awaiting-confirmation result; the model has no approval tool. The authenticated person approves an immutable proposal bound to current material target state. Changed or missing drafts invalidate it. Pending proposals survive questions, restarts and device changes, and can be cancelled by a correction. Tool and turn budgets return explicit deferred outcomes. Signup tools create drafts; they do not silently perform signup.

Approved calendar tasks request device execution. A durable claim binds execution to one installation, preventing another device from concurrently creating the event; the claim does not expire into an automatic replay. EventKit stores a proposal marker and checks for it before retrying event creation. The authenticated device reports success/failure back to the same conversation. This reports a device outcome, not a server observation of the user's calendar. Availability lookup, editing appointments, proximity and travel time are not added here.

## Memory and workspace

The agent can read current state, tasks, safe inbox summaries, activity, search evidence and site learning. It can search retained history and read older events in chunks. Notes and files are agent-authored advisory material, carrying turn/call provenance and revisions; they cannot authorize actions or overwrite confirmed profile facts. Writes require the current revision. File deletion requires human approval.

Private documents are saved immediately in the owner Durable Object and then mirrored asynchronously into the existing retained workspace's artifact/checkpoint mechanism. The durable queue retries failed copies; generation/revision checks prevent a late copy from restoring a deleted or corrected canonical document. No arbitrary shell or code execution tool is exposed. Browser execution continues using the existing retained workspace, evidence and checkpoint system.

## Context and retention

The active provider chain uses `store:true` and `previous_response_id`. At 48,000 retained characters or 24,000 observed input tokens, completed segments are summarized in bounded chunks; each original event is processed, including long messages. The checkpoint commits only after all chunks succeed, with the newest complete turn and active call/result pairs retained. Full originals remain available through history tools. A failed summary leaves the old checkpoint intact. Explicit chain-expiry/context errors can rebuild from owned history; unrelated HTTP errors do not erase context. Early response-created IDs are recorded for cleanup even if streaming interrupts.

Clear conversation invalidates the generation/proposals, removes owned chat history/documents, and tombstones old message IDs against stale snapshot imports. It preserves profile, sites, tasks, and business activity. Individual known provider responses and active workspace copies are queued for deletion; `cleanupPending` exposes outstanding work, with background/alarm retries. Provider deletion follows the provider's soft-delete semantics. Historical R2 checkpoint retention is unchanged; clearing canonical documents does not promise immediate erasure of historical backups. Requests interrupted before a response ID is observable remain subject to provider retention. There is no new account-deletion product/API in this change; any future account-deletion flow must also invoke conversation reset/cleanup before removing owner access.

## Validation and release

Node contract tests cover persistence, exact confirmations, outcomes, uncertainty, budgets, compaction, reset and isolation. Swift tests decode proposal/task wire contracts. The manual CI `agent_evaluation` input exercises the real staging model gateway against synthetic local services, inspecting effects, continuity, correction, notes and cleanup. `Chat staging acceptance` can deploy a selected ref to staging and test authenticated routes with a temporary synthetic account; it never approves external missions. Rejected synthetic task rows remain in the inaccessible test object after auth removal.

Implementation/CI, staging deployment, simulator acceptance, Production and TestFlight are separate outcomes. Main's review requirement remains in force.
