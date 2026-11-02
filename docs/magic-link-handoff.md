# Direct magic-link handoff

Email contains the HTTPS Universal Link directly, with no tracking/redirect host:
`https://api.usehygge.app/auth/magic?token=…` (staging uses its own API host).
The installed app receives it through SwiftUI's URL/user-activity handlers and
redeems it with POST. Apple can open a Universal Link directly from a mail app;
the fallback HTML is never needed on that path.

## Browser fallback

A client or user preference may send the link to a browser instead. The fallback
makes one automatic `hygge://auth/magic` handoff attempt on iPhone/iPad, including
iPad desktop mode. It waits until the page is visible and never loops when the
user returns from the app. The Open Hygge button remains if the client blocks
handoffs or JavaScript. Desktop users are directed to their iPhone/iPad.

The page does not redeem tokens, fetch auth endpoints, load third-party content,
or redirect repeatedly. GET remains safe for email scanners. Valid token data is
URL-encoded/JSON-quoted; malformed tokens cannot execute a handoff. Responses are
no-store/no-referrer, prevent framing, and restrict scripts/resources with CSP.
The mobile handoff also replaces the browser history URL to remove the token.

## Signed release

Both app entitlement files and the origin/Apple-CDN AASA files declare
`3KA38L8A4F.app.usehygge` for the production and staging magic-link domains.
Public origin and Apple-CDN responses were checked successfully on 2026-11-02.
An older local signed build (1.0 build 1) had no associated-domains entitlement;
this is not proof of the entitlements in the user's current installation.

The TestFlight workflow now signs the archive using its existing distribution
certificate/profile, preserving the app's declared capabilities. Before upload,
`check-release-app-links.py` checks the exported IPA's signature, app identifier,
both associated domains, and provisioning authorization. A missing capability
fails the release instead of silently shipping a web-only handoff. No credentials,
Apple capabilities, provisioning profiles or live releases were changed by this
code change.

The 2026-11-02 TestFlight archive exposed a stale CI provisioning profile: Apple
marked it invalid, and it omitted Associated Domains, Push Notifications and
Sign in with Apple even though the App ID already enabled all three. Replace
`BUILD_PROVISION_PROFILE_BASE64` with a freshly generated App Store profile for
the same App ID and distribution certificate. The workflow selects that profile
by its embedded UUID for both archive and export, avoiding a fixed display name.
It checks profile expiration, distribution type and every declared release
capability before archiving, then checks the signed IPA again before upload.

## Acceptance and limits

Automated tests cover direct email hrefs, iPhone/iPad handoffs, desktop handling,
background preview safety, blocked navigation, return-without-loop, malformed
input, GET not consuming tokens, and release entitlement checks. The guard was
also run against the older IPA and correctly rejected the missing entitlement.

Production acceptance requires the backend change to be deployed, a signed build
that passes the new guard to be distributed/installed, and a real inbox-to-app
round trip. Ordinary PR CI does not perform signing or TestFlight distribution.
A mail client can rewrite or suppress links, and iOS can honor a prior choice to
open the website. No app can guarantee zero prompts or taps in every client.
Keep the recovery button for those cases; do not replace the email's verified
HTTPS link with an unverified custom-scheme link.

Apple references: [Supporting associated domains](https://developer.apple.com/documentation/xcode/supporting-associated-domains)
and [Debugging universal links](https://developer.apple.com/documentation/technotes/tn3155-debugging-universal-links).
