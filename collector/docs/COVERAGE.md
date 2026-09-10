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
* **`WHERE next_at IS NOT NULL` over a `lead()` deletes the newest fact.** Uber
  sends ONLINE as a repeated heartbeat and stops sending it while a driver is on
  a job, so the span with no successor is the one belonging to somebody
  currently working. It was in four of the five places that built a span and it
  cost 125 driver-hours in one day; `api/online_span_sql.js` is the one
  definition now. Before writing a span from an event stream, check whether the
  opening event is a TRANSITION or a HEARTBEAT.
* **An open interval must not be closed at `now()` when the collector's clock
  is behind it.** Repairing the above by running the last ONLINE to `now()`
  swaps one invention for another: everything between the last collection and
  now becomes availability nobody asked about. Close an open interval at the
  earliest of now, the grain being drawn, **and the last successful run of the
  feed that would have told you otherwise** — and carry out which bound it was,
  because "still running" and "we stopped asking" are opposite claims that look
  identical on a chart.
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
* **A bare `::int` cast rounds in Postgres, and every other minute-of-day
  figure in this codebase floors.** `/api/driver/day`'s online spans cast
  `extract(epoch …)/60` straight to int, so 08:34:46 rendered as minute 515;
  `collected_to_min` uses `floor()`, `last_event_min` is `hour*60+minute`, and
  `api/online_routes.js`'s `minsInto` is `h*60+m` — all floors. The Online Time
  page therefore said a driver went online at **08:34** while the driver-day
  band drew **08:35** for the same event, on two pages, for months. It became
  a same-page contradiction the moment `closed_by: 'collection'` asserted the
  band's right edge IS the collection reach: measured on production
  2026-09-10, a run finishing 13:17:52 gave a band ending 798 (13:18) beside a
  caption reading "last reached 13:17". `collected_to_min` is the figure that
  cannot move — rounding it up claims we asked Uber about seconds we did not —
  so the spans floor. A minute of the day is the minute an instant falls IN.
  **Residual, and it is inherent:** a band drawn on a minute grid can be up to
  a minute wider than the duration it represents (514→617 draws 103 for
  102.23 real minutes, and `driver_day.online_min` correctly stores 102). No
  surface prints both — `cohort.js` renders `online_min` in hours — but a
  future one must not put them side by side without saying which is which.
* **A fixture that redraws on every request cannot certify agreement between
  two surfaces.** `mockapi.mjs`'s `/api/trips/daily` built its series inside the
  handler with unseeded `Math.random()`, so two calls seconds apart returned 66
  and 80 for the same day. The phone Today screen reads that endpoint TWICE per
  render — once for the claim, once for the chart — so the screen disagreed
  with itself off the fixture alone, recreating the exact production bug
  `api/public/m/screens.js:265` fixed and documents ("68 and 56 for the same day
  on the same screen. One today per screen"). Any test comparing two surfaces
  against such a fixture is a coin flip wearing an assertion's clothes. Measured
  2026-09-10: production's `/api/trips/daily`, `/api/day` and `/api/kpis` all
  said **247** for today; the mock said **65**, **215** and **2,043** on one
  render. The series is now built once per Dubai day from a deterministic
  wobble, and `TODAY` is written down once for every endpoint that speaks about
  it.
* **`mockapi.mjs`'s `/api/kpis` ignores `from`/`to` entirely** — it takes `req`
  and never reads it, answering at the thirty-day scale whatever window it is
  asked for. On a today-only window the phone sub-line therefore reads "2,043
  across 56 drivers and 52 vehicles" beside a claim of 215 bookings today. The
  real endpoint honours the window (`api/window.js` exists for exactly this),
  so the mock is the thing that is wrong. **Not yet fixed** — every windowed
  figure in that constant would have to scale together, and it is a wider change
  than the one it was found inside. Anything asserting a windowed KPI against
  the mock is asserting nothing.
* **"Something is answering on the port" is not "that server can serve today".**
  `test/run-all.mjs` adopted whatever was listening on :8099 on the strength of
  `GET /api/kpis?days=1 → 200`. `test/preview.mjs` mounts the SAME real
  handlers and defaults to the SAME port, and seeds `2026-08-01`..`2026-08-31`
  hard-coded — so it answers that probe perfectly and every today-only window
  reads an empty day. `phone_today_only.test.mjs` reported two failures against
  a product that was correct, and the search went into the product before it
  went into the port. Probe a server for the DATA the tests need, not for a
  pulse; `run-all.mjs` now asks `/api/trips/daily` about today and, if the
  answer is empty, leaves the squatter alone and starts its own mockapi on a
  kernel-assigned port.
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
* **A tile that suppresses part of a figure must caption the part it kept.**
  `faresTile` has three branches and each one had the same defect, found one
  at a time over three commits: branch 3 denied fares that `revenue` carried,
  branch 2 denied them over 1,881 priced bookings, and branch 1 captioned a
  single channel's total with `avg_fare` — the average over EVERY priced
  booking in the window. Measured on production 2026-09-01..09-07: "AED 311 ·
  avg fare AED 51", where the 311 is 5 Bolt bookings at AED 62 and the 51 is
  4,359.11 over 86 across three channels. Ten of the 58 drivers on that branch
  printed a total *smaller than the average beneath it*, which no count of one
  or more can produce. `accounted_fare_bookings` is the denominator that
  belongs to `accounted_fares` and `api/income_sql.js:526` says so in a
  comment; nothing read it. **When a function has several branches returning
  the same shape, fixing one is not fixing it — read them all in the same
  pass.**
* **`accounted_platforms` is every MEASURED channel, not the channels in the
  figure beside it.** It is `measured.map((r) => r.platform)`
  (`api/income_sql.js:530`), so it includes the payout-basis channels. Naming
  it under `accounted_fares` would print "on Bolt, Uber, Yango" beneath a
  Bolt-only total. No field names the fares-basis channels; ship the
  denominator without the channel rather than inventing the attribution.
* **A cancelled ride is not dark money.** `dark_bookings` at driver-day grain
  counts bookings on a channel whose basis is `none` — and a driver whose only
  Bolt rows that day were `driver_did_not_respond` and `client_cancelled` gets
  `dark_bookings 2, dark_pct 20` while `/api/revenue` for the same day reports
  Bolt pricing 11 of 21 bookings and `dark_bookings 0` fleet-wide. Captioning
  the driver tile "2 bookings report no money" would state a reason that is not
  the true one — no ride happened — and would make the driver page contradict
  the fleet page about the same channel on the same day. Check whether a dark
  booking is an unpriced ride or a ride that never ran before calling it a
  money hole.
* **`accounted` and `driver_day.money` are built from disjoint halves of the
  same evidence, and both are labelled money.** `fleetIncome.accounted`
  (`api/income_sql.js:511`) takes each channel's PAYOUT where one exists and
  its fares where it does not; it never reads a statement.
  `driver_day.money` (`src/rollup.js:1126`) takes each channel's STATEMENT NET
  where one was filed and its fares where it was not; it never reads a payout.
  They are two records of the same work, and they disagree by the cash share —
  measured over 2026-08-01..08-31 on `/api/drivers/leaderboard`, which returns
  both on one row, **all 91 people who carry both disagree**: AED 513,264 of
  money against AED 410,017 of payout. `api/income_sql.js:135` predicted the
  size and the consequence in a comment before anyone hit it. Before writing a
  money figure onto a page, know which of the two it is and say so on the
  screen; a page carrying both owes the reader the difference.
* **`Number(null)` is 0, and 0 is finite.** A guard written
  `Number.isFinite(Number(k.field))` passes for a null field and renders an
  absence as a figure — then gives it a reason, which is the one thing this
  dashboard exists not to do. Test `x == null` before `Number()`, not after.
  Caught by a test, not by review, and only because the test asserted the
  ABSENT case rather than the present one.
* **A source-scanning assertion can be satisfied by a different route in the
  same file.** `api/driver_routes.js` has two queries over `driver_day` with an
  identical predicate, so `/FROM driver_day\s*\n\s*WHERE driver_ext_id = ANY\(\$3\)/`
  passed against the file *before* the fix landed. Anchor such a regex on
  something only the new code has — an alias, a returned field name — and prove
  it by reverting and watching it go red. Two vacuous assertions have now been
  caught this way in one week.
* **A percentile of 0 is not a rank when the distribution is flat.** It means
  "nobody is below you", which on a tied majority is a tie, not a low score.
  Measured on production 2026-09-06 over five sampled drivers: two were told
  "Days worked 1 · fleet median 1 · lowest in the fleet" in the warn colour,
  and the desktop painted the same bar `--critical`. `/api/driver/standing`
  returns `tied` and `population` with every metric now so a renderer can tell
  the two apart; `standingNote` in `api/public/ui.js` is the only place either
  shell is allowed to turn a percentile into words.
* **`pct('cancel', false)` inverts the percentile, so 0 there is the WORST.**
  A driver at 66.7% cancellations against a 9.1% median scored 0 and the phone
  printed "lowest in the fleet" — which reads as the fewest. Rank-relative
  wording ("top of the fleet" / "bottom of the fleet") is the only phrasing
  that is true for both orientations; never say highest/lowest about a value
  when what you hold is a rank.
* **A floor applied in SQL before a fold in JavaScript is a floor on the wrong
  thing.** `/api/driver/standing` had `GROUP BY 1 HAVING count(*) >= 5` keyed
  on a provider ACCOUNT and folded to people three hundred lines later, so a
  person with three accounts of under five bookings was not in the cohort at
  all. Over 2026-09-01..09-07 the folded population is 98 and the endpoint
  reported 97; it reports 98 now. That one person was then told "5 trips …
  which is fewer than the five a ranking needs". Whenever a threshold and a
  grouping live in different languages, check they are talking about the same
  row.
* **A page that prints a count from endpoint A beside a threshold applied by
  endpoint B will eventually assert something false about the relation between
  them.** Return the count the decision was made on (`trips_in_window`) and the
  threshold that was used (`peer_floor`), and let the copy state those.
* **`/api/drivers/directory`'s row count is not a headcount.** It keys on the
  provider ACCOUNT — `coalesce(nullif(btrim(driver_ext_id), ''), 'name:' ||
  person_key)` — while the leaderboard beside it groups on `t.person_key`. Over
  2026-09-01..09-07, 20 of the 122 rows with bookings are 10 people listed
  twice, with the SAME `person_key` printed on both rows. Never use its row
  count as a population, and never compare its per-window `trips` with a
  profile's: for one person those read 5 and 44. (This trap produced a wrong
  number in a commit message and in two of these notes before it was caught —
  the claim "104 people have 5+ bookings" was 104 rows, six of them duplicates,
  98 people. The correct figure reconciled exactly with the endpoint under
  test, which is what exposed the duplication.)
