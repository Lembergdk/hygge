# Profile learning + web-accessibility gate (Brief 06)

Every user decision is recorded as a structured feedback event, folded
into a transparent per-user learning model, and used by ONE ranking
function to order and filter future suggestions. Separately, a site
is only ever proposed or scanned when it is probe-verified to work
fully on the web.

## The one ranker

**Where it lives:** `rankItem` in `backend/cloudflare/src/learning.ts`.
**Call sites (exactly two):**

1. Scan surfacing — `runScheduledTick` in `backend/cloudflare/src/scan.ts`
   ranks every gate-passing listing, drops anything below the
   threshold, surfaces the rest in score order, and stamps each
   payload with `rankScore`.
2. Site proposals — `rankSiteProposals` (same module), called from
   `proposeSites` in `backend/cloudflare/src/user-sandbox.ts` after
   web-eligibility filtering.

The Swift `MatchEngine` no longer orders anything.
`MatchEngine.evaluate` is display evidence only (card facts +
recommendation wording), and its `survey` remains the journal's
negative-space report for on-device discovery. App-side learning
types mirror the server model in `Sources/HyggeCore/Learning.swift`.

Honest limit, today: the ranker's **threshold** is fully live
server-side (below-threshold finds never surface), and every
surfaced payload carries its `rankScore`. The **ordering** is not
yet user-visible — the app feed has no ranked opportunity-list
consumer, and server state lists order by `updated_at`, so feed
order does not currently follow `rankScore`.
`MatchEngine.inServerRankOrder` is the ready-made ordering for the
feed work that wires that consumer; until then, do not claim feed
order is ranked.

### Formula (final values)

```
base  = 0.35 * categoryFit + 0.35 * skillsFit + 0.20 * payFit + 0.10 * locationFit
score = clamp(base + affinityAdj + skillAffinityAdj + freshnessAdj
              - tooLowPenalty - tooFarPenalty, 0, 1)
```

Named weights (`RANK_WEIGHTS`) are seeded from the former Swift
MatchEngine (0.35 category / 0.35 skills / 0.20 pay / 0.10 remote),
including its 0.15 "no skills required" credit (`NO_SKILLS_REQUIRED_FIT`).

- `categoryFit`: 1 if the category is one of the user's interests,
  0 if known and not, 0.5 when category/interests unknown.
- `skillsFit`: share of required skills the user has (substring match);
  no requirements → 0.15/0.35.
- `payFit`: ≥ floor → 1; ≥ 80% of floor → 0.4; below → 0; unknown pay
  → 0.5 (neutral). Note the hard bound lives in the gate, not here:
  known below-floor pay is dropped before the ranker is consulted.
- `locationFit`: remote → 1 if the user accepts remote work; otherwise
  scaled by `distanceKm` against the profile's `radiusKm`
  (unknown distance → 0.5, never blocking).
- `affinityAdj`: category affinity (−1…1) × 0.15.
- `skillAffinityAdj`: mean skill affinity × 0.05.
- `freshnessAdj`: ±0.05 around a 7-day half-life on `postedAt`
  (`FRESHNESS_HALF_LIFE_DAYS`); unknown → 0.
- `tooLowPenalty`: rate sensitivity (0…1) × 0.15, full at/under the
  floor, fading to 0 at 125% of the floor.
- `tooFarPenalty`: distance sensitivity × 0.15 × min(1, distance/(2×radius));
  only when distance is known and the work is not remote.

**Surfacing threshold:** `SURFACING_THRESHOLD = 0.45` (the old
MatchEngine keep threshold). Below it, items do not surface and
candidates are not proposed (`belowRankThreshold` in scan summaries).
Threshold/weight changes go through review — no silent tuning.

The ranker orders and filters **above** the Brief 05 gate. It cannot
resurrect a gate-dropped listing, write an application, or bypass
consent, pause, `needs_human`, or the rate floor.

## Feedback taxonomy & learning model

Events are stored per user in that user's Durable Object
(`feedback_events` state table; routes `/feedback-events`, carried by
`/state/export`). Shape:

```
{ id, userId|null, subjectType, subjectId, action, reason|null,
  category|null, requiredSkills[], estimatedHourly|null,
  distanceKm|null, occurredAt }
```

- `opportunity`: `accepted` | `declined` (+ reason) | `ignored`
- `siteProposal`: `approved` | `dismissed`
- `signup`: `signupApproved` | `profileConfirmed`
- `application`: `sent` | `booked` | `completed` (recorded at the
  existing task/stage outcome points — no parallel outcome system)

Decline reasons reuse exactly what the feed records, normalized in
`normalizeFeedbackReason`: `too low`→`tooLow`, `too far`→`tooFar`,
`not their thing`/`not my thing`→`notMyThing`, `just busy`→`justBusy`,
anything else→`other`. Historical declines carry no reason; learning
starts cold — no backfill.

**Recording hooks:** `AppStore.recordFeedback` at `reject(taskID:reason:)`
(the "Not now" menu now passes its reason through instead of discarding
it), `approveProposal` / `dismissProposal`, successful task outcomes
(`recordTaskEvent`: signup/profile/apply), and application stage
changes (`setApplicationStage`, `completeWork`). Events ride the
existing Brief 01 push. On the server, `deriveIgnoredEvents` runs every
scan tick.

