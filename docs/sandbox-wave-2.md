# Wave 2: retained private workspace integration

Implemented locally with runtime, recovery and skill sub-agent lanes. This document records that delivery-time state; staging/production activation is now tracked separately in [workspace-v2-activation.md](workspace-v2-activation.md), including the populated-user adoption blocker and acceptance gates.

## Application path

`HYGGE_WORKSPACE_MODE=retained-v2` selects `workspace-execution.ts` from the verified owner's `UserSandbox`. Absent configuration preserves the existing mode; an unknown mode or incomplete V2 configuration fails closed. The router overwrites external owner headers and the DO permanently pins its environment/user/object identity in SQLite.

The V2 browser runs inside that user's container with an owner/incarnation RPC key. It receives no vault master key, LLM/provider credential or bucket credential. Structured tasks, personal memories, vault data and capabilities remain in the owner DO. Full writable HOME, Chromium profile, private evidence, uploads and completed downloads are saved to verified owner-prefixed immutable R2 manifests. The shared website-skill repository remains intentionally shared.

Every mission entrypoint, including interactive work, scheduler and site probes, uses one owner queue and persistent admission. Run/effect IDs survive pause and retry. Initial navigation reserves its session before dispatch. Private credential/code fills and photo uploads are bracketed once by the same effect ledger. A lost action response pauses without retrying the model's action. Exact owner review resolves only that outcome; not-applied review requires fresh consent before further dispatch.

Mission capabilities, callbacks, saves, browser RPCs and live connections retain their original runtime identity. A delayed callback after fencing cannot obtain replacement authority, mutate its files or overwrite the newer task projection. Idle reattachment requires exact retained-instance proof; unknown provider state never establishes retirement.

The model's `done` is insufficient. Discovery requires observed results, sign-in requires the existing authenticated-state probe, and write missions require deployment-reviewed public DOM postconditions. Task success, canonical receipt, state projection and outbox commit in the same SQL transaction after independent R2 save/readback. Capture freezes tools and refuses human ownership, cleanly closes Chromium and preserves session/epoch state for reopening.

## Shared skills

V2 bypasses the legacy prose promotion path. Reviewed registry IDs and fixed private parameter references are the only representation allowed into shared content. A first ordinary verified run may create a private typed candidate; its result does not count as corroboration. Three subsequent, distinct canonical successes must declare the same candidate hash before execution. Original personal context stays private.

Shared guidance is advisory. Selection is pinned to the actual run, each effect needs current admission/consumption, and successful usage requires that pinned canonical receipt. Quarantined or invalid shared content cannot reappear through another owner's identical private candidate. Store outages deny fallback. The legacy library audit CLI produces a redacted dry-run plan without mutating the library.

## Configuration prepared for later deployment

This was the delivery-time contract. The staging/production
activation values now live in their Wrangler files; see
[workspace-v2-activation.md](workspace-v2-activation.md) for the
current per-environment state and gates. The required sources
remain:

| Setting | Required source |
|---|---|
| `HYGGE_WORKSPACE_MODE` | Explicit `retained-v2` activation |
| `WORKSPACE_CHECKPOINTS` | Reviewed private Hygge R2 binding for the selected environment |
| `HYGGE_WORKSPACE_IMAGE` | Published, immutable Hygge `image@sha256:…` reference |
| `HYGGE_WORKSPACE_NAMESPACE` | Actual selected Hygge namespace identity |
| `HYGGE_SKILL_REGISTRY` | Reviewed `schemaVersion:1` site/route/control configuration; absent means no sharing |
| `HYGGE_WORKSPACE_POSTCONDITIONS` | Reviewed exact origin/outcome/path/required-label rules; absent holds write-task completion |

Build context is `backend/cloudflare`, using `container/Dockerfile`. The allowlist in `.dockerignore` excludes local dependencies, development secrets and unrelated files. A local Linux ARM64 image was built and passed network-disabled Chromium full-profile capture/cold restore. At delivery time no image had been published; the pinned Wave 4 digest has since been deployed with the Wave 4 stack and now in both environment configs. Provider execution remains subject to the acceptance gates in [workspace-v2-activation.md](workspace-v2-activation.md).

No Google Cloud resource is used by this selected adapter. If additional Google infrastructure becomes necessary, the existing policy requires a separate Hygge project inside the Get BOB organization on its intended billing account, isolated from all Get BOB project resources and service identities.

## Preserved data and explicit limits

The destructive constructor reset has been removed. Checked credential-schema migration preserves historical ciphertext and requires verified key/AAD continuity. Missing DO keys are recovered from their existing D1 backup; an unavailable lookup or existing ciphertext without its original key cannot create a replacement key.

`workspace-adoption.ts` inventories populated user state and orchestrates verified copy, quiescence, final capture, exact legacy retirement and restore. Existing Browser Run profiles currently lack the required verified complete-profile transition/source-fencing adapter. Those users remain blocked from V2 initialization, with original tasks, memories, credentials and encrypted profiles intact. A fresh-start waiver is not inferred.

The transport currently supports at most 16 MiB and 8,192 captured entries, with 256 KiB chunks/evidence items. Larger profiles fail visibly; no silent eviction occurs. Larger-capacity streaming, compatible image upgrades, provider idle/total-loss behavior and populated-user migration/rollback must pass the later acceptance gates. Unsaved changes are not claimed as durable acknowledgements.

## Verification and remaining waves

The root delivery report under `outputs/sandbox-wave-2` records final checks and source hashes. Portable tests use actual SQLite and real cryptographic brokers. Local Chromium tests cover capture/restore, takeover, safe reserved-session retry and the complete mission-to-durable-task path. Local workerd checks use the actual router and DO, synthetic owners and persistent temporary SQLite; they verify isolation, restart retention and nondestructive blocking of legacy data. These establish local source behavior, not serving/provider acceptance.

Wave 3 performs independent cross-lane adversarial verification. Wave 4 coordinates separately authorized staging resources/deployment and real two-user, retention, loss/restore, migration and quarantine acceptance. Production rollout remains a separate Wave 5 decision.

## Compatibility follow-up (merged browser work)

The source base now includes the merged reconnect and rich-browser work (formerly PRs #31/#32) on current `main`. The retained adapter was aligned to that contract without changing the ownership, fencing, or recovery design:

- Checkpoint capture suspends live viewers reconnectably (no terminal `ended`, close 1001) and preserves the logical session, ID, and human pause. Container admission preserves ended/auth/saving statuses, heartbeats bypass mutation queues, and each Puppeteer distribution's disconnect token is injected by its host runtime.
- The container browser uses the same bounded observation, live element references, strict changed-target checks, full action set, sensitive-fill handling, PNG model screenshots, and secret redaction as Browser Run. References never survive navigation or restore as authority; vision is withheld for the first snapshot after cold restore and whenever the screenshot cannot fit the verified RPC budget.
- Durable consent admits the full operation set through the same effect ledger; keyboard submission and consequential controls still require exact private proof. Skill learning keys off the actual browser operation and holds operations without a reviewed generic representation private.

The 16 MiB transport bound and legacy-profile adoption blocker described above were unchanged by that follow-up; deployment activation has since happened per [workspace-v2-activation.md](workspace-v2-activation.md). Local validation for this follow-up is recorded in `outputs/sandbox-wave-2/compat-delivery.md`; it is not provider or staging acceptance.
