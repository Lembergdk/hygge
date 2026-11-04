# Verified staging workspace image upgrades

Staging fixture access remains restricted to deliberately created synthetic accounts. Production activation explicitly enables owner-authenticated forward upgrades and promotes the published candidate as the default for newly initialized workspaces. Both exact images remain named so existing owners retain their current placement until verified migration. Production does not enable reverse transitions.

The source image is `ae26f5d92b203d94f18bc13f1c121975459053c3b34d9ee2ea664d68f01d55ff`. Candidate `1c7dcb73cd6ddd7bf9bea12fdbb8b4a7d6498bf87d95a772434797562f95b5f9` was published from merged #84 (`b6f6faf`) in Actions run 41917511772. Both belong to `registry.cloudflare.com/89a95a21e6a6b7c15bbd8e148a6c6242/hygge-workspace`.

`GET /sandbox/image-upgrade` reads the authenticated owner's binding and journals without initializing a workspace. `POST` requires `reviewed:true`, stable `operationId`, `expectedGeneration`, and an immutable `targetImage` matching a configured reviewed transition. These routes are never agent tools. Arbitrary image or owner selection is unavailable.

The controller blocks entry during owner requests, queued/active chat turns, cleanup, human control, active mission/document admission, and prepared, dispatching or uncertain effects. Existing paused tasks, approvals and uncertain actions are not cleared or replayed. The populated canary from the separate sandbox investigation with an unresolved effect remains ineligible and untouched. A persistent maintenance lock blocks ordinary owner routing and cleanup until verification or a safe pre-fence abort.

1. Capture a fresh final source checkpoint and independently verify its manifest and every private object. Keep the immutable original receipt. Hash canonical owner SQL state without exporting values.
2. Recheck the exact source incarnation, generation, recovery head and filesystem/profile revisions. Revoke its lease and fence the exact container. Persist fence intent before destroy. Lost acknowledgement may resume only with that identity-bound intent and verified provider absence.
3. Select the image only on a stopped registry at the expected revision, with an independently verified current checkpoint. Persist a restore grant bound to owner, source image, checkpoint and target. Ordinary recovery still requires the exact image digest.
4. Restore into a fresh incarnation and generation. Reverify every file before readiness. An interrupted target may be recreated only if it is the exact authenticated, frozen, uninitialized attempt and the independent source still verifies. Initialized or leased targets are never reset.
5. Capture the target; compare files, modes, directories, symlinks and artifact index. Session identities, URLs and human state persist, with the expected control epoch increase. Compare complete owner SQL state before accepting and releasing maintenance.

Rollback repeats this sequence on **current new-image state**, including files written after upgrade. It never selects an older recovery head. The old image lacks document tombstones/multipart writes; normal document mirroring stays pending there, while canonical documents remain saved in the DO. Only the synthetic seed helper can write its fixed small fixture on the old image.

Capture failure without a committed receipt blocks retirement. Abort is permitted before fence only after verifying that the original exact runtime is ready and unfrozen. Later failure retains the maintenance lock and original checkpoint; retry the same operation ID. Never reset an owner, steal admission, reconcile an unknown action or delete personal state to obtain a passing check.

The synthetic fixture helper accepts only a UUID marker and fixed actions/fixture URL, returning booleans rather than browser state or file content. The acceptance workflow checks two populated owners, actual cookie/local storage persistence, a file larger than one RPC chunk, idempotent retries, and isolation while a second owner stays on the old image. Live rollback testing was stopped at the user’s request; it is not a release acceptance claim. Cleanup fences synthetic containers and removes temporary authentication/users; immutable DO/R2 evidence remains. Existing investigation canaries are not recreated or reset.

The reused exact-image Docker harness verifies source → candidate → source → candidate in four fresh containers with networking disabled, including a 578,754-byte artifact and deletion watermarks. Run it for the exact candidate digest; a different candidate's receipt is not acceptance. Local Chromium tests cover lost capture/fence acknowledgements and interrupted restore.

The existing 16 MiB/8,192-entry capture bounds remain. Streaming checkpoints, reconciliation of uncertain work and real-site identity flows are separate follow-ups. No workspace or effect is reset to force activation.

## Consolidated production release

Manually approving and merging PR #87 triggers **Release agent workspace**. It waits for the exact merged commit’s main CI, deploys production, upgrades eligible existing workspaces, checks health, and runs the existing TestFlight workflow. TestFlight now waits for Apple processing and reads back internal tester-group membership. No production action happens before the manual merge. Actions → Release agent workspace → Run workflow on `main` is the explicit recovery entry point.

Production migration discovers existing D1 owners and creates one masked, short-lived maintenance session per owner, deleting only that session afterward. It reads owner-private placement/journals and submits only the exact configured forward transition with a stable operation ID. It does not read conversation content or run agent tools. New/uninitialized owners use the new default when first initialized; they are not provisioned by this job.

Busy, unavailable, human-controlled or unresolved workspaces remain on their current image and are counted in the release summary. They are never cleared or replayed. Hard migration failures stop the release before TestFlight; safe deferrals are reported explicitly. Rerun the manual workflow after those owners become eligible. A deferred owner still requires its existing recovery/reconciliation decision.

The automatic sequence checks infrastructure and Apple processing. A short on-device TestFlight check of contextual follow-ups, saved notes/files and a representative tool action remains human acceptance. If Apple has no assigned internal tester group, the workflow reports that explicitly rather than silently distributing to a new group.
