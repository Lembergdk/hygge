# Browser reconnect and mascot badge repair

The floating badge is anchored 18 points right and 28 points down inside the 108-point animation, beside the visible character's upper-left edge. Badge and character share bounce/scale. The notification animation's opaque bounds vary across frames within its transparent 360×450 canvas; frame-corner alignment left the badge floating far away.

## Connection repair

- Use Puppeteer's actual symbol-valued CDP disconnect event, plus browser disconnect/session liveness cleanup. The previous string event never fired.
- Serialize stopping the previous page screencast before starting the next one, including dismissal during startup. Ignore late heartbeat failures from departed viewers.
- Process heartbeat checks independently of queued input/handoffs so a static page or long agent action does not look disconnected.
- Give an inactive Browser Run session a ten-minute window to wait for the person (explicit `keep_alive: 600_000`), instead of the default one minute. Sessions can still expire or be lost when the process restarts; recovery never silently starts another signup.
- Reset the outgoing client queue per socket and ignore old-socket callbacks. Require a fresh frame on each new connection; an old image plus heartbeat cannot masquerade as a live preview.
- Stop automatic recovery after three unsuccessful attempts. Only 30 seconds of healthy frames/heartbeats resets the budget, preventing short-lived connections from creating another endless loop. A silent connection times out after 15 seconds, checked every five seconds.
- HTTP 404/410 or a normal terminal close shows “Session ended” with a return-to-chat action. HTTP 401/403 requests sign-in. Temporary network failures offer explicit Reconnect. Fullscreen keeps its exit/recovery controls available when disconnected.

## Verification

- 80 Swift core tests pass, including bounded retries, flapping, static-page heartbeats and terminal/auth classification.
- 200 backend tests pass; TypeScript check passes. Lifecycle regressions cover teardown overlap, startup dismissal, true Puppeteer disconnect, queued handoff heartbeats and late failures from old connections.
- Real isolated Chrome: pushed changing frames, click/focus, typing, Backspace, scrolling, handback, a static page remaining responsive for 20 seconds, and eight rapid close/reopen cycles all pass.
- Native iPhone 18 Pro / iOS 27.2: badge placement inspected; repeated local disconnects stop at Connection lost; an HTTP 410 stops immediately at Session ended. Native build succeeds. Local captures under `outputs/browser-reconnect-badge/` precede the final removal of disabled takeover controls and terminal heading cleanup.
- Fault injection is loopback-only in `scripts/browser-preview.mts`: POST `/fixture/mode/live`, `/offline`, `/silent`, `/expired`, or `/unauthorized` to exercise the app. Launch the debug app with `--settings-preview --browser-preview -browserPreviewScreen attention` for the badge, or `browser` for recovery. No real account or CAPTCHA is used.

Production logs were not used to prove the exact cause of the reported Fiverr incident. These reproducible lifecycle defects are fixed; deployed Cloudflare/WebSocket behavior and the original external session still require release acceptance. Production and TestFlight were not changed.
