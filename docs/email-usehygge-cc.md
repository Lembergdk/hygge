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
  Email-Worker marker required).
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
  redact codes and replace links with their host; full bodies are
  not retained. Retention follows Brief 01 journal/feed
  retention — no separate expiry in this brief.
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