* **Reconcile a fix's own number after deploying it, not only before.** The
  before-figure here was measured against a different grain than the after-
  figure, and only re-measuring both against the deployed API showed it — and
  then explained the residual as a real defect rather than leaving a six-person
  gap unexplained in the notes.

### The driver money model, measured — 2026-09-08

The operator settled what "money in" means (the all-platform day/week total,
`driver_day.money`) and asked for cash on hand and the bank side beside it.
Four readers and four measurers established the following against production.
**Read this before touching any money figure on a driver page.**

* **Only ONE writer fills `driver_statement_day` from a provider**:
  `src/rollup.js:941`, `source='uber_rest'`, derived from
  `driver_earnings_component`. So the statement view of the money is **Uber
  only**. `driver_payout_day` has one writer, `src/rollup.js:658`, over
  `driver_performance` — **Uber and Yango only**. Bolt, the hotel corporate
  channel, FMS and CABMAN reach every money surface solely as `trip.price`.
* **`driver_statement_day.bank`, `network_cash`, `unremitted` and `trips` are
  dead columns for every API source.** `bank` is NULL on all 212 statement days
  and 234 statement drivers over 2025-01-01..2026-09-08; the only writer is the
  operator's workbook import (`api/server.js:3350`, `source='ledger'`), which
  every money read filters out. **There is no reported bank transfer per
  driver.**
* **`driver_payout_day.earnings` IS a bank figure** — for Uber it is
  `netOutstanding`, "the amount Uber wires" (`src/sources/uber.js:1430`) — so
  `api/public/revenue.js:194`'s "Paid into the bank" is right about it. What it
  is not is a figure over the window a reader picked.
* **Cash is money already in the driver's hand.** `-sum(amount) FILTER
  (category = 'cash_collected')`, `src/rollup.js:816`; the component arrives
  negative and is stored as a magnitude. It is 16.9–18.8% of gross across three
  windows — not 1%, and it is the whole of the 20% gap the driver page used to
  show between its own two money figures.
* **`gross = bank + cash` does not hold and cannot be made to.** Across 302
  driver-window measurements, 260 had all three terms and **exactly 1 closed to
  within AED 1**. With the measured payout as "bank", **bank + cash exceeds
  gross on 81 of 89 drivers**. The residual decomposes exactly (zero error over
  260 rows) and its dominant term is the Uber netOutstanding-vs-statement gap
  that `api/reconcile_routes.js:66-90` already documents as a structural floor.
  The only identity that closes is one defined by subtraction, and a card built
  on it must say it is a remainder.
* **`money`, `stmt_net`, `stmt_gross`, `stmt_fees` and `stmt_cash` are WEEKLY
  figures divided by seven.** Over 84 driver-days each takes exactly four
  distinct values, one per ISO week, changing only on Mondays. **The payout is
  the opposite**: 90 of 90 Uber payout periods have `period_days = 1`. So on a
  one-day window the gross and the cash are allocations and the bank is a
  measurement — the three cards do not share a grain.
* **A seven-day window is not the filing week.** Uber files Monday–Sunday.
  2026-09-01..09-07 is offset by one, and for the sampled driver that is worth
  AED 64.97 of cash and AED 445.00 of gross. `driver_day` stores the grain but
  not the period bounds, so alignment cannot be detected from the endpoint —
  qualify whenever the grain is coarser than a day.
* **`driver_day.payout` over-counts and must never feed a card.** It sums the
  per-day allocation of every payout row landing on any of a person's accounts:
  wrong for 2 of 91 people in the week and 5 of 94 in August, and the driver
  this all came in about is the single worst case in both (+386.34 / 14.7% and
  +1,524.44 / 13.3%). Use `fleetIncome.accounted_payouts`.
* **Three cash figures exist and where two are present they never agree**:
  `day_cash` (Uber statement, the only one with coverage), `cash_earnings`
  (Yango payout) and `day_payout_cash`. Name them; never sum them.
* **A cash card built on the statement alone understates and lies by omission.**
  62 of 112 people took cash on a channel that publishes no cash figure, worth
  ≥ AED 5,001, and 14 would have been shown a dash reading "no channel reports
  it" while `trip_ext.driver_holds_cash` marked the very bookings. The set of
  people with a non-null statement cash figure is **exactly** the set with at
  least one cash-paid Uber booking (89 = 89, no mismatch either way), and Uber
  never files a zero cash line.
* **A caption asserting an ordering between two figures must be gated on their
  grain.** "The fares are Money in before commission" is true over a filing
  week and FALSE on a day — the fares were smaller than the money for 36 of the
  83 drivers who could show both, because the money is a flat weekly seventh
  and the fares are that day's rides.
* **`/api/driver/earnings`'s `fare` is not a fare.** It is
  `sum(driver_statement_day.net)` — gross minus commission — and `tip_pct`
  divides tips by it while calling the result a share of fares.
* **`driver_day.fares` is not the fares half of `money`.** It is
  `sum(trip.price)` over ALL platforms including the ones that filed a
  statement. The fares half is `money − stmt_net`, and only that.

### One money basis — 2026-09-08

`api/income_sql.js` `chooseBasis()` preferred a channel's **payout**. That was
wrong, not merely inconsistent: `driver_payout_day.earnings` is Uber's
`netOutstanding`, the amount wired to the bank (`src/sources/uber.js:1430`), so
every money headline in this product answered *"what reached the bank"* under
the words *"money in"*. The two differ by the cash the drivers already hold —
16.9% to 18.8% across three measured windows.

The order is now **statement → zero_payout → payout → fares**, with the
statement split on coverage exactly as the payout is.

* **Measured, fleet, 2026-09-01..09-07.** accounted 180,482.40 → **182,778.38**;
  the uber term moving from its payout (155,889.48) to its statement net
  (158,185.46). Fleet-wide that is AED 2,295.98; on the driver this came in
  about it was 14%.
* **`partial_statement` exists for the same reason `partial_payout` does, and
  leaving it out nearly shipped a false green.** The first version of the branch
  took any statement and reported no coverage, turning uber's amber
  *"part-window"* into *"accounted for"* over a statement covering **212 of 365
  days (58.1%)** — almost exactly the payout's 215. Coverage is a property of
  the window, not of the channel: the same uber row is `partial_statement` over
  365 days and `statement` over 31.
* **`accounted_payouts` stopped meaning "what reached the bank" the moment the
  statement won.** It sums only the rows *counted on* their payout, so Uber left
  that set and twelve surfaces reading it for the bank figure would have shown a
  remainder — `#finance`'s "Platform payouts" tile reading AED 267 where it read
  AED 155,889, plausible enough not to look broken. `reported_payouts` is the
  bank side across every row that has one. Never use `accounted_payouts` to mean
  the bank.
