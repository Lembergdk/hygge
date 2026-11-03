# Feed design QA

final result: passed

## Source and scope

Source visual truth: user-selected `codex-clipboard-7d234134-76c1-4d1d-9658-051688284e67.png` (1448 × 1086), supplemented by the user's explicit corrections: remove X; short swipes reveal, long swipes trigger; give objects visual storytelling and varied composition; expand the object over the feed instead of presenting a sheet. These corrections supersede the original board's uniform compact rows and bottom sheet.

Native iPhone 18 Pro, iOS 27.2, dark appearance, 402 × 874 points; tool captures normalized to 368 × 800 pixels. This is a native app, so CSS viewport/deviceScaleFactor are not applicable. `outputs/feed-redesign/design-comparison.png` places source phone regions (334 × 721 and 329 × 721) and native feed/detail captures together. Source regions were scaled to 368px width with aspect preserved. Native status-bar regions were excluded from the comparison. Different content heights are intentional after the live feedback, not a pixel-perfect match claim.

## Evidence

- `outputs/feed-redesign/visual-feed.jpg`: actual mixed feed.
- `outputs/feed-redesign/foreground-card.jpg`: expanded site invitation over its feed.
- `outputs/feed-redesign/foreground-browser.jpg`: foreground browser remains live with takeover/fullscreen controls.
- `outputs/feed-redesign/feed-object-overview.png`: all 24 variants rendered with the actual SwiftUI components and local sample data.
- `outputs/feed-redesign/foreground-expansion.mp4`: native expansion recording; recorded before the final card-height reduction.
- `outputs/feed-redesign/short-left.jpg`, `dismiss-undo.jpg`, `swipe-opens-review.jpg`: gesture results.

## Comparison history and findings

1. [P1, resolved] Uniform rows read as a notification list. Replaced them with seven visual compositions and rendered the complete state inventory. The revised feed and catalog show differentiated hierarchy without long descriptions.
2. [P1, resolved] Detail navigation repeated the chat/profile sheet pattern. Added matched-geometry foreground cards, backdrop, return control and escape behavior. Native capture and video verify the change.
3. [P2, resolved] A thin swipe-underlay color edge appeared on resting cards. Hide the underlay at zero offset. Final feed capture has clean rounded cocoa edges.
4. [P2, resolved] Site detail used unnecessary vertical space. Reduced its maximum height to 600pt. Final detail capture fits facts and actions while retaining the surrounding feed.

No remaining actionable P0/P1/P2 findings within this feed change. The existing floating-avatar badge position is handled separately by PR #31; the capture was made before that branch was incorporated.

## Required fidelity surfaces

- Typography: existing rounded system headings and existing body fonts/tokens. Native text is readable, title wrapping is controlled, and secondary information is clearly lower priority. The generated concept's approximate font is not installed as a new dependency.
- Spacing: 20pt feed gutters, 12pt inter-card spacing, differentiated card heights and 22pt card corners. Foreground card has its own 28pt corner radius and shadow. No clipped controls in captured portrait states.
- Colors: existing cocoa, cream, sage, ember and gold theme tokens. Sage means primary/complete; coral means help/dismiss; gold marks opportunities and review.
- Assets: bundled wallet and profile-photo component, SF Symbols for categories/actions. Current production models have no verified site-logo or opportunity-photo fields, so no fictional logos or stock photos are substituted for real data. Real local Chrome stream appears in the browser card. Animated brand assets remain existing components.
- Copy: collapsed cards retain critical title/context/pay; facts and editable drafts are in foreground details. Questions route to chat. There is no X or duplicate collapsed action button. The catalog's explanatory labels are DEBUG-only review content.

The combined full-view comparison is readable at native output size; the separate 1140px catalog provides the focused card typography/icon/artwork comparison without tiny phone-scale details.

## Behavior and verification

- Short right and left swipes reveal named actions without committing; long left dismisses and Undo restores the suggestion.
- Long right on a profile review opens the review, retaining the explicit Publish profile button. No public action was executed.
- Vertical drag beginning on a card scrolls the feed. Opening another reveal closes the prior one.
- Foreground card opens and Back to feed closes it. Expanded browser shows Live, Take control, and Fullscreen browser using the real loopback stream.
- VoiceOver named actions and escape, Reduce Motion animation branches, and adaptive fact rows are implemented. An exhaustive screen-reader, largest-Dynamic-Type and landscape audit was not performed in this pass.
- 81 Swift tests passed, copy/APNG/release-link checks passed, unsigned simulator build passed. Hosted backend and core/app-build jobs passed for `a4a1cb6`.
- No matched-geometry or state-mutation warnings were found in the inspected runtime log. The simulator build has the existing nonfatal AppIntents metadata warning.

## Follow-up polish

P3: Add verified site/listing image fields in a separate data-contract change if richer photography and official site branding are desired. Current icons remain accurate when those assets are unavailable.

## Implementation checklist

- [x] Varied visual feed objects and native inventory
- [x] Foreground expansion instead of feed detail sheets
- [x] Swipe reveal/commit, Undo and public-action review
- [x] Build, targeted tests and native interaction checks
- [x] Preserve production/release ownership with the user
