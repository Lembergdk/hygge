# AGENTS.md — Hygge contributor guide for coding agents

Source of truth for automated work here. Human versions: [README.md](README.md),
[CONTRIBUTING.md](CONTRIBUTING.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
Licensed under MIT — see `LICENSE`.

## What this is

Hygge ("hoo-gah") is an iOS app (SwiftUI, iOS 17+) that finds gig work and
manages it end-to-end behind **one approval queue**: conversational onboarding
builds an `EarningsProfile`, the agent proposes sites, every job is drafted
first, and nothing acts in the user's name without approval. A Cloudflare
Workers backend drives a cloud browser agent on arbitrary user-approved sites —
there are **no per-site API integrations and no navigation scripts** anywhere.
Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before touching agent, vault,
or site-memory code.

## Repo map (concrete)

- `App/HyggeApp.swift` → `ContentView` + `AppStore` (`@Observable`). State is
  `StoreSnapshot`: decode is tolerant (new fields default, never wipe state).
- `App/AppStore.swift` — store, `SiteAccountState`, `ProposedSite`, chat types.
- `App/BackendClient.swift` — `tasks`, `tasks/{id}/approve`, `sessions`,
  `sessions/{id}/act`, `credentials`, `onboarding/message`, `onboarding/stream`
  (SSE), `site-proposals`, `health`, `tasks` probe. Bearer token; stale `http://`
  local-backend URLs and their tokens are dropped (`BackendAddress`).
- `App/Views/` — `HomeFeedView`, `ApprovalsView`, `ConversationView`,
  `OnboardingView`, `CloudBrowserView` (watch/takeover via
  `BrowserSessionSnapshot`), `ProfileHubView`, `YourWorkView`,
  `IntroCarouselView`, `HyggeTheme` (Warm Nordic tokens + dark-mode mappings).
- `Sources/HyggeCore/` — `AgentTask` (kinds, status machine, factory drafts,
  `SimulatedMissionRunner`), `BrowserAgent` (`TargetSite`, `SiteMemory`,
  `CredentialRef`), `MatchEngine` (scoring + thresholds), `Models`
  (`EarningsProfile`, `Opportunity`, `ApplicationRecord`, `ActivityEvent`),
  `Onboarding`, `Journal`, `SeedSites` (17 starter sites), `BackendAddress`,
  `CloudRequirement` (`HYGGE_REQUIRE_CLOUD`), `TaskBatching`, `ChatActions`,
  `Beliefs`, `SampleData` (labelled demo feed items).
- `backend/cloudflare/src/` — `index.ts` (routes `/health /credentials /memory
  /sessions /tasks /site-proposals /onboarding /sandbox`; user id from verified
  credential only), `agent.ts` (mission loop, `MAX_STEPS = 25`), `llm.ts`
  (`selectTier`, `parseDecision`), `vault.ts` (per-user DEK, AES-256-GCM),
  `browser.ts`, `onboarding.ts` (`ReplyStreamExtractor`,
  `heuristicSuggestions`), `user-sandbox.ts`, `env.ts`.
- `backend/cloudflare/test/unit.mts` — tier routing, `parseDecision`, vault
  DEK/AAD binding, stream extractor, suggestions, `distillHints` (cap 12).
- `backend/cloudflare/e2e-staging.mjs` — against live staging: auth, two-user
  isolation, vault canary, approval-gate 403, onboarding SSE, proposals, a real
  Browser Run discover mission, memory hints, snapshot save/restore. Needs
  staging tokens (`/tmp/hygge_staging_tokens.json`); maintainer-run, not CI.
- `backend/agent-service/` — retired local service, history only. Do not revive.
- `docs/design/atoms/` — 17 SVG atoms + token README; `docs/design/
  onboarding-package/ONBOARDING-BUILD-SPEC.md`; `docs/screenshots/`.
- `scripts/` — `check-user-copy.mjs` (banned dev vocabulary in release Swift
  strings), `check-flame-assets.py` (full-canvas APNG frames),
  `make-flame-assets.py` (generates `App/Flame{Walk,Laptop,Notify}.png`).

## Commands (run from the indicated directory)

From repo root:

```bash
swift test   # HyggeCore tests
node scripts/check-user-copy.mjs        # copy check (CI runs this)
python3 scripts/check-flame-assets.py   # flame APNG check (CI runs this)
xcodebuild -project Hygge.xcodeproj -scheme Hygge \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

From `backend/cloudflare/`:

```bash
npm ci
./node_modules/.bin/tsc --noEmit
npm test   # node --experimental-strip-types --test "test/*.mts"
```

Separate wrangler configs per environment, never wrangler `env` — always
`-c <config>`. Health: `api-staging.usehygge.app/health`, `api.usehygge.app/health`.

## Where to change what

| Want | Touch | Prove with |
|---|---|---|
| Match/rank/feed honesty | `MatchEngine.swift`, `HomeFeedView.swift` | `swift test` |
| New/changed mission kind | `AgentTaskKind` + `AgentTaskFactory` + `SimulatedMissionRunner` + `backend/.../agent.ts` | both suites |
| Vault/credentials | `vault.ts`, `CredentialRef`, `BackendClient.storeCredential` | `npm test`, e2e canary |
| Onboarding dialogue/copy | `Onboarding.swift`, `onboarding.ts`, views | copy check + `swift test` |
| Theme/atoms/flame | `HyggeTheme.swift`, `docs/design/atoms/`, `make-flame-assets.py` | flame check |
| Backend route | `index.ts` `USER_ROUTES` + `user-sandbox.ts` | `tsc`, `npm test` |
| Schema change | `migrations/` + wrangler configs + both clients | full CI |

## Contracts you must not break (all test-enforced)

1. **Approval gate.** `AgentTaskKind.requiresApproval` is true for everything
   except `.discover`. Swift throws `AgentError.notApproved`; backend answers
   403 on direct runs; e2e asserts the 403. Never add an unattended path.
2. **Status machine.** `draft → awaitingApproval → approved → running →
   succeeded/failed`, with `needsHuman`/`rejected` exits; illegal transitions
   throw. After `requestReapproval`, the mission needs fresh approval.
3. **Never invent data.** Unknown required values become `askUser`
   `informationRequests` (e.g. signup asks phone/DOB), never guesses.
4. **Vault.** Secrets leave only via `vault.use()` into a login form. The app
   holds `CredentialRef` (id/domain/username — cannot carry a secret); the
   model sends `valueRef: credential.secret`, never literal passwords
   (worker refuses password-shaped literals). e2e scans every response for
   the canary. Do not weaken these tests.
5. **Human handover.** CAPTCHA/2FA/payment/ID → `needsHuman`, pause for the
   user in `CloudBrowserView`. Never bypass.
6. **Site memory is advisory.** `SiteMemoryRepository.learn` distils hints
   (capped at 12, with success/failure counts + `confidence`); missions start
   from goal + live page and may ignore hints. Never per-site step lists.
7. **Matching honesty.** Weights interest 0.35 / skills 0.35 / pay 0.2 /
   remote 0.1; recommend only at confidence ≥ 0.65 (`recommendationThreshold`),
   keep at ≥ 0.45; the rate floor is a promise (known pay below it is dropped
   regardless of score); `survey` records kept/borderline/dropped-with-reason
   as `SearchEvidence`. Journal, earnings and time-saved derive ONLY from
   witnessed `ActivityEvent`s; money counts ONLY from structured
   `estimatedGross`/`agreedGross`, never parsed label text.
8. **Model tiers** (`llm.ts selectTier`): spark-1.3 routine; wonder-1.0 on any
   failure, loop (`repeatedAction`), high-stakes final submit
   (`signup`/`apply`/`bookCalendar`), or drafting user-facing text. Standard
   (non-`-contributor`) model ids only. Step budgets: 25 server, 14 simulated.
9. **Multi-tenancy.** One sandbox per user (`sandboxFor`: DO name = user id);
   every record carries `user_id`; per-user DEKs; shared memory holds no
   personal data. Two-user isolation is e2e-gated — a release gate.
10. **Release honesty.** `HYGGE_REQUIRE_CLOUD`: Debug defaults to staging and
    may simulate; Release requires cloud and never silently simulates
    (`CloudRequirement`, tested).

## Voice and design rules

- Release Swift strings must not contain dev vocabulary
  (`agent service`, `simulated`, `mission(s)`, `payload`, `browser worker`,
  `server`, `vault credential`, `run-live`, `node server`) — the copy check
  fails; `#if DEBUG` is exempt.
- `OpportunityCategory.tileLabel` must fit a two-column tile;
  `activityLabel` is spoken language for onboarding; journal sentences are
  plain ("Hygge booked…", `SearchEvidence.journalSentence` pattern).
- `HyggeTheme` tokens only (dark-mode mappings included, warmed charcoal —
  never pure black): coral `#FF6B57` (theme `HyggeTheme.ember`) never carries
  button text (2.8:1) — primary buttons are ember `#C93A26` (theme
  `HyggeTheme.emberDeep`, white text 5.1:1). One saturated element per screen.
  Typeface SF Rounded everywhere.
- Cards carry one primary action: tag chip, title, 2–3 fact rows or one short
  paragraph, the primary button — anything more becomes a sheet; secondary
  exits are quiet text. Home order is fixed (greeting, at most one
  suggestion, pinned needs-you, journal); no tab bar, ever; the flame floats
  bottom-right, sticker-style.
- The flame is the approved left-facing walking flame (`FlameCharacter`
  asset; source `docs/design/flame-character-source.png`) — never redraw or
  substitute it. Moods animate (`FlameAnimation`: walk/laptop/notify), don't
  swap; honor Reduce Motion and Dynamic Type. Real market Austin, USD.
- Money honesty: counts only structured, witnessed amounts; the fee is not
  finalized — never present a cut as deducted (money screen reads "all
  yours"); time saved is always "about", rounded down, math visible in
  profile; zero work = zero claims ("none yet"). Money moment: "Done." +
  itemized receipt + sage Continue — no flame, no confetti. Beliefs
  (`BeliefBook`) are proposed and confirmed, never silently saved.

## Working agreements

- CI runs core tests + copy/flame checks + unsigned iOS build and backend
  `tsc` + tests on every push/PR. Staging deploys from `main` when green;
  production only on manual `workflow_dispatch`; TestFlight is manual. Never
  trigger deploys/uploads unasked.
- Never commit `.env`, `HYGGE_*` keys/tokens, `*.p12`,
  `*.mobileprovision`, `.wrangler/`, `node_modules/`, staging token files.
  Debug-only `HYGGE_STAGING_TOKEN` bakes are never set in CI/Release.
- Match sibling API shapes; derive contracts from call sites + existing
  tests. Keep README's "What it can do today" and demo-item labelling
  accurate when behavior changes.
