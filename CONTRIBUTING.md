# Contributing to Hygge

Thanks for stopping by! Hygge ("hoo-gah") is an iOS app that finds work
people like and handles the boring parts: one earnings profile, gig scans
across any site the user approves, and a **single approval queue** — nothing
ever acts in the user's name without their tap. Please read the
[README](README.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first;
they explain the mission loop everything else serves.

## Ways to contribute

- **Issues**: bug reports (steps to reproduce, expected vs. actual) and
  feature ideas. For anything that automates user accounts or money, open an
  issue first so we can agree on the safety design.
- **Pull requests**: fixes and features. Large changes deserve an issue first.
- **Concrete starter areas**: new `SeedSites` entries (starter goals for a
  gig site), `SkillPresets`, matching edge cases in `MatchEngine`, design
  atoms in `docs/design/atoms/`, user-facing copy, and tests. The agent needs
  no per-site code — please don't add any.

## Setup

Requirements: Xcode with the iOS 17+ SDK, Swift toolchain, Node 22, Python 3.

```bash
git clone https://github.com/Lembergdk/hygge.git
cd hygge
# iOS: open Hygge.xcodeproj, run on an iOS 17+ simulator or device.
# Backend:
cd backend/cloudflare && npm ci
```

No API keys or cloud accounts needed: without an LLM key a labelled simulated
decider runs the same mission loop, the app falls back to its on-device
simulated runner when the backend is unreachable, and the feed ships labelled
demo items (`Opportunity.isDemo`) so the whole product is explorable offline.

## Running checks

From the repo root:

```bash
swift test                            # HyggeCore tests
node scripts/check-user-copy.mjs      # no dev words in release UI strings
python3 scripts/check-flame-assets.py # flame APNGs must be full-canvas frames
xcodebuild -project Hygge.xcodeproj -scheme Hygge \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

From `backend/cloudflare/`: `./node_modules/.bin/tsc --noEmit` and `npm test`.

CI runs all of the above on every push/PR, deploys staging from `main` when
green, and deploys production only via manual approval. The staging
end-to-end script (`e2e-staging.mjs` — isolation, vault canary, approval-gate
403, live Browser Run mission) needs staging tokens and is maintainer-run;
you don't need it for a PR.

## Pull request process

1. Fork, branch from `main` (`feat/<topic>`, `fix/<topic>`, `docs/<topic>`).
2. Make the smallest change at the root cause; follow sibling conventions.
3. Add or update tests (`Tests/HyggeCoreTests/`, `backend/cloudflare/test/`).
4. Run the checks above; CI must be green. Approval required to merge.

## Ground rules (safety-critical, test-enforced)

Hygge drives real accounts and holds credentials, so these aren't negotiable:

- **Nothing acts without approval.** Every state-changing task is drafted
  first (`AgentTaskFactory`) and runs only after approval
  (`AgentTaskKind.requiresApproval`, 403 on direct backend runs).
- **Never invent user data.** Unknown required info is asked for (`askUser`),
  never guessed. The rate floor is a promise: known pay below it is dropped,
  however good the rest looks.
- **Credentials stay in the vault.** Secrets are encrypted per-user and typed
  into login forms by the browser worker only — never in the app, logs,
  prompts, or API responses. The app holds only `CredentialRef` values.
- **Humans handle the hard stops.** CAPTCHA, 2FA, payments, ID checks pause
  for the user in the cloud-browser view. Don't bypass or automate around them.
- **No per-site scripts.** The agent decides each action from the live page;
  learning lives only as advisory site-memory hints. Isolation is per-user
  (one sandbox each); shared memory must never carry personal data.

## Voice and design

Hygge speaks plainly: journal entries are one witnessed sentence each
("Hygge booked…"), never reconstructed activity. Release strings must avoid
developer vocabulary (server, mission, payload, vault…) — the copy check
enforces this. UI follows `docs/design/atoms/` and `HyggeTheme`: Warm Nordic
tokens, one primary action per card, the locked left-facing flame, and a
quiet money moment (receipt, no confetti). Money counts only from structured,
witnessed amounts; time saved is "about", rounded down. Real market Austin, USD.

## Secrets and security

Never commit `.env`, API keys/tokens, certificates, or provisioning profiles.
If you leak one, tell the maintainer immediately so it can be revoked.

Found a vulnerability? Don't open a public issue — contact the maintainer
privately (see the repo owner's GitHub profile) with details and reproduction
steps, and allow time for a fix before disclosing.

## License

Hygge is open source under the MIT License — see `LICENSE`. By contributing,
you agree that your contributions will be licensed under the same terms.