* **A page cannot infer WHICH payout was excluded, and guessed wrong.**
  `#finance` named "uber's statement" for money that was yango's fares. The
  server returns `uncounted_payouts`, `uncounted_payout_platforms` and
  `uncounted_payout_bases`; the page states, never derives, the reason.
* **`/api/day` fed the operator's workbook into the basis.** It read
  `statement_net` from `source = 'ledger'` under a comment promising the field
  "rides BESIDE the chosen basis and is never added into accounted" — true only
  while `fleetIncome` ignored it. `test/day_routes.test.mjs` caught it as
  *"accounted 620.25 vs statement 620.25"*, the two numbers having silently
  become one. The countable query reads `source <> 'ledger'`; the workbook keeps
  its own field, `ledger_net`. **Any new field named `statement_net` that
  reaches `fleetIncome` must exclude `source = 'ledger'`.**
* **`/api/finance/daily` needed a third per-day source or it lost 86% of the
  fleet.** Its daily bars are built from `USES_FARES` and `USES_PAYOUT`; with
  uber in neither, AED 158,185 of AED 182,778 would have vanished from the bars
  under a tile still showing all of it. The bars adding up to the tile is,
  in that route's own words, "the only property that makes them trustworthy".
* **A count and the list that explains it must come from one filter.**
  `api/public/revenue.js` had its own `underRows` on `partial_payout` alone
  while the server's total counted both kinds, so the tile rendered *"232,832
  more are covered by a report that reaches ␣ — money we hold"*.
* **Yango is a deliberate, measured residual.** `driver_day.money` takes a
  channel's fares where it files no statement, so at driver grain Yango counts
  on AED 814.00 of fares; here it keeps its AED 266.57 payout, because the
  payout branch precedes the fares branch and that is right for a channel taking
  a commission. Fleet 182,778.38 against a `driver_day` sum of ~183,366 —
  roughly AED 588, 0.3%, all of it Yango, down from AED 2,844.
* **A count chart's floor must be zero, and the phone's was the series' own
  minimum.** `spark()` in `api/public/m/ui.js` set `lo = Math.min(...v)`, so the
  smallest day in the window was drawn ON the baseline — a day with work and a
  day with none rendering identically, with no axis, no label and no caption to
  separate them. Reported from the phone as *"I think one day's data is
  missing"* for Shahab Ali Shaukat Hayat over 2026-09-01..09-08. Nothing was
  missing: `/api/driver/daily` returns all eight days — 12, 11, 11, 12, 12, 9,
  14, 9 — and 9 was the minimum, so both 9s sat on the floor and the last one,
  carrying the end-dot, read as zero. Zero-based it sits at 64% of the height.
  All four callers plot counts or amounts per day; the RATING trend is a
  different renderer (`api/public/ui.js`) and is correctly min-scaled, which is
  the case `zeroBased: false` exists for. **Before drawing a series, ask whether
  its zero means anything — and if it does, put the floor there.**
* **`splitToday` keyed on `d` alone while `/api/driver/daily` keys on `day`.**
  So the driver and vehicle charts got `today: null` every time and drew the
  part-day that is still filling beside seven finished ones — a driver eight
  hours into a shift showing a collapse at the right-hand edge. The Today and
  Fares charts on the same phone had always excluded it and said so. When a
  helper tests one field name, check every row shape that reaches it.

### Trip value: `revenue` stopped being a tenth of the work — 2026-09-08

Every note in this repository about `revenue` — `sum(trip.price)` — said the
Uber export carries no fare column, so it describes *"875 of 12,410 bookings,
the hotel channel and Yango"*. **That premise is dead and the notes outlived
it.** `src/sources/uber.js:563` walks Uber's weekly PAYMENTS report and
`UPDATE`s `trip.price` to the **rider fare**, so the coverage measured on
production is:

| window | bookings | priced | trip value | avg |
|---|---:|---:|---:|---:|
| July 2026 | 10,780 | 9,610 (89.1%) | 589,566 | 61.35 |
| August 2026 | 13,993 | 12,567 (89.8%) | 744,136 | 59.21 |
| 1–7 Sep 2026 | 4,973 | 4,470 (89.9%) | 267,211 | 59.78 |

The tenth left over is very nearly the cancellations that took no fee:
2026-09-07 ran **89.9% priced against 87.6% completed**, and `priced_trips`
(607) *exceeds* `completed_trips` (591) because some cancellations carry a fee.

So `revenue` is the fleet's **gross trip value — what riders paid** — and
`accounted` is what the fleet is credited with once each channel is counted
once on the best report it files. **August 2026: AED 744,136 against AED
585,058.** Neither is the other, and both belong on the screen: the operator
asked for the first by name on 2026-09-08, having been shown only the second.

**Money in is not always the smaller of the two.** On 2026-09-08 the day held
AED 7,170 of money in against AED 2,874 of trip value, because the statement
half covers a week whose trips are mostly priced while the day's own Uber
bookings are not priced yet. Any copy describing one as a part of the other, or
naming their difference as commission, is false on every window that includes
today.

### Today's trip value has to be estimated, and how — 2026-09-08

At 20:07 Dubai on 2026-09-08 `/api/day` answered **AED 2,874 over 664
bookings**, and **AED 35,965 over 675** for the day before. The fleet had not
collapsed by 92%: **0 of the day's 596 Uber bookings carried a price.** The
split by channel that evening was uber 0 of 596, hotel 34 of 34, bolt 10 of 31,
yango 3 of 3 — every priced booking on the screen came from a channel that is
not most of the fleet. The measured figure was correct and it was the answer to
*"what have we been told a price for"*, not to *"what did the fleet do today"*.

