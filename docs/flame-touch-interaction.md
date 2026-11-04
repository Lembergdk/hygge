# Flame touch interaction

The feed avatar uses the same touch spring for a short swipe and a carry. The
first movement stretches the torso at the grab point. After 180 ms, a movable
avatar releases its body anchor and follows the finger on a spring. Arms and
legs have independent angular springs driven by body acceleration, and keep
settling when the finger stops moving.

A short release leaves the body rooted: momentum continues the **stretch**, then
it recoils. It does not launch the whole character or invoke the old directional
hop/jump scenes. A carried release commits the intended drop point; residual
position and velocity settle relative to that new placement without a snap.

The reference rig is 210 pt wide. Native sizes scale the same model rather than
changing its timing. Stiffness 180, damping 8, pickup 180 ms match the approved
interactive prototype. Physics runs in bounded 240 Hz substeps and is rendered
at approximately 60 Hz only while an interaction is active. Reduced Motion
keeps pickup/drop available without deformation, recoil, or swinging limbs.
Gesture cancellation, disappearing views, and backgrounding clear the touch.

`FlameStretch.metal` deforms only the torso/face; the rigid limbs and laptop
attach at the same forward-mapped points. Compression is limited to avoid
folding the texture. Building requires Xcode's Metal Toolchain component.

The laptop and typing-arm PNGs had two eyes baked into each layer. Those pixels
were removed while preserving the original 720×900 registration. The asset
check rejects a recurrence; only the face layer supplies eyes.

## Checks

- `swift test --disable-sandbox` covers immediate stretch, delayed pickup without
  more gesture events, rooted stretch follow-through in every direction,
  continuous drop placement, independent joints, cancellation, Reduced Motion,
  fixed avatars, and stalled frames.
- `python3 scripts/check-flame-assets.py` checks full-frame APNGs and extra eyes.
- Debug Flame Lab includes a laptop switch and movable avatar. Flick behavior
  is fixed to the shared touch physics; the other reaction mappings remain.
- Launch with `--settings-preview --flame-render-check` for offline native
  fixtures showing both variants at rest, during recoil, and while carried.
  `--settings-preview -settingsPreviewScreen flamelab` opens the interactive lab.

This change does not publish a build to TestFlight or change the backend.
