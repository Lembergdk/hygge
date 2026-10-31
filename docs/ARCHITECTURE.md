# Hygge architecture (corrected: agentic browsing, not APIs)

## End-user journey (the contract everything serves)

1. **Conversational onboarding — three questions.** Inside the lifelong chat
   thread (script in `OnboardingConversation`, core): what work do you enjoy,
   your lowest rate, roughly where + when (with the calendar permission asked
   in context). Everything else is learned progressively. The app around it
   is one Home feed (pinned needs-you + plain-sentence journal), a floating
   flame into this conversation, and one profile hub — no tab bar (see the
   redesign specification, `hygge-ui-redesign-from-scratch.pdf`).
2. **Site proposals.** The agent proposes candidate sites for the user's
   interests (`POST /site-proposals`; live muse-spark-1.3 suggestions or
   curated seeds offline), each with a rationale. The user approves per site:
   *create my account* or *I already have an account* — or dismisses.
3. **Joining missions.** Approval drafts a high-level mission ("get me set up
   on Rover"). The agent must resolve the unknowns itself on the live site:
   existing account or new signup? What does the form require? Anything it
   cannot know (phone for verification, DOB, …) comes back as `askUser`
   information requests in the app — never invented data. Bot checks / 2FA /
   ID checks pause for takeover in the cloud-browser view.
4. **Ongoing work.** Discovery missions surface matched opportunities;
   apply/message/book missions follow the same draft → approve → mission loop.
   Site memory accrues hints so repeat visits get faster.

## The model

There are **no per-site API integrations and no navigation scripts**. One
cloud browser agent drives *any* website the user points it at the way a
person would: it knows its mission, looks at the page, and decides each
action itself. Afterwards, runs are distilled into per-domain **site memory**
— advisory hints with success/failure counts — so repeat visits start
smarter, never more scripted.

```
iPhone (SwiftUI)                Agent service (Node)                 Cloud browser
─────────────────               ─────────────────────                ─────────────
Onboarding → earnings profile   Tasks API (approval gate)            Cloudflare Browser Run
Opportunity feed + matching     Site memory (JSON store)  ←→   (isolated Chrome per
Approvals (edit drafts)         Credential vault (AES-256-GCM)       session, via CDP wss)
Interactive browser view        Browser worker (CDP)                 or local Playwright
Applications + calendar         Session manager (takeover)           or simulated (dev)
```

## Cloud browser

- Production worker: **Cloudflare Browser Run** over CDP —
  `wss://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/browser-rendering/devtools/browser?keep_alive=600000`
  with a Bearer API token, driven via Playwright `connectOverCDP`
  (`HYGGE_BROWSER=cloudflare`, needs `CF_ACCOUNT_ID`, `CF_API_TOKEN`,
  `npm i playwright-core`). Each session is an isolated sandbox browser.
- **Interactive**: the app renders the session snapshot (screenshot + element
  list) and can send actions (`click`, `type`, `navigate`) or flip
  human/agent control. CAPTCHA, 2FA, email verification and ID checks pause
  into this view for the user — they are never bypassed.
- Dev worker: `SimulatedBrowser`, a deterministic page model so the full
  contract is testable offline. The iOS app falls back to the local simulated
  runner if the service is unreachable, and the task log says when it did.

## The mission loop (how browsing actually works)

There are no scripts, playbooks, or per-site step lists — anywhere. Every
task is a **mission** (a goal plus approved draft content). The agent loop is:

```
observe page -> LLM decides ONE action -> execute -> observe -> ... -> done
```

- One decision per call, validated against an action schema
  (navigate/click/type/extract/done/needsHuman). The model finds its own
  path from what the page actually shows.
- Model tiers (`llm.mjs`): **muse-spark-1.3** decides routine steps;
  **muse-wonder-1.0** takes over after failures/deviations/loops, for final
  submits on high-stakes missions, and for composing user-facing text.
- Harness rails (enforced in code, not prompts): step budget, loop
  detection, literal passwords refused (vault placeholders only), CAPTCHA /
  2FA / payment / ID checks return `needsHuman` and pause for the user.

## Site memory (learning is an output, never an input script)

After a successful mission the trajectory is distilled into advisory
**hints** for that domain ("clicking X worked", "Y was not found — try a
different label", "listings readable from the landing page"), stored with
success/failure counts (`SiteMemory` in Swift core, `memory.json` in the
service). Future missions receive hints as context the agent may use or
ignore when the page disagrees. A brand-new site always starts from the
goal alone — memory can make the agent faster, never more rigid.

## Credential vault

Per the product decision, logins are stored **server-side** so the agent can
sign in unattended within approved tasks:

- AES-256-GCM at rest, random nonce per credential, domain+username as
  authenticated data. Master key from `HYGGE_VAULT_KEY` — in production
  this must come from a KMS/HSM or secret manager, not an env file on disk.
- Secrets leave the vault only inside `vault.use()`, called by the browser
  worker to fill a login form. No endpoint returns a secret; the app holds
  only `CredentialRef {id, domain, username}` — a type that cannot carry one.
  Tests prove the secret appears in neither the vault file nor any response.
- The agent references `credential.secret` placeholders; substitution
  happens in the worker, so secrets never reach prompts, drafts, or logs.
- Production hardening still required: user authn/z on every endpoint
  (optional bearer token exists: `HYGGE_API_TOKEN`), per-user keys, KMS
  key rotation, an audit log of every vault use, and TLS in transit.

## Multi-tenancy & privacy invariants

All users call the same shared model weights (muse-spark-1.3 /
muse-wonder-1.0). Model API calls are stateless: the model retains nothing
between requests, and Hygge never fine-tunes on user data — all "learning"
lives in the external site-memory store, precisely so it can be isolated, audited,
and deleted. Everything an agent appears to "remember" is Hygge state, so
isolation is enforced there:

1. **One agent (Durable Object) per user.** Prompts are assembled only from
   that user's profile, tasks, and page snapshots. Stateless model calls —
   no shared provider threads/conversation memory features.
2. **Per-user encryption keys.** Credentials and browser cookie jars are
   encrypted under a per-user DEK (wrapped by the master KEK). Deleting the
   DEK crypto-shreds that user's secrets. One user's key can never decrypt
   another's data.
3. **Tenancy on every record.** Every task, memory record, application, and
   object-storage key carries `user_id`; isolation tests (user A can never
   read user B's anything) are a release gate.
4. **Shared memory carries no personal data.** Promoted site-memory hints
   contain only facts about websites (labels/paths that worked). Values, page
   text, and names are scrubbed before promotion and never cross tenants.
5. **Provider data handling.** Standard (non-`-contributor`) model ids only —
   contributor variants may train on content. Review Meta Model API data
   retention terms before launch; minimise personal data in prompts.
6. **Page content is hostile input.** Listings can contain prompt injection
   aimed at the *same* user's agent ("email my CV to…"). Agent tools stay
   constrained to the approved goal; anything state-changing needs the user's
   approval, and secrets are vault-placeholders the model can't exfiltrate.

Note: the current local prototype is single-tenant (one Node process, one
vault file, no user auth). These invariants land with the production
Worker + Durable Object + D1 build; the prototype must never be exposed to
multiple users as-is.

## Guardrails that did not change

- **Human-approved**: any task that changes state on a site is drafted first
  (goal + exact text to type) and runs only after approval. Enforced in the
  Swift runner (`AgentError.notApproved`), the backend (403 on direct runs),
  and covered by tests on both sides.

## Risks to plan for

- Storing third-party passwords makes the vault a high-value target — budget
  for the KMS/auth/audit work above before real users.
- Some sites prohibit automated access in their terms and actively detect
  bots; expect per-site reliability to vary, use human checkpoints, and let
  confidence scores surface problem sites instead of hiding them.