`/api/day` now values the bookings that carry no price yet
(`expected_revenue`, `projected_revenue`, `projection_parts`, and — for a
channel it cannot value at all — `unrated_bookings`). Four rules make it
defensible, and two of them were learned by getting it wrong on production:

* **The rate is per BOOKING, not per priced booking.** About a tenth of
  bookings never carry a fare, so dividing settled revenue by *priced* bookings
  and multiplying by every unpriced one bills the fleet for its cancellations:
  AED 59.25 a priced booking against AED 53.28 a booking on 2026-09-07, an 11%
  overstatement. Per booking already averages the fee-less cancellations in.
* **A day joins the rate only once ≥50% of that channel's bookings on it carry
  a fare.** The dangerous shape is not an empty day — `priced > 0` excludes
  those — it is a **half-walked** one, a day whose weekly report has begun to
  land and has not finished. Proved in `test/day_routes.test.mjs`: a fixture day
  with 10 of 150 priced drags the rate from AED 90 to AED 73.24 a booking, 19%
  low, and every projection built on it with it.

* **A channel is projected on COMPLETED MINUS PRICED, not on how many bookings
  lack a price.** Two wrong versions preceded this, both fixed against
  production:
  * *Every unpriced booking.* Wrong on the day easiest to check — 2026-09-07 is
    settled and it still added AED 3,355 for the 68 bookings without a price,
    reporting an expected 39,320 over a measured 35,965. Those 68 are fee-less
    cancellations, and the per-booking rate already spreads them in.
  * *Priced share below its settled share.* Better, still a proxy: Bolt on
    2026-09-07 ran 21 of 40 priced against a 61.9% settled share, read as "still
    walking" and added AED 133 — on a channel that prices every booking as it
    lands and had simply cancelled more than usual. A channel that never defers
    pricing would be projected on every bad day and, the estimate being floored
    at the measurement, never marked down on a good one.

  The signal is a count the endpoint already holds. **Work that finished and
  carries no money is pending; a cancellation that took no fee is done.**
  Measured on production it separates the cases outright:

  | day | channel | completed | priced | pending |
  |---|---|---:|---:|---:|
  | 2026-09-07 | uber | 541 | 557 | 0 |
  | 2026-09-07 | bolt | 21 | 21 | 0 |
  | 2026-09-08 | uber | 569 | 0 | **569 (100%)** |
  | 2026-09-08 | bolt | 10 | 10 | 0 |

  `priced` exceeds `completed` on a settled Uber day because some cancellations
  do carry a fee, which is why the count floors at zero. A **10% floor under the
  pending share** drops the one complimentary hotel ride that shows up as 3.4%
  of a small channel and would otherwise replace the whole of it with an
  estimate.
* **A channel being projected is valued WHOLE, not by its remainder.**
  `measured + unpriced × rate` double counts, because the per-booking rate
  already spreads the never-priced bookings in. It is
  `max(measured, bookings × rate)` — the floor being what stops an estimate
  contradicting a measurement. Proved in `test/day_routes.test.mjs` on a channel
  at 20 of 100 priced: whole-channel adds 7,000, the remainder form adds 7,200.

Measured against the day it projects: valuing 2026-09-08's unpriced bookings at
the fourteen settled days behind them gives **≈ AED 35,600**, and 2026-09-07
settled at **AED 35,965**. A settled day reports **no estimate at all**:
`expected_revenue` is null and the screens fall back to the measurement.

The estimate rides beside the measurement and never becomes it — `revenue` is
untouched, and nothing projected is ever added into `accounted`.

### Traps this added to the list

* **A guard regex over a source file cannot tell a comment from rendered copy.**
  `test/phone.test.mjs` pinned that no screen still says *"Uber publishes no
  per-trip fare"* — and failed, because the fix's own block comment quotes the
  sentence it retired. This repository asks every fix to leave that history
  behind, so the guard now strips comments before testing and asserts the
  history separately. **A staleness guard must test the rendered strings, not
  the file.**
* **A fixture that does not add up renders a false sentence, and shape checks
  cannot see it.** `mockapi.mjs` carried `accounted_payouts` equal to
  `accounted_statements`, so the money screen drew *"AED 237,366 … AED 196,178
  on platform statements, AED 41,188 in fares, AED 196,178 in payouts"* — three
  numbers summing to 433,544 under a total of 237,366, on the fixture every
  rendering pass reads. `test/mockapi.test.mjs` now asserts the identity the
  pages state.
* **`day_routes`' `priced_bookings` is a coverage flag, not a count.** It is set
  to a platform's WHOLE row count when *any* of it carries a fare, which is what
  `income_sql.js` wants and is not a priced count. The platforms query carries
  `bookings` and `priced` separately for anything that does arithmetic.
* **`/api/day`'s `platforms` rows include telematics.** `n` counts every row the
  channel produced — fms contributed 271 journeys and no booking on 2026-09-08 —
  so anything reasoning about bookings must filter, not read `n`.

### The fare of a charged cancellation, and the null that erased it — 2026-09-09

**Uber prices every completed trip.** Measured 2026-09-07: 541 of 541 completed
Uber bookings carry a fare, and `priced` (557) *exceeds* `completed` because 16
cancellations carried a fee. Same on 2026-09-01 (557/557), 2026-08-25 (416/416),
2026-07-15 (290/290). A full scan of the settled week 24–30 August — 3,321 Uber
bookings — found **zero completed-unpriced and zero priced-at-zero**. The
permanent ~10% unpriced residual is cancellations, not unfinished collection.

**But a cancellation that DID charge is stored as though it charged nothing.**
A cancellation fee reaches the payments report as a row whose description says
*"adjust"*. `orderKind` (`src/sources/uber.js:347`) routes those to a branch that
never reads the fare column — and Uber does not populate it on them anyway: the
live probe's own adjustment row carries `Fare "0"` beside a real *Paid to you*
of 5.00. So the trip came back `{fare: null, earnings: 11.06}`, passed the walk's
`fare == null && earnings == null` filter, and was written onto `trip.price` as
**NULL**.

Measured on production 2026-09-08, rows with `price IS NULL` beside an
`uber_payments` blob showing real earnings and a real service fee:

| window | unpriced Uber cancellations | of those, billed | worth |
|---|---:|---:|---|
| 2026-08-10 .. 09-08 | 1,356 | **8** | AED 15.00–18.00 each |
| 2026-05 (whole month) | 1,120 | **27** | AED 15.00–90.00 each |

**It does not heal with age.** May 2026 has been through several full Sunday
backfills and still holds its 27 — nothing could repair it while the walk
re-erased it on every pass.

**The product was not silent about it; it was confidently wrong.**
`/api/trips/list` served *"A cancelled ride that charged nothing has no fare and
never will"* over those rows, and `income_sql.js:85` published them as
`uncharged_bookings`. That is the exact failure the house rule names — absent
with a reason is required, and **never with a reason that is not the true one**.

**The fare is recoverable, exactly.** It is not in the report as a number but it
is there as an identity, and `test/uber_payments_order.test.mjs` had already
pinned it in the other direction (*"the service fee is a quarter of it"*):

```
fare = (earnings − tip) + 1.05 × |service fee|
```

The 1.05 is the 5% UAE VAT on Uber's commission. Measured over
2026-05-01..2026-09-08 against every distinct blob holding both a fare and a
service fee — **2,518 trips, 60 shapes, exact within six fils on 2,518 of
2,518, zero misses.** Worked: `11.06 + 3.9375 = 15.00`; `13.27 + 4.725 = 18.00`.

