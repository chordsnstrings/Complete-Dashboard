# What we actually hold, per provider — measured, not assumed

A standing reference so the same questions do not get re-measured every time
they are asked. Every figure here was taken off **production**, and each one
says the date it was taken and the endpoint it came from, because a coverage
number with no date on it is a number that will be wrong within a week.

Re-measure with:

```bash
B=https://fleet-dashboard-wpeqb.ondigitalocean.app
curl -s "$B/api/revenue?from=2026-08-01&to=2026-08-31&fleet=egari&_=$RANDOM" | jq '.platforms[]|select(.platform=="uber")'
curl -s "$B/api/settings/jobs&_=$RANDOM"   | jq '.jobs[0].progress.step'   # what a running backfill is on
curl -s "$B/api/status?_=$RANDOM"          | jq '.[]|select(.source=="uber")'
curl -s "$B/api/coverage?from=…&to=…"      # row counts and first/last per feed
```

`&_=$RANDOM` is not decoration: the API caches, and a before/after comparison
without it reads as "nothing changed".

---

## The denominator, first

Every percentage below divides by **chargeable bookings** — a booking that can
carry a fare at all, which is `completed OR already priced`. Cancellations are
excluded, because a ride nobody took has no fare and counting it as missing
coverage understated three channels at once. `chargeable_bookings` and
`uncharged_bookings` are on every `/api/revenue` platform row.

**House rule, and the reason for most of what follows:** a figure that cannot
be measured renders ABSENT WITH A REASON, never as zero — canonical in
`api/alert_coverage_sql.js`. The corollary matters just as much: a figure that
CAN be answered better must not render absent, and must not render at a
precision that destroys it.

---

## Uber

Two orgs — `ecosine` and `egari` — with separate credentials, separate supplier
sessions and separate report quotas. Almost every surprise in this file comes
from something being true of one of them and not the other.

### Per-trip fares — coverage by month

Measured 2026-09-05, `/api/revenue?fleet=…`, per calendar month, `uber` only.

| month | Ecosine priced / chargeable | Egari priced / chargeable |
|---|---|---|
| 2025-04 | 9,361 / 14,029 · 66.7% | 0 / 4,531 |
| 2025-05 | 7,696 / 12,245 · 62.9% | 0 / 5,042 |
| 2025-06 | 6,914 / 7,119 · 97.1% | 0 / 3,654 |
| 2025-07 | 6,097 / 7,002 · 87.1% | 0 / 3,035 |
| 2025-08 | 5,283 / 8,798 · 60.0% | 0 / 3,313 |
| 2025-09 | 18,195 / 18,211 · 99.9% | 0 / 7,233 |
| 2025-10 | 21,184 / 21,184 · 100% | 0 / 7,692 |
| 2025-11 | 22,113 / 22,116 · 100% | 0 / 8,420 |
| 2025-12 | 17,158 / 17,174 · 99.9% | 0 / 6,716 |
| 2026-01 | 19,777 / 19,789 · 99.9% | 0 / 7,810 |
| 2026-02 | 15,449 / 15,469 · 99.9% | 0 / 6,939 |
| 2026-03 | 3,499 / 3,499 · 100% | 0 / 1,523 |
| 2026-04 | 4,072 / 4,072 · 100% | 0 / 1,793 |
| 2026-05 | 5,743 / 5,743 · 100% | 0 / 2,719 |
| 2026-06 | 5,982 / 5,982 · 100% | 0 / 2,960 |
| 2026-07 | 6,000 / 6,000 · 100% | filling — 42.7% at 06:30 |
| 2026-08 | 7,729 / 7,736 · 99.9% | 3,503 / 3,503 · 100% |
| 31 Aug–5 Sep | 2,176 / 2,177 · 100% | 936 / 936 · 100% |

Three separate facts are in that table.

**1. Ecosine is complete for every month Uber still serves.** 99.9–100% from
September 2025 onward. The residual 0.0–0.1% is a handful of rows per month
(7 in August) that are completed and unpriced; every other unpriced row is a
cancellation, which correctly has no fare.

**2. Before ~September 2025 the coverage is partial — and Apr–Aug 2025 is a
bug, not a ceiling.** This section said the opposite until 2026-09-05 and was
wrong twice. Both errors are corrected here rather than deleted, because the
sentence they produced — *"can never be repaired"* — is the kind that stops
anybody trying again.

