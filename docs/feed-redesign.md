# Compact home feed

Home shows a short title and useful secondary line for site suggestions, real opportunities, pending reviews, chat requests and witnessed activity. Cards open scrollable detail sheets; live browser cards retain the shared live stream.

- Tap: open details, review, browser or the relevant chat.
- Short swipe right: expose the named primary action. Tap it to continue.
- Short swipe left: expose Dismiss.
- Long swipe: haptic cue at 62% of card width (minimum 160pt); release to trigger. Retreating below the threshold only reveals the action or closes it. Velocity alone never commits.
- Another card's swipe closes the previously exposed action. Vertical pans remain feed scrolling.
- VoiceOver offers equivalent named actions. Reduce Motion removes rotation and spring travel.

The collapsed surface has no primary/secondary action buttons or dismissal X. Review sheets carry the actual draft and explicit Send/Publish/Add to calendar action. A swipe never approves those actions. Setup and preparing an application retain the existing authorization and backend gates.

Dismissing a site or opportunity uses its existing persisted status and offers Undo. Dismissing task/help/activity cards archives their presentation to Earlier on this device. It does not cancel work, reject an approval, mark a question answered or change the agent's authorization. A new task status/help request gets a new presentation key and resurfaces. The account cache retains archive IDs across launch and clears them on account reset; they are not sent as backend state.

Artwork uses bundled Hygge assets and SF Symbols. The production site/listing models have no verified logo/thumbnail fields, so cards use category/action icons instead of the fictional logos/photos in the illustrative concept. No third-party image fetch or fabricated production listing was introduced.

## Local preview

Debug only: launch with `--settings-preview --feed-preview`. This seeds the production views with isolated local fixtures and uses the existing preview storage and disabled production networking. It is not present in release routing.

## Validation

`swift test --disable-sandbox`, `node scripts/check-user-copy.mjs`, `python3 scripts/check-flame-assets.py`, `python3 scripts/test-release-app-links.py`, and an unsigned iOS Simulator build. Gesture tests cover reveal/commit in both directions, retreat, tiny movement, landscape widths and invalid geometry. See `design-qa.md` for native rendered evidence and interaction checks.
