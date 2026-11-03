# Visual home feed

Home tells different stories through different card compositions. Invitations use a site icon and a small setup journey, opportunities have a category illustration header and pay/location, reviews show a portrait or action icon and an approval label, questions use a coral chat cue, earnings feature the bundled wallet and actual amount, and completions use a sage seal. Routine updates stay smaller. Live browser cards retain the shared live stream.

Tapping a detail-bearing card moves it into the foreground with matched geometry over a dimmed feed. Its details scroll inside the floating card. Back to feed, tapping the backdrop, dragging down on the top bar, and accessibility escape return to the same feed position. Chat questions open the relevant chat; profile and chat retain their existing sheets.

## Live work and incoming updates

Ongoing work always occupies the first feed section, above invitations, opportunities and reviews. A browser paused for human help is still ongoing; its card takes the person into chat. Active cards cannot be dismissed or archived. Once the task finishes, its existing witnessed activity event appears as a compact Journal row; a stale browser identifier on a completed task never creates a live card. Earnings retain their visual amount card in Journal.

At the top, arrivals animate into place with a short spring and fade (fade only with Reduce Motion). Away from the top, new identities wait outside the rendered feed and the order of admitted cards is retained. A floating “New updates” pill scrolls to the top; reaching the top either by the pill or by scrolling admits the latest data. The pill overlays the viewport rather than pushing its content down. Existing task state continues updating, obsolete cards disappear, and scroll-position tracking anchors the current reading position. Updates also wait while a detail/profile/chat presentation covers the feed. Undo admits only the restored card, leaving unrelated arrivals queued.

- Tap: open details, review, browser or the relevant chat.
- Short swipe right: expose the named primary action. Tap it to continue.
- Short swipe left: expose Dismiss.
- Long swipe: haptic cue at 62% of card width (minimum 160pt); release to trigger. Retreating below the threshold only reveals the action or closes it. Velocity alone never commits.
- Another card's swipe closes the previously exposed action. Vertical pans remain feed scrolling.
- VoiceOver offers equivalent named actions. Reduce Motion removes rotation and spring travel.

The collapsed surface has no primary/secondary action buttons or dismissal X. Foreground reviews carry the actual draft and explicit Send/Publish/Add to calendar action. A swipe never approves those actions. Setup and preparing an application retain the existing authorization and backend gates.

Dismissing a site or opportunity uses its existing persisted status and offers Undo. Dismissing task/help/activity cards archives their presentation to Earlier on this device. It does not cancel work, reject an approval, mark a question answered or change the agent's authorization. A new task status/help request gets a new presentation key and resurfaces. The account cache retains archive IDs across launch and clears them on account reset; they are not sent as backend state.

Artwork uses bundled Hygge assets and SF Symbols. The production site/listing models have no verified logo/thumbnail fields, so cards use category/action icons instead of the fictional logos/photos in the illustrative concept. No third-party image fetch or fabricated production listing was introduced.

## Local preview

Debug only: launch with `--settings-preview --feed-preview`. This seeds the production views with isolated local fixtures and uses the existing preview storage and disabled production networking. It is not present in release routing.

Add `--browser-preview` with the existing loopback browser fixture for a real local live stream. Add `--feed-catalog` to render `Documents/feed-object-overview.png` from production SwiftUI components. The catalog covers 24 states: site suggestion, opportunity, live work, profile/application/message/calendar reviews, question/verification/login/recovery help, public-action chat review, earnings, account/profile completion, application/message/calendar outcomes, search, site learning, filed mail, permission reminder, pause, and caught-up state. Its data is illustrative and never uploaded.

Add `--feed-arrivals-preview` to insert a local opportunity after 30 seconds, then finish the local browser task with a witnessed profile event 15 seconds later. This verifies queued arrivals and the live-to-journal handoff without production traffic.

## Validation

`swift test --disable-sandbox`, `node scripts/check-user-copy.mjs`, `python3 scripts/check-flame-assets.py`, `python3 scripts/test-release-app-links.py`, and an unsigned iOS Simulator build. Gesture tests cover reveal/commit in both directions, retreat, tiny movement, landscape widths and invalid geometry. See `design-qa.md` for native rendered evidence and interaction checks.
