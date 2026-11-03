# Browser capabilities available to the mission agent

Hygge continues to use Cloudflare Browser Run through `@cloudflare/puppeteer`.
This change exposes more of that existing browser to the model; it does not add
Playwright or a second browser session. Live viewing and human control still
share the same page, including the reconnect/expiration behavior from PR #31.

## Observing a page

Each mission observation provides:

- Visible page text and prominent headings, alerts and dialogs.
- Actual accessibility names and roles from CDP, plus DOM-derived control labels,
  descriptions, types, required/invalid/disabled states, checkbox state, links
  and native select options. Accessibility textbox values are excluded.
- Stable references to the actual DOM nodes, including controls in frames and
  open shadow roots. Replacement, navigation, or changed control semantics
  require another observation. Legacy callers may use an exact, unique label;
  ambiguous labels and missing targets fail instead of choosing another field.
- A viewport screenshot passed to the model as an image alongside the text,
  when the privacy checks allow it. This is separate from the app's live stream.
- Recent action results, including extracted listing text.

Observations are bounded to 160 controls, eight frames, 12,000 text characters,
160 named accessibility nodes, 60 options per native select and a 4 MB PNG.
Controls in the viewport take priority. For long pages, text includes the current
viewport plus page context; scrolling makes later controls/content observable.
Truncated observations are explicitly marked. Closed shadow roots and unobserved
frames are not interactable through these references. Custom widgets use their
observed controls and allowed keys; this is not unrestricted page scripting.

## Actions

| Action | Arguments / behavior |
| --- | --- |
| `navigate` | HTTP(S) URL in `value`, including relative URLs |
| `back`, `forward` | Browser history |
| `scroll` | `up` / `down`, 80% of viewport height |
| `wait` | 100–2,000 milliseconds |
| `click`, `hover` | Observed control reference |
| `type` | Replace an observed editable field, never append to an unrelated input |
| `select` | Observed native select and an observed option value |
| `check` | Checkbox/radio and `true` / `false`; repeated setting is idempotent |
| `press` | Enter, Tab, Escape, arrows or Space on an observed control |
| `upload` | Existing private profile-photo mechanism, bound to an observed file input on the approved HTTPS site |
| `extract` | Existing listing extraction, now included in subsequent model context |

The mission approval policy applies to new control actions using the observed
label rather than the opaque reference. Enter/Space require approval because
keyboard submission can bypass labeled buttons. Approvals bind to the targeted
node and its observed semantics. CAPTCHA/identity/2FA handoff and exclusive human
control remain in place. Extra trace metadata preserves the exact browser action
while the existing action enum remains decodable by released iOS clients.

## Private values and images

Credential secrets and emailed codes still enter through private runtime
references. They are not supplied as model-generated literal values. Entered
secrets are retained only in the browser session's redaction set and removed
from text, metadata, titles, and listing extraction. Authentication-like URL
parameters are redacted in model observations. Private runtime values are not
filled into a different-origin frame.

Images are withheld while a recognized sensitive field is filled (including
revealed passwords), when known secret text appears on the page, during human
control, when a frame cannot be inspected, or when the size limit is exceeded.
Images are excluded from application traces and image-bearing requests disable
AI Gateway payload collection. Ordinary non-secret page content remains visible
to the model. These are conservative field/text checks, not general OCR-based
redaction of arbitrary confidential pixels, canvas content or videos.

The API payload uses Meta's documented `image_url` chat content format:
https://dev.meta.ai/docs/image-understanding
Cloudflare's browser-session APIs remain the underlying automation engine:
https://developers.cloudflare.com/browser-run/get-started/

## Verification

From `backend/cloudflare`:

```sh
npm ci
./node_modules/.bin/tsc --noEmit
npm test
npx wrangler deploy --dry-run -c wrangler.staging.jsonc --outdir /tmp/hygge-browser-test-bundle
BROWSER_TEST_BUNDLE=/tmp/hygge-browser-test-bundle/index.js npm run test:browser
```

The browser test starts its own loopback fixture server and a temporary Chrome
profile. It never attaches to an existing user browser. `BROWSER_TEST_EXECUTABLE`
can override the default Chrome binary. CI runs both the source adapter and the
page observer extracted from the generated Worker bundle, catching serialization
errors that plain TypeScript tests would miss.

Tests cover duplicate labels, missing/stale targets, disabled controls, field
replacement, selects, checkboxes, frames, open shadow roots, secret redaction,
image withholding, navigation, truncation and scrolling. Unit tests cover the
model payload, approval gates/fingerprints, checkpoint detection and iOS trace
compatibility. Local Chrome plus mocked model HTTP validate integration code;
they do not prove a production Cloudflare session or a live model call.

Not included: Playwright migration, arbitrary model JavaScript/CDP execution,
Quick Actions PDF generation, crawl jobs, multi-tab management, or generic file
uploads/downloads. Those are separate product capabilities rather than necessary
parts of the current interactive account-setup workflow.
