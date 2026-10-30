# Hygge — an agent that browses the gig economy for you

*Hygge* (Danish) is being cozy and spending quality time with the people you
love — what you get more of with fewer worries about money and more control
over your work-life balance. That's the point of this app.
Official domain: [usehygge.app](https://usehygge.app)

Hygge builds one **earnings profile** from your skills and interests, then a
**cloud browser agent** works on *any* website you point it at — pet-sitting
sites, Upwork, Reddit, Facebook groups, local task boards, or a URL you paste
in. No per-site APIs, integrations, or scripts: the agent starts each mission
from its goal, looks at the page, and decides every action itself. Afterwards
the run is distilled into advisory **site memory** — hints that make future
visits faster but are never replayed as a script.

You stay in charge: the agent drafts every task first (goal, site, exact text),
and nothing runs until you approve it. Site passwords live **encrypted in the
server-side vault** and are filled into login forms by the browser worker —
never shown in the app, logs, or prompts.

## Run it

The browser is driven by an LLM agent, one per user: **muse-spark-1.3** for
routine steps/extraction, **muse-wonder-1.0** for planning, deviations, and
drafting — routed per phase in `llm.mjs`. Point it at a live endpoint with
`MUSE_LLM_BASE_URL` + `MUSE_LLM_API_KEY`; until then a labelled simulated
decider runs the same loop offline.

**Agent service** (cloud browser, site memory, credential vault)

```bash
cd backend/agent-service
node test_server.mjs                                    # integration checks
GIGPILOT_VAULT_KEY=$(openssl rand -hex 32) node server.mjs   # http://127.0.0.1:8787
```

Real browsing via Cloudflare Browser Run (isolated Chrome per session).
On this machine the API token is read at runtime from the macOS Keychain
item "Muse Cloudflare Token" (never written to disk) and the account ID is
auto-discovered:

```bash
npm install
npm run test:live    # opens a real Browser Run session on example.com
npm run start:live   # service with the live browser worker
```

Anywhere else, set `GIGPILOT_BROWSER=cloudflare CF_ACCOUNT_ID=… CF_API_TOKEN=…`
instead.

Without those, the service uses a deterministic simulated browser so the whole
product works offline in development.

**iOS app** — `open Hygge.xcodeproj`, run on an iOS 17+ simulator/device.
Compile check: `xcodebuild -project Hygge.xcodeproj -scheme Hygge -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build`

**Core logic tests** — `swift test`

## Status (v1, honest edition)

Real: LLM-generated conversational onboarding (personalized replies,
free-text extraction, tailored category/skill suggestions) with email,
location, calendar and notification permissions; site proposals with
per-site approval and account tracking; signup missions that ask the user
for unknown required information instead of inventing it; matching,
any-URL sites, goal-based missions with edit-and-approve, the LLM mission
loop (observe → decide → act, tested on both stacks including a
page-variant test no canned script could pass), live discoveries entering
the feed as real items, site-memory distillation, encrypted credential
vault with redacted injection, interactive cloud-browser view with
takeover, applications pipeline, calendar booking.

Live-verified on this machine (`npm run test:live:agent` in
`backend/agent-service`): on a cold visit to Remote OK the agent chose its
own actions step by step (muse-spark-1.3, escalating to muse-wonder-1.0
after a failed click), extracted real job listings, decided it was done,
and only then distilled site-memory hints. Still to build: deduped,
click-through extraction into feed items (the app feed still ships
labelled demo items), and the production Cloudflare deployment (per-user
Durable Objects). See `docs/ARCHITECTURE.md`.