**Ignored:** `IGNORED_AFTER_DAYS = 7` days surfaced with no action,
no application, and no prior feedback event (deterministic
`ignored:<opportunity id>`, derived exactly once).

**Derived model** (`learning_profiles`, one row per user, rebuilt
deterministically from the event log whenever the cached row's
`eventCount` no longer matches the log — `ensureLearningProfile`):
per-category affinity (−1…1 with accept/decline/ignore counts),
per-skill affinity, rate/distance sensitivities, reason counts.
Deltas (`FEEDBACK_DELTAS`): accept +0.20 (skills +0.10); decline −0.20;
`notMyThing` −0.30 (skills −0.15); `tooLow`/`tooFar` −0.05 category plus
+0.20 matching sensitivity (cap 1); `justBusy` −0.02; ignored −0.05;
proposal approved +0.10 / dismissed −0.10; signup +0.10; application
sent +0.15 / booked +0.20 / completed +0.25.

**Rate floor:** never auto-changed by learning (no code path from
feedback to the floor). At `RATE_FLOOR_PROMPT_MIN_TOO_LOW = 3` "too
low" declines, `rateFloorPrompt` flags a review and the profile hub
shows a plain-language note; the floor moves only when the user
explicitly sets a new one.

Feedback, affinities, and beliefs are per-user DO state and never flow
into shared skills except through Brief 02's sanitized promotion.

## Beliefs: stated vs inferred

Mapping (`beliefKind`, mirrored in Swift): explicit server `kind`
wins; source `youSaidIt` (user said it; edits rewrite to this) is
**stated**; a confirmed (non-pending) belief is **stated** (confirmed
in the profile hub); everything else — pending proposals,
`learnedFromWork`/`guessedFromChat` unconfirmed — is **inferred**.

- Stated always wins conflicts per topic (`resolveBeliefs`) and never decays.
- Inferred carry confidence with a decay **half-life of 30 days**
  (`INFERRED_BELIEF_HALF_LIFE_DAYS`); below 0.2 effective confidence
  they expire and are pruned on scan ticks / server pulls.
- `proposeInferredBeliefs` proposes inferred beliefs from patterns
  (≥2 "too far" → distance preference; ≥3 "too low" → pay preference;
  category affinity ≤ −0.5 with ≥2 declines) as pending rows, shown in
  the hub as "My guess — check me". A stated belief on the same topic
  suppresses the proposal. Edit/delete affordances are unchanged.

## Web-accessibility gate (probe-verified)

Fleet-level D1 `site_catalog` columns (migration
`0005_web_access.sql`, no user data): `web_accessible`
(`true|false|unknown`), `probed_at`, `probe_evidence`,
`unknown_cycles_used`, `app_wall_strikes`. Logic in
`backend/cloudflare/src/web-access.ts`; the probe itself reuses the
browser mission path (`runWebProbe` in user-sandbox.ts — an ordinary
read-only discover mission; no per-site scripts or APIs, no writes).

The probe checks on desktop web: signup page reachable + form
present, profile edit reachable, apply flow startable. Final rules:

- Any key outcome behind a mobile-app wall (or a failed check) in a
  **probe** → `web_accessible=false` (ineligible: never proposed,
  never scanned; the gate is site-level by domain).
- An app-wall signal in an ordinary mission (`ScanMissionOutcome.appWall`,
  distinct from the generic human-check signal) is **one strike + an
  immediate re-probe** (the one retry). A confirming probe, or a
  second strike (`APP_WALL_STRIKES_TO_DISQUALIFY = 2`), disqualifies.
  A human-only check during a probe is not an app wall: undecided.
- `unknown` is transient: sites are probed before their first
  proposal/scan. If a probe cannot decide, the site stays `unknown`
  and is allowed **exactly one** proposal/scan cycle
  (`UNKNOWN_MAX_CYCLES = 1`), then blocks until a probe resolves it.
  There is no permissive default left (the Brief 05 deferral marker
  is removed; a gate context without a site verdict blocks).
- Re-probe after **30 days** (`REPROBE_AFTER_DAYS`), or immediately on
  an app-wall strike.
- Becoming ineligible withdraws open site proposals and logs a
  plain-language journal sentence with the probe evidence as the
  reason (`withdrawProposalsForSite`); scans stop at the tick's gate.

## Chosen defaults (confirm at review)

- Weights/threshold seeded from the old MatchEngine as above; bounded
  adjustments ±0.15/±0.05/±0.05 are new and deliberately small.
- Ignored = 7 days; inferred half-life = 30 days; expiry 0.2;
  floor-prompt at 3 "too low" declines; reprobe 30 days;
  app-wall: one probe retry, two strikes disqualify.
- Proposal rows for withdrawn sites are **removed** (the app's
  `ProposalStatus` has no withdrawn case) with the journal sentence
  as the durable reason.
- `distanceKm`/`postedAt` on listings are optional (JSON extraction
  only today); null is neutral and never blocks.
- Migration 0005 must be applied to D1 before this code is deployed;
  until then catalog reads treat sites as unknown (one-cycle rule).
  No staging/production changes were made by this brief; the staging
  probe demonstration is still outstanding.
