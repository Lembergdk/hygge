# Push notifications (Brief 07)

Transactional only. A push exists to keep one promise — "I'll tell
you in the morning — sooner if something needs you" — and nothing
else notifies. No marketing, no digests, no re-engagement, ever.

Format (user's call, 2026-11-03, superseding the brief's
title-only draft): messages from Hygge wear the sender's name
(`Hygge`) with the actual message as the body; the new-work chat
push names its listing. Every tap opens the chat message that
triggered it; a listing or a filed mail is one further tap from
that message's embedded card.

Policy (Mikael, Nov 5, 2026 — the spec for this document): every
decision card warrants a chat message linking to the card, and
every chat message generates a push — no exceptions. A push only
ever comes from a chat message; no feed card ever pushes on its
own. No push notifications while the app is open/foregrounded
(enforced app-side). Chat messages linking to cards are composed
by the agent from context and chat history — no static texts,
except the documented fallbacks in "How the message text is
composed" below. The deadline a card carries is set by the agent
itself when it surfaces something that has one; see "Deadlines"
below.

## Triggers (the complete list)

| # | Server event | Where it fires | Push |
|---|---|---|---|
| 1 | A task freshly enters `needsHuman` (or `failed` with a help) carrying a chat-routed help — any decision kind: information, approval, verification, credentials, recovery | `UserSandbox.saveTask` → `shouldNotifyDecisionHelp` + `helpRoutesToChat` | `needs_you`, title `Hygge`, body = the chat message's own words (the help card's text), deep link `task/<id>` opening the task's chat help card. A help-less `needsHuman` gets no message and no push — there is no content to compose a message about. The push fires only when the mirror message row actually exists (see "How the message text is composed") |
| 1b | A task freshly enters `awaitingApproval` — a draft is ready for review ("Ready for your review") | `UserSandbox.saveTask` → `notifyDraftReady` | `needs_you`, title `Hygge`, body = the agent-composed draft message, deep link `chat/<message-id>` opening the message whose embedded card is the draft. Deterministic id `draft-chat-<taskId>`, idempotent |
| 1c | A still-pending decision card reaches its expiry date | Scheduled tick → `UserSandbox.notifyExpiredCards` | `needs_you`, title `Hygge`, body = the agent-composed expiry notice, deep link `chat/<message-id>` opening the message whose embedded card is the expired card. Exactly once per card (server flag `expiryNotifiedFor`); a lifecycle notice, not urgency — expiry never affects routing |
| 2 | A scheduled-scan tick surfaces new listings | `POST /scheduled-scan/tick` → `planTickNotifications(summary)` | `new_work`, title `Hygge`, body = the agent-composed chat message text, deep link `chat/<message-id>` opening the conversation the message lives in |
| 2b | A scheduled-scan tick opens a needs-you episode (login failure / human check) | same tick hook | none — the episode waits in the feed; it has no chat message, so it cannot push |
| 3 | Authenticated mail from a tracked (or work-ruled) sender mentions a client message | `UserSandbox.handleEmailInbound` → triage highlights → backing chat message + embedded mail card | `message_waiting`, title `Hygge`, body = the backing chat message's composed words, deep link `chat/<message-id>`; at most one per sender per day. Skipped when the same mail already produced a chat question (trigger 3b) — one mail, one push |
| 3b | Authenticated mail asks a question the agent cannot answer alone | `handleEmailInbound` → `composeAndWriteMailChat` | `needs_you`, title `Hygge`, body = the composed chat question, deep link `chat/<message-id>`; once per mail (deterministic id dedupes) |
| 4 | The agent writes a reply in conversation | `chat-services.ts` `publishMessage` → `notifyChatMessage` | `needs_you`, title `Hygge`, body = the reply's own words, deep link `chat/<message-id>` |

Rules that bound all of them:

- **A push only ever comes from a chat message.** No feed card
  ever generates a push on its own. If there is no chat
  message, there is no push — that is why a help-less
  `needsHuman` and a scan needs-you episode stay silent.
- **Every chat message generates a push — no exceptions.** Any
  server path that writes an agent chat message schedules its
  push in the same step. There is no open-app exception
  server-side; the app suppresses banners while foregrounded.
- **At most one push per scan tick.** A tick sends at most the
  one new-work chat message; a scan batch never produces one
  push per item, and a needs-you episode never pushes at all.
- **Scan missions never double-notify.** Trigger 1 excludes
  scheduled-scan tasks; a tick's only push is trigger 2.
- **One mail, one push.** A mail that both triggers a chat
  question (trigger 3b) and mentions a client message (trigger 3)
  pushes once — the question's push. The backing push is skipped
  when the mail already produced a chat question.
