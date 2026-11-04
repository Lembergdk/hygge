# Canary workspace image migration

The migration API is owner-authenticated and limited by a reviewed `HYGGE_WORKSPACE_UPGRADE_POLICY`. The initial policy is staging-only and names two synthetic canary users. Production config and the default image remain unchanged. Adding a named image does not itself change an owner's registry binding.

The source is the pinned Wave 4 image (`ae26f5d…1d55ff`). The candidate published from packaging commit `e7e5b46` is `registry.cloudflare.com/89a95a21e6a6b7c15bbd8e148a6c6242/hygge-workspace@sha256:0fb1072f1864622ff979b67c54398e69d38e946f1cb2b1a70423c5c4d0d30c82`. The first attempted build of merged #81 failed because `.dockerignore` excluded the new artifact module; the allowlist and a Docker build/smoke gate are corrected here. Publication is separate from deployment and migration.

## Protocol

`GET /sandbox/upgrade` returns the authenticated owner's binding and migration journal. It does not provision, start, reset or migrate a workspace. `POST /sandbox/upgrade` requires exactly `operationId`, `direction` (`upgrade` or `rollback`), `expectedGeneration`, `expectedCheckpointId` (including null), and `confirm:true`. The target comes from deployment policy, never from the request or model. These endpoints are not agent tools.

The source must already be ready, idle and free of human control. Active owner requests, chat turns, cleanup, browser missions and admission/lineage pins block entry. A durable owner-private journal blocks ordinary routes and background cleanup during the transition. The original public task, its pending effect and consumed approval are preserved; no browser action runs during migration.

1. Capture and independently verify the final source checkpoint, complete tree and every blob. Hash the owner SQL state, including canonical chat, documents, credentials and effect/consent records; never export its values.
2. Retire the exact source runtime through the existing registry fence. Its intent is persisted before destroy, so a lost destroy acknowledgement can be reconciled against the same identity and provider absence. Absence without that intent still fails closed.
3. Change the stopped registry's image only after matching checkpoint, generation, revision and persisted fence proof. Ordinary restores still require an exact image. A different-image restore needs this journal's exact owner/checkpoint/source image/target image/target generation grant.
4. Restore into a fresh incarnation and generation. Independently verify all bytes before readiness. If an old image cannot resume an interrupted restore, only that exact, authenticated, still-uninitialized replacement may be retired and recreated from the verified source checkpoint. A leased or initialized runtime cannot be discarded this way.
5. Capture the target and compare files, modes, directories, symlinks and artifact index. Session IDs, URLs and human-control state persist; control epochs increase exactly once. Reordered JSON artifact keys are compared semantically. SQL state must remain unchanged before acceptance.
6. Commit an accepted journal and resume normal owner routing. Repeating the same operation returns its result; changing its scope rejects.

Rollback repeats the same gates against a **new final capture of current work**. It never selects the original pre-upgrade checkpoint. The old image lacks multipart writes/document tombstones, so document mirroring fails explicitly and remains pending on that image; canonical private documents remain saved in the DO. A subsequent upgrade restores deletion watermarks and the latest revisions.

## Failure and rollout boundaries

A failed source capture cancels before image change or source retirement. Once fenced, incomplete transitions remain gated for verified recovery and same-operation retry. Never reset the owner, clear effects or restore an arbitrary older checkpoint to make a test pass. Existing orphan admissions still require the established exact-fence supervisor path; a timer is not authority to delete them. Source capture failures that cannot be reconciled from committed evidence block retirement rather than discarding the native filesystem.

The deployment must retain both exact named images until every permitted owner and any rollback path is reconciled. No automatic fleet migration or image default promotion is introduced. Runtime/image deployment, canary migration, live-site acceptance and a production rollout remain separately recorded outcomes.

The existing 16 MiB/8,192-entry capture bounds still apply; this is not the streaming checkpoint follow-up. Historical R2 checkpoints retain their existing retention semantics. No identity-dependent job-site signup, login or submission is added by these tests.

## Verification

Unit tests use real SQLite and independently verified object manifests for upgrade, latest-state rollback, unchanged unknown effects, authorization, human/busy gates and lost lifecycle acknowledgements. The root browser test exercises real Chromium capture/restoration and a lost chunk reply across root reconstruction. `container/scripts/image-upgrade-smoke.mjs <source-image> <target-image>` uses four fresh network-isolated Docker containers to check source → target → source → target with synthetic cookies, local storage, large evidence, corrected files and deletion watermarks. These local adapters do not establish Cloudflare provider acceptance. Release receipts under the task's private output directory record the exact published images and staging canaries; credentials remain in Keychain.
