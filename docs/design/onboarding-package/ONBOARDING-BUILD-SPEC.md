# Hygge onboarding carousel — build spec

**For the coding agent. Design state: Oct 31, 2026 (screen 3 v4).**
**The three PNGs in this package are still-frame visual references. Motion is specified in text below — the PNGs do not show it.**

## 1. What this is

A 3-screen carousel that introduces Hygge before signup. It is a **prelude, not a replacement**:

```
carousel (this spec) → signup → existing conversational onboarding → home feed
```

- Shown **once**, on first launch. Returning users go straight to sign-in / home.
- The existing conversational onboarding is **untouched** by this work.
- Structure: **Who → How → Where**.

## 2. Navigation (all three screens)

- Advance by **swipe left** or by tapping **Next**. Never gesture-only: every action has a tappable control (VoiceOver / motor accessibility).
- **Dots** show position (1/3, 2/3, 3/3). Dots are indicators; tapping a dot to jump is optional, not required.
- **Skip** (top-right, every screen) goes to **signup** — never past signup.
- Screen 3 replaces Next with **Get started** (→ signup) plus a **"Already have an account? Sign in"** text link (→ sign-in).
- No passwords are introduced anywhere in this flow.

## 3. Screen 1 — Who

- **Copy (exact, do not reword):**
  - Headline: "Hi, I'm Hygge,"
  - Pronunciation line: "hoo-gah"
  - Body: "I find work you like and handle the boring parts."
- **Visual:** the existing dark welcome screen (the flame scene from the reference screenshot), with the carousel chrome added: Skip top-right, dots 1/3, Next button.
- **Controls:** Skip, Next, dots 1/3.

## 4. Screen 2 — How

- **Copy (exact, do not reword):**
  - Headline: "I work on my own computer."
  - Body: "I have my own browser and manage your profiles on the work sites you allow. Nothing happens without your approval."
- **Visual:** the repo's animated flame-with-laptop asset, **`App/FlameLaptop.png`** (animated PNG — play the animation; the reference PNG shows a still frame only).
- **Controls:** Skip, Next, dots 2/3.

## 5. Screen 3 — Where (the last page)

- **Copy (exact, do not reword):**
  - Headline: "One feed for all your work"
  - Body: "Everything I do is posted in the feed. If I need your attention on anything, I will send you a message."
- **Layout (top to bottom):**
  1. **Mini-mockups, side by side:**
     - **Left — mini home feed** (cream card): "Pinned • Needs you" approval card ("Dog walk approval", "Luna • Golden Retriever", "Today • 7:30–8:30pm", "Approve" pill), a "Journal" entry ("Walked Finley in Botanical Gardens. Felt calm and sunny."), and a "Time saved this week / 4h 20m" strip.
     - **Right — messages, no chrome:** just text bubbles with avatars floating on the dark background (no card, no input bar). Tiny flame avatar + "Found a walk near Zilker Park that fits your mornings"; generic user avatar + "Yes, book it." The user avatar is a plain person glyph — do not invent a face or photo for it.
  2. **Flame below the mockups:** the repo's **`App/FlameNotify.png`** (animated PNG — play it as the placeholder). See §6 for the swap point.
  3. Headline, body, dots 3/3, **Get started** button, "Already have an account? Sign in" link.
- **The mini-mockups are illustrations, not live UI.** Hardcode the copy above. They are not the real feed, not real user data, and not tappable — the "Approve" pill inside the mini feed card does nothing. Only the carousel controls, Get started, and Sign in are interactive on this screen.

## 6. Screen 3 entrance animation (new requirement, Oct 31)

On the last page, the feed elements and message elements **animate in** when the screen appears. They must not just be sitting there statically.

