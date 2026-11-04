# Verified staging workspace image upgrades

This controller is restricted to staging accounts deliberately created by the acceptance harness with `workspace-upgrade-…@example.invalid` addresses. Production configuration and the default image remain unchanged. Both immutable images are named in staging; publication and adding a named image do not migrate an owner.

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

The synthetic fixture helper accepts only a UUID marker and fixed actions/fixture URL, returning booleans rather than browser state or file content. The acceptance workflow checks two populated owners, actual cookie/local storage persistence, a file larger than one RPC chunk, latest-state rollback and idempotent retries. Cleanup fences synthetic containers and removes temporary authentication/users; immutable DO/R2 evidence remains. Existing investigation canaries are not recreated or reset.

The reused exact-image Docker harness verifies source → candidate → source → candidate in four fresh containers with networking disabled, including a 578,754-byte artifact and deletion watermarks. Run it for the exact candidate digest; a different candidate's receipt is not acceptance. Local Chromium tests cover lost capture/fence acknowledgements and interrupted restore.

The existing 16 MiB/8,192-entry capture bounds remain. Streaming checkpoints, fleet migration, reconciliation of existing uncertain work, real-site identity flows, Production deployment and TestFlight are separate gates. No default image promotion or automatic fleet migration is included.
