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

## How many cars are there? 138 — measured over all 273 plates, 2026-09-07

The operator's standing question: "the L plate can be multiple, but VIN number
is unique. We do not have 273 cars."

Every one of the 273 plates in `/api/vehicles/directory` was fetched through
`/api/vehicle/profile?plate=` and cross-referenced against its own directory
row. No sampling, no errors, 273 of 273.

| | plates | bookings | telematics journeys |
|---|---|---|---|
| **VIN, and it has worked** | **138** | 364,184 | 222,415 |
| no VIN, has old bookings | 3 | 1,052 | 0 |
| no VIN, never seen at all | **132** | 0 | 0 |

**The fleet is 138 cars.** The 132 with neither a VIN nor a single booking nor a
single telematics journey are the CABMAN phantoms recorded as C18 in
`docs/FIXLIST-2026-09-05.md` — plates that entered on three historical polls,
produced one fix each, and have been counted as live fleet ever since. The
three remaining are cars that left before Uber's vehicle profile was collected:
their last bookings are 2025-05-01, 2025-09-03 and 2025-11-09.

### The VIN does not deduplicate — it identifies

The hypothesis was that one car wears several plates and the VIN would collapse
them. It does not, on the data we hold: **138 plates carry a VIN, there are 138
distinct VINs, and not one appears on two plates.** Plate to VIN is 1:1 across
the whole covered half.

What the VIN turns out to be is an almost perfect answer to a different and
more useful question — *is this row a car at all*:

* every plate with a VIN has work (138 of 138);
* every plate with work today has a VIN;
* 132 of the 135 without one have never been seen doing anything.

So "has a VIN" is a cleaner fleet-membership test than any activity window, and
it is one a page can state in a sentence.

### Where the VIN comes from, and the half that has none

All 138 come from Uber's vehicle profile (`vehicle_profile.vin`, read through
`coalesce(v.vin, vp.vin)` at `api/vehicle_routes.js:661`). No other channel has
supplied one: the count by source platform is `{uber: 138}`. The fleet is 68
Tesla Model Y, 45 BYD Han EV, 11 Polestar 4, 10 Tesla Model 3, 2 Lexus ES and 2
Toyota Highlander.

That means VIN coverage is exactly Uber's vehicle roster. A car Uber does not
list would have no VIN and would fail the membership test above however busy it
is — worth re-measuring before the test is used to exclude anything, because
today the two sets happen to coincide and that is a fact about this fleet.

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

### What was built for it, and where it stops

`src/identity_link.js` recomputes the links on every collector run and writes
them to `driver_identity_link` (sql/schema_v65.sql) with the evidence that
decided each. It fails closed: a number on three records links nobody, and
neither does one that appears twice inside a channel — both identify a handset
rather than a person, and being wrong in that direction merges two people's
work and money, which is not a mistake a page can help a reader notice.

`api/identity_links.js` applies them at the API boundary, in this precedence:

    the register (a person checked it)  →  the roster link (a rule ran)
      →  the stored person_key  →  the folded name

A rejection recorded by an operator survives every later run, and a REFUSED
pair never enters the table at all.

**Where it stops, and this is the part a finance figure depends on:** a link
folds the driver directory and the driver pages. It does **not** move
`person_key`, which is a stored generated column over 364,015 rows built from
`api/identity_map.js`, so every rollup, statement fold and money surface still
counts the two records apart. `bin/promote-links.mjs` prints the unpromoted
links as register entries for a human to review; pasting them in and running
`bin/gen-schema-v53.mjs` is what moves the stored column. `#identity` prints
this distinction rather than implying the fold is complete, and
`/api/drivers/identity-links` marks each row `promoted` so the two kinds are
not read as one.

### The register as it stands — 2026-09-07

`api/identity_map.js` now applies **93 entries over 90 people**, from three
sweeps that are kept apart in the file because they are believable for three
different reasons:

