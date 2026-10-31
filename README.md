<p align="center">
  <img src="docs/screenshots/mark.png" alt="Hygge, the walking flame" width="120">
</p>

<h1 align="center">Hygge</h1>

<p align="center"><strong>Work you like, without the boring parts.</strong></p>

<p align="center">Hygge (Danish, pronounced "hoo-gah") is being cozy and spending quality time with the people you love. This app gets you more of that — more money, fewer worries — by doing the boring work of finding it.</p>

<p align="center"><a href="https://usehygge.app">usehygge.app</a> · Built for the Meta Global AI Developer Hackathon — theme: <em>Build for Your World</em></p>

## The problem

Finding work — or saving money — is itself unpaid work. Gig opportunities are scattered across dozens of sites, boards, subreddits, and Facebook groups, and nobody has time to watch them all. Meanwhile the money leaks quietly: this project started with 68 subscriptions leaking from one inbox. And underneath it sits a bigger worry: being at the mercy of the next layoff round instead of having control over your own income.

Hygge watches all of it for you, and only asks for your time when there's something worth deciding.

## What Hygge does

**Earn more.** Hygge builds one earnings profile from your skills and interests, then finds work that fits: tailored job applications, freelancer and gig-site signup with profile management and proposals, and scans of boards, subreddits, and Facebook groups for paid opportunities — so you never miss a beat.

**Save more.** Subscriptions, refunds, settlements, fees, coupons, and price protection — the quiet leaks, found and plugged.

**One morning report, one approval queue.** Everything Hygge finds lands in a single feed, and nothing ever acts in your name without your approval.

## Screenshots

| Welcome | Home feed | Approval |
|---|---|---|
| <img src="docs/screenshots/welcome.png" width="240"> | <img src="docs/screenshots/home-feed.png" width="240"> | <img src="docs/screenshots/approval.png" width="240"> |

| Onboarding | Conversation |
|---|---|
| <img src="docs/screenshots/onboarding.png" width="240"> | <img src="docs/screenshots/conversation.png" width="240"> |

## How it works

1. **Tell Hygge what you're good at.** A conversational onboarding builds your earnings profile from your skills and interests — personalized replies, free-text extraction, tailored suggestions.
2. **Radar scans the sites you approve.** A cloud browser agent works on *any* website you point it at — pet-sitting sites, Upwork, Reddit, Facebook groups, local task boards, or a URL you paste in. No per-site APIs, integrations, or scripts: the agent starts each mission from its goal, looks at the page, and decides every action itself.
3. **Agents draft, you approve.** Every task is drafted first (goal, site, exact text), and nothing runs until you tap approve. Afterwards each run is distilled into advisory site memory — hints that make future visits faster, never replayed as a script.
4. **Morning report.** What was found, what was saved, what needs you — in Hygge's voice, in one feed.

## For judges

- **Built during the event.** This repository was created Oct 30, 2026, and every commit falls inside the Oct 26 – Nov 4 event window.
- **Meta models doing real work.** The cloud-browser agent runs on Meta's Muse models, routed per phase: Spark 1.3 for routine steps and extraction, Wonder 1.0 for planning, deviations, and drafting.
- **Verified live, not claimed.** On a cold visit to Remote OK, the agent chose its own actions step by step (Spark 1.3, escalating to Wonder 1.0 after a failed click), extracted real job listings, decided it was done, and only then distilled site-memory hints. The mission loop (observe → decide → act) is tested on both stacks, including a page-variant test no canned script could pass.
- **Rules the app never breaks.** It never invents data: when required information is unknown, a signup mission asks you instead of guessing. Nothing runs without your approval. Site passwords live encrypted in the server-side vault and are filled into login forms by the browser worker — never shown in the app, logs, or prompts. CAPTCHA, 2FA, and ID checks hand over to a human — never bypassed.

## What it can do today

Conversational onboarding with email, location, calendar, and notification permissions; site proposals with per-site approval and account tracking; signup missions that ask instead of inventing; matching; any-URL sites; goal-based missions with edit-and-approve; the LLM mission loop; live discoveries entering the feed as real items; site-memory distillation; encrypted credential vault with redacted injection; interactive cloud-browser view with takeover; applications pipeline; calendar booking. Cloudflare Workers backend: per-user Durable Object sandboxes with encrypted vault and site memory — staging E2E green, production environment provisioned.

Still to build: deduped click-through extraction into feed items (the feed still ships labelled demo items). See `docs/ARCHITECTURE.md`.

## Pricing

Free until Hygge makes you $100 in a month — then Plus at $9.99/month or $99/year for unlimited earnings. The goal is never a cut of every paycheck: it's becoming embedded in your personal finances, where partnerships, in-house services, member perks, and sponsored opportunities do the rest.

## Tech

- **iOS app:** SwiftUI, iOS 17+
- **Backend:** Node agent service — cloud browser, site memory, credential vault
- **Browser:** Cloudflare Browser Run (isolated Chrome per session), with a deterministic simulated browser so the whole product works offline in development
- **Backend (Cloudflare):** Workers + per-user Durable Objects, D1, R2 — staging `api-staging.usehygge.app`, production `api.usehygge.app`
- **Tests:** `swift test` (HyggeCoreTests) and backend integration checks

## Run it

**iOS app** — open `Hygge.xcodeproj`, run on an iOS 17+ simulator or device.

```bash
xcodebuild -project Hygge.xcodeproj -scheme Hygge -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

**Agent service** (cloud browser, site memory, credential vault)

```bash
cd backend/agent-service
node test_server.mjs                                    # integration checks
HYGGE_VAULT_KEY=$(openssl rand -hex 32) node server.mjs   # http://127.0.0.1:8787
```

Real browsing via Cloudflare Browser Run — set `HYGGE_BROWSER=cloudflare`, `CF_ACCOUNT_ID`, and `CF_API_TOKEN`. Or point the agent at a live LLM endpoint with `MUSE_LLM_BASE_URL` + `MUSE_LLM_API_KEY`; until then a labelled simulated decider runs the same loop offline.

Cloudflare Workers backend: see `backend/cloudflare/README.md` (staging `api-staging.usehygge.app`, production `api.usehygge.app`).

**Core logic tests** — `swift test`

## Repo map

- `App/` — iOS app (SwiftUI views, flame assets)
- `backend/agent-service/` — cloud browser agent, site memory, credential vault
- `backend/cloudflare/` — Cloudflare Workers backend (staging + production)
- `Tests/` — HyggeCoreTests
- `docs/` — architecture notes and design atoms
- `scripts/` — asset and dev scripts