*Subtracting the tip is the part that is easy to get wrong.* Without it the
tipped shapes miss and nothing else does — fare 15 against earnings 16.06
(11.06 plus a 5.00 tip), 21 trips in one window. The first attempt at this fix
had exactly that bug and production named it.

### Traps this added to the list

* **`csvToPayments` folds a WEEK, but a trip's transactions do not respect one.**
  A trip priced from its own week was un-priced whenever a later week's report
  mentioned it again — the fare column is read on trip-kind rows alone, so an
  adjustment or a tip arriving on its own carries no fare. The write is now
  `price = coalesce($3, price)`; the idiom was already on the same line, one
  column to the left, on `currency`.
* **`priced += rowCount` counted an erasure as a success.** A row the walk wrote
  NULL over was reported as priced, which is why this survived every check
  anyone ran. `priced` and `held` are now separate, and `derived` rides with
  them on the chunk.
* **The damage lands on CANCELLATIONS, where nobody looks.** It never appears as
  a completed-unpriced row, so the "priced > completed on every settled day"
  screen, the per-day convergence table and the 20-day sweep all pass while it
  is happening. The invariant that catches it is
  `price IS NULL AND raw ? 'uber_payments' AND earnings <> 0`, expected zero.
* **`/api/trips/list` computed its summary over the PAGE and `total` over the
  WINDOW**, on the same response and under the same names — 5.75× out at the
  default limit on a 675-booking day. Both now come from one query.
* **A derived figure must say so.** Recovered fares carry `fare_derived: true`
  into the blob, onto the row, and into a sentence on the page. A derivation
  presented as a reported number breaks the same rule this fix exists to serve.

### Unauthorized trips: where they went, and what the distance was worth — 2026-09-09

The most serious claim this product makes arrived with no geography and no
amount. `/api/unauthorized/list` returned `start_lat 25.24687004`,
`start_lng 55.3535881` and both end coordinates on every row, and the page
rendered **none of them** — so an operator reading "L46706, 23:53, 62 km,
unauthorized" could not tell a car repositioning to the airport from a car
taken home to Sharjah.

**The names come from the fleet's own gazetteer, not a geocoder.**
`place_cell` (`sql/schema_v67.sql`) folds every positioned trip endpoint into
~0.5 km cells holding the modal area name. Coverage measured on production
2026-09-09 through `/api/driver/day`: **194 of 197 fixes named**, with 750–1,300
votes on the named cells. `api/place_sql.js` is the shared fragment; it imports
`CELL` from `src/places.js` rather than retyping `0.005`, which
`api/driver_routes.js:2299` does and which is a second place to get it wrong.

**The vote counts travel with the name.** A cell one trip named is not the claim
a cell four hundred trips agree on. Under five votes the table dims the name and
marks it; a cell nothing has ever named renders as its coordinate under a
tooltip saying so, never as a blank and never as the nearest place we hold.

### Revenue forgone is not a cost

The operator asked for "how much that costed the company", as average AED/km
times distance. The product is worth having and **it is not a cost**: it is the
revenue those kilometres would have earned had they been sold. The fuel and wear
behind them is a different, smaller number nothing here measures. Printing it
under the word *cost* would be a reason that is not the true one, so every
surface says **forgone** and names the rate.

The rate is the SAME definition `/api/kpis` publishes as `revenue_per_km`
(`api/server.js:456`) — numerator and denominator over ONE population, bookings
carrying **both** a fare and a distance. That comment records what happens
otherwise: *"live it came out 3.93 where revenue/priced_km is 5.28"*, a ratio
between two different populations. `test/segment_routes.test.mjs` pins it by
seeding a priced booking with no distance and an unpriced one with 100 km: the
correct rate is AED 4.38/km, dropping one filter gives 4.82 and the other 16.88.

**Two windows, both stated out loud.** The list values a segment over the window
the reader picked; the detail page has no window and values it over the
segment's own calendar month. Each names its basis in the sentence it prints, so
a reader comparing them sees which is which instead of finding a contradiction.

### Traps this added to the list

* **A source-regex guard that tests a string NEAR the mechanism proves nothing.**
  Three checks here tested for `label: 'From → to'` and `label: 'Forgone'` and
  passed against a file whose columns had been switched off — the label is still
  written down inside a branch that no longer runs. The thin-name marker
  appears twice in the same file, so deleting one occurrence left its regex
  satisfied. Pin the whole expression that decides whether the thing exists, and
  prove it by turning that expression off.
* **A `?? 0` default in a test helper silently destroys the case being tested.**
  `seg()` defaults `km` with `?? 8` and `trip()` with `?? 10`, so passing `null`
  builds a row with a distance and the null-distance assertion tests nothing.
  Rows that need a null go in with direct SQL.
* **Widths: a two-place cell set to wrap makes every row three lines tall.**
  Names are clipped to 18 characters with the full name in the title, and the
  cell is `nowrap`. The sentence on the detail page carries them in full.

### "Al WarqaAl Warqa 3" is the provider's spelling, not a parser fault

Visible on `#unauthorized` the moment the places landed, so it is worth writing
down before somebody "fixes" `place_area()` over it. Measured on production
2026-09-09 through `/api/trips/list?days=365&q=warqaal`: **6 trips in a year**,
and the concatenation is in the address the provider sent —

```
Al WarqaAl Warqa 2, Dubai
Unnamed Road - Al WarqaAl Warqa 1 - Al Warqa'a First - الورقاء الأولى - دبي - …
```

The dash-separated form of the same community arrives correctly on 728 trips in
the same window (`5CR5+GW5 - Al Warqa - Al Warqa 3 - Dubai - …` → `Al Warqa 3`),
so the parser is reading its input faithfully. A rule that collapsed a repeated
prefix would mangle legitimate names — Dubai has communities that genuinely
repeat a word — for six rows in a year. **Left as the provider wrote it.**

### One fleet's failure, printed against the other — 2026-09-09

`/api/platforms` reported, on production, `days=1`:

```
bolt/ecosine  partial  "FI roster ecosine: BOLT_CLIENT_ID is not entitled
                        to company_id 142868 — NOT_AUTHORIZED …"
bolt/egari    partial  "FI roster ecosine: BOLT_CLIENT_ID is not entitled
                        to company_id 142868 — NOT_AUTHORIZED …"
```

**Egari's row states an Ecosine failure**, and Egari's own FI roster reads
company 142897 without complaint — the message says so in its own second
sentence. `channelHealthSql()` was `DISTINCT ON (source)` and `channelHealth()`
keyed its map by source, so of the two runs a channel makes each pass the later
one won and was printed against every fleet row on that channel.

`/api/status` was fixed for exactly this and records why in its own header —
*"Ecosine and Egari are separate businesses with separate credentials on the
same providers … Keyed on (source, mode) alone, one fleet's row won and the
other vanished"* — becoming `DISTINCT ON (source, mode, fleet_id)`.
`api/channels_sql.js` was left behind, and **both** routes reading it kept the
bug: `/api/platforms` and `/api/revenue`.

**And the lookup was only half of it.** With the lookup fixed the Egari row
*still* carried the Ecosine text, because `src/sources/bolt.js` wrote **one run
row with `fleet_id` null** for both businesses — every surface's failures joined
into one string — while Uber and FMS write one per fleet. So there was no
per-fleet Bolt verdict to show. Bolt now writes one row per company: every
failure it records already knew its fleet (the portal loop has `c` in scope at
each push, the FI refusal is built per company), so the split is a grouping and
not a guess. A failure with **no** fleet — the two catches that fire before any
company is reached — rides with every fleet, because neither was collected.