| sweep | entries | what decided each |
|---|---|---|
| hand-checked, 2026-09-03 | 3 | shared plates, interleaved custody days, the gap between one record handing a car to the other |
| shared history, 2026-09-05 | 45 applied (+5 held back) | same cars, same days, trips interleaving **inside** the day rather than following one another |
| shared phone, 2026-09-07 | 45 | one phone number the roster filed against both records |

Twenty-six people were found by BOTH the custody sweep and the phone sweep,
independently — which is the strongest reason to believe either — and the
phone list carries only the forty-five the custody list did not already hold.
Three people are on the list twice, once from each sweep: that is one person
with three or four records, not two pairs, and `mergedIds` unions across every
entry on the key rather than taking the first (it took the first until
2026-09-07, so opening Aliyan khalil's Uber record found his Yango work and
not his Bolt standing).

**The five held back** carry a CONTRADICTION — a day on which both records
took a trip at the same time in different cars — and two of the five also
share a phone. When a shared phone and a simultaneous trip disagree, the
records stay apart: merging two humans' work and money is the mistake no page
can help a reader notice.

Measured over the 395-row directory fixture (`test/fixtures/roster_395.json`,
production on 2026-09-03): the register joins **72 groups** and takes the
distinct-people count from **395 to 322**. The other 18 people have a second
record that has never filed a trip — 56 of the register's 130 alias ids are
Bolt standings and hotel ObjectIds carrying a phone and no work — which is
precisely why no name fold could ever have reached them.

### Promoting a link — 2026-09-07

`bin/promote-links.mjs` now does the whole transcription:

    node bin/promote-links.mjs            # print the entries, change nothing
    node bin/promote-links.mjs --count    # how many are waiting
    node bin/promote-links.mjs --write    # append them and regenerate the SQL

`--write` appends to `FROM_ROSTER` and runs `bin/gen-schema-v53.mjs`. The
register's guard runs at IMPORT, so a batch that would merge a refused pair,
move a key or map one record onto two people throws there and the schema is
never regenerated. **Read the printed entries first** — the tool does the
typing, not the deciding.

Three rules it exists to get right, all of which were got wrong by hand first:

* **The survivor is the register's, not the rule's.** `identity_link.js` picks
  the fuller name, which is right when neither record is known and wrong the
  moment one of them is an entry — the rule proposed "Raja Khalil Ahmed Raja
  Nouman Khalil" as the survivor of a man the register files as "Raja Nouman
  Ahmed", which would have moved a key every stored row carries.
* **A pair somebody has ruled on is not re-raised.** `identity_link.js`
  honoured `REFUSED` and not `PENDING` — and PENDING is not "nobody has looked
  yet", it is *verified and deliberately not applied* over a simultaneous trip
  in two cars. Two of the five share a phone, so the rule proposed one of them
  (Tariq Afzal) the day the Yango roster landed. Fixed at the rule, with the
  tool as a second net.
* **It refuses to write rather than guess.** If it cannot find the end of
  `FROM_ROSTER` exactly, it exits non-zero and writes nothing.

The register went **93 entries over 90 people → 130 over 124** on 2026-09-07,
which is the 37 the Yango roster's phone numbers made reachable.

**A promotion is one-way from the links page.** Rejecting a promoted link
takes it off `#identity` and leaves the two records folded, because the fold
now lives in the stored column. Undoing one means editing
`api/identity_map.js` and re-running `bin/gen-schema-v53.mjs`.

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

### Yango has a second door, and it does not want a cookie — measured 2026-09-07

`fleet.yango.com` is the web console and wants a Yandex session. It has
answered **403 with an HTML page from a CDN edge** since 2026-09-06 — and
every Yango *API* refusal is JSON, so the HTML is something in front of the
API, not the API. The park is provably right: `/api/fleet/ui/v1/parks/users/
profile` returns 200 and names "ECOSINE TRANSPORTS LLC". The same call
answers **401 with the cookie removed**, and from one origin that pair is
unreachable unless an edge is doing the refusing.

`https://fleet-api.yango.tech` is a **different product** — Yango's own Fleet
API, keyed rather than cookied. The `YANGO_API_KEY` we already store opens it:

