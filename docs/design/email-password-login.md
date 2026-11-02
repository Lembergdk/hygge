# Optional email passwords

The returning login screen uses the existing animated flame and “Welcome back”.
Apple remains first. The email-link button and “Use a password” appear only while
email is focused or valid; both need a valid email to act. Switching methods
preserves the email and clears the password. Empty/invalid email on blur hides
these actions. Onboarding retains its existing magic-link card.

Your logins groups connected identities in one surface. An “Add more” heading
appears above providers that are not connected and disappears when both methods
are connected. Verified emails have
“Create password”, or “Password / Change” when configured. Setup expands inline
with one revealable field, an explicit create/update action, and Cancel. Success
collapses the editor with a temporary confirmation. No Email sublabel,
magic-link reassurance, or Add another email row. Apple-only accounts can verify
their first email. Existing removal is available from the row's context menu and
VoiceOver actions, with the backend's last-method safeguard.

## Authentication contract

- `POST /auth/email/password` accepts `email` and `password`, returning the same
  session shape as Apple/magic-link sign-in. It never creates users or methods.
- `POST /auth/methods/password` accepts `methodId` and `password`. It requires a
  real, unrevoked session created within ten minutes and an owned, verified
  email method. Dev tokens cannot set passwords. A stale session receives
  `reauthentication_required`; the inline editor offers an email confirmation.
- Signed-in magic-link consumption returns `linked: true`, a refreshed session,
  and methods. The client replaces its Keychain token without switching accounts.
  The previous session is revoked. Magic links preserve modern password hashes.
- Password creation/change revokes all other sessions atomically. Compare-and-set
  prevents a concurrent password update from being overwritten. Login session
  insertion checks the verified method and hash atomically to prevent a sign-in
  using a hash that changed during verification.
- 15–128 Unicode scalar values, with no trimming or normalization of passwords.
  Native `node:crypto` scrypt uses N=32768, r=8, p=3, a random 16-byte salt, and a
  32-byte key. Stored hashes are versioned. Parameters follow an
  [OWASP scrypt profile](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
  supported by [Workers node:crypto](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/).
- Unknown, unverified, unset-password, and incorrect-password attempts share a
  generic response; valid-shaped attempts do equivalent hash work. No email,
  password, token or hash is logged or returned in public method data.
- Atomic attempt limits: 10/email and 30/requester per rolling 15 minutes; password
  setup 5/account. Hashed keys use a separate namespace in the existing abuse
  ledger. Old password-attempt rows are pruned. No database migration is needed.
- Auth responses are no-store and request bodies are bounded at 16 KiB.

## Verification

Core tests cover focus/validity visibility, Unicode length and older-server method
responses. Backend tests cover ownership, verification, reauthentication,
password changes, hash secrecy, session revocation/races, magic-link coexistence,
recovery, and rate limiting. A disposable local Worker/D1 test exercises native
scrypt, setup/login, cross-account rejection, revocation and concurrent limits.

Debug-only screenshots: launch with `--settings-preview -settingsPreviewScreen
logins -passwordPreviewState none|editing|created`; use `-settingsPreviewScreen
login` plus `-loginPreviewEmail sam@example.com` and optionally
`-loginPreviewPassword YES` for returning-login states. No real sessions are used.

Production rollout, TestFlight distribution, and on-device acceptance are separate
from code merge. Older servers omit hasPassword; clients decode it as false.
