# @usehygge.cc email identity (Brief 04) — receive only

Hygge never sends mail from a `@usehygge.cc` address. There is no
SMTP client, no send API, no reply/forward path, and no send
binding in any wrangler config. A backend test
(`backend/cloudflare/test/email.mts`, "receive-only: no
mail-send path exists") asserts this over all backend source and
config. The only outbound call the pipeline makes is an HTTPS GET
on a verification link that arrived inside received mail (https
only, no embedded credentials, no IP/localhost hosts — see
`isSafeVerificationLink` in `backend/cloudflare/src/email.ts`).

## DNS observed at build start (step 1)

Re-checked 2026-11-01 from the build machine:

```console
$ dig +short NS usehygge.cc
priscilla.ns.cloudflare.com.
harlan.ns.cloudflare.com.
$ dig +short MX usehygge.cc        # (empty)
$ dig @1.1.1.1 +short MX usehygge.cc  # (empty)
$ dig +short TXT usehygge.cc       # (empty)
```

The zone is connected in Cloudflare (Cloudflare nameservers), but
Email Routing is **not** enabled and the domain cannot receive
mail yet. No existing MX/TXT/routes were found from DNS; check the
dashboard for any existing address/routing rules before enabling
(open question in the brief — if human mailboxes exist on this
domain, add explicit routes for them **before** the catch-all).

## Mikael action: enable Email Routing (step 2)

Zone changes were out of bounds for the build agent (no DNS/zone
changes, no deploys). Exact steps:

1. Cloudflare dashboard → select the `usehygge.cc` zone →
   **Email** → **Email Routing** → **Get started / Enable**.
   Cloudflare adds the required DNS records itself:
   - MX `route1.mx.cloudflare.net`, `route2.mx.cloudflare.net`,
     `route3.mx.cloudflare.net` (priorities assigned by Cloudflare)
   - TXT SPF record for Email Routing
   (Do not hand-edit these afterwards; routing breaks if the MX
   set changes.)
2. Confirm there are no pre-existing destination addresses or
   routing rules that must keep working. If any exist, create
   explicit **Custom address** rules for them first — specific
   rules take precedence over the catch-all.
3. **Routing rules → Catch-all address**: enable it and set the
   action to **Send to a Worker** → `hygge-api-production`
   (the worker whose `email` handler is `handleEmailMessage` in
   `backend/cloudflare/src/email.ts`). All `*@usehygge.cc` mail
   then enters the pipeline. Unknown numeric addresses are
   dropped inside the worker with only a daily count recorded.
4. Confirm the deployed production worker has the `0004_email.sql`
   D1 migration applied (`hygge_email_addresses`,
   `email_routing_counts`) and `HYGGE_EMAIL_DOMAIN=usehygge.cc`
   (already in `wrangler.production.jsonc`). Apply the same
   migration to staging before staging tests.
5. Email Workers availability: the `email` handler deploys with
   the normal worker. If the dashboard reports the plan does not
   include Email Workers, stop and report — do not substitute
   another mail provider.

Staging note: Email Routing is per-zone, so live mail can only be
routed to one worker. Test on staging with the synthetic pipeline
tests (`npm test` in `backend/cloudflare`); do the first live
delivery test (below) against the production worker using one
allocated test address. Do not point the production catch-all at
staging.

## Verification commands (steps 2 and 8)

```console
dig +short MX usehygge.cc     # expect route1/2/3.mx.cloudflare.net
dig +short TXT usehygge.cc    # expect the Email Routing SPF record
dig @8.8.8.8 +short MX usehygge.cc
dig @1.1.1.1 +short MX usehygge.cc
```

Live end-to-end (after enablement + production deploy, handled by
the coordinator):

1. In the app (profile hub → "Your Hygge email address") allocate
   an address for a test account: `NNNNNNNNNN@usehygge.cc`.
2. From any normal mailbox, send a mail to that address with
   subject `Your sign-in code` and body `Your one-time code is
   123456.` — then check `GET /email/messages` shows a filed
   summary with the code redacted and `GET /email/codes/pending`
   shows only sender domain + time (never the code).
3. Send a second mail to an unallocated numeric address (e.g.
   `0000000001@usehygge.cc`): nothing is filed anywhere; only the
   `dropped_unknown` daily count in `email_routing_counts` rises.
4. A verification-style mail containing an https verify link for
   a pending Hygge-address signup completes that task (see
   `attachEmailToTask`); the same path is covered without live mail by the backend end-to-end test.

## How the pieces fit

- Allocation: `POST /email/address` (idempotent) inserts into D1
  `hygge_email_addresses` — 10 random digits, unique constraint,
  regenerate-and-retry on collision (`allocateHyggeAddress`).
  Format choice: 10 digits = 10^10 space; at 100k users a fresh
  draw collides with probability about 1e-5, absorbed by retry.
  Leading zeros are allowed (the full 10^10 space). Digits come
  only from the random source — never from name/email — and the
  mapping is read only as "my own address" by the signed-in user
  (`GET /email/address`). There is no lookup-by-digits endpoint.
- Pipeline: catch-all → worker `email` handler → parse
  (`parseMimeMessage`: attachment bodies dropped, metadata only)
  → classify (verification / security code / other) → deliver
  into the owning user's Durable Object (`/email/inbound`,
  Email-Worker marker required; the marker is stripped from
  outside requests in `index.ts`, so deliveries cannot be forged
  over HTTP).