Confirmed on production after both fixes: `bolt/ecosine` carries the FI refusal,
`bolt/egari` does not.

**What it cost.** An operator pasted a fresh Bolt portal token, watched the page
still show Bolt red on both fleets, and concluded the paste had been rejected.
It had been accepted — `BOLT_REFRESH_TOKEN_ECOSINE` was written at 06:04 UTC and
picked up by the collector at 07:05 — and a completely different credential on
the other fleet was down. **A misattributed error costs more than a missing
one: it sends somebody to re-do work that already succeeded.**

**Two Bolt credentials, and only one of them is a paste.** Worth stating plainly
because the page conflated them:

| credential | surface | fixable by |
|---|---|---|
| `BOLT_REFRESH_TOKEN_*` (portal, fleet-owner login) | trips, orders, fares | pasting a fresh capture |
| `BOLT_CLIENT_ID` / `_SECRET` (Fleet Integration app) | driver roster, vehicles | adding the company to the app **in the Bolt portal** |

The portal login is entitled to both companies — which is why the curl carrying
`company_id: 142868` works — while the FI app has its own allow-list, and only
142897 was ever added to it. `fiRefusal()` already says all of this correctly
and already records `state: 'unentitled'` rather than `'invalid'`; nothing was
wrong with the message, only with which fleet it was shown against.

### Traps this added to the list

* **A fleet with no run of its own must report ABSENT, never the other fleet's.**
  The obvious fallback — try the fleet, then fall back to the channel — is the
  same defect wearing a hat. `healthFor()` falls back only to a run the source
  genuinely recorded with `fleet_id` null, and returns absent otherwise.
* **A caller with no fleet dimension needs the WORST fleet, not the latest.**
  `/api/revenue` folds the fleets into one row per channel; taking the most
  recent run made "is this channel healthy" a coin toss between two fleets. A
  channel collecting for one business and refused for the other is not `ok`.
* **When a route is fixed for a bug, grep for the shape rather than the route.**
  `DISTINCT ON (source` was the searchable signature here, and it sat in a
  second file for as long as it took somebody to be misled by it.

### Going online: what Uber tells us, and the four ways it does not — 2026-09-09

The Online time page (`#online-time`, under People) answers "who came online at
what time, against the hour you expect them to start". It produces a call list,
so every absence on it had to be told apart from every other absence: a driver
who is on that list gets phoned.

**What we hold.** `driver_timeline_event` (schema_v37) carries Uber's ONLINE /
OFFLINE transitions per driver account. Coverage is 100% on complete days since
2026-07-28 and 0% before — the collector did not exist before that date, and
Uber's timeline endpoint does not backfill.

**How it is collected.** `src/run.js:407` anchors each tick on the instant it
wakes: `to = new Date(), from = daysAgo(2)`. `src/sources/uber_timeline.js:203`
uses that same pair BOTH to choose which drivers to ask about and to bound what
it fetches, and it chooses them from `trip`, not from the roster. Cron is
`UBER_TIMELINE_CRON`, `17 */3 * * *`. There is a whole-roster mode
(`node src/index.js timeline-roster`, 30 days) which has **no cron at all** and
last ran 2026-08-27.

**The four absences, and which of them heal.**

| state | what it means | heals? |
|---|---|---|
| `already_online` | the span opened before midnight — this day has no start of its own | n/a, it is the true answer |
| `awaiting_feed` | trips landed, the three-hourly timeline has not caught up | yes, next tick |
| `not_asked` | no trip inside the collector's 48 h selection window, so Uber was never asked | **no** — only a manual roster sweep closes it |
| `cannot_earn` | the Uber standing does not permit taking work at all | n/a, it is the true answer |
| `absent` | Uber WAS asked and returned nothing for the day | n/a, it is the true answer |

**Thirty of the 157 cannot earn, and none of them is a suspension.** Measured
2026-09-09: 157 people hold an Uber account, 127 of them a standing that
permits work. The other 30 are all at some stage of ONBOARDING —
`ONBOARDING_STATUS_WAITLISTED_AUTO_REACTIVATION` ×21, `..._REJECTED` ×6,
`..._ACCEPTED` ×2, `..._APPLIED` ×1 — which is why the page gives them four
different sentences rather than one: an application Uber has turned down is not
a person who simply has not started, and an operator would chase them
differently. The raw enum is never shown; `standingWords()` maps
`src/roster.js`'s normalised state, and falls back to the provider's word
tidied rather than to a key. They are on the page — dropping them silently would
hide a car that may still be attached to somebody who cannot drive it — but
they carry their own reason, are never counted late, and are out of the "Drove"
denominator. Before that they fell into `not_asked` and sat in the call list,
which is the operator's own stated failure mode.

Measured for 2026-09-08: 109 accounts held an active Uber standing, 84 drove,
and all 25 who did not also took no trip on the 6th or 7th — so the collector
never asked Uber about a single one of them. "Never came online" is unprovable
for those people by construction.

