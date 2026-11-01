# Scheduled scanning (Brief 05)

Plain summary: Hygge looks for new work on its own, three times a day,
on sites the user said yes to. New listings that fit wait in the feed.
Nothing is ever sent, booked, or applied for by a scan.

## What was already true (verified before building)

- Pause already lives on the server. The app pause switch writes
  through the Brief 01 state push into the profile row, so the
  scanner reads the same flag the app sets. No new pause flag was
  needed; the scanner just honors it on every tick.
- Discover missions already existed (manual only). A scan reuses the
  exact same mission path, so saved sign-ins, site skills, and
  human-only checks behave identically.
- The app already dedupes discoveries by title + site. The server
  uses the same rule (with case/space tidying) plus a stable item
  id, so a listing can never appear twice.

## How often each site is checked

| Site state | How often | Notes |
| --- | --- | --- |
| Said yes + saved login | 3× a day | Signed-in look each time |
| Said yes, no saved login | 1× a day | Public pages only, no sign-in tried |
| Suggested, not said yes | Never | Suggestions only |
| User paused everything | Never | Checked before anything else |

Times are 07:00, 13:00, and 19:00 UTC. That is morning, midday, and
evening for the current UK and Europe users. The times are fixed in
UTC for now; per-person local times are a later change.

One extra stop rule: if a public look finds nothing readable at all,
Hygge stops looking at that site in public until a login is saved,
instead of knocking on a closed door every day.

## What reaches the feed (the gate)

A listing appears only when all of these hold:

- The kind of work matches what the person said they enjoy.
- Any listed skills overlap with the person's skills.
- The place fits, or the work can be done from home.
- Pay, when a rate is known, is at or above the person's lowest
  rate. Below that, the listing is dropped and never shown.
- It is not a listing the person already saw, turned down, or
  applied to.
- It is not known to be unreachable on the web. Until Brief 06
  lands, "not yet checked" counts as reachable; this is marked in
  code as temporary.

Unknown facts (no rate listed, no place listed) do not block a
listing. Only known-bad facts do, apart from the lowest rate, which
is a hard line the moment a rate is known.

## Quiet categories rest

Per person, per kind of work, Hygge remembers when it last looked
and when it last found something new. If a full week of looks finds
nothing new, that kind of work rests for a month. During the rest,
every planned look is skipped and the skip is written down with its
reason. After the month, Hygge looks once; finding something
reopens the category at once, finding nothing starts another
month's rest. Adding a site in that kind of work, or changing the
lowest rate or home area, reopens the category straight away.
Failed looks (a site error, for example) never count toward the
quiet week.

## When a sign-in stops working

Trusted sign-ins can expire. The next look notices, signs in again
with the saved login, and carries on — nothing for the user to do.
If the saved login itself is turned away, or the site asks for a
check only the person can do, Hygge stops there. It never tries to
get past such a check. Exactly one card appears in the feed saying
what is needed, and that site is not looked at again until the
login is saved again or a look succeeds. One card per problem,
never one per look.

## Cost guardrails

- At most three looks per signed-in site and one per public site
  per person per day. Extra ticks stop at the cap and say so.
- The same slot can never run twice for the same site.
- Every look is written down: site, time, how many listings were
  read, how many were new, and whether shared site know-how was
  used or the stronger helper had to work it out fresh.

## Who schedules, and where state lives

A single clock on the server wakes each person's own space in
turn. All decisions — paused or not, which sites, what tier, what
is exhausted — happen inside that person's space, from that
person's data only. One person's looks can never see or touch
another person's anything.

The walk through all users is one at a time for now, and the
starting point rotates so nobody is always last. If the walk ever
gets too long, the follow-up is splitting the day's work or giving
each person their own alarm; that trade-off is noted where the
sweeper lives.

## Not in this brief

- Phone alerts for new finds (Brief 07). Finds wait in the feed.
- Smarter ordering of finds and the reachability check tightening
  (Brief 06).
- Anything that writes on a site. A find becomes an application
  only through the person's own approval, exactly as before.

## Operator notes

- Trigger config is committed for staging and production but was
  not switched on by this change. Before switching on, confirm the
  account plan allows three daily triggers and the expected run
  time across all users.
- A single person's tick can be run by hand through the same route
  the clock uses, which is how the tests here prove the behavior
  without a live browser or a deployed clock.
