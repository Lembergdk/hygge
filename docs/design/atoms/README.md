# Hygge design atoms

Real SVG elements for the coding agent. One file per element, all in this folder.
Raster mockup images from earlier are archived under `_raster-archive/` and are
not part of the handoff.

## Tokens (from the V1 spec PDF, Warm Nordic)

| Token | Hex | Role |
| --- | --- | --- |
| paper | #FAF6EF | Screen background |
| card | #FFFFFF | Card surface |
| ink | #2B2320 | Primary text, flame face |
| muted | #7A6A61 | Secondary text |
| coral | #FF6B57 | Flame outer, Pinned chip |
| ember | #C93A26 | Primary buttons (white text passes at 5.1:1; coral + white fails at 2.8:1, so never use coral for button text) |
| gold | #FFC53D | Flame inner, thinking dots |
| sage-deep | #3E5C38 | Quiet button, clock, avatar silhouette |
| sage-tint | #E4EBDD | Time-saved card, user bubble, avatar ground |
| butter-tint | #FFF3D6 | Journal date chip |
| butter-text | #8A5A00 | Text on butter tint |

Typeface: SF Rounded everywhere (`font-family="SF Rounded, ui-rounded, Helvetica Neue, Arial, sans-serif"` in these files; the app renders real SF Rounded, SVG viewers fall back).

## Files

- `flame-mark.svg` — the locked L3 mark: coral outer, gold inner, dot eyes, small smile, flat. All flame variants reuse these exact two paths; only the face and extras change.
- `flame-asleep.svg` — closed eyes, small smile.
- `flame-needs-you.svg` — mark face, hop arcs, Ember count badge with the number of needs-you cards.
- `flame-thinking.svg` — eyes looking aside, three gold thinking dots.
- `flame-celebrating.svg` — happy arc eyes, open smile, hop arcs. Never used for a fee.
- `button-approve.svg` — primary pill, Ember Deep, white text.
- `button-approve-small.svg` — small version for cards.
- `button-continue.svg` — quiet pill, sage-deep, for money confirmations.
- `card-needs-you.svg` — pinned card: chip, title, date/time/location rows, small Approve.
- `card-time-saved.svg` — sage-tint summary with clock icon.
- `card-insight.svg` — two stats: earnings, time saved.
- `card-journal-entry.svg` — date chip + one journal line, written in Hygge's voice ("Hygge booked…").
- `floating-button.svg` — mark inside a white rounded square; bottom-right of Home.
- `avatar.svg` — circular placeholder; replaced by the user's photo in the app.
- `chat-bubble-hygge.svg`, `chat-bubble-user.svg` — conversation bubbles.
- `share-graphic.svg` — invite card: mark + "I saved about X hours with Hygge." + usehygge.app.

## Notes for the coding agent

- Placeholder data in these files (dates, places, dollar amounts, hours) is illustrative only. Real market is Austin, USD.
- Flame states animate, they don't swap images: needs-you = two small hops then still 30s+; celebrating = one hop on booking/payment; thinking = dots pulse. Reduce Motion honored.
- The money moment stays quiet: no flame, no confetti, itemized receipt only.
