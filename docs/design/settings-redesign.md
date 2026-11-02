# Settings redesign

The profile sheet replaces the long settings page with a compact identity and
preferences header, illustrated earnings/time-saved tiles, and focused subviews.
It uses Hygge's appearance-aware palette, rounded typography, native navigation,
and a swipe-to-dismiss sheet with no close button or repeated “You” title.

## Behavior

- Edit profile: photo picker, name and location beside the photo, interests and
  minimum rate. Valid edits save locally immediately and use the existing
  debounced cloud import. Pending edits survive relaunch and cannot be replaced
  by a stale profile pull; failures expose a retry action.
- Name and location use placeholders without separate titles. The location icon
  asks for when-in-use permission and fills city/region from a fresh fix; manual
  edits made during lookup win. Denied/unavailable location leaves the input
  editable. The normal saved-status row and footer flame are removed.
- Interest chips and the picker use the same short category labels. Custom
  interests can be added and removed, sync with the profile, and appear in the
  main sheet and discovery context. They remain preferences, separate from
  skills and category IDs. Older profiles decode with no custom interests.
- The profile photo is downsampled, saved in private server storage and cached
  on-device. It syncs across signed-in devices and is available to the browsing
  agent for approved signup/profile tasks. Sign-out clears the local cache;
  the account photo remains on the server. Failed uploads stay pending with a
  retry action. Legacy device-only photos migrate without replacing an existing
  server photo.
- Invite: the gift button opens an editable invitation, copy link and native
  share sheet. No message is sent until the user chooses a recipient and sends.
- Your logins: connected methods and the existing Apple/email linking flows.
  Last-login removal remains prohibited. Sign out is the final main-sheet row.
- Approved sites: real approved account states, saved credentials, trusted
  sign-ins, site know-how and disconnect. Empty and populated lists are supported.
- Hygge email: existing setup plus actual address, copy and filed mail summaries.
  Addresses retain the service's ten-digit `@usehygge.cc` format.
- Permissions: separate notification, calendar and location grants. Existing
  authorization opens system Settings; granting location does not replace the
  profile's chosen location.
- Personal beliefs and play/pause are removed from settings. Underlying belief
  data and work scheduling are preserved.

The main insights use confirmed earnings and the existing time-saved estimate;
there are no seeded metrics in the shipping UI. Illustration limbs are brown
sticks, including the new permissions, email, sites and login artwork.

## Verification

Local validation covers the unsigned simulator build, HyggeCore tests (including
locale-aware rate parsing), release-copy check and animated-flame asset check.
Dark-mode simulator renders are reviewed with populated local fixture data.
Authenticated provider operations and system permission dialogs still require
device acceptance; screenshots do not establish those outcomes.

For repeatable visual review, a Debug build can be launched on a fresh simulator
with `--settings-preview --settings-populated -settingsPreviewScreen main`.
Screen values: `main`, `edit`, `invite`, `logins`, `sites`, `email`, `permissions`.
This path has a separate cache, suppresses launch/foreground synchronization,
uses a localhost backend with no token, and is excluded from Release builds.
Use a disposable simulator because OS permissions and UserDefaults are still
device-scoped. Normal app navigation must also be checked before release.

Merging this work triggers the repository's existing main-branch CI and staging
deployment. TestFlight and production publication remain separate workflows.

The insights header uses the dedicated `SettingsInsightsFlame` peeking pose from
the approved sheet: front-facing coral/gold flame, brown stick arms resting over
the time-saved tile, glints and sage leaves. It is anchored to that tile rather
than rendered as the walking `FlameMark` beside the heading. The earnings tile
label is “Your earnings”; its underlying amount remains unchanged.
