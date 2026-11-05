# Hygge promo site

A simple, static promotional site for Hygge. No build step, no external
dependencies — just open `index.html`, or serve the folder with any static host.

## What's in here

- `index.html` — hero, TestFlight + GitHub buttons, three short steps, footer
- `style.css` — responsive layout (single column on mobile, two columns on desktop)
- `flame.js` — the interactive flame, ported from the repo's `FlameActor`
  (the app's home flame): `FlameTouchPhysics` (180ms pickup, rooted
  stretch, carry commits the drop point, flick recoil, 240Hz substeps,
  acceleration-driven limb joints, lean), full `FlamePose` reaction
  scenes (pat, poke, foot-tap dance, hops, big jump, duck, side hop,
  twirl, wiggle, stretch, puff up, shrink startle, dizzy, wave, point
  up, laugh, cry, nauseous, turn around, walk about), `FlameActor`
  gesture rules (tap zones, double-tap, long-press, pinch in/out,
  spin-to-nausea, short swipe = spring stretch only, no placement),
  and `FlameIdlePlanner` idle life. Not ported: the Metal torso warp
  (rigid layers move by the same `displacement(at:)` formula at their
  anchors instead), gyro lean, phone shake, laptop typing, and travel
  hops (app-internal states). Web-only adjustments: limb displacement
  is capped to 10pt from the torso's displacement so a fast drag
  cannot disconnect a limb (the app's Metal warp closes that gap
  instead), the ground shadow follows his horizontal position, and
  page pinch/double-tap zoom is disabled (viewport maximum-scale,
  touch-action pan-y, gesture/double-touchend guards) while flame
  drag, tap, double-tap and pinch keep working on the stage.
  The shadow uses two plain translateX calls, not calc() inside
  translate() — Safari drops the pixel part of that calc and left
  the shadow centred. Dragging is immediate (1:1, no morph/elastic
  stretch): the app's stretch-then-carry spring lagged on the web,
  disconnected limbs on fast drags, and felt unresponsive, so the
  body now sits exactly where the finger put it; tap, double-tap,
  long-press, pinch and idle reactions are unchanged.
- `assets/flame/` — the flame rig layers straight from the Hygge repo
  (`App/FlameRig*.png`): body, arms, legs, and all eight face layers,
  stacked in the browser the same way the app layers them
- `assets/flame-character.png` — the app's flame mark, used as the favicon
- `privacy.html`, `terms.html` — short starter privacy/terms pages linked
  discreetly from the footer (review before treating them as final legal pages)

## Links

- TestFlight: https://testflight.apple.com/join/VQwBCNSP (iOS 17+)
- GitHub: https://github.com/Lembergdk/hygge

## Hosting on usehygge.app

Deploy this folder's contents to the **apex** (usehygge.app) only. Do not
point the apex deploy at anything that would disturb `api.usehygge.app` or
`api-staging.usehygge.app` — those subdomains serve the Hygge backends and
must keep working as-is.

Shadow: painted behind the flame (DOM order + z-index), follows
him horizontally, and is driven by his height above the ground —
higher up means fainter, smaller and more blurred; dragged below
the shadow line his feet pass under the ground and the shadow
fades out and disappears.

Speech bubble: inside the stage, centred above his head, following
him wherever he is dragged, hops, or walks (positioned every frame
from his current offset). Dragging: while carrying, he sits below
the finger (offset from the grab point to just above his tip, capped
at 90pt) so the finger never covers him; the drop point includes
that offset, so he stays put on release.
