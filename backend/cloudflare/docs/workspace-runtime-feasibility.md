# Wave 1 runtime/storage feasibility and foundation

## Result and scope

The provider-neutral registry and verified filesystem-manifest checkpoint foundation are implemented. Production browser/runtime integration remains gated. There is no running provider adapter, no selected Google Cloud fallback, no new dependency, and no resource configuration in these modules. Existing application routes continue to use the original implementation until separately integrated.

The preferred candidate remains a retained owner-specific Cloudflare Linux sandbox with colocated Chromium, closed/quiesced full-profile capture and independently verified R2 recovery. Trusted orchestration/model calls can remain outside it. Each workspace is keyed by environment + verified user + workspace, never Get BOB organization/BOB/team identity.

## Evidence from supported interfaces

Cloudflare's [Container API](https://developers.cloudflare.com/containers/api/durable-object-container/) supports selected images, entrypoints, process execution, inspection labels, destroy and lifecycle monitoring. Those primitives make a custom Chromium image a plausible candidate, but they do not themselves prove safe Chromium profile capture, download restoration, browser streaming, or an exact-incarnation browser/control fence. A native snapshot is not the independently durable checkpoint contract.

Cloudflare [Browser Run limits](https://developers.cloudflare.com/browser-run/limits/) describe active session reuse, configurable idle expiry up to 20 minutes, and session closure during provider rollouts. This does not establish indefinite full-profile durability. Current Hygge `src/browser.ts` exports selected cookies/localStorage; its existing private state is not a full Chromium user-data directory. A retained browser session or exported cookies is not a substitute for complete profile recovery.

The Get BOB owning implementation examined in Wave 0 is pinned to Orchestrator `1953af7a1c2a6252338844ee6fc18b192cdc6c3e`: [native composition](https://github.com/getbob-ai/getbob-agent-orchestrator/blob/1953af7a1c2a6252338844ee6fc18b192cdc6c3e/src/sandbox/native/application-runtime.ts#L90), [durability](https://github.com/getbob-ai/getbob-agent-orchestrator/blob/1953af7a1c2a6252338844ee6fc18b192cdc6c3e/src/sandbox/native/durability.ts#L104). Reused pattern: retained native active files; consistent capture; independent immutable objects; verified manifest; atomic private recovery-head promotion; failed capture does not advance the head. This is not the historical R2-mounted filesystem pattern. No Get BOB endpoint, credentials, resource, namespace, or default is imported into this code. Dependency/license approval for any later source copying remains required; these foundations implement contracts independently.

The real storage adapters use [DO storage transactions](https://developers.cloudflare.com/durable-objects/api/storage-api/) and [R2 Workers conditional puts/readback](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/). Bucket credentials remain with the trusted service. The R2 adapter verifies content even when a conditional put finds an existing immutable object; naming alone is not a hash check.

## Explicit provider gate

`UnsupportedRuntimeProvider` and `UnsupportedNativeCapture` throw prerequisite errors rather than fabricate readiness, stopped evidence, or a durable profile. Before replacing them, establish and implement:

- Image/Chromium version pin and supported launch with a private user-data directory.
- Exclusive human/agent control epoch and trusted supervisor admission freeze, including uploads/downloads, before capture.
- Clean Chromium close or a supported consistent profile mechanism covering SQLite, WAL/SHM, cookies, storage, keys and referenced files. Copying live databases is insufficient.
- Exact-incarnation provider stop/destroy readback and retirement of all associated browser control before replacement. A reused name, lease expiry, returned stop request or arbitrary 404 is insufficient.
- Quiesced capture and restoration of all declared durable files/profile components across runtime and image changes, with explicit reauthentication behavior where sites reject sessions.
- Streaming/segmented capture and restore appropriate for real profile sizes. Current transport defaults deliberately cap each capture at 512 entries and 16 MiB; named constructor limits can be configured. Files preserve permission modes, directories preserve modes/empty directories, and safe internal symlinks preserve targets. Ownership IDs, hardlink identity, timestamps, special files and large-profile streaming are not implemented; a production capture adapter must either represent required semantics or reject unsupported entries rather than silently dropping them.
- Private authenticated takeover transport and reconnect. Browser runner/takeover wiring is Wave 2; total-loss/profile acceptance uses authorized staging later.

No supported full Browser Run profile-export API was established in this source/offline assessment. Colocated Chromium is a design candidate, not a deployed acceptance result. If candidate constraints fail, Google Cloud can be compared; it is not automatically activated. Any such work must use a separate Hygge Google Cloud project, isolated from every Get BOB project. Project/identity/network/disk-resource validation belongs to root's explicit policy and is required before an adapter can be wired. This lane creates no Google resources or SDK client.

## Implemented trust and commit boundaries

`WorkspaceRegistry` persists one owner-specific binding. DO synchronous SQL transactions reserve lifecycle operations before external provider calls. Retries reuse operation IDs; the injected provider must reconcile those IDs. Unknown start/stop remains pending/fencing; competing lifecycle operations fail. Fence validation matches owner, exact provider runtime, internal incarnation/generation, browser retirement and timestamp. Restart requires an existing verified recovery point and provider-reported recovery of that exact checkpoint. New runtime generations cannot reuse the old incarnation.

Registry methods are internal trusted-service primitives, not authenticated HTTP endpoints. `sqliteWorkspaceRegistryStorage({sql, transactionSync})` provides a synchronous `readCurrentLease(owner)` over the authoritative registry table. C must use that reader inside its same-database synchronous ledger transaction, never a cached asynchronous lease. `registry.readLease(actor, owner)` exposes the canonical persisted lease for root capability issuance. `actor` must already have been resolved by root's signature/audience/scope broker; caller-provided JSON identity is not authentication. Root must additionally require lifecycle permissions and `workspace.commit` before entry. Shared authenticated services are trusted; injected provider/capture adapters are not model-supplied.

The current registry exposes ensure, heartbeat, fence, read and recovery-head commits. Graceful idle quiescence needs the eventual supervisor/capture/browser integration; it must freeze admission, commit required work and only then fence. No idle stop is wired here.

Capture checks source incarnation, revisions, quiesced profile state, safe relative paths, artifact coverage and size limits. Immutable owner-prefixed blobs and manifest are read back and SHA-256 verified. A single DO transaction then verifies current canonical lease ID/revision, commits the recovery pointer and private idempotent receipt. Generation revocation or concurrent registry mutation prevents stale promotion. Same write ID with different request rejects; same exact request after acknowledgement loss resolves and re-verifies the original receipt without capturing again. Existing file revisions cannot regress or reuse an old revision for new bytes.

`verifyReceipt(actor, owner, receiptId)` re-reads the committed private receipt and verifies its owner, manifest/lineage, required artifact paths and all blob hashes. It is a trusted resolver for recovery/completion. It proves durable file bytes and supported directory/link/mode metadata exist; it does not itself instantiate Chromium, unpack files, or prove a provider has restored them. Provider start must report the exact recovered checkpoint before registry readiness. Initial runtime start is usable only for bootstrap: root must not publish successful workspace initialization or admit user-dependent work until the first verified recovery point exists.

DO structured memory stays canonical in DO; file-based notes and artifacts are captured. No second writable personal-memory database is introduced. Native disk writes alone cannot produce a durable receipt. Unsaved in-flight writes and dispatched external actions retain uncertainty; there is no zero-loss or exactly-once claim. These modules do not read real customer data or issue browser/network customer actions.

## Tests and remaining acceptance

Focused tests exercise two owners, exact-incarnation denial, persisted unknown-stop fencing, expired/stale leases, concurrent lifecycle requests, unsupported adapters, DO transaction adaptation, independent byte verification, missing/tampered objects, acknowledgement loss, capture-time lease revocation, CAS conflict, unsafe paths, live-browser rejection, artifact coverage and revision regression. R2 is exercised through its real adapter with a controlled structural bucket fixture; DO SQL semantics are additionally exercised with a real SQLite database; no deployed R2 or provider runtime was contacted.

The source tests establish foundation behavior with injected trust adapters. They do not establish provider browser feasibility, resource permissions, snapshot policy, real R2 retention, profile consistency or deployed isolation. Production adapter wiring remains unavailable until the explicit gate above is resolved.
