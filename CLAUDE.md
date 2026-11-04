# CLAUDE.md — Hygge guide for Claude

Start with [README.md](README.md), then
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). [AGENTS.md](AGENTS.md) is the
source of truth for commands, change-paths, and contracts — follow it.
Licensed under MIT (`LICENSE`).

## Orientation

- **App** (`App/`, SwiftUI, iOS 17+): `HyggeApp` → `ContentView` + `AppStore`.
  One Home feed (greeting, ≤1 suggestion, pinned needs-you, journal), a
  floating flame into the lifelong conversation, one profile hub — no tab bar.
  `ApprovalsView` is the single queue where every drafted task waits.
- **Core** (`Sources/HyggeCore/`, tested by `Tests/HyggeCoreTests/`):
  `AgentTask` (six kinds in `AgentTaskKind`, status machine, `AgentTaskFactory`
  drafts, `SimulatedMissionRunner` fallback), `MatchEngine` (0.35/0.35/0.2/0.1
  weights, recommend ≥ 0.65, keep ≥ 0.45, floor is a promise), `Models`
  (`EarningsProfile`, `Opportunity` with `isDemo` demo labelling,
  `ApplicationRecord`, witnessed-only `ActivityEvent`), `SiteMemory` (hints
  capped at 12), `SeedSites` (17 starters; users can add any URL via
  `TargetSite.userAdded`), `Journal` (plain sentences from events only).
- **Backend** (`backend/cloudflare/src/`, TypeScript): `index.ts` routes,
  `agent.ts` mission loop (`MAX_STEPS = 25`), `llm.ts` tier routing
  (spark-1.3 routine, wonder-1.0 on failure/loop/high-stakes/drafting),
  `vault.ts` per-user DEK, `user-sandbox.ts` (DO name = user id).
  Unit tests in `test/unit.mts`; `e2e-staging.mjs` covers isolation, vault
  canary, and the 403 approval gate against live staging (maintainer-run).

## The one idea to internalize

Observe page → LLM decides ONE action → execute → repeat. No per-site
integrations, no scripts; runs distil into advisory hints, never replayed.
If you're about to add per-site logic, stop and re-read the architecture doc.

## Fastest safe loop

```bash
swift test                                    # core tests (repo root)
node scripts/check-user-copy.mjs              # banned dev words in UI strings
python3 scripts/check-flame-assets.py         # full-canvas APNG frames only
(cd backend/cloudflare && ./node_modules/.bin/tsc --noEmit && npm test)
```

Unsigned iOS build with `xcodebuild -project Hygge.xcodeproj -scheme Hygge`
(see AGENTS.md). Debug → staging, Release → production; Release never
simulates (`CloudRequirement`).

## Things Claude should be careful with here

- **Approval/vault/matching rules are test-enforced** (AGENTS.md Contracts).
  Verify with the repo's suites, not throwaway scripts; never weaken a
  vault/approval test to make a change pass.
- **Design atoms** (`docs/design/atoms/`) + `HyggeTheme` own the UI: Warm
  Nordic tokens, one primary action per card, locked left-facing flame
  (`FlameCharacter`, never redrawn), quiet money moment ("Done." + receipt +
  sage Continue), no dev vocabulary in user strings. Build against atoms,
  compare screenshots against mocks.
- **Environments:** never trigger production deploys or the manual TestFlight
  workflow unasked. Secrets (`.env`, `HYGGE_*`, certs, profiles, staging
  token files) are never committed, pasted, or logged.
