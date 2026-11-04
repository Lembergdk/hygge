# Password confirmation and returning sign-in

Creating or changing an email password sends a confirmation immediately. The wait UI is the shared Check-your-email page used by every emailed link: envelope, the typed address, Open mail + mail-app menu, 30s-cooldown Resend, Use a different email (settings scenarios add a Done), with waiting, working, and problem states. Password confirmation renders through the same page and keeps its real server cancel. Failure to open a client is explained, and the link itself works from any email client through the existing universal-link/fallback path.

The server stores only a salted password hash and a SHA-256 token hash in a separate, 15-minute pending request. No raw password is saved on the phone. The email explicitly says “Confirm your Hygge password.” Opening its link causes an app POST that atomically replaces the password, invalidates the pending request and revokes older sessions. A fresh session is returned and the app shows “Password saved.” This works after app termination. GET requests from mail scanners never activate the change. Ordinary magic links cannot confirm passwords. Cancellation, expiry, supersession, account mismatch and concurrent password changes fail closed.

A failed send surfaces as a problem state on the page. A user can cancel the request and start again. A new request replaces the older link. Five requests per account per 15 minutes are allowed. Mail-provider acceptance is not a guarantee of inbox delivery.

Returning sign-in now retains the sign-in view until account adoption finishes and uses the server's `isNewUser` identity flag for routing. Existing accounts enter Home even if their local onboarding cache was cleared or their server profile has no completed flag. Their local answers are never imported over server state. Truly new accounts still finish onboarding. Foreground sync does not compete with sign-in adoption.

## Rollout

CI applies `backend/cloudflare/migrations/0007_password_confirmations.sql` before deploying each worker. It creates one new table and index; it changes no existing rows. Do not replay older migrations: 0006 intentionally cleared old password hashes when originally introduced.

Deploy and verify the backend before releasing the new iOS build. Older clients and normal magic links remain compatible. No sender, credentials or Apple capabilities change. Production schema/deployment approval is separate from merging this change.

## Verification

- Core routing tests cover existing accounts with empty local state, fresh accounts, signed-out accounts, and password-link host/purpose validation.
- Auth tests cover request ownership, delivery failure, limits, cancellation, expiry, supersession, wrong-account confirmation, replay and cold-start confirmation.
- SQLite tests execute the actual D1 statements and migrations, including concurrent confirmation, session revocation and a concurrently replaced password.
- Native previews: `--settings-preview -settingsPreviewScreen logins -passwordPreviewState waiting` or `saved`.
