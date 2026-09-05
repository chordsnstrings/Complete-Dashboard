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

**2. Before ~September 2025 the coverage is partial and can never be
repaired.** Uber's report retention is about **12 months** (stated at the head
of `src/sources/uber.js`, and verified nightly by `uberAuditTick`, which walks
three windows per fleet a night so the whole retention window is re-checked
inside a week). April–August 2025 sit outside it: what is held was collected
while those months were still in range, and the walk now classifies a refusal
there as `outside retention` rather than as a hole. **This is a ceiling, not a
bug.**

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
| trips | TRIP_ACTIVITY report | ≤31-day windows | ~12 months |
| per-trip fare | PAYMENTS report | whole weeks | ~12 months |
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

---

## Known holes, with owners

| what | state | needs |
|---|---|---|
| Bolt Ecosine roster | `BOLT_CLIENT_ID is not entitled to company_id 142868` — the same token reads 142897 (Egari), so the secret is fine | the fleet-integration app in the Bolt portal to be granted 142868 |
| Yango Ecosine | `YANGO_PARK_ID` → HTTP 403 (401 without a cookie) | park entitlement |
| Uber fares, Apr–Aug 2025 | 60–97%, permanently | nothing — past retention |
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