| header | value |
|---|---|
| `X-API-Key` | the stored `YANGO_API_KEY` |
| `X-Client-ID` | `taxi/park/<park id>` — **this exact shape**; the bare park id and `fleet/<park id>` both get `403 invalid client id or api key` |

Measured from production, no cookie anywhere:

| path | | |
|---|---|---|
| `POST /v1/parks/driver-profiles/list` | **200** | 145 drivers |
| `POST /v1/parks/cars/list` | **200** | 104 cars, **with VINs** |
| `POST /v1/parks/orders/list` | **200** | trips, cursor-paged |
| `POST /v1/parks/transactions/list` | 404 | `path_not_found` |
| `POST /v1/parks/transactions/categories/list` | 404 | `path_not_found` |
| `POST /v1/parks/summary/drivers/list` | 404 | `path_not_found` |

`/api/probe/yango/keyapi` re-measures all of this on demand and returns the
field names two levels deep. Run it before writing any mapper.

**The shapes differ from the console's.** This host nests what
`/api/reports-api/v1/orders/list` kept flat:

| trip column | console field | key API field |
|---|---|---|
| `driver_ext_id` | `driver_id` | `driver_profile.id` |
| `driver_name` | `driver_full_name` | `driver_profile.name` (same single string, same word-order trap) |
| `plate` | `car_license_number` | `car.license` (object) — `car.callsign` is the reliable fallback |
| `pickup_addr` | `address_from` (string) | `address_from.address`, with `.lat`/`.lon` beside it |
| `dropoff_addr` | `address_to` | last of `route_points[].address` |
| `distance_km` | `mileage` (number) | `mileage` (**string**) |
| `price` | `price` (number) | `price` (**string**) |
| — | — | `events[]` = `{event_at, order_status}`, the per-order status trail |

`driver-profiles/list` gives the **decomposed** name (`driver_profile.
first_name` + `last_name`) that the word-order fix needs, plus
`driver_profile.phones[]`, `driver_profile.driver_license`,
`current_status.status`, `accounts[].balance`, and `car.vin`.

**What it is now wired to, as of 2026-09-07.** `src/sources/yango.js` reads
three surfaces from `fleet-api.yango.tech` (trips, roster, cars) and still
*asks* the console for the other two every run, so a recovery is noticed
rather than waited for. The paths live in one exported object,
`YANGO_SURFACES`, which `src/credcheck.js` imports — the two files used to
spell the same literal, and the day orders moved the check was left testing a
surface nothing collects from.

Three things the key host gives that the console never did:

* **VINs, from a second independent source.** `cars/list` returns 104 cars with
  `vin`. Until now `src/sources/uber_fleet.js` was the *only* writer of
  `vehicle_profile`, so every VIN this product holds had been checked against
  nothing.
* **The decomposed name, without a cookie.** `driver-profiles/list` gives
  `first_name` and `last_name` separately — the fix for one Yango driver
  arriving as two people — from a host that needs no session.
* **Phone numbers.** The roster pull writes `driver_compliance`, which the
  console path never did, so `src/identity_link.js` can now see Yango drivers
  at all.

**What the key API cannot replace.** The weekly per-driver aggregate
(`driver_performance`) and the payment ledger (`ledger_entry`) have no
endpoint on this host. The aggregate could be recomputed from the orders —
except that `price_platform_commission` is not in an order, so the earnings
would be **gross**, which is the exact defect
`src/sources/yango.js` was fixed for (Yango's commission is ~24%: Aliyan
Khalil, August 2026, gross 3,069.00 against -749.58). Do not synthesise it.
Those two stay absent with a reason until the console session works again.

---

## Known holes, with owners