*Retention is ~17.6 months, not ~12.* Measured against the live backfill, not
read off a comment: `PAYMENTS_ORDER` accepts a window starting 2025-03-17 and
refuses 2025-03-16. The `~12mo` at the head of `src/sources/uber.js` is a note
somebody wrote from the documentation; the boundary above is what the server
actually does. `uberAuditTick` still verifies it nightly, walking three windows
per fleet so the whole horizon is re-checked inside a week — it was the horizon
that was mis-stated, not the audit.

*So April–August 2025 is INSIDE retention, and the gap is ours.* Those eight
payments weeks were generated successfully by Uber and we failed to download
them: `download timed out after 600s for report <uuid>`, thrown at
`src/sources/uber.js:137`. Two things make it recur rather than resolve. The
reportId is discarded inside an error string, so the generated report — which
Uber had already built and would serve — cannot be re-fetched; and the failure
is not checkpointed, so every Sunday backfill spends about 80 minutes and eight
of its three-at-a-time report slots re-failing the same eight windows. Roughly
13,800 Ecosine bookings and some AED 700k of fares are recoverable, and the
recovery is a retry that keeps the reportId, not a new entitlement.

**3. Egari had nothing before August 2026, and the reason was ours.** Egari's
reports are served — the weeks that were finally asked for came back full, and
its August went 0% → 100% in the hours a resumed backfill spent on it. Nothing
had ever asked. `collect()` ran one whole pass per org, so Egari's ~105 weekly
fare windows sat behind all of Ecosine's, at roughly a minute each plus a paced
sleep, in a worker that restarts on every deploy. Backfill job 50 died at
Ecosine week 51 and had to be resumed before Egari saw a single window.

**Fixed** by making the pass phases across the orgs and interleaving the fare
walk week by week — `fareTasks()` in `src/sources/uber.js` yields every fleet
on a week before any fleet moves to the next, so a run that is cut short leaves
both fleets the same distance back. Held down by
`test/uber_fares_interleaved.test.mjs`.

### Where each Uber figure comes from

| figure | surface | grain | horizon |
|---|---|---|---|
| trips | TRIP_ACTIVITY report | ≤31-day windows | ~17.6 months (measured) |
| per-trip fare | PAYMENTS report | whole weeks | ~17.6 months (measured) |
| driver earnings / trips / km | supplier GraphQL, daily grid | one Dubai day | **192 days**, rolling |
| earnings components (fare, fee, tips) | supplier GraphQL, weekly | whole weeks only | 192 days |
| acceptance / cancellation / rating | DRIVER_QUALITY report | whole weeks | `QUALITY_WEEK_HORIZON` = 26 |

Server limits: ≤31-day range, ≤3 concurrent reports, async generation. The
payments report has a **generation cap of its own**, separate from the
three-in-flight one — "Payment report generation limit reached" — which is why
the fare walk is weekly rather than monthly and paced with an 8s sleep (20s
after a failure).

### Uber's fare tree

Identical on two independent surfaces, which is what proves it:

```
Paid to you → Your earnings → Fare (BRANCH)      == statement `fare`
                               └─ Fare (LEAF)    == statement `little_fare`
                               └─ Surge, Wait time, Cancellation, Reservation Fee…
                            → Service fee        == exactly 25.00% of the branch
                            → Taxes              == 5% VAT on the fee
```

`PAY_COLS.fare` reads the **branch**. Verified twice: 29 trips show the service
fee at exactly 25.00% of it, and 6/6 fully-priced driver-weeks equal the
statement's `fare` line to the cent (before the fix, 5/5 equalled
`little_fare`).

### Money grains, and the trap in them

The supplier GraphQL surface reports the same money at 1, 2, 3, 4, 7 and 31-day
spans. `driver_payout_day_finest` resolves per driver-DAY and blanks the
coarser rows on days the daily grid ran. Verified against the bank: Uber
27 Jul–30 Aug moved 465,923.53 → 440,726.21 against **AED 440,445.31 actually
credited** (+0.06%). Coarse grains now 0.

Two extrapolations that look reasonable and are not:

* Scaling a partly-priced week up to 100% **overstates by ~11%** — the unpriced
  rows are cancellations, which are worth far less than a completed ride.
