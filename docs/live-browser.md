# Live browser experience

The feed and chat attach a live view of the same Chrome page used by the agent. Opening the sheet or fullscreen reuses the app's session connection. The feed attachment has no mascot; chat and the sheet use the existing animated laptop/notification artwork. The floating Hygge is larger with its badge at the top-left.

## Control and transport

Authenticated `/sessions/:id/stream` upgrades to a WebSocket in the user's Durable Object. One CDP screencast supplies compositor frames to all viewers, with one outstanding frame per viewer and latest-frame catch-up. Frames are not persisted. This replaces screenshot polling in the UI; agent snapshots remain available for reasoning and older app versions.

Take control stops admission of new agent actions immediately and waits for any in-flight action before acknowledging ownership. An epoch invalidates decisions made before takeover. Pointer, scroll, text and keyboard events go to Chrome through CDP, not a list of extracted page elements. Only the owning connection can send input. Disconnect keeps the agent paused. Let Hygge continue validates the attached task, releases ownership, and schedules the existing mission after its prior invocation finishes. Pending public-action approvals are not bypassed.

Fullscreen supports both orientations, resizes Chrome to the available viewport, and hides all persistent app chrome. Swipe inward from the right edge to reveal controls; VoiceOver has an equivalent action. Controls remain visible with VoiceOver. Precision cursor mode, direct tapping, scroll, drag, pinch zoom, native keyboard and hardware navigation keys are supported.

## Local reproduction

Start an isolated local Chrome with `--headless --remote-debugging-port=9237 --user-data-dir=/tmp/hygge-browser-qa`. In `backend/cloudflare`, run:

```
node --experimental-strip-types scripts/browser-preview.mts
node --experimental-strip-types scripts/check-browser-live.mts
```

The fixture only listens on loopback port 8768 and uses a local fictional Workroom form. Launch the Debug app with `--settings-preview --browser-preview -browserPreviewScreen feed` (or `chat`, `browser`). These entry points do not exist in Release builds. The transport integration checks changing frames, focus, direct click, text, Backspace, scrolling and handback against real Chrome.

## Acceptance boundaries

Local Chrome verifies the CDP protocol and native interaction. It does not establish acceptance against a deployed Cloudflare Browser Rendering session or a real external site's CAPTCHA/login. Validate the deployed WebSocket upgrade, stream lifetime and handback on staging before production rollout. Browser audio, remote DOM accessibility, clipboard synchronization, file-picker forwarding and multi-tab switching are not included. VoiceOver can operate Hygge controls but does not receive the third-party page's DOM tree.