| what | state | needs |
|---|---|---|
| Bolt Ecosine roster | `BOLT_CLIENT_ID is not entitled to company_id 142868` — the same token reads 142897 (Egari), so the secret is fine | the fleet-integration app in the Bolt portal to be granted 142868 |
| Yango Ecosine, console | `fleet.yango.com` → HTTP 403, an HTML page from a CDN edge; 401 with the cookie removed. NOT the park: `parks/users/profile` returns 200 and names the company | a session Yango's edge will accept — or nothing, for the two surfaces below |
| Yango weekly driver aggregate + payment ledger | no endpoint on `fleet-api.yango.tech` (404), and the orders carry no commission field, so recomputing them would report **gross** as net | the console session, or a Yango endpoint that has them |
| Yango trips, roster, cars | **not a hole any more** — `fleet-api.yango.tech` answers all three with the stored key and no cookie | the collector repointed at it |
| Uber fares, Apr–Aug 2025 | 60–97% — **recoverable**, and this row said "permanently" until 2026-09-05 | a retry that keeps the reportId: eight weeks Uber generated and we timed out downloading, inside retention, re-failed every Sunday because the failure is not checkpointed |
| Uber "offline payment" trips | tracked, unexplained | Uber documentation |

---

## Cars: what the register actually holds — measured 2026-09-07

`vehicle_profile`'s primary key is `(platform, vehicle_ext_id)`, with only a
non-unique index on `plate`. Two consequences, and both were live:

**One car can be several rows, and one plate several vehicle records.** Uber
files **222 vehicle_ext_ids across 138 plates**. `api/analytics_routes.js`
joined `vehicle_profile` on the normalised plate *inside* an aggregate, so
every plate with two Uber records had its trips, completed count, premium
count and kilometres **doubled** — before Yango wrote a single row. Proven by
construction in `test/vehicle_identity.test.mjs`: five trips report 10 and
100 km through the old join, 5 and 50 through the view.

**`sql/schema_v66.sql` adds the view `vehicle_plate`** — one row per plate,
every scalar the first non-null in the order uber, yango, then alphabetically,
plus `platforms` and `profile_rows`. It **coalesces rather than picks**,
because the channels are complementary: Uber has the image and the compliance
status, Yango has a VIN for cars Uber has none for. Four read routes were
repointed at it (`vehicle_routes` ×2, `cohort_routes`, `economics_routes`) and
`analytics_routes` gets a `DISTINCT ON` over it, because that join normalises
the plate and the view is keyed on the raw one.

**Read `vehicle_plate`, never `JOIN vehicle_profile ... ON plate`.** The test
finds offenders by regex across `api/*.js` rather than listing them, so a fifth
file is covered without editing it.

### The second opinion, measured on production 2026-09-07

With the Yango collector reading `fleet-api.yango.tech`, `vehicle_profile`
finally has two writers. Over all 273 plates:

| | |
|---|---|
| plates with a VIN | **138** — the figure that was established by hand, now a column |
| distinct VINs among them | **138** |
| plates with no VIN from anybody | 135 |
| VIN filed by Uber only | 51 |
| VIN filed by **both** channels | **87** |
| …of which the two channels **agree** | 46 |
| …of which they file **different** VINs | **41** |

**Do not read those 41 as 41 re-plated cars.** Yango's own VIN column is
internally inconsistent: `/api/schema/raw-fields?table=vehicle_profile&platform=yango`
reports **104 car rows carrying 58 distinct VINs**, so Yango is already
reusing a VIN across its own cars before Uber is consulted. Uber's 138 are
1:1 with their plates. So the disagreements are far more likely Yango's data
than the fleet's plates moving, and `vehicle_plate` prefers Uber's value for
exactly that reason.

The page says what is known and no more: a disputed plate is drawn as a
disagreement, with "either the plate moved between cars or one of them is
wrong, and nothing here can say which". Settling the 41 needs a third source
— the registration document — not another provider's feed.

### The claim that could not fail

"138 plates, 138 distinct VINs, not one VIN on two plates" was reported as
evidence against re-plating. It is not evidence of anything: each
`vehicle_profile` row carries one plate and one VIN, so one-to-one is
guaranteed by the primary key. The **138 VINs are real**; the *inference* was
not. What can now settle it is the second source — a car both channels file is
a car two providers name the same way — and the VIN is a column on
`/api/vehicles/directory`, with a "Cars, by VIN" tile beside the plate count
and the number of plates carrying no VIN stated rather than implied.