- **Trigger:** when screen 3 becomes visible (swipe lands on it, or Next from screen 2).
- **Motion (all elements):** gentle rise + fade — opacity 0 → 1, y offset +16 → 0, ease-out. No bounce, no spring overshoot, nothing attention-seeking. Keep it calm.
- **Sequence (staggered, feed and message tracks run concurrently):**
  - t=0ms — feed card background fades in (opacity only, 300ms).
  - t=100ms — approval card inside the feed rises + fades (350ms).
  - t=200ms — journal entry rises + fades (350ms).
  - t=300ms — time-saved strip rises + fades (350ms).
  - t=150ms — Hygge bubble + flame avatar rise + fade (350ms).
  - t=350ms — user bubble + user avatar rise + fade (350ms).
- **Replay:** play on first appearance only. If the user swipes back to screen 3, show the end state immediately — do not replay.
- **Reduce Motion:** when iOS Reduce Motion is on, skip the animation entirely and show the end state immediately.
- **The flame does NOT participate in this entrance animation.** It keeps playing its placeholder animation as-is. The flame's own animation (pointing up at the mockups) is a separate deliverable from Mikael's team — structure the flame as a swappable component so that animation can drop in later without touching the entrance sequence or the layout.

## 7. Design

- **Mockups show dark.** Build both appearances: dark as shown, plus a light variant of the same layout using the app's light tokens (paper #FAF6EF background, ink #2B2320 text, coral button).
- **Typeface:** SF Rounded (confirmed for the app).
- **Button:** the app's existing coral pill button with white text (the mockups sample it as RGB 189,101,76).
- **Dots:** active = coral, inactive = dim.
- **Skip / Sign in:** muted text, no button chrome.
- **Bottom cluster is fixed:** dots, then button, then (screen 3 only) the sign-in line, with clear space above the dots — body text must never crowd or touch the dots or button. The reference PNGs show the correct spacing.
- **Implementation:** SwiftUI-native animation (transitions / animated state changes). No new packages or dependencies.

## 8. Assets

| What | Source | Notes |
|---|---|---|
| Screen 1 visual | Existing welcome screen (see `screen-1-reference.png`) | Add carousel chrome; copy unchanged |
| Screen 2 flame + laptop | Repo: `App/FlameLaptop.png` | Animated PNG — play it |
| Screen 3 flame (placeholder) | Repo: `App/FlameNotify.png` | Animated PNG — play it; swappable for the pointing animation later |
| Screen 3 mini-content | Hardcoded copy in §5 | Illustration, not live data |
| Reference mockups | `screen-1-reference.png`, `screen-2-reference.png`, `screen-3-reference.png` (this package) | Still frames; motion per §6 |

## 9. Routing + one open decision

- Get started → signup entry point. Skip (any screen) → signup entry point. Sign in link → sign-in.
- **Signup screen itself is out of scope for this package.** Recommended auth method is Sign in with Apple + email magic-link fallback (no passwords), but the method decision is still open — build the route to the signup entry point, and confirm the auth method before building the signup screen itself.

## 10. Acceptance checklist

- [ ] Three screens in order, with the exact copy in §3–§5.
- [ ] Swipe + Next advance; Skip goes to signup from every screen, never past it.
- [ ] Screen 3: Get started → signup; Sign in → sign-in.
- [ ] Screen 3 entrance animation plays as specified in §6 (staggered, first appearance only, Reduce Motion respected, flame excluded).
- [ ] Both appearances (dark as mocked, light variant same layout).
- [ ] VoiceOver order is sensible and every action has a tappable control.
- [ ] Mini-mockup copy matches §5 exactly; mini Approve pill is non-interactive.
- [ ] No new dependencies; flame component is swappable for the future pointing animation.
- [ ] Carousel shows once; returning users skip it.

## 11. Out of scope

- The signup screen itself (pending the auth-method decision).
- The flame's pointing animation (Mikael's team; swap point only).
- Any change to the existing conversational onboarding.
- Any change to the real feed or real conversation screens — the §5 mini-mockups are illustrations only.
