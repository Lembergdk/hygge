# Approved sites and saved logins

Implemented from the accepted November 4, 2026 Simulator design, with two final decisions:

- Suggesting a site opens the existing `ConversationView` and regular composer.
- Site know-how is not displayed. Internal site-memory collection and use remain intact.

The list uses real site logos with a monogram fallback, dynamic site/attention counts, semantic status icons and a secondary suggestion action. Details group saved credentials and remembered sessions under Sign-in. Each removal confirmation describes the access that remains. Disconnect describes stopping site work and clearing pending drafts.

The login sheet uses the shared warm palette, persistent field labels, password-manager content types, Show/Hide password, update-mode username prefill, keyboard-aware save action, progress, recoverable errors and a separate success state. Passwords are cleared before the request and on dismissal. Failure asks for password re-entry; saving does not claim a successful website sign-in.

Removal calls retain local access references until the server confirms deletion. Disconnect preserves confirmed partial cleanup and leaves the site connected if either removal fails; retry can finish the remaining cleanup. Errors are displayed inline and announced to assistive technology.

## Verification

- iPhone 17 Simulator Debug build.
- Seven focused existing tests: `swift test --filter 'SiteIconTests|PasswordLoginTests'`.
- Opt-in Debug integration assertions for failed credential deletion, failed session deletion, both disconnect failure points, and preservation of internal notes. Launch with `--settings-preview --settings-populated --sites-access-failure-check`; logs must contain `APPROVED_SITES_FAILURE_CHECKS_PASSED`.
- Debug visual entry points use `-settingsPreviewScreen sites`, `site-detail`, or `site-login`; add `--sites-saved-login` for fictional saved-access metadata. These require `--settings-preview --settings-populated`. They do not simulate successful server writes.

Simulator tap automation reported success without opening screens, so layout verification uses these direct entry points. Real credential writes/deletions, complete interactive navigation, VoiceOver interaction and release acceptance were not tested. No release or backend deployment is part of this change.