---

## Places: who gives a name, who gives a position — measured 2026-09-07

Nobody gives both. Counted on production through `/api/coverage`:

| dataset | rows | with a coordinate | with an address |
|---|---:|---:|---|
| `trip:uber` | 315,505 | **0** | yes, on effectively all |
| `timeline:uber` | 197,687 | **0** | n/a |
| `trip:fms` | 222,543 | **222,543 (100%)** | yes, beside every fix |
| `trip:bolt` | 48,382 | 0 | no |
| `trip:hotel` | 1,786 | 1,234 (69%) | yes |
| `trip:yango` | 50 | 11 (22%) | yes |

Two consequences, and both shape how the driver page answers "where".

**Uber's driver timeline has a `lat`/`lon` column and it is null on all 197,687
rows.** `src/sources/uber_timeline.js` asks for `rootLocation { latitude
longitude }` in the GraphQL query and Uber accepts the field without ever
filling it. So the obvious answer to "where did this person go online" — the
coordinate on the ONLINE transition — does not exist. `/api/driver/day` reads
the position from the tracker in the same car, at the fix nearest in time to
the transition, and reports how many minutes away that fix was. Beyond thirty
minutes it returns no place and says why, rather than borrowing a stale one.

**The gazetteer is the fleet's own history, not a geocoding service.** FMS is
the telematics box in these cars and it reverse-geocodes every fix it reports,
so 222,543 trips arrive with two labelled endpoints each. `src/places.js` folds
those pairs into `place_cell` (sql/schema_v67.sql): one row per ~0.5 km cell
holding the modal area name, the votes for it, and the votes cast. It covers
exactly the roads this fleet drives, and every name it returns already appears
on a trip in this database — so a place on the driver page and the same place
on the Territory tab cannot be spelled two different ways. It cannot name a
coordinate the fleet has never driven near, and it says so rather than reaching
for the nearest thing it has.

`refreshPlaceCells()` runs once per collector pass, after the pulls and before
the rollups, and rebuilds the table whole. A merge would be wrong: it cannot
express a name *losing* a vote, so an address corrected upstream would leave
the old name outvoting its own replacement for ever.

### What counts as the area in an address

Every provider returns the same dash-separated shape, most specific first,
ending in city then country. The area is the **third segment from the end**,
which is `place_area()` in sql/schema_v67.sql. Measured against real production
strings, against what the read API used to do (the second segment from the
front):

| address | third from end | second from front |
|---|---|---|
| `Cluster T - Al Thanyah Fifth - Jumeirah Lakes Towers - Dubai - UAE` | Jumeirah Lakes Towers | Al Thanyah Fifth |
| `4538+544 - Al Falak St - Al Safouh Second - Dubai Internet City - Dubai - UAE` | Dubai Internet City | **Al Falak St** — a street |
| `Sheraton Hotel, Mall of The Emirates - Level 2 - … - Al Barsha - Dubai - UAE` | Al Barsha | **Level 2** — a floor |
| `Al Thanyah Second - Dubai - United Arab Emirates` | Al Thanyah Second | **Dubai** — the emirate |

Counting from the end is also the only version that survives an address that is
not in English, and a real share of them are not:

    Boulevard Street - برج خليفة - Burj Residence Phase I & II - دبي - 阿拉伯联合酋长国

A rule that recognises "Dubai" and "United Arab Emirates" by name drops that
row entirely. Position does not care what alphabet the city is written in.

Fewer than three segments means there is no area in the string — `Mall of
Emirates Al Barsha 1 AE` arrives with no separators at all — and that is NULL,
reported as unnamed rather than guessed at.

Two corrections after the first gazetteer was built and looked at
(sql/schema_v68.sql), both found by reading the names it produced:

