# Push notifications (Brief 07)

Transactional only. A push exists to keep one promise — "I'll tell
you in the morning — sooner if something needs you" — and nothing
else notifies. No marketing, no digests, no re-engagement, ever.

## Triggers (the complete list)

| # | Server event | Where it fires | Push |
|---|---|---|---|
| 1 | A task freshly enters `needsHuman` (approval checkpoint, human-only check, or information request) | `UserSandbox.runTask` → `shouldNotifyNeedsHuman` | `needs_you`, deep link to the task |
| 2 | A scheduled-scan tick surfaces new feed items | `POST /scheduled-scan/tick` → `planTickNotifications(summary)` | `new_work`, deep link to the first new item |
| 2b | A scheduled-scan tick opens a needs-you episode (login failure / human check) | same tick hook | `needs_you`, deep link to the episode's feed item |

Rules that bound both:

- **At most one push per scan tick.** If a tick both surfaces work
  and opens a needs-you episode, only the needs-you push is sent;
  the new work is waiting in the feed when the user opens the app.
  A scan batch never produces one push per item.
- **Scan missions never double-notify.** Trigger 1 excludes
  scheduled-scan tasks; their episodes go through trigger 2b once
  per tick.
- **Fresh transitions only.** A task already sitting in
  `needsHuman` does not re-notify. A resumed run that hits a
  further check is a new entry and does notify.
- **Paused users receive nothing.** Every send re-reads the
  Brief 01 server-side pause flag first.
- **No token, no send.** Denied permission means no token was ever
  registered, so there is nothing to attempt.
- Filed mail (Brief 04), successes, proposals, and everything else
  do **not** notify: the brief lists exactly the triggers above.

## Payload

The only shape `buildPushPayload` (backend `src/push.ts`) can emit:

```json
{
  "aps": { "alert": "Hygge needs you", "sound": "default" },
  "hyggeKind": "needs_you",
  "hyggeRef": "<task-or-feed-item-id>",
  "hyggeRoute": "task/<id>"
}
```

- `alert` is a bare **title string** — there is no body field, so
  no detail can leak through one. Titles are the brief's proposed
  neutral copy: "Hygge needs you" / "New work found" (final copy is
  Mikael's call at review).
- No credentials, no codes, no amounts, no mail subjects, no
  profile data. A 2FA code never travels by push (Brief 04's
  pipeline owns codes). A schema test asserts the exact key set.
- **No badge number is sent** (chosen default): the server keeps
  no badge count, and an invented one would drift from the feed.
- Routes: `task/<uuid>`, `feed/<uuid>`, `home`. The app parses
  them in `PushDeepLink` (HyggeCore); anything unknown lands on
  Home. A task route opens that task's detail sheet; a feed route
  lifts the named listing to the top of Home.

## Token lifecycle

1. **Ask once, at the right moment.** After the first notifiable
   thing exists (a needs-you card or real found work), Home shows
   a one-time primer card ("Want a word when something needs
   you?"). Never at first launch, never during onboarding.
   Either answer retires the card forever (`NotificationPrimerPolicy`,
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

`GET /device-tokens` lists the caller's own tokens only;
`DELETE /device-tokens/<token>` (or a JSON body) removes one of the
caller's. There is no parameter anywhere that names another user.

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
| 5 consecutive failed attempts | 0 (suppressed) | `suppressed` | yes | nothing until a send succeeds again |
| APNs not configured (no key yet) | 0 | `unconfigured` (once per event) | yes | nothing — logged no-op, never a fake success |
| User paused | 0 | — (not an attempt) | yes | nothing, by their choice |
| No registered token / denied | 0 | — (not an attempt) | n/a | nothing |

Suppression keeps a broken setup from becoming a retry storm: it
lifts automatically when a later attempt succeeds (a fresh token
registration is the usual path back).

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
   (the simulator cannot receive remote pushes reliably).
5. **Final title copy sign-off** at review, if different titles are
   wanted.