- Sender authentication: Hygge addresses are handed to sites at
  signup, so forged mail is realistic. Sender-attributed actions
  — sealing a code, following a verification link, completing a
  signup — require an aligned DKIM/SPF/DMARC pass in
  `Authentication-Results` for the From domain
  (`senderPassesAuthentication`). Mail without one is only ever
  filed as a summary. Scheduled scans never spend emailed codes
  at all (see Brief 05); a check during a scan pauses for the
  user instead.
- Verification: the https verify link is followed server-side and
  the outcome (host only, never the token URL) is attached to the
  pending signup task; a Hygge-address signup awaiting email
  verification completes without the user opening email.
  Verification codes travel the code path instead.
- Codes: sealed with the user's DEK in their object
  (`email_codes`), 30-minute expiry, deleted on first consumption
  by the next approved mission (`emailCode.code` valueRef). Codes
  never appear in summaries, task JSON, logs, prompts, or any API
  response (`/email/codes/pending` returns sender domain + time
  only). The mission may fill one two-factor field once from this
  sealed store; CAPTCHA/ID and all other checks still pause for
  the user exactly as before.
- Other site mail: filed as a summary (`email_summaries` plus a
  `filedEmail` journal event in Brief 01 server state). Summaries
  redact codes and replace links with their host. New ordinary originals
  are now retained separately under the encrypted receive-only experience
  update below. Older summary-only records cannot recover their bodies.
- Model reading (2026-11-03): ordinary mail ("other" kind only —
  verification/code mail never reaches a model) is read once at
  ingest, while the parsed text still exists (`reasonAboutEmail`
  in `email.ts`). The system text treats the mail as untrusted
  data that can never issue instructions; output is validated
  (`validateEmailReading`): kind-checked mentions, bounded
  lengths, and an `instruction` field that survives only when the
  sender is the sender-proven owner (same gates as above). The
  reading upgrades the stored summary (re-redacted), the
  highlights (concrete mention details over keyword labels), and
  feeds the existing triage actions in the owning object —
  scan-tick trigger, message-waiting push, owner command
  execution (strict parser first, on the owner's own words;
  model instruction second, site reference re-validated). No
  model, no change: the deterministic reading stands.
- One mail, one event, actions in action surfaces (2026-11-04):
  identity is content (`mailContentHash`: sender domain +
  Fwd-stripped subject + opening body) — a re-forward changes
  nothing (no second summary, journal entry, proposal, or push).
  Each distinct mail earns exactly one journal entry: a
  past-tense fact (what arrived, what it said, what Hygge did),
  never an ask. Anything needing the user lives elsewhere: a
  jobs-bearing mail evidencing a place becomes a feed proposal
  (`proposeSiteFromMail`, carrying `sourceMailDomain`);
  work-relevant mail with no place to attach becomes a question
  in the chat thread (`composeAndWriteMailChat` — the agent
  composes the question from the mail, then it pushes); genuinely uninferrable senders are evaluated like work mail (the sender-decision card is gone). Outcomes
  are counted (`duplicate` / `proposed_site` / `chat_asked` /
  `reasoned`) without logging content.