**The ask-window is an INSTANT window, not a calendar one.** This is the trap:
the collector's window is a rolling 48 hours anchored on the tick, and writing
it as three Dubai calendar days (`BETWEEN day - 2 AND day`) is up to 24 hours
too generous — which makes the page print `absent` ("Uber was asked and
returned no online event") for a day no tick ever fetched. The endpoint now
uses `requested_at >= least(dayEnd, now()) - interval '48 hours'`: a tick at
that instant covers the whole day, so a trip inside it is *sufficient* proof of
selection. It is not necessary, which makes the residual error fall towards
`not_asked` — the state that claims nothing — rather than towards `absent`.

**Uber drops deactivated drivers from the supplier roster.** 395 people are
built from trips against 338 on the roster (`api/roster_routes.js:80`). Their
online events are still collected, because the collector picks who to ask from
`trip`. Any page that takes Uber ids from `driver_platform_state` alone loses
them — and, if it then falls through to "no online event has arrived yet",
excuses a real no-show permanently and silently.

**The first trip is not a start time.** A trip is necessarily after going
online, by a median of 68 to 73 minutes measured over two days on production.
It is carried on the row as evidence and never as a verdict; a lateness mark
built on it would be systematically too kind.

**What Uber does NOT give us here:** a reason for going offline, an ONLINE
event for a driver it was not asked about, anything at all before 2026-07-28,
and any notion of a scheduled or rostered start — the expected start time is
the reader's own, held in `localStorage` under `online-time:start` and shared
by both shells.

**ONLINE IS A HEARTBEAT, NOT A TRANSITION — and it stops during a job.**
Measured on production 2026-09-10. `kind='status'` holds only ONLINE and
OFFLINE; job progress is a separate `kind='job'` stream keyed by `job_ext_id`
(DJ_ASSIGNED / DJ_PICKUP_ARRIVED / DJ_PICKUP / DJ_COMPLETED / DJ_CANCELED /
DJ_UNASSIGNED). Uber REPEATS ONLINE — 132 rows for one driver in one day,
90,389 fleet-wide over thirty days — so an ONLINE is almost never followed by
an OFFLINE, it is followed by the next ONLINE. And it **stops for the length of
a booking**: the status stream goes quiet while the driver is dispatched and
resumes afterwards.

Two consequences, and the product had both wrong in four places:

- The last ONLINE of a driver's stream has no successor, so a span built as
  `ONLINE → lead(at)` with `WHERE next_at IS NOT NULL` **deletes it** — and
  because the heartbeat stops when work starts, the deleted event is the one
  immediately before the work. `GET /api/probe/uber/timeline` counts it live in
  `dangling_online`: **60 of 89 drivers, 56 of them dated today, 7,518 minutes
  (125 driver-hours) dropped from that single day.** Driver
  `369dd9c1-ae0a-4526-8d46-d91a8c217121` went online 09:59:15, was dispatched
  six seconds later, and `/api/driver/day` drew him online 08:35→09:59 and
  printed "99% of online time" — 83 minutes of job time taken from the whole
  day, divided into an 84-minute window that stopped before two of his three
  trips.
- A `kind='job'` interval is **direct evidence of being online**: Uber does not
  dispatch an offline driver, and those intervals cover exactly the stretches
  the heartbeat omits.

`api/online_span_sql.js` is now the single definition — dangling ONLINE kept,
closed at the bound described below, marked `open_ended` and carrying
`closed_by`; job intervals unioned in; the two de-overlapped so nothing is
counted twice; OFFLINE still closes. `api/online_routes.js` had it right all
along and says why: *"A dangling ONLINE … still starts a span. Its start is a
fact even when its end is not."*

**A dangling ONLINE is closed at the earliest of three bounds**, and the span
says which one did it:

| bound | `closed_by` | why it exists |
|---|---|---|
| `now()` | `now` | it cannot have run into the future |
| end of its own Dubai day | `day` | the day is the grain every reader draws at |
| last successful `uber_timeline` `collection_run.finished_at`, **per fleet** | `collection` | **we cannot claim somebody was online after the last moment we actually asked Uber** |

The third is the one that makes the other two honest, and it is the one that
matters most: **56 of the 60 dangling drivers were dangling on TODAY**. The
timeline runs on `UBER_TIMELINE_CRON`, every three hours as shipped, so at any
moment the most recent hours of today have not been fetched. Closing at `now()`
credits a driver with all of them — it converts *"we have not asked yet"* into
*"they were working"*, which is the exact substitution this dashboard exists to
refuse. At a three-hourly cadence that is up to three hours per driver and, at
the mean gap across those 56, on the order of **84 driver-hours a day** (derived
from the cron and the dangling count, not measured — the probe reports the
dropped tail, not the invented one). The figure now grows as collection catches
up, which is the self-healing direction `awaiting_feed` already runs in.

*Per fleet, with no cross-fleet fallback.* `src/sources/uber_timeline.js` stamps
both the events (:143) and the run row (:290) with the same `o.fleet`, so the
two cannot drift. A fleet whose timeline has never completed a run has no
evidence of when it was last asked, so it gets no ceiling and falls back to the
first two bounds — borrowing another fleet's collection clock would be a claim
about a collection that never happened. `status <> 'error'`, not `= 'ok'`: a
`partial` run did reach the provider and did collect something, while an `error`
row must never push the ceiling forward on the strength of a run that collected
nothing.

*A run that finished BEFORE the event does not bind either.* That combination
means we hold an event we could not have fetched — a contradiction in the
bookkeeping rather than evidence about the driver — and resolving it by
truncating the span would throw away the one thing we do know.

**The residual, stated rather than hidden.** The ceiling does **not** close the
other case: a dangling ONLINE on a day the collector has since covered many
times over sits below the ceiling, so the ceiling cannot bind and the span still
runs to that day's midnight. That is the **4 of 60** on a day that is not today,
and the honest reading is that we asked repeatedly and Uber never sent anything
later — which is evidence, but not proof that the driver stayed online. So it
remains a claim: `closed_by` says `day`, `open_ended` stays true, and every
surface that must not overstate can refuse it on that flag alone.
`/api/driver/day` carries `collection` — the last run, the minute of the day it
reached, and whether the day is complete — so the page says *"this day is still
being collected"* rather than letting a band that stops read as a driver who
stopped. **That sentence is scoped to the person's own fleets, exactly as the
ceiling is**: a global `max(finished_at)` would print "collected to 22:17"
beside a band that stops at 10:17 because that is when THAT fleet was last
asked, which is the page contradicting itself in two adjacent lines.
`test/dangling_online.test.mjs` pins all of it — every bound, the per-fleet
independence in both directions, and this residual.

### Traps this added to the list

- **A collector's window is in the collector's units.** Restating a rolling
  48-hour instant window as Dubai calendar days changed which of two opposite
  sentences a driver got. When a page's honesty rests on "was this fetched",
  read the fetch code, not the schedule.
- **`person_key IS NOT NULL` is not the predicate.** The column is generated
  from the name, so a blank name folds to `''`, not NULL. Every index in
  `schema_v53` is partial on `person_key IS NOT NULL AND person_key <> ''` and
  the schema says why — "an empty key must never become the bucket every
  anonymous row falls into". Use `coalesce(nullif(person_key, ''),
  driver_ext_id)`, exported as `personKeyStored` in `api/custody_sql.js`.
- **The roster is not the population.** `driver_platform_state` is who Uber
  *currently* lists. `trip` is who drove. For anything about attendance the
  answer is the union, and taking ids from the roster alone silently drops the
  people most likely to be worth a phone call.
- **A repeated status event is not a transition, and `WHERE next_at IS NOT
  NULL` throws away the newest fact you hold.** See above. The filter reads as
  hygiene — "drop the incomplete row" — and what it actually drops is the most
  recent thing the provider told you about every currently-working driver.
- **`driver_timeline_event` needs `driver_ext_id` bound.** Its only useful
  index leads on the id (`schema_v37:56`); the other is on the Dubai-DATE
  expression, so a raw `at` range matches neither and scans ~197k rows.

### One handset, four spellings, and the tel: links that could not dial it

`src/identity_link.js:72` already recorded that the channels write the same
number differently — the hotel feed as `971558089547`, Uber as
`+971558089547`, a fleet roster as `00971…` and `0558089547` — and folds the
last nine digits to match them. Nothing normalised them for **dialling**.

Five `tel:` links across both shells handed the stored string to the href.
Without a leading `+` a handset dials it as a local number: the dialler opens,
the call does not connect, and nobody reads a failed call as a data problem.
Both spellings are live in the same column on `#online-time`, three rows apart
— measured 2026-09-09.

`dialable()` in `api/public/ui.js` is now the only thing that builds a `tel:`
href, and `test/phone.test.mjs` fails if any call site dials a raw string. It
assumes a country code **only** where the number cannot be anything else — a
UAE national number (`0` + 9 digits) or a bare 9-digit mobile starting `5`.
Anything else keeps its digits and gets no `+`: a wrong country code dials a
stranger.

### Uber money at DAY grain, and the week that has not closed — 2026-09-10

**The defect.** Uber files this fleet weekly. `src/rollup.js:916` divides each
statement by the days it covers — `p.net / p.days` across
`generate_series(period_start, period_end)` — and writes one row per day into
`driver_statement_day`. For a **closed** week that is right, and `period_days`
travels beside it so a reader knows the day is an allocation.

For a week still running it fails twice over. Measured on production
2026-09-10, with the week 7–13 Sept open:

| week | filed net / day | bookings on its days |
|---|---|---|
| 31 Aug – 6 Sept (closed) | AED 25,768.69 | 665–820 |
| 7 – 13 Sept (open) | AED 4,444.39 | 675, 787, 763 |

An 83% collapse the fleet did not have. The numerator is only what Uber has
settled so far, and the denominator is all seven days — **three of which had
not happened**, so money that *was* earned is spread across days with no work
in them.

**What we already hold, and it is better.** Uber's per-trip fare is on
`trip.price` at Dubai-day grain for 88–92% of bookings (the rest are
cancellations, which correctly carry no fare). That gross **is** the
statement's own `fare` line, and the statement's net is that gross less Uber's
commission — which this fleet can *measure* rather than assume:

```
net / gross, by closed statement week, 29 Jun – 6 Sept 2026
0.7481  0.7496  0.7526  0.7372  0.7500
0.7458  0.7484  0.7497  0.7449  0.7459        mean 0.7468, spread ±1%
```

