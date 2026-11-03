# Hygge sandbox Wave 1 — foundation delivery

Wave 1 implements the approved retained-Cloudflare/private-user design as new source modules, trusted internal composition and offline validation. These modules do not register public routes or replace current `UserSandbox` execution. Wave 2 owns existing call-site integration, browser runner/takeover, old task/UI projections, deployment wiring and the provider prerequisites below.

## Mandatory Google Cloud isolation

Any Google Cloud resources for Hygge must use a **separate dedicated Hygge project**, completely isolated from all Get BOB projects. Do not reuse Get BOB compute, service accounts, workload identity pools, buckets, KMS keys, Secret Manager secrets, networks, database instances or deployment identities. Existing credits motivate provider preference; credit eligibility/balance are not verified here. No Google project/resource/IAM was created, selected or connected.

The dedicated project must be **inside the existing Get BOB Google Cloud organization and linked to its intended billing account**. Organization/billing ownership is shared deliberately; runtime resources, service identities and access remain isolated by project. The policy requires explicit organization and billing-account IDs and validates the resolved organization ancestry and billing linkage from trusted provider metadata before provisioning. Existing organization-level access and policy inheritance still require review; shared organization/billing does not authorize cross-project service access. No separate organization or billing account is requested.

`workspace-project-policy.ts` has no ambient `GOOGLE_CLOUD_PROJECT` fallback. It requires explicit trusted Hygge project ID/number and a reviewed Get BOB project denylist, rejects overlap by either ID or number, validates provider resource project metadata, project-qualified Google resource paths and dedicated service-account emails. Naming is constrained to `hygge-*` for this proposed setup; no actual project name is invented. Metadata must come from authenticated provider readback, not caller labels. Before any Google adapter is enabled, verify actual project IAM (including inherited and cross-project principals), resource ownership, Shared VPC/peering, key/secret references, WIF/service identities and billing/credit applicability. Code guards are not an audit of live IAM.

The Google adapter is not selected or implemented in Wave 1. `WorkspaceRegistry` rejects GCP initialization; the type union preserves the conditional alternative without creating a second runtime implementation.

## Implemented modules

| Area | Source | Behavior |
|---|---|---|
| Protocol and owner authorization | `workspace-contract.ts`, `workspace-security.ts`, `workspace-brokers.ts` | Strict signed HMAC capabilities; owner/runtime/incarnation/generation/lease/audience/task/domain/scope binding; fresh clock and authority checks; canonical request hashing |
| Internal composition | `workspace-foundation.ts` | Actual A+C composition on the same DO SQL database; authenticated save wrapper; unsupported runtime/capture defaults deny activation |
| Registry and lifecycle | `workspace-runtime.ts` | DO SQLite adapter, canonical lease IDs, single-owner lifecycle reservations, idempotent operations, exact-incarnation stop evidence and stale-owner denial |
| File durability | `workspace-capture.ts` | Immutable owner-prefixed R2 objects, readback/hash verification, safe filesystem metadata, committed manifest/recovery-head CAS, historical receipt verification |
| Execution persistence | `workspace-persistence.ts`, `runtime-checkpoints.ts` | Per-owner SQLite CAS/idempotency, run/hash pins, durable checkpoint coverage, atomic completion/immutable receipt/outbox; committed retries survive verifier outages |
| External effects | `effect-ledger.ts` | Consent consumption with dispatch, no blind replay, prepared-effect cancellation, current phase gating, uncertain outcome reconciliation |
| Safe schema/adoption | `schema-migrations.ts`, `workspace-migration.ts` | Nondestructive current/known historical credential migration; crypto/mapping preflight; final verified capture before retirement; post-write rollback fencing |
| Shared website skills | `skill-contract.ts`, `skill-policy.ts`, `skill-publication.ts`, `skill-brokers.ts` | Strict structured V2, private canonical evidence, signed minimized attestations, transactional D1 publication/versioning/usage/quarantine/admission, current registry/policy revalidation |