- Mail acts by default (2026-11-04): the sender-decision card is gone — every tracked sender's mail is evaluated like work mail always was (highlights, message push, site proposal, chat asks), and the only remembered sender call left is 'ignore'. Proposing a site and asking in chat no longer require sender authentication (asking is consent, not action); authentication still gates pushes, owner commands, and codes. The mail reading gains a bounded jobs list; a forwarded job alert proposes the site its links point at with your rationale, or lists the jobs in one chat message when no site pins. Filed-mail detail gains Ignore/Stop-ignoring, and Settings lists ignored senders.
- Forwarding: mail the user forwards or cc's from their own
  mailbox to their Hygge address enters the same pipeline
  (attributed by recipient digits). The profile hub shows the
  address with short forwarding instructions. No external mailbox
  is auto-configured.
- Own-email path: at a site signup the user can confirm their own
  email instead. Hygge suggests a strong site password (generated
  on-device, `SitePasswordSuggestion` in HyggeCore; policy mirrored in
  `email.ts`: 20 chars across four groups); on confirmation it
  goes once to the existing per-user-DEK vault via
  `POST /credentials` and nowhere else. It is a site password,
  never a Hygge-account password.
- Observability: `email_routing_counts` holds daily counts only
  (received / dropped_unknown / dropped_malformed / kind /
  link_follow_ok|failed / delivery_failed). No addresses, senders,
  subjects, bodies, or codes are logged anywhere in this brief.


## Receive-only email experience (implemented; not deployed)

This update supersedes the older summary-only retention policy for new ordinary emails. It does not add any outbound send, reply, SMTP binding, or broader magic-link sender permission.

- New ordinary mail retains the original subject, From/To/Cc, decoded text and HTML body, encrypted with the user's DEK in their Durable Object. Protection/verification mail retains its existing separate code handling and is never exposed as an original. Attachments remain metadata only.
- Bodies are bounded by the existing 512 KiB inbound limit and a 750 KB serialized-original budget. Any retained partial message is explicitly marked truncated. Older rows cannot recover bodies that were never retained; their detail view labels the saved summary as a fallback.
- Generated titles are separate from original subjects. Old rows and unavailable model output fall back to the original subject. No backfill or replay is performed.
- `/email/messages` paginates by timestamp plus ID, returns 100 summaries and an opaque `nextCursor`; original bodies are excluded. `/email/messages/:id/original` reads only that user's sealed message, with `Cache-Control: no-store`.
- Feed cards, history rows and email notification taps open the AI summary first, including structured roles when available. “Email details” then navigates to the original and is the only point that fetches its body. Both views use “Discuss in chat” to open the regular conversation.
- The original-email reader renders in an isolated, nonpersistent WebKit view with content JavaScript disabled, a blocking resource rule and CSP. Remote resources/forms/automatic navigation are blocked. Deliberate HTTP(S) link taps can open externally. No reply composer is added; Discuss in chat opens the regular chat with the mail context.
- `/email/addresses` lists account addresses and separately managed personal addresses. Adding a personal address returns a 24-hour verification subject. The user sends a new email from that address to their Hygge address with the exact subject. An aligned authenticated sender plus the one-use hashed challenge verifies ownership. Hygge sends no verification mail. Challenge emails bypass model reading and are consumed without replaying old messages or executing instructions.
- Inbound owner recognition merges verified managed addresses with the existing account identities, retaining sender-authentication checks. Managed addresses are not login methods. Account addresses remain managed through account login settings.
- `/email/messages/:id/me` records a reversible manual label and adds the exact sender to the personal-address flow when available. The label does not set verified-owner authority or rerun the email. Older redacted/missing sender addresses can still be labelled; the user adds the actual address separately.
- Domain ignores remain reversible and take effect in the UI only after server acknowledgment.

### Validation and deployment

The implementation includes local SQLite history/verification tests, ingestion/encryption tests, backward-compatible Swift model tests, and a localhost-only UI fixture (`scripts/receive-email-ui-fixture.py`). Launch DEBUG with `--settings-preview --settings-populated --email-ui-fixture` and `-settingsPreviewScreen email-original`, `email-history`, or `email-preferences`; `--email-feed-preview` opens the real feed using fixture metadata.

No production/staging deployment, DNS change, live schema activation, live identity change, incoming mail replay, or outbound mail send is authorized by this implementation. New DO tables/columns initialize on the first request after a future deployment. Deploy the backend capability before releasing the corresponding client. Original-body retention starts only with newly ingested ordinary mail after that deployment.