* **Blank segments are punctuation and are dropped before counting.** FMS emits
  runs of them, and counting from the end over the raw split walks straight
  past the community that is sitting in the string:
  `45HMWX6 - Madinat Jumeirah -  1 -  - United Arab Emirates,` resolved to
  `1` — 69 of one driver's 222 fixes on a single day.
* **A candidate carrying a digit, no lowercase letter and no space is a code,
  not a community**, and so is a bare number with or without a road letter in
  front of it. `57VWG8`, `3583+3W3`, `D71`, `E 11`, `9`. Those return NULL, so
  the observation leaves the gazetteer entirely and the *second* most voted
  name in that cell — usually a real one — wins it. A cell with no nameable
  candidate stays unnamed.

The filter is deliberately loose about what it keeps: `Sheikh Zayed Rd` is a
street rather than a community, but it is a place a person can picture, and a
true coarse answer beats no answer. Only codes and bare numbers are refused.

Measured on production 2026-09-07, the first build under the v67 rule:
**4,855 cells, 709 distinct names, 410,627 observations**, naming 221 of one
driver's 222 tracker fixes.

## Traps that have cost time more than once

* **A migration that DROPs a column fails on production and passes in the
  tests, because the tests build a fresh database.** `sql/schema_v53.sql` drops
  and re-adds `person_key`; `sql/schema_v62.sql` defines `trip_ext` as
  `SELECT t.*` over `trip`, so the view depends on that column. On a fresh
  replay v53 runs at 53 and the view is created at 62 — nothing blocks it. On a
  database that already exists, every view is already there and the drop is
  refused. It failed on **every boot since v62 shipped**, the ledger does not
  record a failed file so nothing accumulated, and the stored `person_key`
  quietly stayed on an old register while `api/identity_map.js` grew to 130
  entries in front of it. **The pages folded; the money did not.**
  The fix reads the dependent view definitions out of `pg_get_viewdef()`, drops
  them, rebuilds, and recreates them — no second copy of any view, and a view
  added tomorrow is handled by the same code. Dropping them and leaving a later
  file to recreate them does NOT work: the ledger skips a file whose sha it has
  seen, so that file never runs again.
  **Test a migration against the production SHAPE, not a fresh database.**
* Backticks inside a JS template literal, and backticks inside a bash heredoc —
  both silently break, differently. **Hit again 2026-09-07**: a prose comment
  written *inside* a SQL template literal quoted `const [spec] =` in backticks
  and took `api/vehicle_routes.js` down with `SyntaxError: missing ) after
  argument list`, pointing at a line 200 characters away. Comments inside a
  template literal are still inside the literal.
* **A shared placeholder detector is diluted by a second channel.** The
  compliance page decides a licence date is "a default, not a date" when one
  value covers >=50% of the dated rows. That was measured fleet-wide, so the
  94 hotel placeholders (94 of 94) would have fallen to 94 of 239 the moment
  Yango filed 145 real dates — the detector silently stops firing and 94 rows
  begin rendering as real expiries, with `src/insights.js` raising "stand the
  driver down" for each. **A default is a property of a FEED**: scope the share
  to the channel the mode came from. Same for the licence number.
* **A rule that fails closed still fails open if nothing withdraws its old
  answers.** `src/identity_link.js` skips a phone on three records — but only
  ever INSERTed, so a pair linked while the number sat on two records stayed
  linked once a third appeared. Any new channel that files phone numbers
  creates exactly that. It now deletes links the run no longer produces,
  sparing the ones a person rejected or confirmed.
* **`rowCount` (node-postgres) vs `affectedRows` (PGlite).** A count read off
  one is `undefined` under the other — so a guard passes in the tests and
  reports nothing on production. Use `RETURNING` and count the rows.
* **`JSON.stringify(x).slice(0, N)` into a JSONB column is a time bomb.** A
  sliced JSON string is not JSON: Postgres answers `invalid input syntax for
  type json` and the whole batch rolls back, so one oversized record costs
  every row beside it. `rawJson()` in `src/roster.js` stores the record whole
  or a small object saying how big it was — never a fragment.