- **Expiry notices fire exactly once per card.** The server flag
  (`expiryNotifiedFor` on the task, set before composition) means
  a later tick never re-fires for the same deadline; a re-asked
  help with a new deadline gets its own notice.
- **Fresh transitions only.** A task already sitting in
  `needsHuman` (or `failed`) does not re-notify. A resumed run
  that hits a further check is a new entry and does notify.
- **Paused users receive nothing.** Every send re-reads the
  Brief 01 server-side pause flag first.
- **No token, no send.** Denied permission means no token was ever
  registered, so there is nothing to attempt.
- Other filed mail (Brief 04), successes, proposals, and
  everything else do **not** notify: the triggers above are the
  complete list. Trigger 3 needs an aligned sender-authentication
  pass on top of the tracked/work-ruled sender, so forged mail
  can never raise a push.

## Payload

The only shape `buildPushPayload` (backend `src/push.ts`) can emit
— shown here for a new-work push, whose ref is the chat message
id itself:

```json
{
  "aps": { "alert": { "title": "Hygge", "body": "I found weekend dog sitting on Rover for £25 a night — it's in your feed." }, "sound": "default" },
  "hyggeKind": "new_work",
  "hyggeRef": "<chat message id>",
  "hyggeRoute": "chat/<chat message id>"
}
```

The body above is an example of what the composer produces from
the listing's facts — never a template; every message is composed
fresh from context (see "How the message text is composed").
`needs_you` pushes carry the task id instead
(`"hyggeRef": "<task id>"`, `"hyggeRoute": "task/<task id>"`).

- Titles and bodies pass one formatting path (`pushSafeText`):
  whitespace collapsed, code-shaped digit runs redacted,
  truncated at a word boundary (title ≤60, body ≤180 chars).
