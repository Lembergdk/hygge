# AGENTS.md — Hygge contributor guide for coding agents

This is the source of truth for automated work in this repo. Human-oriented
versions: [README.md](/Users/mikaellemberg/Hygge/README.md),
[CONTRIBUTING.md](/Users/mikaellemberg/Hygge/CONTRIBUTING.md),
[docs/ARCHITECTURE.md](/Users/mikaellemberg/Hygge/docs/ARCHITECTURE.md).

## What this is

Hygge is an iOS app (SwiftUI, iOS 17+) plus a Cloudflare Workers backend.
A cloud browser agent performs user-approved missions on arbitrary websites —
there are **no per-site API integrations and no navigation scripts** anywhere.
Read [docs/ARCHITECTURE.md](/Users/mikaellemberg/Hygge/docs/ARCHITECTURE.md)
before touching agent, vault, or site-memory code.

## Repo map

- `App/` — iOS app (SwiftUI views, services, assets). Entry: `App/HyggeApp.swift`.
- `Sources/HyggeCore/` — testable core logic (mission loop, matching, vault
  types, site memory, onboarding). Mirrored by `Tests/HyggeCoreTests/`.
- `backend/cloudflare/` — Worker + per-user `UserSandbox` Durable Object
  (browser worker, vault, site memory). See `backend/cloudflare/README.md`.
- `backend/agent-service/` — retired local Node service, kept in git history
  only. Do not revive it; the cloud backend is the production path.
- `docs/` — architecture notes, design atoms (`docs/design/atoms/`), screenshots.
- `scripts/` — `check-user-copy.mjs`, `check-flame-assets.py`,
  `make-flame-assets.py`.
- `.github/workflows/` — `ci.yml` (tests + staging deploy), `testflight.yml`
  (manual TestFlight upload).

## Commands (run from the indicated directory)

From repo root:

```bash
swift test   # HyggeCore tests
node scripts/check-user-copy.mjs        # user-facing copy check (CI runs this)
python3 scripts/check-flame-assets.py   # flame assets are full-frame APNGs (CI runs this)
xcodebuild -project Hygge.xcodeproj -scheme Hygge \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

From `backend/cloudflare/`:

```bash
npm ci
./node_modules/.bin/tsc --noEmit
npm test   # node --experimental-strip-types --test "test/*.mts"
npm run dev # wrangler dev -c wrangler.staging.jsonc
```

Backend deploy uses **separate config files per environment, never wrangler
`env`** (container bindings require it). Always pass `-c <config>`:

```bash
npx wrangler deploy -c wrangler.staging.jsonc
npx wrangler deploy -c wrangler.production.jsonc
```

Health: `https://api-staging.usehygge.app/health`,
`https://api.usehygge.app/health`.

## CI / release rules

- CI (`ci.yml`) runs core tests + copy check + flame check + unsigned iOS
  build, and backend `tsc` + tests, on every push and PR.
- Staging deploys automatically from `main` after green tests (health-checked).
- Production deploys **only** on manual `workflow_dispatch` with
  `deploy_production: true` (health-checked). Never trigger or imply a
  production deploy unasked.
- TestFlight uploads are manual (`testflight.yml`, signing via secrets).
  Never run this workflow unasked.

## Contracts you must not break

These are covered by tests on both stacks — keep them green:

1. **Approval gate.** Any state-changing task is drafted first and runs only
   after user approval. Enforced in Swift (`AgentError.notApproved`) and
   backend (403 on direct runs). Never add a path that acts in the user's
   name without approval.
2. **Never invent data.** Unknown required info comes back as `askUser`
   requests, never guessed values.
3. **Credential vault.** Secrets leave the vault only inside `vault.use()`
   to fill a login form. No endpoint returns a secret; the app holds only
   `CredentialRef {id, domain, username}`. Secrets never reach prompts,
   drafts, logs, or responses. Tests prove this — do not weaken them.
4. **Human handover.** CAPTCHA, 2FA, payment, and ID checks return
   `needsHuman` and pause for the user. Never bypass or automate around them.
5. **Site memory is advisory.** Distilled hints with success/failure counts;
   the agent may ignore them when the page disagrees. Never turn hints into
   scripts or per-site step lists.
6. **Model tiers.** `muse-spark-1.3` for routine steps/extraction,
   `muse-wonder-1.0` for planning, deviations, and user-facing text.
   Standard (non-`-contributor`) model ids only.
7. **Multi-tenancy.** One agent per user; every record carries `user_id`;
   per-user encryption keys; shared memory carries no personal data.
   User A can never read user B's anything — isolation tests are a release gate.
8. **Release builds require the cloud backend** (`HYGGE_REQUIRE_CLOUD`).
   Debug defaults to staging, Release to production; a developer override wins.

## Design rules (Warm Nordic)

Tokens and atoms: [docs/design/atoms/README.md](/Users/mikaellemberg/Hygge/docs/design/atoms/README.md).

- Flame mark is locked: coral `#FF6B57` outer + gold `#FFC53D` inner, exact
  paths in `flame-mark.svg`. Variants change face/extras only.
- Ember `#C93A26` for primary buttons (white text); never coral button text.
- Typeface SF Rounded everywhere; honor Dynamic Type and Reduce Motion.
- The money moment stays quiet: itemized receipt only, no flame, no confetti.
- Placeholder data in design atoms is illustrative; real market is Austin, USD.

## Working agreements

- Never commit secrets: `.env`, `HYGGE_*` keys/tokens, `*.p12`,
  `*.mobileprovision`, `.wrangler/`, `node_modules/`. `.gitignore` covers
  these — keep it that way.
- Match existing API shapes and reuse sibling helpers; derive the contract
  from call sites and existing tests, not from the issue text alone.
- Keep `README.md`'s "What it can do today" accurate when behavior changes.
- No `LICENSE` file exists yet — the maintainer is choosing one (see
  [CONTRIBUTING.md](/Users/mikaellemberg/Hygge/CONTRIBUTING.md)). Do not assert
  license terms in code or docs.