* `array_remove(array_agg(...), NULL)` removes NULLs and **not empty strings**,
  so a provider filing `''` beats a real value from another channel in a
  coalesce. `nullif(btrim(x), '')` inside the agg.
* A `LEFT JOIN` inside an aggregate does not just add rows to the output — it
  multiplies the rows the aggregate is computed over. A join that looks
  harmless because the query `GROUP BY`s afterwards is the most dangerous kind:
  the row count looks right and every `count(*)` and `sum()` is wrong.
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
* **Both services run `migrate()` on boot, and a deploy starts them together.**
  `src/index.js:20` and `api/server.js:5533`. That was free while every file was
  additive — two processes racing `CREATE TABLE IF NOT EXISTS` cost nothing. It
  stopped being free the moment `schema_v53.sql` began dropping nine views,
  rebuilding six generated columns and putting the views back: the two boots
  took locks on the same objects in different orders and Postgres killed one
  with `deadlock detected`. The killed file is not recorded, so the next boot
  did it again. `src/db.js` now takes `pg_advisory_lock` on a client checked out
  of the pool — *checked out*, because a session lock taken through `pool.query`
  is released the moment that query's client goes back to the pool, which is no
  lock at all. It **waits** rather than using `pg_try_advisory_lock`: a service
  that skipped migrations to avoid a wait would go on to serve against a schema
  it had not applied.
* **A test written only as a negative passes against the unfixed file.**
  `!/pg_try_advisory_lock/.test(src)` was meant to prove the migration lock
  blocks rather than gives up. A `db.js` with no lock at all also contains no
  `pg_try_advisory_lock`, so it was green before the fix and green after, and
  proved nothing either time. Caught by the house rule — revert the fix and
  watch the test go red; three of the four went red and this one did not. Assert
  the thing is *present* in the shape you want, not merely that the wrong shape
  is absent.
* **A lock wait is a statement, so `statement_timeout` cancels it.** The pool
  arms every session with 120s (`poolConfig` in `src/db.js`). `pg_advisory_lock`
  blocks, and Postgres cancelled the *wait* at two minutes; the `catch` around
  it swallowed the cancellation and the boot carried on without the lock —
  which is precisely the fail-open the lock was added to prevent. It is
  invisible in the log unless you subtract durations from timestamps: on
  2026-09-07 the API ran `schema_v53.sql` from 15:09:00 to 15:11:02 and the
  collector started its own copy at 15:10:59.94, two seconds before the API
  committed. Raise `statement_timeout` on the migration session *before*
  reaching for the lock, and never swallow a failure to take it.
* **A table that has just been rewritten has no statistics at all.** Re-adding
  a generated column rewrites the heap, and Postgres does not sample the result
  — it waits for autovacuum, which on `basic-xxs` is a long wait. Every plan
  over `person_key` was then costed against a table the planner believed was
  empty: `/api/kpis` over the full window went from about a second to 48, on
  unchanged SQL and unchanged data. `ANALYZE` at the end of the migration costs
  single-digit seconds against a two-minute rewrite. `VACUUM` cannot go there —
  `pool.query()` sends a multi-statement file as one implicit transaction and
  `VACUUM` is illegal inside one — so the bloat from a rolled-back concurrent
  rewrite is left to autovacuum.
* **A test that greps a file for a forbidden word finds it in the comment that
  explains why it is forbidden.** `!/\bVACUUM\b/` on `schema_v53.sql` failed
  against the *fixed* file, because the fix documents why `VACUUM` is absent.
  Strip `--` comments before scanning SQL for what must not be in it.
* **A provider that accepts a field is not a provider that fills it.** Uber's
  driver timeline takes `rootLocation { latitude longitude }` in the GraphQL
  query, returns 200, and leaves lat null on all 197,687 rows on production.
  The column existed in our schema for months and nothing read it, so nothing
  noticed. Before building on a field a provider "supports", count how many
  rows actually carry it — `/api/coverage` exists for exactly this.
