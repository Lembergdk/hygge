# Contributing to Hygge

Thanks for your interest in Hygge! This guide covers setup, workflow, and the
ground rules that keep the project safe for everyone.

Please also read the [README](/Users/mikaellemberg/Hygge/README.md) for product
context and [docs/ARCHITECTURE.md](/Users/mikaellemberg/Hygge/docs/ARCHITECTURE.md)
for how the system fits together.

## Ways to contribute

- Bug reports and feature ideas via GitHub Issues (reproduction steps and
  expected vs. actual behavior help most).
- Pull requests for fixes and features (please open an issue first for large
  changes so we can agree on direction).
- Design and copy: the UI source of truth is `docs/design/atoms/` (see its
  README for tokens and flame rules); user-facing copy is checked by
  `scripts/check-user-copy.mjs`.

## Setup

Requirements: Xcode with the iOS 17+ SDK, Swift toolchain, Node 22, Python 3.

```bash
git clone https://github.com/Lembergdk/hygge.git
cd hygge
# iOS: open Hygge.xcodeproj and run on an iOS 17+ simulator or device.
# Backend:
cd backend/cloudflare && npm ci
```

No API keys or cloud credentials are needed for local development: without an
LLM key a labelled simulated decider runs the same mission loop, and the iOS
app falls back to the local simulated runner when the service is unreachable.

## Running checks

From the repo root:

```bash
swift test                         # HyggeCore tests
node scripts/check-user-copy.mjs   # user-facing copy check
python3 scripts/check-flame-assets.py  # flame assets must be full-frame APNGs
xcodebuild -project Hygge.xcodeproj -scheme Hygge \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

From `backend/cloudflare/`:

```bash
./node_modules/.bin/tsc --noEmit
npm test
```

CI runs all of the above on every push and pull request, deploys staging from
`main` after green tests, and deploys production only via manual approval.

## Pull request process

1. Fork the repo and branch from `main` (`fix/<topic>` or `feat/<topic>`).
2. Make the smallest change that fixes the root cause; follow existing API
   shapes and conventions in sibling code.
3. Add or update tests for behavior changes (`Tests/HyggeCoreTests/` for core,
   `backend/cloudflare/test/` for backend).
4. Run the checks above and make sure CI is green.
5. Open a PR describing what changed and why, referencing any related issue.
   A maintainer will review — approval and CI green are required to merge.

## Ground rules (safety-critical)

Hygge automates real accounts and handles credentials, so these are enforced
by tests and review — they are not negotiable:

- **Nothing acts without user approval.** State-changing work is drafted
  first and runs only after approval. Do not add unattended action paths.
- **Never invent user data.** Unknown required info must be asked for, not
  guessed.
- **Credentials stay in the vault.** Secrets are encrypted at rest and filled
  into login forms by the browser worker only — never shown in the app, logs,
  prompts, or API responses.
- **Human handover stays.** CAPTCHA, 2FA, payments, and ID checks pause for
  the user. Do not bypass or automate around them.
- **No per-site scripts.** The agent decides each action from the live page;
  learning is stored only as advisory site-memory hints.
- **Privacy.** Per-user data isolation is a release gate; shared memory must
  never carry personal data.

## Secrets

Never commit `.env` files, API keys or tokens (`HYGGE_*`), signing
certificates, or provisioning profiles. If you accidentally commit a secret,
tell a maintainer immediately so it can be revoked — don't just revert.

## Reporting security issues

Please do **not** open a public issue for vulnerabilities. Contact the
maintainer privately (see the repository profile for contact details) with a
description and reproduction steps, and allow time for a fix before any
public disclosure.

## License

The project is being prepared for open source and the license file is still
being chosen. Until a `LICENSE` file lands, all rights are reserved to the
repository owner — please don't redistribute the code, and check back for the
final license terms before reusing it.
