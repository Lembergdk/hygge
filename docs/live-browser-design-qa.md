# Browser design QA

Reference: approved option 1 (`outputs/browser-experience-proposal/01-discover-and-watch.png`) with the subsequent user corrections.

## Verified in the native app

- Feed: cocoa card, live page preview, site/live footer, no flame inside the activity card. The separate floating laptop flame is enlarged.
- Chat: live attachment with suggested answers and a direct takeover option; the existing notification APNG is used for attention. Help stays in chat.
- Expanded browser: espresso background, compact site identity, animated laptop while working, notification animation while waiting, sage Take control button with cursor icon. Removed both unwanted explanatory lines.
- Takeover: visible You’re in control state; tapping a real page field and typing changes the remote Chrome field. Handback returns to the working state.
- Fullscreen: live page fills portrait and landscape, persistent chrome disappears, right-edge swipe reveals controls, handback works.
- Floating badge: source review confirms top-leading placement on the enlarged avatar; the captured working feed has no badge.

Screenshots are local QA artifacts under `outputs/browser-implementation/`: feed.png, chat.png, fullscreen-portrait.png, fullscreen-landscape.png. The page is an isolated fictional Workroom fixture, not a production user account. The existing sheet screenshot was also inspected during testing.

## Corrections during QA

Fixed SwiftUI frame redraw observation, miniature preview scaling, fullscreen safe-area letterboxing, and viewport resizing after reacquiring control. Kept actual third-party page styling inside Hygge’s warm container.

## Validation

- iPhone 18 Pro simulator, iOS 27.2: Debug build succeeds with zero warnings.
- 77 Swift core tests passed; merged backend suite: 195 tests passed; TypeScript check passed.
- Real local Chrome: changing pushed frames, click/focus, text, Backspace, scroll and handback passed.
- Production and TestFlight were not changed. Deployed Cloudflare streaming and real external-site acceptance remain staging checks before release. VoiceOver remote DOM navigation and full IME editing are outside this transport’s current support.