* Summing raw `components` over a multi-week window **over-counts by ~19%** —
  weekly statements get counted whole at the boundaries.

### The running week

Uber refuses a range whose **end is in the future** ("endDate is too late") —
not a part-week. So the current week is asked for as Monday-to-today, clamped,
and never checkpointed, on every catch-up and backfill. Effect: 10 → 2,150
priced trips within eight minutes of the deploy that landed it. Before, a
Monday trip waited until Sunday.

`weekIsClosed` compares on the **Dubai** day; `w.end < now` had been calling a
week closed from Sunday 00:00 UTC, which is 04:00 Sunday in Dubai — twenty
hours early.

---

## Other channels

| channel | fares on the trip row? | payout? | notes |
|---|---|---|---|
| Hotel (corporate) | yes, same day — 98.8% of Aug | none published | nothing takes a commission between booking and bank |
| Bolt | yes — 99.7% of chargeable Aug | none published | figure is GROSS; the commission is not published to us |
| Yango | yes — 100% | yes | earnings are NET: cash + cashless + commission (commission is negative) |
| FMS | journeys, not bookings | n/a | watches cars, does not sell rides |
| CABMAN | realtime GPS, 5-min poll | n/a | the only feed with a seat sensor |

`COMMISSION_CHANNELS = {uber, bolt, yango, careem}` — the channels whose fares
are a gross the platform takes a cut of. `fleetIncome()` / `chooseBasis()` pick
ONE figure per platform, payout-first wherever a payout covers the window,
fares only where no payout exists.

---

## When each collector runs

| pass | schedule (UTC) | window | runs the fare walk? |
|---|---|---|---|
| incremental | every 30 min | 3 days | **no** — the payments cap would be spent on an open week |
| catch-up | 21:00 daily | 30 days | yes |
| backfill | 22:00 Sundays | whole horizon | yes |
| CABMAN tick | every 5 min | now | — |
| Uber timeline | own cron | 2 days | — |
| Uber profile | 00:20 Mondays | — | — |
| past-window audit | 01:45 daily | 3 windows/fleet | — |
| probe | 22:20 daily | — | — |
| analyst | 23:10 daily | a month | — |

So: **the last 30 days of both fleets stay current nightly**; anything older is
repaired only by the Sunday backfill. Checkpoints (`collector_checkpoint`) are
per job and per `fleet:window`, so a worker restart resumes rather than
restarting — which is what makes the backfill survivable at all.

---

## Today, live

`/api/day?day=…` carries **two** money figures for a day and they differ by an
order of magnitude — on 5 September, AED 964 and AED 9,657:

* `revenue` — the price on the bookings actually taken since midnight. A
  **measurement** of today.
* `accounted` — whose own `payout_basis` reads "a share of each weekly platform
  statement, spread evenly across the days it covers". Right for a settled day,
  a **projection** for a day three hours old: it prints the same number at
  06:00 as at 23:00.

The live band on the desktop shell and the "Today so far" card on the phone
therefore show `revenue`, with the count it covers, and link to the day page
for the accounted view with its basis stated. `/api/day` takes a day and
nothing else — no platform or fleet filter — so both surfaces say "both fleets,
every channel" rather than pretending to follow the chips.

**Three caches sit between a live figure and the truth**, and each needs a
different answer. `api()` in `api/public/data.js` is stale-while-revalidate:
it hands back the held body immediately, which is right for a page about a
window and wrong for a line stamped "as of 07:15 Dubai" — on production the
band read 56 bookings while the lede three inches below it read 68, for the
same day, in the same second.

| cache | how to pass it |
|---|---|
| the client store (`swr.js`) | pass **any** options object to `api()` — it then neither reads nor writes the store |
| the browser's HTTP cache | `cache: 'no-store'` |
| the server's response cache (`api/cache.js`) | version-keyed, re-checked every 30s — a `&t=<minute>` key costs at most one real computation a minute |

And **one today per screen**: anything that mentions the current day must read
the same object, not a second endpoint. `todayLive()` is that object.

Today's Uber fares lag its bookings, and that is a schedule rather than a hole:
the payments report is walked on the nightly catch-up and the Sunday backfill,
never on the half-hourly incremental. `FARES_LAG` in `api/public/today.js` is
the one sentence both shells say it with.

