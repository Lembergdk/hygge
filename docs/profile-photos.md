# Private profile photos

`GET`, `PUT`, and `DELETE /profile/photo` use the existing authenticated `/profile`
router. The verified account selects its Durable Object; no user ID, URL or
storage key is accepted from a photo request. Each object's `profile_photo`
SQLite table stores one JPEG and its content hash, separate from profile JSON
imports. No public bucket, new binding, secret or D1 migration is required.

Uploads must be JPEG, at most 512 KiB, with bounded JPEG framing and dimensions
no greater than 1024 pixels. The app creates a 512-pixel thumbnail and re-encodes
it as JPEG without the original image metadata. Responses use `private, no-store`
and `nosniff`. A missing photo is 404; malformed/oversized uploads do not replace
the previous photo. `If-None-Match: *` provides atomic create-only migration.

iOS keeps a durable pending upload and serializes requests. A photo selection
made during a fetch/upload is processed next; an older response cannot replace
it. Sign-out/account changes invalidate in-flight results and clear only the
local cache. Existing device-only photos migrate on the next authenticated sync,
yielding to a photo already stored by another device. Failed requests preserve
the cached photo and expose a retry action in the editor.

The mission decider sees `hasProfilePhoto` and observed file-input labels, never
the image bytes or a download URL. `upload` with `valueRef: profile.photo` resolves
the asset inside that user's worker. It is enabled only for approved `signup`
and `buildProfile` tasks, never scheduled scans or discovery. The executor and
browser both check the approved HTTPS host. The browser requires one matching
file input and refuses attachment during human control. Existing identity,
CAPTCHA and other checkpoint guards still stop the mission. The trace records
attachment as input (`type`) for compatibility with older iOS clients.

Tests in `backend/cloudflare/test/profile-photo.mts` cover storage reads,
replacement/deletion, isolation, rejected uploads, migration races, prompt
redaction, approval/host constraints and identity-check handling. Third-party
file-picker behavior still needs acceptance on real supported work sites.

The normal main-branch workflow deploys staging. Production backend deployment
and TestFlight publication remain separate; the new iOS photo flow needs the
matching backend endpoint before it can upload successfully.
