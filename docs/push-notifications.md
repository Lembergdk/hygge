# Push notifications (Brief 07)

Transactional only. A push exists to keep one promise — "I'll tell
you in the morning — sooner if something needs you" — and nothing
else notifies. No marketing, no digests, no re-engagement, ever.

Format (user's call, 2026-11-03, superseding the brief's
title-only draft): messages from Hygge wear the sender's name
(`Hygge`) with the actual message as the body; the new-work chat
push names its listing. Every tap opens the exact element that
triggered it. Feed items never push (policy Nov 5, 2026).

## Triggers (the complete list)

| # | Server event | Where it fires | Push |
|---|---|---|---|
| 1 | A task freshly enters `needsHuman` with a chat-routed help (a deadline approval, a human-only check) | `UserSandbox.runTask` → `shouldNotifyNeedsHuman` + `helpRoutesToChat` | `needs_you`, title `Hygge`, body = the chat card's own words, deep link to the task. Information questions and deadline-free approvals stay in the feed and never push |
| 2 | A scheduled-scan tick surfaces new feed items | `POST /scheduled-scan/tick` → `planTickNotifications(summary)` | `new_work`, title `Hygge`, body `New work on <site>:` + first listing (title · its own pay label · place) + count, deep link `chat/<message-id>` opening the conversation the message lives in |
| 2b | A scheduled-scan tick opens a needs-you episode (login failure / human check) | same tick hook | none — the episode waits in the feed, no push |
| 3 | Authenticated mail from a tracked (or work-ruled) sender mentions a client message | `UserSandbox.handleEmailInbound` → triage highlights | `message_waiting`, title `Hygge`, body `<Site> emailed: "<subject>"`, deep link to that filed mail; at most one per sender per day |

Rules that bound both:

- **At most one push per scan tick.** A tick sends at most the
  one new-work chat message; a scan batch never produces one
  push per item, and a needs-you episode never pushes at all.
- **Scan missions never double-notify.** Trigger 1 excludes
  scheduled-scan tasks; a tick's only push is trigger 2.
- **Fresh transitions only.** A task already sitting in
  `needsHuman` does not re-notify. A resumed run that hits a
  further check is a new entry and does notify.
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

The only shape `buildPushPayload` (backend `src/push.ts`) can emit:

```json
{
  "aps": { "alert": { "title": "Hygge", "body": "Rover: I need a detail to continue. Which dates are you free?" }, "sound": "default" },
  "hyggeKind": "needs_you",
  "hyggeRef": "<task-or-feed-item-or-mail-id>",
  "hyggeRoute": "task/<id>"
}
```

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
  The app parses them in `PushDeepLink` (HyggeCore); anything
  unknown lands on Home. Each route opens the exact element it
  names, after a fresh pull: the task's chat help card, the
  listing's (or episode's) own detail, that one filed mail. A
  route naming something already handled lands on Home with one
  plain line — never a substituted element.

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