---

## What each provider does NOT give us — measured 2026-09-07

The most expensive mistakes this session were all the same shape: building on a
field a provider *appears* to offer and does not populate for this org. Every
line here is a count off production, not a reading of a doc.

| claim | measured | how |
|---|---|---|
| Uber sends a coordinate on a timeline event | **0 of 194,107** rows carry lat/lon | `/api/coverage` → `geo["timeline:uber"]`; ecosine 0/120,002, egari 0/74,105 |
| Uber sends a pickup coordinate on a trip | **0 of 315,029** | same call, `geo["trip:uber"]` |
| Bolt sends any coordinate | **0 of 48,346** — no lat/lon field exists in its payload at all | `geo["trip:bolt"]` |
| FMS sends both an address and a coordinate | **222,330 rows, 100% of both** | `geo["trip:fms"]` |
| Hotel channel | 1,763 rows, 97.3% address, 68.7% coordinate | `geo["trip:hotel"]` |

**So the trackers are the only source of position at scale.** Anything that
needs to say *where* — a wait, a driver going online, a dead zone — has to come
from `telemetry_snapshot` or FMS trips, never from Uber. `driver_timeline_event`
has `lat`/`lon` columns and the collector maps them at
`src/sources/uber_timeline.js:147`; Uber answers null every time. The repo's own
fixture agrees: `test/fixtures/uber_timeline.json` is null on all 17 events.

**FMS is a free gazetteer.** Address and coordinate on the same row means
444,660 (name, lat, lng) pairs in exactly the area this fleet works, needing no
key and no network. From a 0.27% sample: 67.6% of stationary tracker fixes have
a named point within 250 m, median nearest distance 138 m. **The honesty limit
is measured too** — of 1,200 harvested points, 628 have another named point
within 150 m and **139 of those (22.1%) carry a different name**. So roughly one
lookup in five has a rival answer, and any name shown must carry its distance or
refuse. A place name that is a guess dressed as a fact is worse than the
coordinate it replaced.

**Addresses are in the RIDER's language.** 22.0% of Uber and 17.4% of Bolt
addresses contain a non-ASCII character because the string is localised to
whoever booked. `#corridors` already pays for this: `Дубай` is a corridor
endpoint with 1,101 Bolt trips — Dubai counted twice under two spellings. Uber
and hotel use `" - "` hierarchies whose second segment is the community; Bolt
and Yango are comma-separated (537 of 1,000 Bolt addresses contain no `" - "` at
all), so one splitter cannot serve both.

**Two feeds nobody reads.** `alert` has 447,543 rows and a populated `location`
TEXT column (1,062 distinct names, from FMS "Start Location") while `alert.lat`
and `alert.lng` are written by nothing — a name with no coordinate, the mirror
image of the telemetry problem. And nothing anywhere reads
`driver_timeline_event` rows with `kind='job'`.

---

## Uber's recommendation feed is a snapshot, not a verdict

`getRecommendations` (→ `platform_recommendation`, written by
`pullRecommendations()` in `src/sources/uber_fleet.js`) is republished **during
the day, about the day in progress**. It is not a closing figure.

This cost the product its most severe finding. On 2026-09-07 the board's top
item read *"8 drivers were online but completed no trips"* at critical severity.
Against our own `trip_norm` those eight completed **71 bookings** on 6
September — 16, 14, 10, 9, 8, 6, 4 and 4 — and Uber's "13.5 hours online in
total" was **109 hours** measured. All eight were active, could earn, and were
rated 4.85–4.99 over hundreds of lifetime trips. A driver who went online at
07:49 and completed his first booking at 09:01 is "1.2 hours online, zero trips"
in an 08:01 snapshot and a full day's work by evening.

**Rule: never repeat a platform's judgement about a period without checking the
half of the answer we hold ourselves.** `platformFlags()` now cross-checks
against `trip_norm` and drops anybody who completed a booking, says how many it
dropped and why, and reports an unclosed period at warning rather than critical.
See `test/platform_flags_truth.test.mjs`.

---

## Credentials, and what shape each one is