**Backtested, not asserted.** Predicting each closed week's *filed* net from
its own gross times the ratio of the weeks **before** it:

| week | predicted | Uber filed | error |
|---|---|---|---|
| 27 Jul | 92,163 | 92,550 | −0.42% |
| 3 Aug | 94,375 | 94,160 | +0.23% |
| 10 Aug | 98,051 | 98,207 | −0.16% |
| 17 Aug | 114,061 | 114,410 | −0.30% |
| 24 Aug | 131,930 | 131,414 | +0.39% |
| 31 Aug | 180,724 | 180,381 | +0.19% |

Worst error **0.42%** over six consecutive out-of-sample weeks, against a
smeared open week that is **83% low**.

**What the product does now** (`api/statement_fill_sql.js`): a day inside an
**open** statement period is answered from its own trips at the measured
commission; a day in a **closed** period keeps the statement untouched, because
that is Uber's own filed number and it reconciles against the bank wire. Both
`/api/finance/daily` and `/api/kpis` apply the same correction to the same
platform rows, so the bars and the tile above them cannot disagree. A channel
whose commission cannot be measured — no closed period, or under eight closed
days — keeps its statement and gets a sentence saying so; nothing is defaulted.

It is **not a forecast**: every fare in it is one Uber has already published
against a trip that has already run, and a day with no trips yet contributes
nothing rather than an average.

**TODAY reads low under this rule, and that is the honest answer.** The Uber
fare walk does not run on the half-hourly incremental — the payments report has
a generation cap of its own — so today's trips are not priced until the 21:00
UTC catch-up (`src/sources/uber.js:1896`, and `FARES_LAG` in
`api/public/today.js:103` is the existing sentence for it). Measured
2026-09-10 at 09:07 Dubai: 95 Uber bookings, **2 priced**. So today's derived
figure is small, its bar is drawn hollow, and it says it is still being
collected — which is true. The figure it replaced was a seventh of a partial
week, which was not today's money either; both are incomplete and only one of
them says so.

**Uber surfaces that would serve day-grain money directly, and their state:**

| surface | verdict |
|---|---|
| `POST /v1/vehicle-suppliers/transactions` | Documented POST, ≤15-min window, ≤24 h lookback, per-trip `tripUUID` + earnings. **All three of our probes issued it as a GET** and recorded the resulting 404 as "the provider has nothing". `/api/probe/uber/realtime` now asks with the documented verb across seven parameter shapes. Cannot backfill — a freshness tier, never a history one. |
| `POST /v1/vehicle-suppliers/analytics-data/query` | Documented `vs:TotalEarnings` (vehicle-only), minimum 1-hour range, no lookback wall — the best odds of the four. **Never called by anything.** |
| `getPerformanceReport` (supplier GraphQL) | Returns `totalEarnings` per driver. **Never called**; the `PerformanceReportRequest__Input` shape is recorded nowhere, and introspection is disabled. |
| `earners/payments` (REST, per day) | Serves a one-day ask, but Uber attributes an item to the period it **settles** in — sliced into days the components lose 2–3% of fare and 9–16% of tips. A measurement of settlement, not of earning. |

### Traps this added to the list

- **A weekly figure divided by seven is not a daily figure while the week is
  open.** Check whether the period has *ended* before treating its per-day
  share as a measurement. `period_days` says how long the period is; it does
  not say whether it is finished.
- **A statement period can extend into the future.** `driver_statement_day`
  carries rows for days that have not happened. Any query that takes
  `max(day)` as "the last day we hold data for" will be wrong by up to a week.
- **Detect an open period WITHOUT the display window.** A reader looking at
  1–9 Sept must still be told the 7th–9th sit in a period running to the 13th;
  a query bounded by their window sees a last day of the 9th and concludes the
  period closed.
- **Uber's commission is 25% of the fare branch and measurable per week.**
  `net = fare + service_fee`, and the service fee is exactly −25.00% of fare on
  29 of 29 sampled rows. The fleet-level net/gross lands at 0.7468 because the
  remaining spread is tips and taxes.

### Uber's live per-trip feed WORKS — the request shape, measured 2026-09-10

`POST /v1/vehicle-suppliers/transactions` returns per-trip money at sub-minute
freshness on the scope `src/config.js:125` already requests. It has been
recorded in this codebase three times as a surface that "serves nothing"; that
was our verb, then our parameter shape, then our clock.

**The one request shape that answers:**

```
POST https://api.uber.com/v1/vehicle-suppliers/transactions?org_id=<org>
Authorization: Bearer <oauth token>
Content-Type: application/json

{"filters":[{"field":"timeRange",
             "operator":"FILTER_OPERATOR_IN_RANGE",
             "value":["<epoch-ms as a STRING>","<epoch-ms as a STRING>"]}],
 "pagination_options":{"page_size":50}}
```

Everything about that is load-bearing. Each refusal below named the next
correction, which is the only reason the shape was found at all:

| what was sent | what Uber said |
|---|---|
| `GET` (what all three of our probes send) | `404 page not found` |
| POST, no `filters` | `required field filters not found in data` |
| `paginationOptions` | `required field pagination_options not found in data` |
| `value` as `{startTime,endTime}` | `ReadArrayCB: expect [ or n` — it is an ARRAY |
| `operator: 'IN_RANGE'` | `unknown enum value` — the `FILTER_OPERATOR_` prefix is required |
| `field: 'time_range'` / `'processed_at'` / `'processedAt'` | `Invalid filter passed in request` |
| numeric `value` entries | `expected string value, got ValueType(2)` |
| epoch **seconds**, ISO ±millis, RFC3339 +offset | `invalid start time` |
| a window ending at `now` | `invalid start time` — `startTime` must be **≥5 minutes old** |

So: `timeRange`, the prefixed enum, **epoch milliseconds as strings**, a window
that lags ~6 minutes, and a snake_case envelope. Rate limit 1 req/s — a sixth
attempt fired back-to-back drew `429 TooManyRequests`, which without pacing
reads as "this shape does not work".

**What a row carries** (9 transactions in a 14-minute window):

```
driverInfo      { driverUuid, firstName, lastName }
transactionInfo { transactionUuid, tripUuid, processedAt, description,
                  breakDowns[] }
description     TRIP | PERSONAL_TRANSPORT
```

`breakDowns` is the same category tree the weekly statement carries, per trip,
with amounts in **e5** (divide by 100,000 for AED):

```
paid_to_you
└── your_earnings              AED 34.61
    ├── fare                   AED 46.94
    │   ├── little_fare        AED 45.77
    │   └── wait_time          AED  1.17
    ├── service_fee           −AED 11.74
    └── taxes_earnings        −AED  0.59
```

**It independently confirms the commission this fleet derives money from.**
`service_fee / fare` on that trip is **25.01%**, and `your_earnings / fare` is
**0.7373** — inside the 0.7372–0.7526 band measured across ten closed weekly
statements, reached by a completely different route. The derived open-week
figure and this feed agree.

**Its ceiling, stated honestly.** Range ≤15 minutes, lookback ≤24 hours,
`startTime` ≥5 minutes old, 1 req/s, `page_size` 1–500. It therefore **can
never backfill**: ~96 polls per org per day with a stored cursor would keep
today current, and nothing older than 24 hours is reachable. It is a freshness
tier on top of the weekly payments walk, never a replacement for it.

**What it would fix.** Today is the one day the money chart still reads low,
because the Uber fare walk runs on the nightly catch-up rather than the
half-hourly pass — 2 of 95 bookings priced at 09:07. This feed would price them
within a minute of the trip ending.