Migration `backend/cloudflare/migrations/0008_shared_skills_v2.sql` is additive and unapplied. Existing V1 skill rows/readers remain unchanged until a reviewed V2 switch; old entries are never silently blessed. No reviewed website registry is populated automatically. External controls/routes need reviewed generic evidence; ambiguous candidate data stays private.

All services are trusted backend primitives. They must not be exposed directly to model code. Cryptographic issuer closures require trusted issuance/evidence authority. A user/runtime token cannot mint shared usage outcomes, issue publication signatures or quarantine skills. Existing site credentials and master key stay in the vault; required consent/outcome/postcondition callbacks must be wired to real private authority in Wave 2, not copied from permissive test fixtures.

## Verified integration and review

The integration tests use actual SQLite statements/transactions and real cryptographic verification. They connect the canonical registry, same-transaction lease checks, consistent synthetic capture, independent object verification, completion ledger and three-run skill publication. Tests inspect public rows to exclude private user/workspace/evidence/provenance. Separate failure tests cover changed idempotency payloads, acknowledgement loss, stale lease/generation, tampered objects, unknown stop, rollback, consumed consent, uncertain effects, expiry during asynchronous checks, removed skill controls and changed policy/body between read and admission.

Cross-review fixes were applied before final validation: stricter checkpoint-kind types; revalidation at read/admit/consume; replay lookup before external proof checks; prepared cancellation; failed/paused checkpoint dispatch denial; post-await capability expiry checks; persisted canonical lease identity; no obsolete ready-state operation replay; filesystem modes/directories/safe links and defensive snapshot copies.

## Browser/provider gate and limits

Source assessment is in [runtime feasibility](../backend/cloudflare/docs/workspace-runtime-feasibility.md). Existing Browser Run cookie/localStorage exports do not prove full authenticated Chromium profile durability. Colocated pinned Chromium is a supported design candidate, but its consistent SQLite/WAL capture, large-profile streaming, exact-incarnation retirement and owner-scoped human-control transport still require implementation and real staging proof. `UnsupportedRuntimeProvider` and `UnsupportedNativeCapture` deliberately throw until a supported adapter satisfies the contract; no false ready/save result is supplied.

Capture currently supports regular-file bytes/modes, explicit directories/empty directories/modes and validated internal symlinks. Defaults cap transport at 512 entries / 16 MiB and are configurable, not product quotas. Large profiles, ownership IDs/hardlinks/timestamps/special files and real extraction/restore must be represented or explicitly rejected by a later production driver. Local object-existence proof does not instantiate Chromium or prove a provider restored it.

The destructive legacy constructor guard still exists on the current application path: Wave 1 supplies its safe replacement helper, while Wave 2 must wire preflight before removing/replacing that guard. New canonical task/outbox tables are not yet the old UI/task projection. No user migration, reset, real job-site action or credential change occurred.

## Validation commands

From `backend/cloudflare`:

```sh
npm test
./node_modules/.bin/tsc --noEmit
node scripts/workspace-foundation-smoke.mjs
```

Final Node backend suite: **276 passed, zero failures/skips** (baseline 195; 81 new foundation/regression tests). TypeScript no-emit: passed. The optional local workerd smoke uses synthetic data, a localhost listener and ephemeral SQLite; its result is recorded in the delivery receipt. It imports existing development tools transitively through the installed Wrangler lockfile, adds no package dependency and does not deploy. The installed local workerd supports compatibility date `2026-10-30`; the script uses that date only, leaving app config `2026-10-31` unchanged. Local smoke is not validation of the exact deployed compatibility date or any remote provider resource.

Implementation, source checks, local workerd, configured storage retention/IAM, browser runtime acceptance and production rollout are separate outcomes. Wave 1 completes the source foundations and source-level feasibility assessment; it does not declare the browser gate passed or the original product requirements deployed.

Organization/billing clarification validation: all 3 affected project-policy tests and full TypeScript checking passed. The 276-test full-suite receipt above predates this isolated policy clarification. No cloud project, organization or billing account was created or changed.