- No credentials, no codes, no earnings claims. Pay appears only
  as the listing's own label; a mail subject arrives already
  code-redacted from the email pipeline. A 2FA code never travels
  by push (Brief 04's pipeline owns codes). Schema tests assert
  the exact key set, the truncation, and the code redaction.
- **No badge number is sent**: the server keeps no badge count,
  and an invented one would drift from the feed.
- Routes: `task/<uuid>`, `chat/<uuid>`, `feed/<uuid>`, `email/<uuid>`, `home`.
  `feed/<uuid>` and `email/<uuid>` are legacy/compat shapes no
  current trigger emits — nothing in this codebase plans a feed or
  email push anymore (policy Nov 5, 2026 — feed items never push).
  The app parses them in `PushDeepLink` (HyggeCore); anything
  unknown lands on Home. Each current route opens the chat message
  that triggered the push, after a fresh pull: the task's chat help
  card (`task/<id>`), or the message itself (`chat/<id>`) — for
  mail, the tap opens the message, never the filed mail directly;
  the filed mail is one further tap from the message's embedded
  card. A route naming something already handled lands on Home
  with one plain line — never a substituted element.

## How the message text is composed

No chat message linking to a card carries a static string as its
text — each surface composes its text from context plus recent
chat history via `chat-composer.ts`, using the drafting tier
(wonder-1.0), naming only facts present in the context — never
invented, never a code or password, never a greeting or sign-off.
The feed card stays the interaction surface; the message is the
notification, not the interaction. Composition runs under a
30-second total budget (`CHAT_COMPOSER_TIMEOUT_MS`) so a stalled
model cannot block the sandbox, and every composition failure is
reported server-side (a structured error log plus a
`chat-composer-failure` row in the object's `events` table) so a
model outage silently killing notifications is detectable.

Decision helps are the one surface with a split: a help whose
text the mission model already composed from live page context
relays verbatim (`decisionHelpMessageText` in `task-help.ts`) —
the message and the card can never disagree. A help whose text is
a hardcoded literal (marked `staticText` at its producer:
recovery/verification/credentials fallbacks, checkpoint and
takeover wording) is composed from its facts instead: the mirror
first writes the literal relay so the message row exists, then
`saveTask` upgrades the row's text to the composed version and
pushes its words. The workspace projector's mirror has no
composer and keeps the literal relay as its fallback path.

Failure semantics: composition retries once, then fails closed —
no message is written and no push is scheduled. The feed card
remains the durable surface, and the next tick (or the next
turn) can compose again. Two documented exceptions to
"no static text anywhere":
- A static-literal help whose composition fails keeps its literal
  relay as the message text (logged, via the failure report
  above) and its push goes out with that text — the literal is
  the only content the card has.
- A push-body fallback ("Something needs you.", "You may have a
  new message", "New work is waiting in your feed.") fires only
  when a push event is built with no message text at all. No
  current caller does that: the decision-help push is gated on
  the mirror row existing, and the offer/mail/draft/expiry pushes
  require the composed text to plan anything. The fallbacks exist
  so a malformed call still notifies rather than silently
  dropping.

Every message row also carries `previousResponseId` — the id of
the message written immediately before it, resolved from the
live transcript at write time (strict previous_response_id
policy, Nov 5, 2026; null only for the first message). An
in-place text upgrade (the static-help composition above) keeps
the row's original value: an upgrade is not a new message.

## Deadlines

A card's deadline is an OPTIONAL EXPIRY TIME, FOR DISPLAY ONLY
(policy Nov 5, 2026, simplified Nov 5, 22:08 CST): it never
drives routing, escalation, or enforcement — every decision card
goes to chat anyway, so an expiry cannot gate anything. There is
no "short" concept and no window.

- The agent itself sets a deadline when it surfaces something
  that carries one (an offer expiry, an application closing
  date, a code expiry): the mission loop's model decision carries
  `deadline` through to `help()` (`agent.ts`, `task-help.ts`). A
  draft inherits a deadline only from an explicit deadline on the
  underlying opportunity/action — never invented.
- Validation: a deadline must parse as a real ISO date in the
  future. Garbage or past dates are dropped (and logged) and
  treated as no deadline. A date that lapses after it was set
  renders as a past "Expires" date on the still-live card —
  accepted as a display detail.
- Under the new policy the deadline no longer gates whether a
  decision card gets a message — every decision card gets one.
- Expiry lifecycle (Nov 5, 22:14 CST): when a still-pending
  decision card reaches its expiry, the card is marked expired
  but left in the feed — still viewable and dismissable, with
  interactivity removed (the expired display is derived lazily
  client-side from the expiry time) — and the agent is prompted
  to send a message about it (trigger 1c above), exactly once per
  card. The scheduled tick is the server-side trigger
  (`UserSandbox.notifyExpiredCards`). Only still-pending cards
  expire; a card the user already acted on is gone from the feed.
- Some producers never set one: onboarding/profile questions,
  credentials and recovery helps, checkpoint-budget verification,
  human-takeover verification, and the workspace runner's
  recovery help. Information helps carry one only when the agent
  surfaces one.

## Token lifecycle

1. **Ask once, with the reason stated first.** Onboarding asks
   for notifications alongside calendar, in the same message,
   each with its own optional Allow and the reason explained
   before the system prompt. Answering there (either way) retires
   the question: the Home primer card ("Want a word when
   something needs you?") exists only for people who skipped it
   undecided, shown after the first notifiable thing exists, and
   either answer retires it forever (`NotificationPrimerPolicy`,
   HyggeCore). After a no, the only way back is the Notifications
   section in the profile hub, which deep-links to Settings.
2. **Grant → register.** iOS delivers the token to
   `HyggeAppDelegate`; the app hex-encodes it and `POST
   /device-tokens` stores it in D1 `device_tokens` under the
   signed-in user (session auth; the token proves nothing).
   Registration is an idempotent upsert, refreshed on foregrounding,
   so rotation/reinstall just updates the row.
3. **Sign-out → unregister.** The app deletes exactly its token
   before the session is revoked, then forgets it locally.
4. **Permission revoked in Settings → unregister.** The next
   foreground refresh sees the denial, unregisters, and drops the
   local copy.
5. **APNs says the token is dead → delete immediately** (below).

There is deliberately no list endpoint, and `DELETE /device-tokens`
takes the token in the JSON body only (never in a URL path, where
it would land in logs). Registering a token that currently belongs
to another account reassigns it — a physical phone belongs to
whoever is signed in on it now. There is no parameter anywhere
that names another user.

## Failure behavior (silent-failure matrix)

Every *attempt* is one row in D1 `push_log` (`user_id`, `kind`,
`apns_status`, timestamp — never the token, never payload
contents). Push delivery can never fail user work: sends run after
the task/tick is saved, inside swallowed-error wrappers.

| Situation | Network call | `push_log` | Token kept? | User sees |
|---|---|---|---|---|
| APNs 200 | 1 | `ok` | yes | the notification |
| APNs 410 `Unregistered` | 1 | `410:Unregistered` | **deleted** | nothing (app gone) |
| APNs 400 `BadDeviceToken` | 1 | `400:BadDeviceToken` | **deleted** | nothing |
| Other APNs error (429/500…) | 1, no retry | `<status>:<reason>` | yes | nothing this time |
| Network error reaching APNs | 1 attempt | `network_error` | yes | nothing this time |
| Bad/missing local key material | 0 | `key_error` | yes | nothing |
| 5 consecutive failed events | 0 (suppressed) | `suppressed` | yes | nothing until a send succeeds or a fresh token registers |
| APNs not configured (no key yet) | 0 | `unconfigured` (once per event) | yes | nothing — logged no-op, never a fake success |
| User paused | 0 | — (not an attempt) | yes | nothing, by their choice |
| No registered token / denied | 0 | — (not an attempt) | n/a | nothing |

Suppression keeps a broken setup from becoming a retry storm.
Failures count per *event* (one `event_failed` summary row each),
not per token attempt, so one event fanning out to many stale
tokens counts once. Suppression lifts when a send later succeeds
or when a fresh device token registers (a status-only `registered`
marker row; routine re-registration of the same token writes no
row).

## Sender

`backend/cloudflare/src/push.ts`, Worker-side:

- ES256 provider JWT via WebCrypto (`importApnsKey`, `signApnsJwt`),
  cached 50 minutes (`ApnsJwtCache` — APNs caps tokens at one hour
  and forbids minting more often than every 20 minutes).
- `POST https://<host>/3/device/<token>` with `apns-topic`
  (bundle id), `apns-push-type: alert`, `apns-priority: 10`.
  Cloudflare `fetch` negotiates HTTP/2 to APNs. One attempt per
  token per event, newest tokens first, capped at 10.
- Host by environment: staging sends to `api.sandbox.push.apple.com`
  (Debug builds hold development tokens), production to
  `api.push.apple.com`. Selected by `HYGGE_APNS_ENVIRONMENT`.

## App / project changes

- `App/PushService.swift`: `HyggeAppDelegate` (token capture, tap
  routing, foreground banner) + `PushInbox` drain queue.
  `HyggeApp` installs it via `@UIApplicationDelegateAdaptor`.
- `App/Hygge-Debug.entitlements` (`aps-environment: development`)
  and `App/Hygge-Release.entitlements` (`production`), wired per
  build configuration via `CODE_SIGN_ENTITLEMENTS`; the Push
  capability is recorded in the project. Bundle id `app.usehygge`,
  team `3KA38L8A4F` — unchanged. Alert pushes need no
  background-modes entry, so none was added.
- No D1 migration: `device_tokens` and `push_log` from
  `migrations/0001_init.sql` already hold everything above
  (suppression is derived from `push_log`, not a new column).

## Configuration (names already reserved in `src/env.ts`)

| Name | Where | Notes |
|---|---|---|
| `HYGGE_APNS_KEY_P8` | **wrangler secret only** | the .p8 contents; PEM, one-line `\n`, or bare base64 all parse |
| `HYGGE_APNS_KEY_ID` | var or secret | the key's 10-character id |
| `HYGGE_APNS_TEAM_ID` | var or secret | `3KA38L8A4F` |
| `HYGGE_APNS_ENVIRONMENT` | var (committed) | `sandbox` staging / `production` production |
| `HYGGE_APPLE_BUNDLE_ID` | var (committed) | `app.usehygge`, used as `apns-topic` |

Until all three key values exist, sending is the logged
`unconfigured` no-op above — by design, so this code can deploy
before the key does.

## Remaining external gates (Mikael, Apple Developer portal)

Nothing below was done by this change; no key exists yet and no
live push has ever been sent.

1. **Create the APNs key**: developer.apple.com → Certificates,
   Identifiers & Profiles → Keys → new key with *Apple Push
   Notifications service (APNs)* enabled. Download the `.p8`
   (shown once) and note the Key ID. The App ID `app.usehygge`
   needs the Push Notifications capability enabled.
2. **Set the secrets** per environment (staging shown):
   `npx wrangler secret put HYGGE_APNS_KEY_P8 -c wrangler.staging.jsonc`,
   then `HYGGE_APNS_KEY_ID` and `HYGGE_APNS_TEAM_ID` the same way
   (or as plain vars — ids are not sensitive; the .p8 is).
   Repeat with `wrangler.production.jsonc` (same key works for
   both hosts; tokens differ per build).
3. **Deploy** both workers through the normal gate (not done here).
4. **Prove it on a device**: install a Debug build, sign in,
   accept the primer after a needs-you card appears, confirm the
   token row in staging D1, then trigger a `needsHuman` task and a
   scan batch and confirm delivery + `push_log` `ok` rows. This is
   the brief's end-to-end acceptance item and needs a real device
   (the simulator cannot receive remote pushes reliably). Warning:
   a TestFlight (Release) build pointed at staging registers
   *production* tokens with the staging backend, which sends
   sandbox — those pushes silently never arrive. Push proofs use a
   Debug device build against staging, or TestFlight against
   production after production secrets are set.
5. **Final title copy sign-off** at review, if different titles are
   wanted.