* **The second dash-separated segment of an address is not the area.** It is a
  street on a six-segment address, a floor of a hotel on a seven-segment one,
  and the emirate on a three-segment one — and all three were rendered under
  the heading "area" on the Territory tab and in the corridor analytics. The
  area is the third segment from the END. Counting from the front also breaks
  on the addresses whose city and country come back in Arabic or Chinese;
  counting from the end does not care.
* **A rebuild on every collector pass is a rebuild forty-eight times a day.**
  The gazetteer scans both endpoints of every positioned trip — 445,000 rows
  and growing — and the collector's incremental runs every thirty minutes. On
  a one-vCPU managed Postgres shared with every dashboard query, that is the
  kind of statement that grows into the pool's two-minute timeout while
  relearning a map of Dubai that changed by a few cells.
  `refreshPlaceCells()` skips a table younger than `PLACE_CELL_MAX_AGE_HOURS`
  (6), and always builds an empty one so a fresh database is named on its first
  pass. Ask what a derived table is a map OF before deciding how often it needs
  rebuilding.
* **A derived table built by a rule the rule then changes must be emptied by
  the migration that changes it.** `place_cell` is guarded by a six-hour
  freshness check, so correcting `place_area()` in sql/schema_v68.sql would
  have left production serving names built by the old rule until the guard
  expired — long after the deploy "succeeded". The migration ends with
  `DELETE FROM place_cell`, because `refreshPlaceCells()` always rebuilds an
  empty table whatever its age.
* **A window bound widened to 23:59:59.999 is not a whole day, and rounding it
  makes one.** `win()` in `api/driver_routes.js` widens the upper bound so a
  timestamp comparison catches the whole last day. Differencing that against a
  bare lower bound gives 0.99999 of a day, and
  `Math.round(diff / 86400000) + 1` — the usual inclusive day count — turned
  that into TWO days for a one-day window, eight for a week, thirty-one for a
  month. It was invisible while the value was only passed to `coverage()`,
  where it is merely the fallback base for a channel with payouts and no
  bookings; it became obvious the moment the figure was returned to the client.
  Truncate both bounds to their date before differencing. Returning an internal
  figure to the page is a cheap way to find out whether it was ever right.
* **`accounted_fares` being null does not mean there are no fares.**
  `fleetIncome` picks ONE basis per channel so a fare and the payout that fare
  became are never summed, so `accounted_fares` is null whenever every channel
  in the window was counted on its payout — while `revenue` in the same
  response holds what the trip feed priced. The Fares tile read the null as
  "there are none" and printed a sentence saying so: measured on production
  2026-09-06, 70 of the 87 drivers who worked that day were shown "no trip
  carries a fare and no statement reports one" over AED 24,731.32 of fares on
  415 priced bookings. Suppressing a figure and denying it exists are different
  things.
* **`driver_payout_day.earnings` is a period divided by its days**
  (`sql/schema_v23.sql:61`), exactly like the `hours_online` column this
  codebase already refuses to sum. Over a window containing whole periods it is
  exact — the seven days of a week sum to the week to within two fils — but a
  window narrower than a period holds a SHARE, spread evenly across days nobody
  worked evenly, and a tile calling that "paid out" is naming a payment that
  never happened on that day. `/api/driver/kpis` returns `payout_period_days`,
  `payout_periods` and `window_days` so the caption can tell the two apart.
* **`String(v).slice(0, 10)` on a pg DATE gives "Tue Oct 0".** node-postgres
  hands a DATE back as a JS Date, and `String(new Date())` is
  `"Tue Oct 01 2026 00:00:00 GMT+0400"` — so the usual ISO-day slice silently
  produces a weekday. `test/driver_day_keys.test.mjs` bans the shape in
  `api/driver_routes.js` outright and caught the window-length fix above on its
  first full run, even though both of that fix's inputs are query-string text
  today and it would have worked. Use `isoDay()` from `src/sources/ledger.js`,
  which takes a string or a Date. A guard that holds only while nobody changes
  where a value comes from is not a guard.