| credential | shape | consequence |
|---|---|---|
| Uber driver photo URL | CloudFront pre-signed, **exactly 12 h** (43,200 s, two runs agreeing to 0.1 s) | never store the URL — store the bytes. `sql/schema_v63.sql` |
| Bolt refresh token | JWT, **7-day** life (`iat`→`exp`), carries `fleet_owner_id` | a weekly human paste is a scheduled outage; check whether it rotates on use before storing one in an env var |
| Yango | park id + API key + Yandex session cookie, all three sent on every request | a 403 **with** the cookie and 401 **without** it means the cookie IS being accepted and something else is refused — do not send anybody to re-paste a session that was never the question |
| Uber timeline window | Uber refuses >31 days; the collector cuts at 30 | `MAX_WINDOW_DAYS` in `src/sources/uber_timeline.js` |

**Reverse geocoding** is reachable from the collector (not from Chromium):
`photon.komoot.io/reverse?lat=&lon=&lang=en` returns 200. Its `district` field
is the operator's vocabulary — "Downtown Dubai", "Dubai Marina", "Al Garhoud",
"Palm Jumeirah". **`&lang=en` is not optional**: without it every answer comes
back in Arabic. `name` is a building and is often noise ("Wmart"); `district` is
the useful field.

---

## One person, two rows: the phone is the join nothing uses — measured 2026-09-07

Reported from the product: "Muhammad Khalifa Afzal Khalid has uber trips, but it
doesn't show that uber is there. it only shows bolt trips."

He does have Uber trips. The roster carries both records and the same phone
number on each:

| channel | id | name |
|---|---|---|
| hotel | `67483c64055e070d79100112` | MUHAMMAD KHALIFA AFZAL KHALID |
| uber | `76ede4ae-768b-4126-804b-0b5c88043682` | Muhammad Khalid |

The Uber account carries **4,461 trips over 302 days on 8 vehicles**, statement
gross AED 38,380.87, fees AED 9,596.02, cash AED 3,895.03. The row an operator
sees for him reports **822 trips and AED 15,636**, on Bolt.

### Why the fold cannot see it

