# Retained workspace V2 activation

`HYGGE_WORKSPACE_MODE=retained-v2` is configured for both staging
and production. Configuration alone is not acceptance: each
environment is live on V2 only after its deploy completes and the
checks below pass. Production remains a manual deploy dispatch.

## What each environment gets

| Setting | Staging | Production |
| --- | --- | --- |
| Workspace mode | `retained-v2` | `retained-v2` |
| Namespace | `hygge-staging` | `hygge-production` |
| Checkpoint bucket | `hygge-workspace-checkpoints-staging` | `hygge-workspace-checkpoints-production` |
| Container image | Pinned Wave 4 digest in both the container `base` image and `HYGGE_WORKSPACE_IMAGE` | Same pinned digest |
| Skill registry | Wave 4 acceptance site only | Unset: no shared guidance or promotion |
| Completion postconditions | Wave 4 acceptance site only | Unset: write completions hold |

CI ensures the checkpoint bucket and applies the additive
`0008_shared_skills_v2.sql` migration before each deploy. The
image digest is deliberately pinned; changing it is an image
upgrade, not an ordinary worker deploy, because existing
workspace registry and recovery records are bound to the digest.
The manual **Publish workspace image** workflow builds and pushes
a new immutable image and reports its digest, but never deploys:
pinning that digest in both Wrangler configs remains a separate
reviewed change.

## Known fail-closed blockers

- A populated legacy Browser Run profile, or a task carrying a
  live legacy session, blocks first V2 initialization with
  `LEGACY_BROWSER_ADOPTION_REQUIRED`. Existing state is preserved;
  no fresh-start waiver is inferred.
- Without a reviewed registry entry for a site, no shared skill
  guidance or promotion is available for that site.
- Without a reviewed postcondition for a write outcome, V2 does
  not declare that write complete. Discovery and sign-in keep
  their observed-result/authenticated-state checks.
- Checkpoint capture remains bounded at 16 MiB and 8,192 entries;
  larger profiles fail visibly rather than evicting data.

These are blockers for the affected work, by design. They are not
reasons to loosen consent, completion, or lineage checks.

## Acceptance gates

Staging, with fresh test users:

1. `/health` reports `workspace: "retained-v2"` and
   `jobs: "queued"`.
2. `/sandbox/verify` returns `mode: "retained-v2"` for a fresh
   user; a populated legacy-profile user fails closed without
   mutating legacy tasks, credentials, or profiles.
3. Two users run work concurrently with separate workspaces,
   checkpoints, credentials, and browser state.
4. Retention: stop/restart restores the exact workspace and
   browser profile from R2; a wrong-owner or wrong-image restore
   is refused.
5. Loss: an interrupted run resumes from durable effects without
   replaying a consumed one-shot approval.
6. Wave 4 jobs: the reviewed `apply` flow completes only on the
   configured success pathname with its required label.
7. Quarantine: an authorized maintainer can quarantine a shared
   skill and no owner can resurrect the same body privately.

Production dispatch is a separate explicit action after staging
acceptance. Passing local tests or a successful deploy is not by
itself production acceptance.
