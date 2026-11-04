# CLAUDE.md — Hygge guide for Claude

Start with [README.md](/Users/mikaellemberg/Hygge/README.md) for what Hygge is,
then [docs/ARCHITECTURE.md](/Users/mikaellemberg/Hygge/docs/ARCHITECTURE.md)
for how it works. [AGENTS.md](/Users/mikaellemberg/Hygge/AGENTS.md) is the
source of truth for commands, CI, and engineering contracts — follow it, and
don't duplicate its contents here.

## Orientation

- **iOS app** (`App/`, SwiftUI, iOS 17+): onboarding conversation, Home feed,
  single approval queue, interactive cloud-browser view. No tab bar — one Home
  feed, a floating flame into the conversation, one profile hub.
- **Core logic** (`Sources/HyggeCore/`, tested by `Tests/HyggeCoreTests/`):
  mission loop, matching, vault types, site memory, onboarding.
- **Backend** (`backend/cloudflare/`, TypeScript on Cloudflare Workers):
  one `UserSandbox` Durable Object per verified user, D1 control plane.
  Staging `api-staging.usehygge.app`, production `api.usehygge.app`.

## The one idea to internalize

One cloud browser agent drives any user-approved website the way a person
would: observe page → LLM decides one action → execute → repeat. There are no
per-site integrations or scripts, and runs distill into advisory site-memory
hints — never replayed as scripts. If you're about to add per-site logic,
stop and re-read the architecture doc.

## Fastest safe loop

```bash
swift test                                    # core tests (repo root)
node scripts/check-user-copy.mjs              # copy check (repo root)
python3 scripts/check-flame-assets.py         # flame asset check (repo root)
(cd backend/cloudflare && npm ci && ./node_modules/.bin/tsc --noEmit && npm test)
```

Unsigned iOS build:

```bash
xcodebuild -project Hygge.xcodeproj -scheme Hygge \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

## Things Claude should be careful with here

- **Approval gate and vault rules** (AGENTS.md §Contracts) are test-enforced.
  Verify with the repo's tests, not throwaway scripts, and never weaken a
  vault/approval test to make a change pass.
- **Design atoms** in `docs/design/atoms/` are the UI source of truth: Warm
  Nordic tokens, locked flame mark, quiet money moment. Match them; don't
  improvise new flame faces or button colors.
- **Environments:** Debug → staging, Release → production, override wins.
  Never trigger production deploys or the manual TestFlight workflow unasked.
- **Secrets** (`.env`, `HYGGE_*` keys, certificates, profiles) are never
  committed, pasted into prompts, or logged. The app holds only
  `CredentialRef` values — a type that cannot carry a secret.
- The repo has no `LICENSE` file yet (maintainer is choosing one). Don't
  assert license terms.