`personFold` (api/custody_sql.js) decides two records are one person from the
NAME — case, whitespace, an adjacent repeated word — and api/identity_map.js
argues at length, correctly, that it must never learn to do more. The pattern
here is that **Bolt and the hotel channel file the full legal name and Uber
files a shortened one**, with the middle (father's) name dropped:

    Zubair Khan Shaukat Ali      / Zubair Khan Ali
    Nauman Hassan Shida Muhammad / Nauman Hassan Muhammad
    Zia Ali Said Muhammad        / Zia Ali Muhammad

A subsequence rule would join those — and would also join `Muhammad Khalid` to
`Muhammad Khalid Gul`, who are two different men with 77 simultaneous trips on
two plates, refused by hand in api/identity_map.js. The name cannot settle it.
The phone can, and it is already stored on `driver_compliance` for both sides.

### The measurement

Over the 289 roster rows (`/api/compliance/drivers`, 157 Uber + 132 hotel):

| | |
|---|---|
| distinct phone numbers | 217 |
| phones on more than two rows | **0** |
| phones on two rows of the SAME platform | **0** |
| phones shared across two platforms | **72** |
| …of which the two names differ, so no name fold can reach them | **61** |
| …still rendering as two separate directory rows | **58** |
| trips sitting on the smaller row of those pairs | **13,056** |
| money likewise | **AED 393,731** |

Every phone maps to exactly one or two records, and never twice within a
channel, so on this roster the phone is a clean one-to-one cross-channel join.

### And it agrees with the refusals

Of the three pairs a human investigated and declined to merge, the phone rule
keeps two apart — `Muhammad Naeem Khan`/`Mohammad Naeem Khan` and
`Muhammad Khalid Gul`/`Muhammad Khalid` both have different numbers, which is
the whole point. The third, `Sanaullah Sher Zamin`/`Sana Ullah Sher Zamin`,
shares a phone; that entry is marked UNDECIDABLE rather than refused ("the
hotel record has 0 trips, 0 custody rows and 0 money … settled by a phone call,
not by this file"), so it is a case the register could not decide, not one it
decided against. REFUSED must still win over the rule regardless.

### The limit, stated

166 of the 434 directory rows carry **no phone on any of their records** — 93
Bolt-only, 51 Uber-only (Uber accounts that appear in trips but not in the
compliance roster), 15 already spanning both — and 80,443 trips sit on them.
The phone rule is blind to every one of those. It polices the 268 rows that
carry a phone and says nothing about the rest, and a page built on it has to
say so rather than implying the roster is now clean.

Bolt has no phone in `driver_platform_state` at all; Bolt records reach Uber
transitively, because Bolt and the hotel channel file the same full name and
the existing name fold already joins those two.

---

## Known holes, with owners

| what | state | needs |
|---|---|---|
| Bolt Ecosine roster | `BOLT_CLIENT_ID is not entitled to company_id 142868` — the same token reads 142897 (Egari), so the secret is fine | the fleet-integration app in the Bolt portal to be granted 142868 |
| Yango Ecosine | `YANGO_PARK_ID` → HTTP 403 (401 without a cookie) | park entitlement |
| Uber fares, Apr–Aug 2025 | 60–97% — **recoverable**, and this row said "permanently" until 2026-09-05 | a retry that keeps the reportId: eight weeks Uber generated and we timed out downloading, inside retention, re-failed every Sunday because the failure is not checkpointed |
| Uber "offline payment" trips | tracked, unexplained | Uber documentation |

---

## Traps that have cost time more than once

* Backticks inside a JS template literal, and backticks inside a bash heredoc —
  both silently break, differently.
* A raw `DATE` from node-postgres stringifies as `"Sat Aug 01"`, not
  `"2026-08-01"`. Use `String(d).slice(0, 10)` only after checking which it is.
* `CREATE OR REPLACE VIEW` can add a column but never remove one. Rename the
  view instead of editing an earlier migration — the ledger skips unchanged
  shas, so editing v23 later silently reverts the fix.
* Tests pinned to a literal source spelling break on refactors that do not
  touch the invariant. Pin the PROPERTY, and derive the list from the one place
  that enumerates it. `collector_invariants` has been broken this way twice.
* The production API caches. Append `&_=$RANDOM`.
* Chromium in this sandbox has **no route to the internet**. Use
  `bin/prod-mirror.mjs` (:8200, production bytes) or `bin/live-ui.mjs` (:8100,
  working tree against production data), and pass
  `executablePath: '/opt/pw-browsers/chromium'`.
* `pkill -f "node test/…"` **matches its own command line**, so `until ! pgrep
  -f …` never fires and a `pkill` can kill the shell issuing it. Wait on the
  output file's tally line instead.
* A python heredoc and a test run in one backgrounded command are **two
  commands**. A failed `assert` prints a traceback nobody reads and the suite
  then passes against the unchanged file. This has produced a false "fixed"
  claim twice. Verify the edit landed (`grep` the file) before believing a
  green run.
* Two suite runs writing to one output file clobber each other and lose whole
  blocks of results. Check `ps` for a live `run-all.mjs` before starting one.
* `new URL(u).host` carries the **port**; `.hostname` does not.
* An express fixture that promises a `content-length` it never sends poisons the
  keep-alive socket for the *next* request — a fixture bug wearing a product
  bug's clothes, one run in three.
* `/api/driver/day` derives its position feed from **that day's trips**
  (`api/driver_routes.js`), so a driver with zero trips gets `fixes: 0` — which
  is exactly the cohort any "online but idle" question is about. Take the plate
  from `driver_standing` instead.
* Online spans are **clipped to the Dubai day**, so a shift that began 23:43 the
  night before reads as `00:00`. Never print that as a start time; read the
  un-clipped ONLINE transition.
* `put()` in `src/insights.js` arbitrates a fleet row on
  `(code, entity_type, entity_id)`. If `entity_id` is a constant, every row
  overwrites the last and **the oldest in the batch survives** — and two fleets
  silently replace each other. Has happened twice: `tracker_feed_dark`, then
  `drivers_online_no_trips`.
* Charts are drawn at the host's measured width (`chartBox()` in
  `api/public/charts.js`). A fixed `viewBox` stretched by CSS scales the TEXT
  too — it was 1.514× on a 1440px window and 0.44× in a narrow column.
* A chart's y-axis formatter is **not** its tooltip formatter. `valueFmt` is the
  tooltip; `axisFmt` is the axis. One serving both put "10 bookings" on every
  gridline, 28px outside the panel.
