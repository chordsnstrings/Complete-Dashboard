# How the top drivers stay on top — a fleet analysis in SQL

The owner's question is: **who is actually in the top 10 every month, and how do they stay there regardless of seasonality?** The window is `:start` to `:end` (Sep-2025 .. Aug-2026), the fleet is ~241 people across Uber, Yango, Bolt, a hotel booking channel and FMS telematics, and the answer has to survive the fact that most of the columns you would reach for first are empty.

## 1. What the data can and cannot tell you

Read this table before any number in this document. Three of the five channels do not populate the column the obvious query would use, and every one of those gaps fails **silently** — it returns a plausible average computed over a tenth of the fleet, not an error. A fleet owner acting on a NULL-blind average would pay a bonus to the wrong driver.

| The owner asks | Answerable? | What you actually get |
|---|---|---|
| Who are my top 10 this month? | **Yes** | Completed trips per `person_key` per Dubai month. Rank on trips, on bank earnings and on AED per online hour **separately** (A2) — they are different populations, and a blended score hides which one a driver is consistent on. |
| Who is most productive per hour online? | **No — for 232 of 241 people** | `hours_online` is NULL for 232 of 241 drivers (`api/performer_routes.js:31`). Only Yango writes it (`src/sources/yango.js:61`); `driver_performance` is built from the Uber earnings breakdown, which carries trips, distance and money and no time at all. Any `avg(hours_online)` is a **Yango-only average wearing a fleet-wide label**. Proxies used throughout: active days per Dubai month, and trips per active day — both computable on every channel. |
| How long is a trip? | **No** | `trip.duration_s` is declared in the schema and written by no collector, on any platform, ever. The nearest measure is `ended_at - requested_at`, which **includes wait time**, and Bolt never sets `ended_at` at all — so the proxy silently drops a whole channel rather than shortening it. Trip size is measured in km (`has_distance`), not minutes. |
| What did the fleet earn? | **Per platform yes. Summed across platforms, no.** | `trip.price` is NULL on **every** Uber row, and Uber is most of this fleet's work. `api/income_sql.js` deliberately picks a different basis per platform: the hotel channel reports **gross fare**, Uber reports **net payout**. Adding them produces a number with no meaning. Money in Module A comes from `driver_payout_day` (the bank measure) and is always reported beside its coverage count. |
| Where is the demand? | **Yes, but only with FMS filtered out** | FMS writes GPS-inferred "twin" journeys that mirror trips the ride platforms already reported — same plate, same minute, near-identical distance. FMS supplied **62% of "corridors seen 3+ times"** (`api/analytics_routes.js:1216`). Every demand query filters `trip_norm.is_booking` (`platform <> 'fms'`); a raw `count(*) FROM trip` is roughly double the truth by construction. |
| How did they do last week / last month? | **Yes — in Dubai days, never UTC days** | The fleet's top driver has a median start hour of **01:04** (`api/performer_routes.js:20`). A UTC day boundary cuts his shift in half and files the halves under two different days and two different weeks. Everything here groups on `trip_norm.local_day` / `date_trunc('month', requested_at AT TIME ZONE 'Asia/Dubai')`. |
| Is this the same person on Uber and on Bolt? | **Yes, by folded name** | `trip.person_key` (`sql/schema_v20.sql:28`) is the canonical cross-platform identity and is indexed; it is the join key for the entire analysis. It has to be the name: Bolt trips carry no driver id whatsoever, and FMS rows carry no driver at all. Plate is **not** a person — vehicles change hands. |
| What is their acceptance / cancellation rate? | **Not as reported** | `acceptance_rate` and `cancellation_rate` are declared on `driver_performance` and written by no collector. Derived instead from outcomes: `not_completed / outcome_n` over `trip_norm.outcome`, which also catches Bolt's three failure states that contain no substring "cancel". |
| What is vehicle utilisation? | **No** | `hours_on_trip` has no writer anywhere, so `hours_on_trip / hours_online` cannot be computed. The `vehicle_utilisation` table declares the whole online-time model and is empty. Not used in this document. |

Two consequences worth stating plainly. **First:** the only measure available on every channel for every driver is the completed trip count, so it carries the primary ranking and money is reported beside it, never blended into it. **Second:** a collection outage looks exactly like a quiet month — an expired credential returns `{err:null, rows:[]}`, the same shape as nobody driving. A1 exists to make that visible before it is mistaken for behaviour.

## 2. The method — five modules

**Module A — consistency.** Who is genuinely top 10 month after month, and who spiked once and looks permanent in a year-to-date total. It builds the monthly leaderboard three independent ways, converts each driver-month into a share of that month's market, and then tests whether the *share* is steady rather than the raw count. This is the module that answers "how do they stay there": a driver whose trip count is flat while the market swings is not consistent, he is simply not following demand. The insight sits in **A5** (the seasonality-adjusted index), **A7** (the volatility test, which uses coefficient of variation rather than standard deviation so a big producer is not automatically called volatile) and **A4**, which fixes the cohort definition every later query re-derives.

**Module B — online time.** The honest treatment of the question the data cannot answer directly. `hours_online` exists for nine drivers, so B measures presence from trips instead: the span between `first_trip_at` and `last_trip_at` per driver-day out of `vehicle_driver_day`, the number of active days per month, trips per active day, and the daypart mix. It answers "do the top 10 work more hours, or the same hours better?" as far as this schema can. The insight is in **B2** (shift span per driver-day, the closest thing to a real shift the data holds) and **B4** (active days and trips per active day, which separates *showing up more* from *earning more per day shown up*).

**Module C — spatial.** Where they pick up and where they drop, from the district segment of the address string plus the coordinates that exist on hotel and FMS rows only. Pickup/dropoff area mix, corridor pairs, airport specialisation, coordinate hotspots and the chain-gap repositioning between consecutive trips. It answers whether a top driver's edge is *place* — an airport queue, a hotel corridor, a district he never leaves. **C3** (corridor pairs) and **C4** (airport specialisation) carry the finding; **C1** gates the whole module, because Bolt gives neither address nor coordinate.

**Module D — recency.** Whether the leaderboard is a story about the same people or about survivorship. Month-on-month activity and last trip per driver, a recency ladder, monthly retention by joining cohort, and a dormancy/churn watch list. It answers the quiet half of the owner's question: a "permanent" top 10 is much less impressive if the fleet under them churns every quarter. **D3** (retention by cohort) and **D4** (dormancy watch) are the ones to read.

**Module E — seasonality.** The calendar itself: `world_event` (Ramadan/Eid, school breaks, Dubai summer, high season, GDELT geopolitical news) joined to the fleet's own monthly market shape, then per-driver sensitivity to it. It answers "regardless of seasonality" directly — whether a driver's output is insulated from the season or amplified by it, whether he survives the summer trough, and how fast he comes back from a shock. **E3** (per-driver seasonality beta), **E4** (summer-trough retention ratio) and **E5** (shock drawdown and recovery, off `metric_break` with its supply-vs-demand attribution) are the headline queries.

## 3. The headline tests

Four queries answer "how do they stay top 10 regardless of seasonality" directly. Everything else is supporting evidence.

**A5 — the seasonality-adjusted performance index.** For each driver-month it computes `completed_trips / fleet_median_trips_that_month`, then per driver the mean, sd and CV of that index, the index in the 3 busiest versus the 3 quietest months, and the correlation between the driver's share and the market's level. Read `mean_adj_index` as a multiple of the median driver: **2.0 or above** is a genuine big producer, **1.0** is an ordinary month-in month-out driver. Then read `cv_adjusted`: **≤ 0.20** is a stable share of the market, **> 0.50** means the top-10 place is luck of the month. The pair `cv_raw` vs `cv_adjusted` is the actual test — `cv_raw 0.35` collapsing to `cv_adjusted 0.12` means the swing was the market's and the driver held his share; `cv_adjusted` *larger* than `cv_raw` means a flat trip count against a moving market, which reads as consistency and is actually failure to follow demand. `peak_minus_trough_index` should sit within roughly ±0.2; below `0.8 × trough` the driver is market-carried. **Never read the verdict without `peak_months_worked` and `trough_months_worked` beside it** — both must be non-zero or the query returns `UNJUDGED` by design, because an unworked peak month is absence, not evidence of decline.

**E3 — per-driver seasonality beta.** The slope of a driver's monthly index against the fleet's monthly level. **β ≈ 1.0** means he moves exactly with the market — a good driver, but a seasonal one. **β ≤ 0.3** with `mean_adj_index ≥ 2.0` is the profile the owner is asking about: high output that barely notices the calendar. **β ≥ 1.5** is an amplifier — spectacular in high season, the first to disappear in July, and the one who looks best in a year-to-date total and worst in August. Read β together with its fit: a high β with a weak fit is noise, not seasonality.

**E4 — summer-trough retention ratio.** The driver's mean monthly output across Jun–Aug divided by his own Oct–Apr mean, then divided again by the fleet's same ratio. The fleet ratio is the benchmark, typically **0.7–0.8** in Dubai. A driver at **≥ 0.9 absolute / ≥ 1.15 relative to fleet** genuinely works through the summer; **≤ 0.6 absolute / ≤ 0.85 relative** melts with everyone else and only holds his rank because his competitors melt faster. The trap: a driver on leave in August scores near zero and looks like the worst performer in the fleet, so read `months_active` in the trough window first — the ratio is only a behaviour signal when he was present.

**E5 — shock drawdown and recovery.** For each structural break in `metric_break`, the depth of the drop against the pre-break baseline and the number of months to return to within 5% of it. **Drawdown ≤ 15% recovering in ≤ 1 month** is resilience; **≥ 40% with recovery beyond 2 months, or no recovery inside the window,** is a driver whose year is made or broken by events he does not control. Read the break's supply-vs-demand attribution alongside it: a demand-side drawdown is the market happening to him, a supply-side one means he stopped driving, and those are opposite findings with the same shape in the chart.

## 4. The SQL pack

Queries are grouped by module and every one is runnable as-is with `:start` and `:end` set — no temp tables, no prior step, no manual driver list.

### MODULE A — WHO IS ACTUALLY TOP 10, AND HOW THEY STAY THERE

> Every query in this module shares one spine: bookings only (`trip_norm.is_booking`, i.e. `platform <> 'fms'`), Dubai calendar months, identity by `trip.person_key`, and money from `driver_payout_day` reported separately from trip counts. `person_key` is not exposed on `trip_norm`, so each query joins base `trip` back to `trip_norm` on `(platform, external_id)` — the same workaround `src/rollup.js` uses. Run A1 first.

#### A1. Measurement coverage audit — run before any number below

```sql
-- A1  MEASUREMENT COVERAGE AUDIT. What each channel actually populates in this window, so
-- every figure below is read against the columns that EXIST rather than the columns the schema
-- DECLARES. Distrust, in this order: hours_online (Yango writes it and nobody else -- expect a
-- single-digit driver count against a fleet of ~241); duration_s (declared, written by no
-- collector on any platform -- expect 0 on every row); price (NULL on every Uber row, and Uber
-- is most of this fleet's work); ended_at (never set by Bolt, so the ended_at - requested_at
-- proxy drops that channel entirely); fms_twin_rows (GPS mirrors of rides the ride platforms
-- already reported -- they are NOT bookings and enter nothing below).
WITH params AS (
  SELECT CAST(:start AS date) AS win_start,
         CAST(:end   AS date) AS win_end
),
rows_in_window AS (
  SELECT n.platform, n.is_booking, n.outcome, n.has_fare, n.has_distance,
         t.price, t.distance_km, t.duration_s, t.ended_at, t.requested_at,
         t.person_key, t.driver_ext_id, t.pickup_lat, t.pickup_addr
  FROM trip_norm n
  JOIN trip t ON t.platform = n.platform AND t.external_id = n.external_id
  CROSS JOIN params p
  WHERE t.requested_at IS NOT NULL
    -- Dubai day, not UTC day: the fleet's top driver has a median start hour of
    -- 01:04, so a UTC boundary moves his night onto the previous calendar date.
    AND (t.requested_at AT TIME ZONE 'Asia/Dubai')::date >= p.win_start
    AND (t.requested_at AT TIME ZONE 'Asia/Dubai')::date <= p.win_end
),
trip_cov AS (
  SELECT coalesce(platform, 'ALL_PLATFORMS')                              AS platform,
         count(*)                                                         AS rows_stored,
         count(*) FILTER (WHERE is_booking)                               AS booking_rows,
         -- FMS is telematics, not a channel: one GPS journey mirroring a ride
         -- Uber/Yango already reported. is_booking = (platform <> 'fms').
         count(*) FILTER (WHERE NOT is_booking)                           AS fms_twin_rows,
         count(*) FILTER (WHERE is_booking AND outcome = 'completed')     AS completed_bookings,
         count(*) FILTER (WHERE is_booking AND outcome IS NOT NULL)       AS outcome_known,
         count(*) FILTER (WHERE is_booking AND coalesce(person_key,'') <> '') AS rows_with_person_key,
         count(*) FILTER (WHERE is_booking AND driver_ext_id IS NOT NULL) AS rows_with_platform_driver_id,
         count(*) FILTER (WHERE is_booking AND has_fare)                  AS rows_with_usable_fare,
         count(*) FILTER (WHERE is_booking AND price IS NOT NULL)         AS rows_with_any_price,
         count(*) FILTER (WHERE is_booking AND has_distance)              AS rows_with_usable_distance,
         -- declared in the schema, written by NO collector: expect 0 on every row.
         count(*) FILTER (WHERE duration_s IS NOT NULL)                   AS rows_with_duration_s,
         -- Bolt never sets ended_at, so the ended_at - requested_at proxy drops
         -- that whole channel rather than shortening it.
         count(*) FILTER (WHERE is_booking AND ended_at IS NOT NULL)      AS rows_with_ended_at,
         round((percentile_cont(0.5) WITHIN GROUP (
                 ORDER BY extract(epoch FROM (ended_at - requested_at)) / 60.0)
               FILTER (WHERE is_booking AND ended_at IS NOT NULL
                         AND ended_at > requested_at))::numeric, 1)       AS median_req_to_end_min,
         count(*) FILTER (WHERE is_booking AND pickup_lat IS NOT NULL)    AS rows_with_coordinates,
         count(*) FILTER (WHERE is_booking AND coalesce(pickup_addr,'') <> '') AS rows_with_address
  FROM rows_in_window
  GROUP BY GROUPING SETS ((platform), ())
),
payout_cov AS (
  SELECT coalesce(d.platform, 'ALL_PLATFORMS')                            AS platform,
         count(*)                                                         AS payout_day_rows,
         count(*) FILTER (WHERE d.hours_online IS NOT NULL)               AS payout_rows_with_hours_online,
         count(*) FILTER (WHERE d.hours_on_trip IS NOT NULL)              AS payout_rows_with_hours_on_trip,
         count(*) FILTER (WHERE d.cancellation_rate IS NOT NULL)          AS payout_rows_with_cancellation_rate,
         count(DISTINCT regexp_replace(btrim(regexp_replace(lower(d.driver_name), '\s+', ' ', 'g')),
                                       '(\m\w+)( \1)+', '\1', 'g'))       AS drivers_with_payout,
         count(DISTINCT regexp_replace(btrim(regexp_replace(lower(d.driver_name), '\s+', ' ', 'g')),
                                       '(\m\w+)( \1)+', '\1', 'g'))
           FILTER (WHERE d.hours_online IS NOT NULL)                      AS drivers_with_any_online_hours,
         round(sum(d.earnings), 2)                                        AS payout_earnings_aed,
         round(sum(d.hours_online)::numeric, 1)                           AS hours_online_total
  FROM driver_payout_day d
  CROSS JOIN params p
  WHERE d.day BETWEEN p.win_start AND p.win_end
    AND coalesce(btrim(d.driver_name), '') <> ''
  GROUP BY GROUPING SETS ((d.platform), ())
)
SELECT coalesce(tc.platform, pc.platform)                                  AS platform,
       tc.rows_stored, tc.booking_rows, tc.fms_twin_rows, tc.completed_bookings,
       tc.rows_with_person_key, tc.rows_with_platform_driver_id,
       tc.rows_with_usable_fare, tc.rows_with_any_price,
       round(100.0 * tc.rows_with_usable_fare / nullif(tc.booking_rows, 0), 1) AS pct_bookings_with_fare,
       tc.rows_with_usable_distance,
       tc.rows_with_duration_s, tc.rows_with_ended_at, tc.median_req_to_end_min,
       tc.rows_with_coordinates, tc.rows_with_address,
       pc.payout_day_rows, pc.drivers_with_payout,
       pc.payout_rows_with_hours_online, pc.drivers_with_any_online_hours,
       pc.payout_rows_with_hours_on_trip, pc.payout_rows_with_cancellation_rate,
       pc.payout_earnings_aed, pc.hours_online_total,
       round(pc.payout_earnings_aed / nullif(pc.hours_online_total, 0), 2)  AS aed_per_online_hour_this_platform_only
FROM trip_cov tc
FULL JOIN payout_cov pc ON pc.platform = tc.platform
ORDER BY (coalesce(tc.platform, pc.platform) = 'ALL_PLATFORMS'), 1;
```

Read it top-down as a set of go/no-go gates. `fms_twin_rows` should be large and `booking_rows` for FMS should be zero — that is segregation working, not data loss. `rows_with_duration_s` must be 0 everywhere; if it is not, a new collector started writing it and the km-based trip-size measures below can be revisited. `pct_bookings_with_fare` will be ~100% for hotel, Yango and Bolt and **0% for Uber** — that single cell is why money is never summed across platforms in this document. The decisive one is `drivers_with_any_online_hours` against `drivers_with_payout`: on this fleet that is roughly 9 against 241, and every per-hour column in A2 and A6 is measured on that 9, not on the 241.

#### A2. Monthly leaderboard, three independent rankings

```sql
-- A2  MONTHLY LEADERBOARD, THREE INDEPENDENT RANKINGS. Top 25 per Dubai month by completed
-- trips, by bank earnings, and by earnings per online hour, kept as three separate columns and
-- NEVER blended into a composite -- a single score would hide which measure a driver is actually
-- consistent on, and would be unfalsifiable. Trips is the only measure every channel reports.
-- Money is driver_payout_day (what was WIRED TO THE BANK), not trip.price. Distrust rank_eph on
-- any row where hours_platforms is empty.
-- CORRECTED vs the reviewed draft: (1) earnings_per_online_hour divided ALL-platform bank
--     earnings by Yango-only hours -- measured at 40.30 AED/h against a true 10.00. Numerator and
--     denominator now come from the SAME driver_payout_day rows, and hours_platforms names the
--     channel that supplied them. (2) A (person, month) holding payout money but no completed
--     trip row was discarded outright, so rank_earnings could only rank people who also had trip
--     rows -- exactly the failure a credential outage produces. The driver-month spine is now a
--     UNION of trip-months and payout-months, with payout_only_month flagged.
WITH params AS (
  SELECT CAST(:start AS date) AS win_start,
         CAST(:end   AS date) AS win_end
),
months AS (
  SELECT gs::date                                              AS month,
         (gs + interval '1 month' - interval '1 day')::date     AS month_end,
         row_number() OVER (ORDER BY gs)::int                   AS month_idx,
         (least((gs + interval '1 month' - interval '1 day')::date, p.win_end)
          - greatest(gs::date, p.win_start) + 1)                AS days_observed
  FROM params p
  CROSS JOIN LATERAL generate_series(date_trunc('month', p.win_start),
                                     date_trunc('month', p.win_end),
                                     interval '1 month') AS gs
),
bookings AS (
  SELECT date_trunc('month', (t.requested_at AT TIME ZONE 'Asia/Dubai'))::date AS month,
         (t.requested_at AT TIME ZONE 'Asia/Dubai')::date                      AS local_day,
         t.person_key, t.driver_name, n.platform,
         n.outcome, n.has_fare, n.price, n.has_distance, n.distance_km
  FROM trip_norm n
  JOIN trip t ON t.platform = n.platform AND t.external_id = n.external_id
  CROSS JOIN params p
  WHERE n.is_booking
    AND t.requested_at IS NOT NULL
    AND (t.requested_at AT TIME ZONE 'Asia/Dubai')::date >= p.win_start
    AND (t.requested_at AT TIME ZONE 'Asia/Dubai')::date <= p.win_end
    AND coalesce(t.person_key, '') <> ''
),
driver_month AS (
  SELECT month, person_key,
         max(driver_name)                                              AS driver_name,
         count(*) FILTER (WHERE outcome = 'completed')                  AS completed_trips,
         count(*) FILTER (WHERE outcome = 'not_completed')              AS not_completed,
         count(*) FILTER (WHERE outcome IS NOT NULL)                    AS outcome_n,
         count(DISTINCT local_day) FILTER (WHERE outcome = 'completed') AS active_days,
         sum(price)       FILTER (WHERE has_fare AND outcome = 'completed')     AS trip_revenue,
         count(*)         FILTER (WHERE has_fare AND outcome = 'completed')     AS priced_trips,
         sum(distance_km) FILTER (WHERE has_distance AND outcome = 'completed') AS km,
         count(*)         FILTER (WHERE has_distance AND outcome = 'completed') AS measured_trips,
         array_agg(DISTINCT platform ORDER BY platform)                 AS platforms
  FROM bookings
  GROUP BY 1, 2
),
payout_month AS (
  SELECT date_trunc('month', d.day)::date AS month,
         regexp_replace(btrim(regexp_replace(lower(d.driver_name), '\s+', ' ', 'g')),
                        '(\m\w+)( \1)+', '\1', 'g')                     AS person_key,
         max(d.driver_name)   AS payout_driver_name,
         sum(d.earnings)      AS payout_earnings,
         sum(d.cash_earnings) AS payout_cash,
         sum(d.hours_online)  AS hours_online,
         sum(d.trips)         AS payout_trips,
         -- hours_online is written by src/sources/yango.js ALONE. Any per-hour
         -- ratio must take its numerator from the SAME rows that carried the hours.
         sum(d.earnings) FILTER (WHERE d.hours_online IS NOT NULL) AS earnings_with_hours,
         sum(d.trips)    FILTER (WHERE d.hours_online IS NOT NULL) AS trips_with_hours,
         array_agg(DISTINCT d.platform) FILTER (WHERE d.hours_online IS NOT NULL) AS hours_platforms
  FROM driver_payout_day d
  CROSS JOIN params p
  WHERE d.day BETWEEN p.win_start AND p.win_end
    AND coalesce(btrim(d.driver_name), '') <> ''
  GROUP BY 1, 2
),
person_month AS (   -- the SPINE: a payout month with no trip row is still a month
  SELECT month, person_key FROM driver_month
  UNION
  SELECT month, person_key FROM payout_month
),
merged AS (
  SELECT m.month_idx, m.days_observed, s.month, s.person_key,
         coalesce(dm.driver_name, pm.payout_driver_name)  AS driver_name,
         (dm.person_key IS NOT NULL)                      AS has_trip_rows,
         (dm.person_key IS NULL AND pm.person_key IS NOT NULL) AS payout_only_month,
         coalesce(dm.completed_trips, 0)                  AS completed_trips,
         coalesce(dm.not_completed, 0)                    AS not_completed,
         coalesce(dm.outcome_n, 0)                        AS outcome_n,
         coalesce(dm.active_days, 0)                      AS active_days,
         dm.trip_revenue, dm.priced_trips, dm.km, dm.measured_trips, dm.platforms,
         pm.payout_earnings, pm.payout_cash, pm.hours_online, pm.payout_trips,
         pm.earnings_with_hours, pm.trips_with_hours, pm.hours_platforms
  FROM person_month s
  JOIN months m       ON m.month = s.month
  LEFT JOIN driver_month dm ON dm.month = s.month AND dm.person_key = s.person_key
  LEFT JOIN payout_month pm ON pm.month = s.month AND pm.person_key = s.person_key
),
lb AS (
  SELECT mg.*,
         count(*) FILTER (WHERE completed_trips > 0) OVER (PARTITION BY month) AS drivers_active_that_month,
         CASE WHEN completed_trips > 0 THEN
           rank() OVER (PARTITION BY month
                        ORDER BY (CASE WHEN completed_trips > 0 THEN completed_trips END) DESC NULLS LAST,
                                 person_key)
         END AS rank_trips,
         CASE WHEN payout_earnings IS NOT NULL THEN
           rank() OVER (PARTITION BY month ORDER BY payout_earnings DESC NULLS LAST, person_key)
         END AS rank_earnings,
         CASE WHEN earnings_with_hours IS NOT NULL AND hours_online > 0 THEN
           rank() OVER (PARTITION BY month
                        ORDER BY (CASE WHEN hours_online > 0 THEN earnings_with_hours / hours_online::numeric END)
                                 DESC NULLS LAST, person_key)
         END AS rank_eph
  FROM merged mg
  WHERE completed_trips > 0 OR payout_earnings IS NOT NULL
)
SELECT month, days_observed, drivers_active_that_month,
       rank_trips, rank_earnings, rank_eph,
       driver_name, person_key, platforms,
       has_trip_rows, payout_only_month,
       completed_trips, active_days,
       round(completed_trips::numeric / nullif(active_days, 0), 2)        AS trips_per_active_day,
       not_completed,
       round(100.0 * not_completed / nullif(outcome_n, 0), 1)             AS not_completed_pct,
       round(payout_earnings, 2)                                          AS payout_earnings_aed,
       round(hours_online::numeric, 1)                                    AS hours_online,
       hours_platforms,
       round(earnings_with_hours, 2)                                      AS earnings_on_hours_reporting_platforms_aed,
       round(earnings_with_hours / nullif(hours_online::numeric, 0), 2)   AS earnings_per_online_hour,
       round(trip_revenue, 2)                                             AS trip_revenue_aed,
       priced_trips,
       round(km::numeric, 1)                                              AS km,
       measured_trips
FROM lb
WHERE rank_trips <= 25 OR rank_earnings <= 25 OR rank_eph <= 25
ORDER BY month, rank_trips NULLS LAST, rank_earnings NULLS LAST;
```

Compare the three rank columns on the same row before believing any of them. A driver who is rank 3 on trips and rank 20 on earnings is running short cheap rides; the reverse is running airport work. Where `rank_trips` is NULL and `payout_only_month` is true, the money arrived but the trips did not — that is a collection hole, and A1 will say which channel. `days_observed` matters at the edges: the first and last month of the window are partial, so their counts are not comparable to a full month without scaling.

#### A3. Rank stability per driver

```sql
-- A3  RANK STABILITY OVER THE WINDOW. Months in the top 10, longest consecutive top-10 streak,
-- mean rank, rank dispersion, best and worst month -- the difference between someone who is
-- permanently there and someone who spiked once and looks permanent in a year-to-date total.
-- Ranks are on COMPLETED TRIPS, the one measure every channel reports. A month not worked is NOT
-- dropped: for a consistency score it is the worst rank available that month, so both the honest
-- ("when active") and the penalised statistic are reported side by side.
-- FIXED: the penalised fallback used mm.ranked_n + 1, which is NULL in a month where NO driver
-- has a completed trip row -- the total-outage case it exists for -- and avg()/stddev_samp() skip
-- a NULL silently, so the outage month escaped the penalty entirely. Now coalesced to 0 + 1, with
-- months_with_no_ranked_drivers emitted so a zero-driver month is visible rather than absorbed.
WITH params AS (
  SELECT CAST(:start AS date) AS win_start,
         CAST(:end   AS date) AS win_end
),
months AS (
  SELECT gs::date                                              AS month,
         (gs + interval '1 month' - interval '1 day')::date     AS month_end,
         row_number() OVER (ORDER BY gs)::int                   AS month_idx,
         (least((gs + interval '1 month' - interval '1 day')::date, p.win_end)
          - greatest(gs::date, p.win_start) + 1)                AS days_observed
  FROM params p
  CROSS JOIN LATERAL generate_series(date_trunc('month', p.win_start),
                                     date_trunc('month', p.win_end),
                                     interval '1 month') AS gs
),
bookings AS (
  SELECT date_trunc('month', (t.requested_at AT TIME ZONE 'Asia/Dubai'))::date AS month,
         (t.requested_at AT TIME ZONE 'Asia/Dubai')::date                      AS local_day,
         t.person_key, t.driver_name, n.platform,
         n.outcome, n.has_fare, n.price, n.has_distance, n.distance_km
  FROM trip_norm n
  JOIN trip t ON t.platform = n.platform AND t.external_id = n.external_id
  CROSS JOIN params p
  WHERE n.is_booking
    AND t.requested_at IS NOT NULL
    AND (t.requested_at AT TIME ZONE 'Asia/Dubai')::date >= p.win_start
    AND (t.requested_at AT TIME ZONE 'Asia/Dubai')::date <= p.win_end
    AND coalesce(t.person_key, '') <> ''
),
driver_month AS (
  SELECT month, person_key,
         max(driver_name)                                              AS driver_name,
         count(*) FILTER (WHERE outcome = 'completed')                  AS completed_trips,
         count(*) FILTER (WHERE outcome = 'not_completed')              AS not_completed,
         count(*) FILTER (WHERE outcome IS NOT NULL)                    AS outcome_n,
         count(DISTINCT local_day) FILTER (WHERE outcome = 'completed') AS active_days,
         sum(price)       FILTER (WHERE has_fare AND outcome = 'completed')     AS trip_revenue,
         count(*)         FILTER (WHERE has_fare AND outcome = 'completed')     AS priced_trips,
         sum(distance_km) FILTER (WHERE has_distance AND outcome = 'completed') AS km,
         count(*)         FILTER (WHERE has_distance AND outcome = 'completed') AS measured_trips
  FROM bookings
  GROUP BY 1, 2
),
payout_month AS (
  SELECT date_trunc('month', d.day)::date AS month,
         regexp_replace(btrim(regexp_replace(lower(d.driver_name), '\s+', ' ', 'g')),
                        '(\m\w+)( \1)+', '\1', 'g')                     AS person_key,
         sum(d.earnings)      AS payout_earnings,
         sum(d.hours_online)  AS hours_online
  FROM driver_payout_day d
  CROSS JOIN params p
  WHERE d.day BETWEEN p.win_start AND p.win_end
    AND coalesce(btrim(d.driver_name), '') <> ''
  GROUP BY 1, 2
),
lb AS (
  SELECT m.month_idx, m.days_observed, dm.*,
         pm.payout_earnings, pm.hours_online,
         count(*) OVER (PARTITION BY dm.month) AS drivers_active_that_month,
         rank() OVER (PARTITION BY dm.month ORDER BY dm.completed_trips DESC, dm.person_key) AS rank_trips
  FROM months m
  JOIN driver_month dm ON dm.month = m.month
  LEFT JOIN payout_month pm ON pm.month = dm.month AND pm.person_key = dm.person_key
  WHERE dm.completed_trips > 0
)
, grid AS (   -- every driver x every month in the window, so an ABSENT month is visible as absent
  SELECT d.person_key, d.driver_name, m.month, m.month_idx,
         lb.rank_trips,
         coalesce(lb.completed_trips, 0)                        AS completed_trips,
         -- a month the driver did not work is not "no rank"; for a consistency score it is the
         -- worst possible rank that month, so it is penalised to last-place + 1.
         coalesce(lb.rank_trips, coalesce(mm.ranked_n, 0) + 1) AS rank_penalised,
         -- a month in which NOBODY has a completed trip row is a collection outage, not a
         -- quiet month; without coalesce(mm.ranked_n, 0) it produced a NULL that avg() and
         -- stddev_samp() skip silently, so the outage month was not penalised at all.
         mm.ranked_n                                           AS ranked_drivers_that_month
  FROM (SELECT person_key, max(driver_name) AS driver_name FROM lb GROUP BY 1) d
  CROSS JOIN months m
  LEFT JOIN lb ON lb.person_key = d.person_key AND lb.month = m.month
  LEFT JOIN (SELECT month, count(*) AS ranked_n FROM lb GROUP BY 1) mm ON mm.month = m.month
),
islands AS (   -- gaps-and-islands: consecutive top-10 months share (month_idx - row_number)
  SELECT person_key, month_idx,
         month_idx - row_number() OVER (PARTITION BY person_key ORDER BY month_idx) AS island
  FROM grid
  WHERE rank_trips <= 10
),
streaks AS (
  SELECT person_key, max(len) AS longest_top10_streak
  FROM (SELECT person_key, island, count(*) AS len FROM islands GROUP BY 1, 2) s
  GROUP BY 1
)
SELECT g.person_key,
       max(g.driver_name)                                                  AS driver_name,
       count(*)                                                            AS months_in_window,
       count(g.rank_trips)                                                 AS months_active,
       count(*) FILTER (WHERE g.rank_trips <= 3)                           AS months_top3,
       count(*) FILTER (WHERE g.rank_trips <= 10)                          AS months_top10,
       count(*) FILTER (WHERE g.rank_trips <= 30)                          AS months_top30,
       coalesce(max(st.longest_top10_streak), 0)                           AS longest_top10_streak,
       round(avg(g.rank_trips)::numeric, 2)                                AS mean_rank_when_active,
       round(stddev_samp(g.rank_trips)::numeric, 2)                        AS sd_rank_when_active,
       round(avg(g.rank_penalised)::numeric, 2)                            AS mean_rank_penalised,
       round(stddev_samp(g.rank_penalised)::numeric, 2)                    AS sd_rank_penalised,
       min(g.rank_trips)                                                   AS best_rank,
       (array_agg(g.month ORDER BY g.rank_trips ASC NULLS LAST))[1]        AS best_month,
       max(g.rank_trips)                                                   AS worst_rank_when_active,
       (array_agg(g.month ORDER BY g.rank_trips DESC NULLS LAST))[1]       AS worst_month,
       sum(g.completed_trips)                                              AS completed_trips_total,
       count(*) FILTER (WHERE g.ranked_drivers_that_month IS NULL)         AS months_with_no_ranked_drivers,
       -- the distinction the user is asking for, stated in one column
       CASE
         WHEN count(*) FILTER (WHERE g.rank_trips <= 10) >= 10 THEN 'permanent top 10'
         WHEN count(*) FILTER (WHERE g.rank_trips <= 10) >= 6  THEN 'frequent but not permanent'
         WHEN count(*) FILTER (WHERE g.rank_trips <= 10) >= 2  THEN 'volatile visitor'
         WHEN count(*) FILTER (WHERE g.rank_trips <= 10) = 1   THEN 'one-month spike'
         ELSE 'never top 10'
       END                                                                 AS stability_class
FROM grid g
LEFT JOIN streaks st ON st.person_key = g.person_key
GROUP BY g.person_key
ORDER BY months_top10 DESC, mean_rank_penalised ASC;
```

`months_top10` and `longest_top10_streak` are the two columns the owner is asking for; `mean_rank_when_active` next to `mean_rank_penalised` is where the story breaks. A driver with `mean_rank_when_active` of 4 and `mean_rank_penalised` of 30 works brilliantly and irregularly. A gap of less than 2 between the two means he was there every month. `months_with_no_ranked_drivers` greater than zero invalidates the penalised column for that driver — go back to A1.

#### A4. The cohort — permanent top 10 versus volatile

```sql
-- A4  THE COHORT. Permanent top 10 (>=10 of 12 months) vs volatile high performers (>=4) vs
-- one-month spikes vs the 11-30 chasers vs the rest. THIS CASE EXPRESSION IS RE-DERIVED
-- CHARACTER FOR CHARACTER IN A7 AND A8 -- in a module about consistency, a silently different
-- cohort rule is the exact defect the module exists to catch.
-- CORRECTED vs the reviewed draft: payout_earnings_aed was understated by every month holding
--     driver_payout_day money but no completed trip row -- measured AED 6,000 reported against
--     AED 72,200 of truth, a 92% understatement, with no coverage column beside it to show the
--     shortfall. The spine is now the UNION spine, and the money figure carries months_with_payout,
--     months_paid_but_no_trip_rows and payout_in_months_with_no_trip_rows_aed. aed_per_online_hour
--     takes its numerator from the same rows that supplied the hours.
WITH params AS (
  SELECT CAST(:start AS date) AS win_start,
         CAST(:end   AS date) AS win_end
),
months AS (
  SELECT gs::date                                              AS month,
         (gs + interval '1 month' - interval '1 day')::date     AS month_end,
         row_number() OVER (ORDER BY gs)::int                   AS month_idx,
         (least((gs + interval '1 month' - interval '1 day')::date, p.win_end)
          - greatest(gs::date, p.win_start) + 1)                AS days_observed
  FROM params p
  CROSS JOIN LATERAL generate_series(date_trunc('month', p.win_start),
                                     date_trunc('month', p.win_end),
                                     interval '1 month') AS gs
),
bookings AS (
  SELECT date_trunc('month', (t.requested_at AT TIME ZONE 'Asia/Dubai'))::date AS month,
         (t.requested_at AT TIME ZONE 'Asia/Dubai')::date                      AS local_day,
         t.person_key, t.driver_name, n.platform,
         n.outcome, n.has_fare, n.price, n.has_distance, n.distance_km
  FROM trip_norm n
  JOIN trip t ON t.platform = n.platform AND t.external_id = n.external_id
  CROSS JOIN params p
  WHERE n.is_booking
    AND t.requested_at IS NOT NULL
    AND (t.requested_at AT TIME ZONE 'Asia/Dubai')::date >= p.win_start
    AND (t.requested_at AT TIME ZONE 'Asia/Dubai')::date <= p.win_end
    AND coalesce(t.person_key, '') <> ''
),
driver_month AS (
  SELECT month, person_key,
         max(driver_name)                                              AS driver_name,
         count(*) FILTER (WHERE outcome = 'completed')                  AS completed_trips,
         count(*) FILTER (WHERE outcome = 'not_completed')              AS not_completed,
         count(*) FILTER (WHERE outcome IS NOT NULL)                    AS outcome_n,
         count(DISTINCT local_day) FILTER (WHERE outcome = 'completed') AS active_days,
         sum(price)       FILTER (WHERE has_fare AND outcome = 'completed')     AS trip_revenue,
         count(*)         FILTER (WHERE has_fare AND outcome = 'completed')     AS priced_trips,
         sum(distance_km) FILTER (WHERE has_distance AND outcome = 'completed') AS km,
         count(*)         FILTER (WHERE has_distance AND outcome = 'completed') AS measured_trips,
         array_agg(DISTINCT platform ORDER BY platform)                 AS platforms
  FROM bookings
  GROUP BY 1, 2
),
payout_month AS (
  SELECT date_trunc('month', d.day)::date AS month,
         regexp_replace(btrim(regexp_replace(lower(d.driver_name), '\s+', ' ', 'g')),
                        '(\m\w+)( \1)+', '\1', 'g')                     AS person_key,
         max(d.driver_name)   AS payout_driver_name,
         sum(d.earnings)      AS payout_earnings,
         sum(d.cash_earnings) AS payout_cash,
         sum(d.hours_online)  AS hours_online,
         sum(d.trips)         AS payout_trips,
         sum(d.earnings) FILTER (WHERE d.hours_online IS NOT NULL) AS earnings_with_hours,
         sum(d.trips)    FILTER (WHERE d.hours_online IS NOT NULL) AS trips_with_hours,
         array_agg(DISTINCT d.platform) FILTER (WHERE d.hours_online IS NOT NULL) AS hours_platforms
  FROM driver_payout_day d
  CROSS JOIN params p
  WHERE d.day BETWEEN p.win_start AND p.win_end
    AND coalesce(btrim(d.driver_name), '') <> ''
  GROUP BY 1, 2
),
person_month AS (
  SELECT month, person_key FROM driver_month
  UNION
  SELECT month, person_key FROM payout_month
),
merged AS (
  SELECT m.month_idx, m.days_observed, s.month, s.person_key,
         coalesce(dm.driver_name, pm.payout_driver_name)  AS driver_name,
         (dm.person_key IS NOT NULL)                      AS has_trip_rows,
         (dm.person_key IS NULL AND pm.person_key IS NOT NULL) AS payout_only_month,
         coalesce(dm.completed_trips, 0)                  AS completed_trips,
         coalesce(dm.not_completed, 0)                    AS not_completed,
         coalesce(dm.outcome_n, 0)                        AS outcome_n,
         coalesce(dm.active_days, 0)                      AS active_days,
         dm.trip_revenue, dm.priced_trips, dm.km, dm.measured_trips, dm.platforms,
         pm.payout_earnings, pm.payout_cash, pm.hours_online, pm.payout_trips,
         pm.earnings_with_hours, pm.trips_with_hours, pm.hours_platforms
  FROM person_month s
  JOIN months m       ON m.month = s.month
  LEFT JOIN driver_month dm ON dm.month = s.month AND dm.person_key = s.person_key
  LEFT JOIN payout_month pm ON pm.month = s.month AND pm.person_key = s.person_key
),
lb AS (
  SELECT mg.*,
         count(*) FILTER (WHERE completed_trips > 0) OVER (PARTITION BY month) AS drivers_active_that_month,
         CASE WHEN completed_trips > 0 THEN
           rank() OVER (PARTITION BY month
                        ORDER BY (CASE WHEN completed_trips > 0 THEN completed_trips END) DESC NULLS LAST,
                                 person_key)
         END AS rank_trips,
         CASE WHEN payout_earnings IS NOT NULL THEN
           rank() OVER (PARTITION BY month ORDER BY payout_earnings DESC NULLS LAST, person_key)
         END AS rank_earnings,
         CASE WHEN earnings_with_hours IS NOT NULL AND hours_online > 0 THEN
           rank() OVER (PARTITION BY month
                        ORDER BY (CASE WHEN hours_online > 0 THEN earnings_with_hours / hours_online::numeric END)
                                 DESC NULLS LAST, person_key)
         END AS rank_eph
  FROM merged mg
  WHERE completed_trips > 0 OR payout_earnings IS NOT NULL
)
, grid AS (
  SELECT d.person_key, d.driver_name, m.month, m.month_idx,
         r.rank_trips, r.rank_earnings, coalesce(r.completed_trips, 0) AS completed_trips,
         r.payout_earnings, r.hours_online, r.earnings_with_hours,
         r.active_days, r.not_completed, r.outcome_n, r.payout_only_month
  FROM (SELECT person_key, max(driver_name) AS driver_name FROM lb GROUP BY 1) d
  CROSS JOIN months m
  LEFT JOIN lb r ON r.person_key = d.person_key AND r.month = m.month
),
fleet_total AS (SELECT sum(completed_trips) AS fleet_trips FROM grid)
SELECT g.person_key,
       max(g.driver_name)                                          AS driver_name,
       count(g.rank_trips)                                         AS months_active,
       count(*) FILTER (WHERE g.rank_trips <= 10)                  AS months_top10_trips,
       count(*) FILTER (WHERE g.rank_earnings <= 10)               AS months_top10_earnings,
       min(g.rank_trips)                                           AS best_rank,
       round(avg(g.rank_trips)::numeric, 2)                        AS mean_rank,
       sum(g.completed_trips)                                      AS completed_trips_total,
       round(100.0 * sum(g.completed_trips) / nullif((SELECT fleet_trips FROM fleet_total), 0), 2)
                                                                   AS pct_of_fleet_completed_trips,
       round(sum(g.payout_earnings), 2)                            AS payout_earnings_aed,
       -- coverage for the money figure, which the reviewed version had none of
       count(*) FILTER (WHERE g.payout_earnings IS NOT NULL)       AS months_with_payout,
       count(*) FILTER (WHERE g.payout_only_month)                 AS months_paid_but_no_trip_rows,
       round(sum(g.payout_earnings) FILTER (WHERE g.payout_only_month), 2)
                                                                   AS payout_in_months_with_no_trip_rows_aed,
       count(*) FILTER (WHERE g.hours_online IS NOT NULL)          AS months_with_reported_hours,
       round(sum(g.earnings_with_hours) / nullif(sum(g.hours_online)::numeric, 0), 2)
                                                                   AS aed_per_online_hour,
       CASE
         WHEN count(*) FILTER (WHERE g.rank_trips <= 10) >= 10 THEN 'A_permanent_top10'
         WHEN count(*) FILTER (WHERE g.rank_trips <= 10) >= 4  THEN 'B_volatile_high_performer'
         WHEN count(*) FILTER (WHERE g.rank_trips <= 10) >= 1  THEN 'C_spike_only'
         WHEN min(g.rank_trips) <= 30                          THEN 'D_chaser_11_to_30'
         ELSE 'E_rest_of_fleet'
       END                                                         AS cohort
FROM grid g
GROUP BY g.person_key
ORDER BY cohort, months_top10_trips DESC, mean_rank ASC NULLS LAST;
```

Cohort A is the answer to "who is actually top 10". Expect it to be small — if it holds more than about 12 people the `>=10 of 12` rule is not biting and the fleet has no permanent core. Check `months_paid_but_no_trip_rows` before quoting anyone's earnings: if it is non-zero, that driver's trip counts and his money are describing different sets of months. `pct_of_fleet_completed_trips` summed over cohort A is the concentration number — the share of the fleet's entire output carried by the permanent core.

#### A5. Seasonality-adjusted performance index — **headline test**

```sql
-- A5  THE SEASONALITY-ADJUSTED INDEX. Is the consistency real, or is the market carrying them?
-- Each driver-month becomes trips / the fleet-wide MEDIAN trips that month, so a busy December
-- and a dead July are on the same scale; then the stability of THAT index is measured, not the
-- stability of the raw count. Read cv_raw against cv_adjusted: if the raw count swings and the
-- index does not, the swing was the market's and the driver held his share.
-- CORRECTED vs the reviewed draft: the verdict wrapped both band averages in coalesce(...,0), so
--     a driver who simply did not WORK one of the 3 busiest months was labelled
--     'MARKET-CARRIED' purely from absence, and a driver with no trough month was labelled
--     'REAL consistency - holds share in peak and trough' with zero trough evidence. Peak and
--     trough coverage are now counted and the verdict REFUSES TO JUDGE without both. An
--     unmeasured band is never coerced to zero.
WITH params AS (
  SELECT CAST(:start AS date) AS win_start,
         CAST(:end   AS date) AS win_end
),
months AS (
  SELECT gs::date                                              AS month,
         (gs + interval '1 month' - interval '1 day')::date     AS month_end,
         row_number() OVER (ORDER BY gs)::int                   AS month_idx,
         (least((gs + interval '1 month' - interval '1 day')::date, p.win_end)
          - greatest(gs::date, p.win_start) + 1)                AS days_observed
  FROM params p
  CROSS JOIN LATERAL generate_series(date_trunc('month', p.win_start),
                                     date_trunc('month', p.win_end),
                                     interval '1 month') AS gs
),
bookings AS (
  SELECT date_trunc('month', (t.requested_at AT TIME ZONE 'Asia/Dubai'))::date AS month,
         (t.requested_at AT TIME ZONE 'Asia/Dubai')::date                      AS local_day,
         t.person_key, t.driver_name, n.platform,
         n.outcome, n.has_fare, n.price, n.has_distance, n.distance_km
  FROM trip_norm n
  JOIN trip t ON t.platform = n.platform AND t.external_id = n.external_id
  CROSS JOIN params p
  WHERE n.is_booking
    AND t.requested_at IS NOT NULL
    AND (t.requested_at AT TIME ZONE 'Asia/Dubai')::date >= p.win_start
    AND (t.requested_at AT TIME ZONE 'Asia/Dubai')::date <= p.win_end
    AND coalesce(t.person_key, '') <> ''
),
driver_month AS (
  SELECT month, person_key,
         max(driver_name)                                              AS driver_name,
         count(*) FILTER (WHERE outcome = 'completed')                  AS completed_trips,
         count(*) FILTER (WHERE outcome = 'not_completed')              AS not_completed,
         count(*) FILTER (WHERE outcome IS NOT NULL)                    AS outcome_n,
         count(DISTINCT local_day) FILTER (WHERE outcome = 'completed') AS active_days
  FROM bookings
  GROUP BY 1, 2
),
market AS (
  SELECT dm.month,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY dm.completed_trips) AS median_trips,
         avg(dm.completed_trips)                                         AS mean_trips,
         count(*)                                                        AS active_drivers,
         sum(dm.completed_trips)                                         AS fleet_completed_trips
  FROM driver_month dm
  WHERE dm.completed_trips > 0
  GROUP BY 1
),
market_ranked AS (
  SELECT mk.*, m.month_idx, m.days_observed,
         rank() OVER (ORDER BY mk.median_trips DESC)     AS market_month_rank,
         count(*) OVER ()                                AS n_months
  FROM market mk JOIN months m ON m.month = mk.month
),
idx AS (
  SELECT dm.month, mr.month_idx, dm.person_key, dm.driver_name, dm.completed_trips,
         mr.median_trips, mr.fleet_completed_trips, mr.market_month_rank, mr.n_months,
         dm.completed_trips::numeric / nullif(mr.median_trips::numeric, 0) AS adj_index,
         CASE WHEN mr.market_month_rank <= 3                    THEN 'peak'
              WHEN mr.market_month_rank >  mr.n_months - 3      THEN 'trough' END AS market_band
  FROM driver_month dm
  JOIN market_ranked mr ON mr.month = dm.month
  WHERE dm.completed_trips > 0
),
agg AS (
  SELECT person_key,
         max(driver_name)                                       AS driver_name,
         count(*)                                               AS months_active,
         count(*) FILTER (WHERE market_band = 'peak')           AS peak_months_worked,
         count(*) FILTER (WHERE market_band = 'trough')         AS trough_months_worked,
         avg(completed_trips)::numeric                          AS mean_trips,
         stddev_samp(completed_trips)::numeric                  AS sd_trips,
         avg(adj_index)                                         AS mean_adj_index,
         stddev_samp(adj_index)                                 AS sd_adj_index,
         min(adj_index)                                         AS worst_index,
         max(adj_index)                                         AS best_index,
         avg(adj_index) FILTER (WHERE market_band = 'peak')     AS peak_index,
         avg(adj_index) FILTER (WHERE market_band = 'trough')   AS trough_index,
         corr(adj_index::double precision, median_trips::double precision) AS share_vs_market_corr
  FROM idx
  GROUP BY person_key
)
SELECT person_key, driver_name, months_active,
       peak_months_worked, trough_months_worked,
       round(mean_trips, 1)                                               AS mean_trips,
       round(sd_trips, 1)                                                 AS sd_trips,
       round(sd_trips / nullif(mean_trips, 0), 3)                         AS cv_raw,
       round(mean_adj_index, 3)                                           AS mean_adj_index,
       round(sd_adj_index, 3)                                             AS sd_adj_index,
       round(sd_adj_index / nullif(mean_adj_index, 0), 3)                 AS cv_adjusted,
       round(worst_index, 3)                                              AS worst_index,
       round(best_index, 3)                                               AS best_index,
       round(peak_index, 3)                                               AS index_in_3_busiest_months,
       round(trough_index, 3)                                             AS index_in_3_quietest_months,
       CASE WHEN peak_months_worked > 0 AND trough_months_worked > 0
            THEN round(peak_index - trough_index, 3) END                  AS peak_minus_trough_index,
       round(share_vs_market_corr::numeric, 3)                            AS share_vs_market_corr,
       CASE
         WHEN months_active < 6 THEN 'too few months to judge'
         -- NEVER coalesce an unmeasured band to zero: a driver who simply did not
         -- work the 3 busiest (or 3 quietest) months has no peak/trough evidence,
         -- and calling that 'MARKET-CARRIED' is an accusation manufactured from a NULL.
         WHEN peak_months_worked = 0 OR trough_months_worked = 0
           THEN 'UNJUDGED - no '
                || CASE WHEN peak_months_worked = 0 AND trough_months_worked = 0 THEN 'peak or trough'
                        WHEN peak_months_worked = 0 THEN 'peak' ELSE 'trough' END
                || ' month worked'
         WHEN sd_adj_index / nullif(mean_adj_index, 0) <= 0.20
              AND peak_index >= 0.9 * trough_index
           THEN 'REAL consistency - holds share in peak and trough'
         WHEN peak_index < 0.8 * trough_index
           THEN 'MARKET-CARRIED - flat trip count, falling share when demand rises'
         WHEN sd_trips / nullif(mean_trips, 0) <= 0.25
              AND sd_adj_index / nullif(mean_adj_index, 0) > sd_trips / nullif(mean_trips, 0)
           THEN 'RAW-FLAT, SHARE-SWINGING - the market moves and they do not'
         WHEN sd_adj_index / nullif(mean_adj_index, 0) > 0.50
           THEN 'VOLATILE - share swings month to month, top-10 place is luck of the month'
         ELSE 'mixed'
       END                                                                AS consistency_verdict
FROM agg
ORDER BY mean_adj_index DESC;
```

The good result is `mean_adj_index` at 2.0 or above with `cv_adjusted` at or below 0.20 and `peak_minus_trough_index` near zero — high output, steady share, indifferent to the season. The bad results have distinct shapes: `MARKET-CARRIED` means the raw count is flat while the market rises, so the share falls exactly when there is most work to take; `RAW-FLAT, SHARE-SWINGING` is the same driver seen from the other side. `share_vs_market_corr` near 0 means output is independent of the market's level; strongly negative means the driver is at his ceiling and cannot take the extra demand. Any row reading `UNJUDGED` has no peak or no trough month worked — that is a coverage statement, not a verdict, and must not be reported as one.

#### A6. The gap — what the top band does differently

```sql
-- A6  THE GAP, BY RANK BAND. Top 10 vs ranks 11-30 vs the rest, in raw operating numbers:
-- trips per active day, active days per month, cancellation rate, km per trip, AED per trip and
-- AED per online hour -- each printed beside the coverage count that says how many driver-months
-- it is actually measured on. distinct_drivers_seen_in_band is NOT a headcount split and does
-- NOT sum: a driver is banded per MONTH, so one person who was rank 8 in June and rank 14 in
-- July appears in two bands. The summable unit is driver-months.
-- CORRECTED vs the reviewed draft: (1) trips_per_online_hour and aed_per_online_hour put
--     all-platform trips and money over Yango-only hours -- measured 40.30 AED/h and 0.30
--     trips/h against a true 10.00 and 0.10, with driver_months_with_hours printed beside them
--     reading as though it validated them. Both ratios now take numerator and denominator from
--     the same driver_payout_day rows, and hours_reported_by_platforms names the channel.
--     (2) Driver-months with payout money but no trip rows never reached the banding at all, so
--     band money totals AND the GROUPING SETS grand total silently excluded them -- on a fixture,
--     11 driver-months holding AED 66,200. They now get their own explicit band.
WITH params AS (
  SELECT CAST(:start AS date) AS win_start,
         CAST(:end   AS date) AS win_end
),
months AS (
  SELECT gs::date                                              AS month,
         (gs + interval '1 month' - interval '1 day')::date     AS month_end,
         row_number() OVER (ORDER BY gs)::int                   AS month_idx,
         (least((gs + interval '1 month' - interval '1 day')::date, p.win_end)
          - greatest(gs::date, p.win_start) + 1)                AS days_observed
  FROM params p
  CROSS JOIN LATERAL generate_series(date_trunc('month', p.win_start),
                                     date_trunc('month', p.win_end),
                                     interval '1 month') AS gs
),
bookings AS (
  SELECT date_trunc('month', (t.requested_at AT TIME ZONE 'Asia/Dubai'))::date AS month,
         (t.requested_at AT TIME ZONE 'Asia/Dubai')::date                      AS local_day,
         t.person_key, t.driver_name, n.platform,
         n.outcome, n.has_fare, n.price, n.has_distance, n.distance_km
  FROM trip_norm n
  JOIN trip t ON t.platform = n.platform AND t.external_id = n.external_id
  CROSS JOIN params p
  WHERE n.is_booking
    AND t.requested_at IS NOT NULL
    AND (t.requested_at AT TIME ZONE 'Asia/Dubai')::date >= p.win_start
    AND (t.requested_at AT TIME ZONE 'Asia/Dubai')::date <= p.win_end
    AND coalesce(t.person_key, '') <> ''
),
driver_month AS (
  SELECT month, person_key,
         max(driver_name)                                              AS driver_name,
         count(*) FILTER (WHERE outcome = 'completed')                  AS completed_trips,
         count(*) FILTER (WHERE outcome = 'not_completed')              AS not_completed,
         count(*) FILTER (WHERE outcome IS NOT NULL)                    AS outcome_n,
         count(DISTINCT local_day) FILTER (WHERE outcome = 'completed') AS active_days,
         sum(price)       FILTER (WHERE has_fare AND outcome = 'completed')     AS trip_revenue,
         count(*)         FILTER (WHERE has_fare AND outcome = 'completed')     AS priced_trips,
         sum(distance_km) FILTER (WHERE has_distance AND outcome = 'completed') AS km,
         count(*)         FILTER (WHERE has_distance AND outcome = 'completed') AS measured_trips,
         array_agg(DISTINCT platform ORDER BY platform)                 AS platforms
  FROM bookings
  GROUP BY 1, 2
),
payout_month AS (
  SELECT date_trunc('month', d.day)::date AS month,
         regexp_replace(btrim(regexp_replace(lower(d.driver_name), '\s+', ' ', 'g')),
                        '(\m\w+)( \1)+', '\1', 'g')                     AS person_key,
         max(d.driver_name)   AS payout_driver_name,
         sum(d.earnings)      AS payout_earnings,
         sum(d.cash_earnings) AS payout_cash,
         sum(d.hours_online)  AS hours_online,
         sum(d.trips)         AS payout_trips,
         sum(d.earnings) FILTER (WHERE d.hours_online IS NOT NULL) AS earnings_with_hours,
         sum(d.trips)    FILTER (WHERE d.hours_online IS NOT NULL) AS trips_with_hours,
         array_agg(DISTINCT d.platform) FILTER (WHERE d.hours_online IS NOT NULL) AS hours_platforms
  FROM driver_payout_day d
  CROSS JOIN params p
  WHERE d.day BETWEEN p.win_start AND p.win_end
    AND coalesce(btrim(d.driver_name), '') <> ''
  GROUP BY 1, 2
),
person_month AS (
  SELECT month, person_key FROM driver_month
  UNION
  SELECT month, person_key FROM payout_month
),
merged AS (
  SELECT m.month_idx, m.days_observed, s.month, s.person_key,
         coalesce(dm.driver_name, pm.payout_driver_name)  AS driver_name,
         (dm.person_key IS NOT NULL)                      AS has_trip_rows,
         (dm.person_key IS NULL AND pm.person_key IS NOT NULL) AS payout_only_month,
         coalesce(dm.completed_trips, 0)                  AS completed_trips,
         coalesce(dm.not_completed, 0)                    AS not_completed,
         coalesce(dm.outcome_n, 0)                        AS outcome_n,
         coalesce(dm.active_days, 0)                      AS active_days,
         dm.trip_revenue, dm.priced_trips, dm.km, dm.measured_trips, dm.platforms,
         pm.payout_earnings, pm.payout_cash, pm.hours_online, pm.payout_trips,
         pm.earnings_with_hours, pm.trips_with_hours, pm.hours_platforms
  FROM person_month s
  JOIN months m       ON m.month = s.month
  LEFT JOIN driver_month dm ON dm.month = s.month AND dm.person_key = s.person_key
  LEFT JOIN payout_month pm ON pm.month = s.month AND pm.person_key = s.person_key
),
lb AS (
  SELECT mg.*,
         count(*) FILTER (WHERE completed_trips > 0) OVER (PARTITION BY month) AS drivers_active_that_month,
         CASE WHEN completed_trips > 0 THEN
           rank() OVER (PARTITION BY month
                        ORDER BY (CASE WHEN completed_trips > 0 THEN completed_trips END) DESC NULLS LAST,
                                 person_key)
         END AS rank_trips
  FROM merged mg
  WHERE completed_trips > 0 OR payout_earnings IS NOT NULL
)
, banded AS (
  SELECT lb.*,
         CASE WHEN lb.rank_trips IS NULL THEN '0_paid_but_no_trip_rows'
              WHEN lb.rank_trips <= 10   THEN '1_top10'
              WHEN lb.rank_trips <= 30   THEN '2_rank_11_30'
              ELSE                            '3_rank_31_plus' END AS band
  FROM lb
)
SELECT coalesce(band, 'ALL_DRIVER_MONTHS')                                        AS band,
       count(*)                                                                   AS driver_months,
       -- NOT summable across bands: a driver is banded per MONTH and can sit in
       -- more than one band over the window.
       count(DISTINCT person_key)                                                 AS distinct_drivers_seen_in_band,
       count(*) FILTER (WHERE completed_trips > 0)                                AS driver_months_with_trip_rows,
       round(avg(completed_trips) FILTER (WHERE completed_trips > 0)::numeric, 1) AS avg_completed_trips_per_month,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY completed_trips)
             FILTER (WHERE completed_trips > 0)::numeric, 1)                      AS median_completed_trips_per_month,
       round(avg(active_days) FILTER (WHERE completed_trips > 0)::numeric, 1)     AS avg_active_days_per_month,
       round(sum(completed_trips)::numeric / nullif(sum(active_days), 0), 2)      AS trips_per_active_day,
       round(100.0 * sum(not_completed)::numeric / nullif(sum(outcome_n), 0), 2)  AS not_completed_pct,
       round(sum(km)::numeric / nullif(sum(measured_trips), 0), 2)                AS km_per_completed_trip,
       count(*) FILTER (WHERE priced_trips > 0)                                   AS driver_months_with_a_fare,
       round(sum(trip_revenue) / nullif(sum(priced_trips), 0), 2)                 AS aed_per_priced_trip,
       count(*) FILTER (WHERE payout_earnings IS NOT NULL)                        AS driver_months_with_payout,
       round(sum(payout_earnings) / nullif(count(*) FILTER (WHERE payout_earnings IS NOT NULL), 0), 2)
                                                                                  AS avg_payout_per_month_aed,
       round(sum(payout_earnings) FILTER (WHERE payout_earnings IS NOT NULL AND completed_trips > 0)
             / nullif(sum(completed_trips) FILTER (WHERE payout_earnings IS NOT NULL AND completed_trips > 0), 0), 2)
                                                                                  AS aed_per_completed_trip,
       count(*) FILTER (WHERE hours_online IS NOT NULL)                           AS driver_months_with_hours,
       string_agg(DISTINCT array_to_string(hours_platforms, '+'), ', ')           AS hours_reported_by_platforms,
       round(avg(hours_online) FILTER (WHERE hours_online IS NOT NULL)::numeric, 1)
                                                                                  AS avg_hours_online_per_month,
       -- numerator restricted to the SAME driver_payout_day rows that carried the
       -- hours (Yango only); using trip counts or all-platform earnings here mixes
       -- Uber volume/money into a Yango-only denominator.
       round(sum(trips_with_hours)::numeric
             / nullif(sum(hours_online)::numeric, 0), 2)                          AS platform_trips_per_online_hour,
       round(sum(earnings_with_hours)
             / nullif(sum(hours_online)::numeric, 0), 2)                          AS aed_per_online_hour
FROM banded
GROUP BY GROUPING SETS ((band), ())
ORDER BY 1;
```

The interesting comparison is `avg_active_days_per_month` against `trips_per_active_day`. If the top band is separated by active days, the edge is **showing up**; if by trips per active day, the edge is **density** — better positioning, shorter gaps, less deadhead, and Modules B and C explain it. Both elevated means both. `km_per_completed_trip` distinguishes long-haul airport work from short urban churn at the same trip count. Treat `aed_per_online_hour` as a Yango-only figure always: read `hours_reported_by_platforms` first, and if `driver_months_with_hours` is small relative to `driver_months`, the column describes a handful of people.

#### A7. The volatility test

```sql
-- A7  THE VOLATILITY TEST. Is the top cohort genuinely steadier month to month, or does it just
-- have a higher mean with the same volatility? Standard deviation alone CANNOT answer this: a
-- driver doing 120 trips a month has a larger sd than one doing 20 even when both swing by the
-- same percentage. Three scale-free measures instead -- cv of the raw count, cv of the
-- seasonality-adjusted share, and the dispersion of month-over-month change. If the top cohort
-- merely had a bigger mean, avg_sd_trips would scale with avg_mean_trips and avg_cv_trips would
-- come out FLAT across cohorts. A materially lower cv in cohort A is the only result that
-- supports "genuinely more stable". A zero month counts only INSIDE the driver's own tenure.
-- FIXED: the month-over-month change was (curr - prev) / prev, which is undefined when prev = 0,
-- so a driver's RECOVERY out of a zero month was silently dropped while the COLLAPSE into it was
-- kept at exactly -100%. Every dispersion figure was therefore biased DOWNWARD for the most
-- volatile drivers -- the opposite of what this query is asked to detect. Now a symmetric percent
-- change over the mean of the two months, with avg_mom_observations as its denominator.
WITH params AS (
  SELECT CAST(:start AS date) AS win_start,
         CAST(:end   AS date) AS win_end
),
months AS (
  SELECT gs::date                                              AS month,
         (gs + interval '1 month' - interval '1 day')::date     AS month_end,
         row_number() OVER (ORDER BY gs)::int                   AS month_idx,
         (least((gs + interval '1 month' - interval '1 day')::date, p.win_end)
          - greatest(gs::date, p.win_start) + 1)                AS days_observed
  FROM params p
  CROSS JOIN LATERAL generate_series(date_trunc('month', p.win_start),
                                     date_trunc('month', p.win_end),
                                     interval '1 month') AS gs
),
bookings AS (
  SELECT date_trunc('month', (t.requested_at AT TIME ZONE 'Asia/Dubai'))::date AS month,
         (t.requested_at AT TIME ZONE 'Asia/Dubai')::date                      AS local_day,
         t.person_key, t.driver_name, n.platform,
         n.outcome, n.has_fare, n.price, n.has_distance, n.distance_km
  FROM trip_norm n
  JOIN trip t ON t.platform = n.platform AND t.external_id = n.external_id
  CROSS JOIN params p
  WHERE n.is_booking
    AND t.requested_at IS NOT NULL
    AND (t.requested_at AT TIME ZONE 'Asia/Dubai')::date >= p.win_start
    AND (t.requested_at AT TIME ZONE 'Asia/Dubai')::date <= p.win_end
    AND coalesce(t.person_key, '') <> ''
),
driver_month AS (
  SELECT month, person_key,
         max(driver_name)                                              AS driver_name,
         count(*) FILTER (WHERE outcome = 'completed')                  AS completed_trips,
         count(*) FILTER (WHERE outcome = 'not_completed')              AS not_completed,
         count(*) FILTER (WHERE outcome IS NOT NULL)                    AS outcome_n,
         count(DISTINCT local_day) FILTER (WHERE outcome = 'completed') AS active_days,
         sum(price)       FILTER (WHERE has_fare AND outcome = 'completed')     AS trip_revenue,
         count(*)         FILTER (WHERE has_fare AND outcome = 'completed')     AS priced_trips,
         sum(distance_km) FILTER (WHERE has_distance AND outcome = 'completed') AS km,
         count(*)         FILTER (WHERE has_distance AND outcome = 'completed') AS measured_trips
  FROM bookings
  GROUP BY 1, 2
),
payout_month AS (
  SELECT date_trunc('month', d.day)::date AS month,
         regexp_replace(btrim(regexp_replace(lower(d.driver_name), '\s+', ' ', 'g')),
                        '(\m\w+)( \1)+', '\1', 'g')                     AS person_key,
         sum(d.earnings)      AS payout_earnings,
         sum(d.hours_online)  AS hours_online
  FROM driver_payout_day d
  CROSS JOIN params p
  WHERE d.day BETWEEN p.win_start AND p.win_end
    AND coalesce(btrim(d.driver_name), '') <> ''
  GROUP BY 1, 2
),
lb AS (
  SELECT m.month_idx, m.days_observed, dm.*,
         pm.payout_earnings, pm.hours_online,
         count(*) OVER (PARTITION BY dm.month) AS drivers_active_that_month,
         rank() OVER (PARTITION BY dm.month ORDER BY dm.completed_trips DESC, dm.person_key) AS rank_trips
  FROM months m
  JOIN driver_month dm ON dm.month = m.month
  LEFT JOIN payout_month pm ON pm.month = dm.month AND pm.person_key = dm.person_key
  WHERE dm.completed_trips > 0
)
, market AS (
  SELECT dm.month,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY dm.completed_trips) AS median_trips
  FROM driver_month dm WHERE dm.completed_trips > 0 GROUP BY 1
),
cohort AS (   -- same rule as the cohort query: >=10 of 12 months in the top 10
  SELECT person_key,
         CASE WHEN count(*) FILTER (WHERE rank_trips <= 10) >= 10 THEN 'A_permanent_top10'
              WHEN count(*) FILTER (WHERE rank_trips <= 10) >= 4  THEN 'B_volatile_high_performer'
              WHEN count(*) FILTER (WHERE rank_trips <= 10) >= 1  THEN 'C_spike_only'
              WHEN min(rank_trips) <= 30                          THEN 'D_chaser_11_to_30'
              ELSE 'E_rest_of_fleet' END AS cohort
  FROM lb GROUP BY person_key
),
tenure AS (   -- only months between a driver's first and last active month count as a zero;
              -- months before they joined are not volatility, they are absence.
  SELECT person_key, min(month_idx) AS first_idx, max(month_idx) AS last_idx
  FROM lb GROUP BY person_key
),
series AS (
  SELECT t.person_key, m.month, m.month_idx,
         coalesce(lb.completed_trips, 0)                                          AS completed_trips,
         coalesce(lb.completed_trips, 0)::numeric / nullif(mk.median_trips::numeric, 0) AS adj_index
  FROM tenure t
  JOIN months m ON m.month_idx BETWEEN t.first_idx AND t.last_idx
  LEFT JOIN lb ON lb.person_key = t.person_key AND lb.month = m.month
  LEFT JOIN market mk ON mk.month = m.month
),
deltas AS (
  SELECT s.*,
         lag(completed_trips) OVER (PARTITION BY person_key ORDER BY month_idx) AS prev_trips,
         -- SYMMETRIC percent change, over the mean of the two months. The plain
         -- (curr - prev) / prev is undefined when prev = 0, so a driver's RECOVERY out of a
         -- zero month was dropped while the COLLAPSE into it was kept at exactly -100% --
         -- biasing every dispersion figure DOWNWARD for the most volatile drivers, which is
         -- the opposite of what this query is asked to detect. NULL only when both months are 0.
         (completed_trips - lag(completed_trips) OVER (PARTITION BY person_key ORDER BY month_idx))::numeric
           / nullif((completed_trips + lag(completed_trips) OVER (PARTITION BY person_key ORDER BY month_idx))::numeric / 2, 0)
                                                                                 AS mom_pct
  FROM series s
),
per_driver AS (
  SELECT d.person_key,
         count(*)                                                    AS months_in_tenure,
         avg(d.completed_trips)::numeric                             AS mean_trips,
         stddev_samp(d.completed_trips)::numeric                     AS sd_trips,
         stddev_samp(d.completed_trips)::numeric
           / nullif(avg(d.completed_trips)::numeric, 0)              AS cv_trips,
         avg(d.adj_index)                                            AS mean_adj_index,
         stddev_samp(d.adj_index)                                    AS sd_adj_index,
         stddev_samp(d.adj_index) / nullif(avg(d.adj_index), 0)      AS cv_adj_index,
         stddev_samp(d.mom_pct)                                      AS sd_mom_pct,
         avg(abs(d.mom_pct))                                         AS mean_abs_mom_pct,
         max(abs(d.mom_pct))                                         AS worst_mom_swing,
         count(d.mom_pct)                                            AS mom_observations
  FROM deltas d
  GROUP BY d.person_key
)
SELECT coalesce(c.cohort, 'ALL_DRIVERS') AS cohort,
       count(*)                                                          AS drivers,
       round(avg(p.months_in_tenure)::numeric, 1)                        AS avg_months_in_tenure,
       round(avg(p.mom_observations)::numeric, 1)                        AS avg_mom_observations,
       round(avg(p.mean_trips), 1)                                       AS avg_mean_trips,
       round(avg(p.sd_trips), 1)                                         AS avg_sd_trips,
       -- IF the top cohort only had a HIGHER MEAN with the same volatility, avg_sd_trips would
       -- scale with avg_mean_trips and cv would be flat across cohorts. It is cv, not sd, that
       -- settles the question.
       round(avg(p.cv_trips), 3)                                         AS avg_cv_trips,
       round((percentile_cont(0.5) WITHIN GROUP (ORDER BY p.cv_trips))::numeric, 3) AS median_cv_trips,
       round(avg(p.cv_adj_index), 3)                                     AS avg_cv_share_of_market,
       round(avg(p.sd_mom_pct) * 100, 1)                                 AS avg_sd_month_on_month_pct,
       round(avg(p.mean_abs_mom_pct) * 100, 1)                           AS avg_abs_month_on_month_pct,
       round((percentile_cont(0.5) WITHIN GROUP (ORDER BY p.worst_mom_swing))::numeric * 100, 1)
                                                                         AS median_worst_month_swing_pct
FROM per_driver p
JOIN cohort c ON c.person_key = p.person_key
GROUP BY GROUPING SETS ((c.cohort), ())
ORDER BY 1 NULLS LAST;
```

Compare `avg_cv_trips` across the cohort rows, not `avg_sd_trips`. A cohort A value below about 0.25 against a fleet value near 0.5 is real stability; values within 0.05 of each other mean the top cohort is simply bigger, and the "consistency" in the leaderboard is an artefact of scale. `avg_cv_share_of_market` below `avg_cv_trips` for cohort A says their swings were the market's swings. Check `avg_mom_observations` before reading the month-over-month columns: a cohort averaging 3 observations per driver is describing noise.

#### A8. Cohort index by event month — seasonality, holidays and shocks

```sql
-- A8  DOES THE PERMANENT COHORT HOLD ITS SHARE THROUGH RAMADAN, EID, SCHOOL BREAKS, DUBAI
-- SUMMER AND GEOPOLITICAL NEWS MONTHS? world_event is the only usable calendar here --
-- calendar_day.is_holiday is never written by anything.
-- CORRECTED vs the reviewed draft: (1) the cohort index averaged only the members who were
--     ACTIVE that month, so a permanent-top-10 driver taking Ramadan off -- a market share of
--     ZERO -- left the index unchanged, and the one behaviour that answers the question was the
--     one the aggregate hid. The index is now ZERO-FILLED inside each driver's own tenure, with
--     the workers-only figure kept beside it and per-cohort headcounts published, so "index 2.3
--     in Ramadan" can be told apart from "half of them did not work and the strong half carried
--     it". (2) The cohort CASE now matches A4/A7 character for character instead of collapsing
--     three buckets into one.
WITH params AS (
  SELECT CAST(:start AS date) AS win_start,
         CAST(:end   AS date) AS win_end
),
months AS (
  SELECT gs::date                                              AS month,
         (gs + interval '1 month' - interval '1 day')::date     AS month_end,
         row_number() OVER (ORDER BY gs)::int                   AS month_idx,
         (least((gs + interval '1 month' - interval '1 day')::date, p.win_end)
          - greatest(gs::date, p.win_start) + 1)                AS days_observed
  FROM params p
  CROSS JOIN LATERAL generate_series(date_trunc('month', p.win_start),
                                     date_trunc('month', p.win_end),
                                     interval '1 month') AS gs
),
bookings AS (
  SELECT date_trunc('month', (t.requested_at AT TIME ZONE 'Asia/Dubai'))::date AS month,
         (t.requested_at AT TIME ZONE 'Asia/Dubai')::date                      AS local_day,
         t.person_key, t.driver_name, n.platform,
         n.outcome, n.has_fare, n.price, n.has_distance, n.distance_km
  FROM trip_norm n
  JOIN trip t ON t.platform = n.platform AND t.external_id = n.external_id
  CROSS JOIN params p
  WHERE n.is_booking
    AND t.requested_at IS NOT NULL
    AND (t.requested_at AT TIME ZONE 'Asia/Dubai')::date >= p.win_start
    AND (t.requested_at AT TIME ZONE 'Asia/Dubai')::date <= p.win_end
    AND coalesce(t.person_key, '') <> ''
),
driver_month AS (
  SELECT month, person_key,
         max(driver_name)                                              AS driver_name,
         count(*) FILTER (WHERE outcome = 'completed')                  AS completed_trips,
         count(*) FILTER (WHERE outcome IS NOT NULL)                    AS outcome_n,
         count(DISTINCT local_day) FILTER (WHERE outcome = 'completed') AS active_days
  FROM bookings
  GROUP BY 1, 2
),
lb AS (
  SELECT m.month_idx, dm.*,
         rank() OVER (PARTITION BY dm.month ORDER BY dm.completed_trips DESC, dm.person_key) AS rank_trips
  FROM months m
  JOIN driver_month dm ON dm.month = m.month
  WHERE dm.completed_trips > 0
),
market AS (
  SELECT dm.month,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY dm.completed_trips) AS median_trips,
         count(*)                                                        AS active_drivers,
         sum(dm.completed_trips)                                          AS fleet_completed_trips
  FROM driver_month dm WHERE dm.completed_trips > 0 GROUP BY 1
),
cohort AS (   -- identical CASE to A4/A7; the rest bucket is not collapsed
  SELECT person_key,
         CASE WHEN count(*) FILTER (WHERE rank_trips <= 10) >= 10 THEN 'A_permanent_top10'
              WHEN count(*) FILTER (WHERE rank_trips <= 10) >= 4  THEN 'B_volatile_high_performer'
              WHEN count(*) FILTER (WHERE rank_trips <= 10) >= 1  THEN 'C_spike_only'
              WHEN min(rank_trips) <= 30                          THEN 'D_chaser_11_to_30'
              ELSE 'E_rest_of_fleet' END AS cohort,
         min(month_idx) FILTER (WHERE completed_trips > 0) AS first_idx,
         max(month_idx) FILTER (WHERE completed_trips > 0) AS last_idx
  FROM lb GROUP BY person_key
),
cohort_size AS (
  SELECT cohort, count(*) AS roster FROM cohort GROUP BY 1
),
-- Zero-filled inside each driver's own tenure: a cohort member who took the month
-- off had a share of ZERO that month. Averaging only the members who WORKED
-- answers 'how did the survivors do', not 'did the cohort hold its share'.
roster_month AS (
  SELECT c.person_key, c.cohort, m.month, m.month_idx,
         coalesce(lb.completed_trips, 0)::numeric
           / nullif(mk.median_trips::numeric, 0)                       AS adj_index_zero_filled,
         (lb.completed_trips > 0)                                      AS worked
  FROM cohort c
  JOIN months m ON m.month_idx BETWEEN c.first_idx AND c.last_idx
  LEFT JOIN lb  ON lb.person_key = c.person_key AND lb.month = m.month
  LEFT JOIN market mk ON mk.month = m.month
),
by_month AS (
  SELECT month, month_idx,
         count(*) FILTER (WHERE cohort = 'A_permanent_top10')                      AS n_permanent_in_tenure,
         count(*) FILTER (WHERE cohort = 'A_permanent_top10' AND worked)           AS n_permanent_worked,
         count(*) FILTER (WHERE cohort = 'B_volatile_high_performer' AND worked)   AS n_volatile_worked,
         count(*) FILTER (WHERE cohort NOT IN ('A_permanent_top10','B_volatile_high_performer') AND worked)
                                                                                   AS n_rest_worked,
         avg(adj_index_zero_filled) FILTER (WHERE cohort = 'A_permanent_top10')         AS idx_permanent,
         avg(adj_index_zero_filled) FILTER (WHERE cohort = 'A_permanent_top10' AND worked) AS idx_permanent_worked_only,
         avg(adj_index_zero_filled) FILTER (WHERE cohort = 'B_volatile_high_performer')  AS idx_volatile,
         avg(adj_index_zero_filled) FILTER (WHERE cohort NOT IN ('A_permanent_top10','B_volatile_high_performer'))
                                                                                        AS idx_rest
  FROM roster_month
  GROUP BY month, month_idx
),
event_month AS (   -- world_event is the only usable calendar; calendar_day.is_holiday is never written
  SELECT m.month, m.month_idx,
         coalesce(bool_or(e.code IN ('ramadan', 'eid_fitr')), false)              AS ramadan_or_eid,
         coalesce(bool_or(e.code IN ('school_summer_break','school_winter_break')), false) AS school_break,
         coalesce(bool_or(e.code = 'summer'), false)                             AS dubai_summer,
         coalesce(bool_or(e.code = 'high_season'), false)                        AS high_season,
         coalesce(bool_or(e.category = 'geopolitical' AND coalesce(e.confidence,0) >= 0.5), false) AS conflict_or_war_news,
         count(*) FILTER (WHERE e.source = 'news' AND coalesce(e.confidence, 0) >= 0.5) AS news_events,
         (array_agg(DISTINCT e.code) FILTER (WHERE e.code IS NOT NULL))         AS event_codes
  FROM months m
  LEFT JOIN world_event e
    ON e.starts_on <= m.month_end
   AND coalesce(e.ends_on, e.starts_on) >= m.month
  GROUP BY m.month, m.month_idx
)
SELECT bm.month,
       mk.active_drivers,
       mk.fleet_completed_trips,
       round(mk.median_trips::numeric, 1)                               AS fleet_median_trips,
       round(100.0 * (mk.median_trips::numeric
             / nullif(avg(mk.median_trips::numeric) OVER (), 0) - 1), 1) AS market_vs_year_pct,
       (SELECT roster FROM cohort_size WHERE cohort = 'A_permanent_top10') AS permanent_cohort_size,
       bm.n_permanent_in_tenure, bm.n_permanent_worked,
       round(bm.idx_permanent, 3)                                       AS permanent_top10_index,
       round(bm.idx_permanent_worked_only, 3)                           AS permanent_index_workers_only,
       round(bm.idx_permanent - avg(bm.idx_permanent) OVER (), 3)       AS permanent_vs_own_year_avg,
       bm.n_volatile_worked,
       round(bm.idx_volatile, 3)                                        AS volatile_high_index,
       bm.n_rest_worked,
       round(bm.idx_rest, 3)                                            AS rest_of_fleet_index,
       em.ramadan_or_eid, em.school_break, em.dubai_summer, em.high_season,
       em.conflict_or_war_news, em.news_events, em.event_codes
FROM by_month bm
JOIN market mk      ON mk.month = bm.month
JOIN event_month em ON em.month = bm.month
ORDER BY bm.month;
```

Read `permanent_top10_index` against `permanent_index_workers_only` in every flagged month. Equal values mean the whole cohort worked. A zero-filled index well below the workers-only figure means the cohort held its rank by attrition — the ones who showed up were strong, the rest were absent — and that is a different answer to the owner's question than "they work through it". `n_permanent_worked` against `n_permanent_in_tenure` is the same fact as a headcount. `market_vs_year_pct` gives the size of the season being survived: holding an index of 2.0 through a month at -35% is the result worth paying for.

#### A9. Top-10 churn — entries and exits

```sql
-- A9  TOP-10 CHURN. The blunt version of "do the same ten people hold the board". Entries,
-- exits and movement inside the ten, measured against the PREVIOUS month -- so the first month of
-- the window necessarily reports 100% entrants because it has no predecessor. READ FROM MONTH 2
-- ON. Low movement with zero churn is a frozen board; high movement with zero churn is the same
-- ten people trading places among themselves.
WITH params AS (
  SELECT CAST(:start AS date) AS win_start,
         CAST(:end   AS date) AS win_end
),
months AS (
  SELECT gs::date                                              AS month,
         (gs + interval '1 month' - interval '1 day')::date     AS month_end,
         row_number() OVER (ORDER BY gs)::int                   AS month_idx,
         (least((gs + interval '1 month' - interval '1 day')::date, p.win_end)
          - greatest(gs::date, p.win_start) + 1)                AS days_observed
  FROM params p
  CROSS JOIN LATERAL generate_series(date_trunc('month', p.win_start),
                                     date_trunc('month', p.win_end),
                                     interval '1 month') AS gs
),
bookings AS (
  SELECT date_trunc('month', (t.requested_at AT TIME ZONE 'Asia/Dubai'))::date AS month,
         (t.requested_at AT TIME ZONE 'Asia/Dubai')::date                      AS local_day,
         t.person_key, t.driver_name, n.platform,
         n.outcome, n.has_fare, n.price, n.has_distance, n.distance_km
  FROM trip_norm n
  JOIN trip t ON t.platform = n.platform AND t.external_id = n.external_id
  CROSS JOIN params p
  WHERE n.is_booking
    AND t.requested_at IS NOT NULL
    AND (t.requested_at AT TIME ZONE 'Asia/Dubai')::date >= p.win_start
    AND (t.requested_at AT TIME ZONE 'Asia/Dubai')::date <= p.win_end
    AND coalesce(t.person_key, '') <> ''
),
driver_month AS (
  SELECT month, person_key,
         max(driver_name)                                              AS driver_name,
         count(*) FILTER (WHERE outcome = 'completed')                  AS completed_trips,
         count(*) FILTER (WHERE outcome = 'not_completed')              AS not_completed,
         count(*) FILTER (WHERE outcome IS NOT NULL)                    AS outcome_n,
         count(DISTINCT local_day) FILTER (WHERE outcome = 'completed') AS active_days,
         sum(price)       FILTER (WHERE has_fare AND outcome = 'completed')     AS trip_revenue,
         count(*)         FILTER (WHERE has_fare AND outcome = 'completed')     AS priced_trips,
         sum(distance_km) FILTER (WHERE has_distance AND outcome = 'completed') AS km,
         count(*)         FILTER (WHERE has_distance AND outcome = 'completed') AS measured_trips
  FROM bookings
  GROUP BY 1, 2
),
payout_month AS (
  SELECT date_trunc('month', d.day)::date AS month,
         regexp_replace(btrim(regexp_replace(lower(d.driver_name), '\s+', ' ', 'g')),
                        '(\m\w+)( \1)+', '\1', 'g')                     AS person_key,
         sum(d.earnings)      AS payout_earnings,
         sum(d.hours_online)  AS hours_online
  FROM driver_payout_day d
  CROSS JOIN params p
  WHERE d.day BETWEEN p.win_start AND p.win_end
    AND coalesce(btrim(d.driver_name), '') <> ''
  GROUP BY 1, 2
),
lb AS (
  SELECT m.month_idx, m.days_observed, dm.*,
         pm.payout_earnings, pm.hours_online,
         count(*) OVER (PARTITION BY dm.month) AS drivers_active_that_month,
         rank() OVER (PARTITION BY dm.month ORDER BY dm.completed_trips DESC, dm.person_key) AS rank_trips
  FROM months m
  JOIN driver_month dm ON dm.month = m.month
  LEFT JOIN payout_month pm ON pm.month = dm.month AND pm.person_key = dm.person_key
  WHERE dm.completed_trips > 0
)
, grid AS (   -- driver x month, ranks NULL where the driver did not work that month
  SELECT d.person_key, d.driver_name, m.month, m.month_idx, lb.rank_trips,
         coalesce(lb.completed_trips, 0) AS completed_trips
  FROM (SELECT person_key, max(driver_name) AS driver_name FROM lb GROUP BY 1) d
  CROSS JOIN months m
  LEFT JOIN lb ON lb.person_key = d.person_key AND lb.month = m.month
),
moves AS (
  SELECT g.*,
         lag(g.rank_trips) OVER (PARTITION BY g.person_key ORDER BY g.month_idx) AS prev_rank,
         (g.rank_trips <= 10)                                                     AS in_top10,
         (lag(g.rank_trips) OVER (PARTITION BY g.person_key ORDER BY g.month_idx) <= 10) AS was_top10
  FROM grid g
)
SELECT month,
       count(*) FILTER (WHERE in_top10)                                       AS top10_size,
       count(*) FILTER (WHERE in_top10 AND coalesce(was_top10, false))        AS held_place,
       count(*) FILTER (WHERE in_top10 AND NOT coalesce(was_top10, false))    AS entered,
       count(*) FILTER (WHERE coalesce(was_top10, false) AND NOT coalesce(in_top10, false)) AS dropped_out,
       -- churn is the honest headline: 0% means the same ten people every month
       round(100.0 * count(*) FILTER (WHERE in_top10 AND NOT coalesce(was_top10, false))
             / nullif(count(*) FILTER (WHERE in_top10), 0), 1)                 AS pct_of_top10_new_this_month,
       string_agg(driver_name, ', ' ORDER BY rank_trips)
         FILTER (WHERE in_top10 AND NOT coalesce(was_top10, false))            AS entrants,
       string_agg(driver_name, ', ' ORDER BY prev_rank)
         FILTER (WHERE coalesce(was_top10, false) AND NOT coalesce(in_top10, false)) AS leavers,
       -- how far the people who stayed actually moved inside the ten
       round((avg(abs(rank_trips - prev_rank))
              FILTER (WHERE in_top10 AND coalesce(was_top10, false)))::numeric, 2)
                                                                               AS avg_rank_move_within_top10,
       max(abs(rank_trips - prev_rank)) FILTER (WHERE in_top10 AND coalesce(was_top10, false))
                                                                               AS max_rank_move_within_top10
FROM moves
GROUP BY month
ORDER BY month;
```

`pct_of_top10_new_this_month` is the headline: sustained values under 20% mean a genuinely stable top 10, values above 50% mean the board is re-drawn every month and no one is permanently anything. Read it with `avg_rank_move_within_top10` — near zero churn with movement of 3 or more places means the membership is fixed but the order is not, which is competition inside a stable core rather than stagnation. The `entrants` and `leavers` name lists are for spot-checking against A1: a whole cohort of leavers in one month is usually a collection hole, not a walkout.

### MODULE B — ONLINE TIME: WHEN THEY START, HOW LONG THEY STAY

> **This is the module the data constrains hardest, and you should read every number in it as an estimate.** There is no shift, session, login, logout or break table anywhere in the schema — nothing in this database records a driver going online or offline. `driver_performance.hours_online` is NULL for **232 of 241 people** (`api/performer_routes.js:31`); the only writer in the codebase is `src/sources/yango.js:61`, and `driver_performance` is otherwise built from the earnings breakdown — trips, distance, money. Any `avg(hours_online)` computed over this fleet silently reports Yango drivers only. `driver_performance.hours_on_trip` has no writer at all. `vehicle_utilisation`, the richest online-time schema in the database, is declared and never written, which is why `src/insights.js:122` and `api/vehicle_routes.js:312` always return nothing.
>
> So every session below is **derived**: from telemetry ignition where a tracker exists (B2), and from trip-gap sessionisation everywhere else (B4). A **session** in this module means *observed working time* — the driver demonstrably had the car running, or was taking and finishing jobs. It never means "logged in". The gap that splits one session from the next is a **parameter, not a platform fact**; B3 exists to show you how much the answer moves when you change it. And because a trip-bounded session cannot see the log-in before the first job or the log-out after the last, session length is always a **lower bound** on online time.
>
> Standing rules for every query here. `trip.duration_s` is declared in the schema and written by no collector on any platform, so trip length is `ended_at - requested_at`, which **includes wait time**; Bolt writes no `ended_at` on any row ever, so Bolt trip length is the 30-minute assumption and nothing else. Every query filters `is_booking` (`platform <> 'fms'`), because FMS creates GPS-inferred *twin* journeys mirroring rides the ride platforms already reported — FMS alone supplied 62% of the "corridors seen 3+ times" in `api/analytics_routes.js:1216`. Days are **Dubai days, never UTC**: the fleet's top driver has a median start hour of 01:04 (`api/performer_routes.js:20`), so a UTC boundary would split his shift across two days and two weeks. Identity is `trip.person_key` (`sql/schema_v20.sql:28`), the canonical indexed cross-platform key — but it is not exposed by `trip_norm`/`trip_ext`, whose stars froze before v20, so these queries join base `trip` on `(platform, external_id)` to reach it. Money is only ever `revenue_aed_where_priced`: `trip.price` is NULL on every Uber row and Uber is most of this fleet's work. `:start` and `:end` are Dubai calendar dates, inclusive.

#### B1. Online-time source audit — the gate query, run before anything else

```sql
-- B1  ONLINE-TIME SOURCE AUDIT. RUN THIS FIRST — IT DECIDES WHICH METHOD IS
-- AUTHORITATIVE. Every claim about "hours online" in the rest of the module rests
-- on the answer this returns.
-- Fixes: (a) the recommendation branch now expands ONLY flagged entries that
--        actually carry online_hours (acceptance/cancellation recommendations
--        emit {driver_ext_id, value} with no online_hours — uber_fleet.js:112-127),
--        and counts recommendation ROWS via count(DISTINCT rec_uuid) rather than
--        counting flagged array elements as if they were rows;
--        (b) the driver_performance total is renamed so nobody reads a sum over
--        overlapping report windows as a total;
--        (c) zero-hour entries are counted separately, because the collector
--        coerces a missing onlineDurationMillis to 0.
WITH perf AS (
  SELECT 'driver_performance (raw report windows — NEVER SUM)'::text AS source,
         dp.platform,
         count(*)::bigint                                                          AS rows_in_window,
         count(*) FILTER (WHERE dp.hours_online  IS NOT NULL)::bigint              AS rows_with_hours_online,
         count(*) FILTER (WHERE coalesce(dp.hours_online, 0) > 0)::bigint          AS rows_with_nonzero_hours,
         count(*) FILTER (WHERE dp.hours_on_trip IS NOT NULL)::bigint              AS rows_with_hours_on_trip,
         count(DISTINCT dp.driver_ext_id)::bigint                                  AS entities,
         count(DISTINCT dp.driver_ext_id) FILTER (WHERE dp.hours_online IS NOT NULL)::bigint AS entities_with_hours,
         min(dp.period_start)                                                      AS first_day,
         max(dp.period_end)                                                        AS last_day,
         round(avg(dp.period_end - dp.period_start + 1)::numeric, 2)               AS avg_window_days,
         round(sum(dp.hours_online)::numeric, 1)                                   AS total_hours_online_OVERLAPPING_DO_NOT_USE
    FROM driver_performance dp
   WHERE dp.period_start <= :end::date AND dp.period_end >= :start::date
   GROUP BY 1, 2
),
payout AS (
  SELECT 'driver_payout_day (week spread evenly over its days)'::text,
         d.platform,
         count(*)::bigint,
         count(*) FILTER (WHERE d.hours_online  IS NOT NULL)::bigint,
         count(*) FILTER (WHERE coalesce(d.hours_online, 0) > 0)::bigint,
         count(*) FILTER (WHERE d.hours_on_trip IS NOT NULL)::bigint,
         count(DISTINCT d.driver_ext_id)::bigint,
         count(DISTINCT d.driver_ext_id) FILTER (WHERE d.hours_online IS NOT NULL)::bigint,
         min(d.day), max(d.day),
         round(avg(d.period_days)::numeric, 2),
         round(sum(d.hours_online)::numeric, 1)
    FROM driver_payout_day d
   WHERE d.day BETWEEN :start::date AND :end::date
   GROUP BY 1, 2
),
rec AS (
  -- ONLY entries that carry the measure. uber_fleet.js emits online_hours on the
  -- tripCompletion branch alone; acceptance/cancellation flagged arrays have no
  -- such key, and counting their drivers here overstated the population this
  -- audit exists to size.
  SELECT 'platform_recommendation.flagged JSON (Uber trip-completion, flagged drivers only)'::text,
         r.platform,
         count(DISTINCT r.rec_uuid)::bigint,                                   -- recommendation ROWS, not JSON elements
         count(*) FILTER (WHERE f.elem->>'online_hours' ~ '^[0-9]+(\.[0-9]+)?$')::bigint,
         count(*) FILTER (WHERE f.elem->>'online_hours' ~ '^[0-9]+(\.[0-9]+)?$'
                            AND (f.elem->>'online_hours')::numeric > 0)::bigint,
         0::bigint,
         count(DISTINCT f.elem->>'driver_ext_id')::bigint,
         count(DISTINCT f.elem->>'driver_ext_id') FILTER (WHERE f.elem->>'online_hours' ~ '^[0-9]+(\.[0-9]+)?$')::bigint,
         min(r.period_start), max(r.period_end),
         round(avg(r.period_end - r.period_start + 1)::numeric, 2),
         round(sum(CASE WHEN f.elem->>'online_hours' ~ '^[0-9]+(\.[0-9]+)?$'
                        THEN (f.elem->>'online_hours')::numeric END), 1)
    FROM platform_recommendation r
    CROSS JOIN LATERAL jsonb_array_elements(
           CASE WHEN jsonb_typeof(r.flagged) = 'array' THEN r.flagged ELSE '[]'::jsonb END
         ) AS f(elem)
   WHERE (r.period_start IS NULL OR r.period_start <= :end::date)
     AND (r.period_end   IS NULL OR r.period_end   >= :start::date)
     AND f.elem ? 'online_hours'          -- the whole point of this branch
   GROUP BY 1, 2
)
SELECT * FROM perf
UNION ALL SELECT * FROM payout
UNION ALL SELECT * FROM rec
ORDER BY 1, rows_with_hours_online DESC, 2;
```

**How to read it.** One row per source per platform. The column that matters is `entities_with_hours`: against a fleet of 241 people, a healthy result would be a three-figure number on more than one platform. You will get a single-figure number on `yango` and zero everywhere else. That is not a collector bug — it is the finding, and it is why the rest of this module derives sessions instead of reading them.

Three traps are visible in the output by design. `driver_payout_day` shows a Yango week divided by seven, so `avg_window_days` of 7 means you are looking at an estimate spread across days, never a measured day. The `driver_performance` branch deliberately names its total `total_hours_online_OVERLAPPING_DO_NOT_USE` — its report windows overlap (one driver's 28 weeks are held as 67 rows), so summing it double-counts; only the payout branch carries a legitimate disjoint total. And the Uber branch is not a fleet series at all: it is the ~9 drivers Uber *flagged* below its trip-completion target, over a trailing 30-day window, expanded only from flagged entries that actually carry `online_hours`. Compare `entries_with_nonzero_hours` against `rows_with_hours_online` there — the collector coerces a missing `onlineDurationMillis` to the number 0, so the difference is drivers for whom Uber reported nothing.

#### B2. Telemetry-derived shift sessions — when the car worked

```sql
-- B2  TELEMETRY-DERIVED SHIFT SESSIONS (vehicle grain). Not a driver measure:
-- telemetry_snapshot has no driver column, so this is when the CAR worked, with a
-- custodian attached afterwards.
-- Fixes: (a) source restricted to the two feeds that actually carry ignition and
--        speed — src/sources/uber.js writes telemetry_snapshot rows with status
--        and nothing else, and they were eligible for a "session" via status alone;
--        (b) stationary share no longer treats an unmeasured speed as a stop.
--        fms.js writes `parseFloat(v.speed) || null`, so 0 kph becomes NULL there
--        while NULL means "unknown" elsewhere; both variants are now reported with
--        a speed_known_pct coverage column beside them;
--        (c) duration includes one poll interval, so a 3-fix session is not
--        measured as exactly the minimum;
--        (d) the custody LATERAL has a deterministic ORDER BY.
WITH params AS (
  SELECT 60 AS gap_min, 3 AS min_fixes, 10 AS min_duration_min,
         3.0::double precision AS moving_kph, 5 AS poll_interval_min
),
fix AS (
  SELECT s.plate,
         upper(replace(replace(s.plate, ' ', ''), '-', '')) AS plate_key,
         s.fleet_id, s.source, s.captured_at, s.speed
    FROM telemetry_snapshot s
   WHERE s.plate IS NOT NULL
     AND s.source IN ('cabman', 'fms')          -- the uber surface has no ignition, no speed, no position
     AND (s.captured_at AT TIME ZONE 'Asia/Dubai')::date BETWEEN :start::date AND :end::date
     AND (s.ignition IS TRUE OR lower(coalesce(s.status, '')) IN ('active', 'engaged', 'moving'))
),
marked AS (
  SELECT f.*,
         CASE WHEN lag(f.captured_at) OVER w IS NULL
                OR f.captured_at - lag(f.captured_at) OVER w > make_interval(mins => p.gap_min)
              THEN 1 ELSE 0 END AS is_break
    FROM fix f CROSS JOIN params p
  WINDOW w AS (PARTITION BY f.plate_key ORDER BY f.captured_at)
),
sess AS (
  SELECT m.*,
         sum(m.is_break) OVER (PARTITION BY m.plate_key ORDER BY m.captured_at
                               ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS session_no
    FROM marked m
),
agg AS (
  SELECT s.plate_key,
         max(s.plate)            AS plate,
         max(s.fleet_id)         AS fleet_id,
         s.session_no,
         min(s.captured_at)      AS started_at,
         max(s.captured_at)      AS ended_at,
         count(*)::int           AS fixes,
         count(DISTINCT s.source)::int AS sources,
         -- de-duplicated onto the poll grid, so cabman+fms dual coverage of one
         -- plate does not read as twice the evidence
         count(DISTINCT floor(extract(epoch FROM s.captured_at)
                              / ((SELECT poll_interval_min FROM params) * 60)))::int AS slots,
         round((extract(epoch FROM max(s.captured_at) - min(s.captured_at)) / 60.0
                + (SELECT poll_interval_min FROM params))::numeric, 1) AS duration_min,
         -- COVERAGE FIRST: what share of the fixes carry a speed at all
         round((100.0 * count(*) FILTER (WHERE s.speed IS NOT NULL)
                / nullif(count(*), 0)::numeric), 1) AS speed_known_pct,
         -- stationary among fixes that actually measured a speed
         round((100.0 * count(*) FILTER (WHERE s.speed IS NOT NULL
                                           AND s.speed <= (SELECT moving_kph FROM params))
                / nullif(count(*) FILTER (WHERE s.speed IS NOT NULL), 0)::numeric), 1)
           AS stationary_fix_pct_measured,
         -- the old figure, correctly named: unknown speed folded in with stopped
         round((100.0 * count(*) FILTER (WHERE coalesce(s.speed, 0) <= (SELECT moving_kph FROM params))
                / nullif(count(*), 0)::numeric), 1) AS stationary_or_unknown_fix_pct
    FROM sess s
   GROUP BY s.plate_key, s.session_no
)
SELECT a.plate,
       a.fleet_id,
       (a.started_at AT TIME ZONE 'Asia/Dubai')                        AS started_local,
       (a.ended_at   AT TIME ZONE 'Asia/Dubai')                        AS ended_local,
       (a.started_at AT TIME ZONE 'Asia/Dubai')::date                  AS local_day,
       to_char(a.started_at AT TIME ZONE 'Asia/Dubai', 'Dy')           AS dow,
       extract(hour FROM a.started_at AT TIME ZONE 'Asia/Dubai')::int  AS start_hour,
       extract(hour FROM a.ended_at   AT TIME ZONE 'Asia/Dubai')::int  AS end_hour,
       a.duration_min,
       a.fixes, a.slots, a.sources,
       a.speed_known_pct, a.stationary_fix_pct_measured, a.stationary_or_unknown_fix_pct,
       -- idle from measured speed only; NULL (not 0) where no fix carried a speed
       round(a.duration_min * a.stationary_fix_pct_measured / 100.0, 1)      AS est_idle_min,
       round(a.duration_min * a.stationary_or_unknown_fix_pct / 100.0, 1)    AS est_idle_min_incl_unknown,
       cust.driver_name, cust.driver_ext_id, cust.platform AS custody_platform,
       coalesce(tr.trips_in_session, 0)     AS trips_in_session,
       coalesce(tr.completed_in_session, 0) AS completed_in_session,
       tr.revenue_in_session,
       tr.km_in_session,
       round(a.duration_min / nullif(tr.completed_in_session, 0), 1)   AS min_per_completed_trip
  FROM agg a
  LEFT JOIN LATERAL (
    SELECT v.driver_name, v.driver_ext_id, v.platform
      FROM vehicle_driver_day v
     WHERE upper(replace(replace(v.plate, ' ', ''), '-', '')) = a.plate_key
       AND v.day = (a.started_at AT TIME ZONE 'Asia/Dubai')::date
       AND v.is_primary
     ORDER BY v.trips DESC NULLS LAST, v.first_trip_at ASC, v.driver_ext_id
     LIMIT 1
  ) cust ON true
  LEFT JOIN LATERAL (
    SELECT count(*)::int                                              AS trips_in_session,
           count(*) FILTER (WHERE n.outcome = 'completed')::int        AS completed_in_session,
           round(sum(n.price)       FILTER (WHERE n.has_fare)::numeric, 2)     AS revenue_in_session,
           round(sum(n.distance_km) FILTER (WHERE n.has_distance)::numeric, 1) AS km_in_session
      FROM trip_norm n
     WHERE n.is_booking
       AND n.plate IS NOT NULL
       AND upper(replace(replace(n.plate, ' ', ''), '-', '')) = a.plate_key
       AND (n.requested_at AT TIME ZONE 'Asia/Dubai')::date
           BETWEEN (a.started_at AT TIME ZONE 'Asia/Dubai')::date - 1
               AND (a.ended_at   AT TIME ZONE 'Asia/Dubai')::date + 1
       AND n.requested_at >= a.started_at AND n.requested_at <= a.ended_at
  ) tr ON true
 WHERE a.fixes >= (SELECT min_fixes FROM params)
   AND a.duration_min >= (SELECT min_duration_min FROM params)
 ORDER BY a.plate, a.started_at;
```

**How to read it.** This is vehicle grain, not driver grain, and the distinction is not cosmetic: `telemetry_snapshot` has no driver column, so the person on each row is the day's *primary custodian* from `vehicle_driver_day`, attached after the fact. About 12% of vehicle-days have more than one driver, and no mid-shift handover is visible here.

Read `speed_known_pct` before you read anything derived from speed. `src/sources/fms.js:180` writes `parseFloat(v.speed) || null`, which turns a genuine 0 kph into NULL, while NULL means "unknown" on every other feed — so `stationary_fix_pct_measured` (measured fixes only) and `stationary_or_unknown_fix_pct` (the old, permissive figure) bracket the truth. Below roughly 50% `speed_known_pct`, treat `est_idle_min` as unusable and `est_idle_min_incl_unknown` as a ceiling. `sources = 2` means the plate is carried by both cabman and fms; compare `fixes` against `slots` to see how much of the apparent evidence was the same five minutes counted twice. Roughly 15 of 48 trackers are dead with a last fix in 2024 — they simply produce no rows, so a plate missing from this output means no tracker, not an idle car.

#### B3. Gap-threshold sensitivity — how much of the answer is the parameter

```sql
-- B3  GAP-THRESHOLD SENSITIVITY. The gap threshold is an ASSUMPTION, not a platform
-- fact; this query prices it. If the session count halves across the range, no session
-- statistic downstream is a measurement.
-- Fixes: (a) bsess now accumulates the break flag under the SAME ordering that
--        produced it (requested_at, external_id). Ordering by requested_at alone
--        with a ROWS frame leaves tied timestamps in an unspecified peer order,
--        so session_no could disagree with is_break — noise in the very number
--        this query publishes as a stability measure;
--        (b) telemetry arm restricted to the feeds that carry ignition/speed and
--        de-duplicated onto the poll grid, so cabman+fms dual coverage does not
--        artificially shrink the gaps;
--        (c) telemetry sessions carry the same 3-fix floor B2 applies, so the two
--        queries describe the same population.
WITH thr(gap_min) AS (VALUES (30), (45), (60), (90), (120)),
tfix AS (
  SELECT upper(replace(replace(s.plate, ' ', ''), '-', '')) AS key,
         -- one row per plate per 5-minute slot, whichever feed produced it
         min(s.captured_at) AS captured_at
    FROM telemetry_snapshot s
   WHERE s.plate IS NOT NULL
     AND s.source IN ('cabman', 'fms')
     AND (s.captured_at AT TIME ZONE 'Asia/Dubai')::date
         BETWEEN greatest(:start::date, :end::date - 28) AND :end::date
     AND (s.ignition IS TRUE OR lower(coalesce(s.status, '')) IN ('active', 'engaged', 'moving'))
   GROUP BY 1, floor(extract(epoch FROM s.captured_at) / 300)
),
tmark AS (
  SELECT t.key, t.captured_at, th.gap_min,
         CASE WHEN lag(t.captured_at) OVER (PARTITION BY th.gap_min, t.key ORDER BY t.captured_at) IS NULL
                OR t.captured_at - lag(t.captured_at) OVER (PARTITION BY th.gap_min, t.key ORDER BY t.captured_at)
                   > make_interval(mins => th.gap_min)
              THEN 1 ELSE 0 END AS is_break
    FROM tfix t CROSS JOIN thr th
),
tsess AS (
  SELECT m.*, sum(m.is_break) OVER (PARTITION BY m.gap_min, m.key ORDER BY m.captured_at
                                    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS session_no
    FROM tmark m
),
tagg AS (
  SELECT gap_min, key, session_no,
         extract(epoch FROM max(captured_at) - min(captured_at)) / 60.0 + 5 AS duration_min,
         NULL::bigint AS trips
    FROM tsess GROUP BY 1, 2, 3
  HAVING count(*) >= 3                              -- same floor as B2
),
b AS (
  SELECT t.person_key, t.external_id, t.requested_at,
         CASE WHEN t.ended_at IS NOT NULL AND t.ended_at > t.requested_at THEN t.ended_at
              WHEN n.outcome = 'completed' THEN t.requested_at + make_interval(mins => 30)
              ELSE t.requested_at END AS end_est,
         (n.outcome = 'completed') AS completed
    FROM trip_norm n
    JOIN trip t ON t.platform = n.platform AND t.external_id = n.external_id
   WHERE n.is_booking
     AND (t.requested_at AT TIME ZONE 'Asia/Dubai')::date BETWEEN :start::date AND :end::date
     AND coalesce(btrim(t.driver_name), '') <> ''
),
bmark AS (
  SELECT b.person_key, b.external_id, b.requested_at, b.end_est, b.completed, th.gap_min,
         max(b.end_est) OVER (PARTITION BY th.gap_min, b.person_key ORDER BY b.requested_at, b.external_id
                              ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_end
    FROM b CROSS JOIN thr th
),
bflag AS (
  SELECT m.*, CASE WHEN m.prev_end IS NULL OR m.requested_at - m.prev_end > make_interval(mins => m.gap_min)
                   THEN 1 ELSE 0 END AS is_break
    FROM bmark m
),
bsess AS (
  -- ORDER BY must match bflag's, or the running sum can be taken in a different
  -- row order than the flags were computed in
  SELECT f.*, sum(f.is_break) OVER (PARTITION BY f.gap_min, f.person_key
                                    ORDER BY f.requested_at, f.external_id
                                    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS session_no
    FROM bflag f
),
bagg AS (
  SELECT gap_min, person_key AS key, session_no,
         extract(epoch FROM max(end_est) - min(requested_at)) / 60.0 AS duration_min,
         count(*) FILTER (WHERE completed) AS trips
    FROM bsess GROUP BY 1, 2, 3
)
SELECT method, gap_min,
       count(*)                                                       AS sessions,
       count(DISTINCT key)                                            AS subjects,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_min)::numeric, 1) AS median_session_min,
       round(percentile_cont(0.9) WITHIN GROUP (ORDER BY duration_min)::numeric, 1) AS p90_session_min,
       round(avg(duration_min)::numeric, 1)                           AS mean_session_min,
       round(100.0 * count(*) FILTER (WHERE duration_min < 15) / nullif(count(*), 0)::numeric, 1) AS pct_under_15min,
       round(100.0 * count(*) FILTER (WHERE trips = 1)      / nullif(count(*) FILTER (WHERE trips IS NOT NULL), 0)::numeric, 1) AS pct_single_trip_sessions,
       round(avg(trips)::numeric, 2)                                  AS mean_completed_trips_per_session
  FROM (
    SELECT 'telemetry (last 28d of window, >=3 slots)'::text AS method, * FROM tagg
    UNION ALL
    SELECT 'trips (full window)'::text,                       * FROM bagg
  ) z
 GROUP BY method, gap_min
 ORDER BY method, gap_min;
```

**How to read it.** You are looking for a **plateau**. If `sessions` and `median_session_min` move slowly between 60 and 120 minutes, the sessionisation is finding real breaks and the numbers in B4 and B7 are about drivers. If session counts fall by half across the range, the threshold is doing the work and no session statistic downstream should be quoted as a measurement.

`pct_single_trip_sessions` is the tell at the short end: a high value at 30 minutes means you are cutting *inside* shifts, splitting a driver waiting for the next job into two "sessions". At the long end the risk reverses — two genuinely separate shifts on the same day merge into one and `p90_session_min` climbs past any plausible working day. The two arms are not the same population and are labelled so: the telemetry arm covers only the last 28 days of the window (volume), carries the same 3-fix floor B2 applies, and is de-duplicated onto the 5-minute poll grid so that dual cabman+fms coverage does not artificially shrink the gaps.

#### B4. Trip-derived shift sessions — the authoritative per-person method, **headline test**

```sql
-- B4  TRIP-DERIVED SHIFT SESSIONS (person grain). THE PRIMARY METHOD for this module,
-- because telemetry has no driver key and provider hours_online is Yango-only.
--
-- Params: :start / :end Dubai dates (default 2025-09-01 .. 2026-08-27).
-- Tunables in params:
--   gap_min          90  -- chain two trips into one session when the second is requested
--                        -- within this many minutes of the first finishing (B3 = sensitivity)
--   assumed_trip_min 30  -- trip length assumed where ended_at is missing
--
-- IDENTITY: keyed on trip.person_key — the canonical fold (lowercase, collapse
-- whitespace, collapse adjacent repeated words). It is NOT exposed by trip_norm (the
-- view's star froze before v20 added it), hence the join back to base trip.
-- Bolt sets NO driver_ext_id at all and FMS sets neither id nor name, so an id-keyed
-- version of this query would silently drop the whole Bolt channel. Rows with a blank
-- driver_name are excluded — they cannot be attributed to a person.
--
-- WHAT COUNTS AS ONLINE: sessions are built from ALL bookings including cancelled ones
-- (a cancellation is evidence the driver was online and reachable), but trips and revenue
-- are counted only where trip_norm.outcome = 'completed'. outcome normalises five
-- incompatible status vocabularies: Uber 'completed', Bolt 'finished', Yango 'complete',
-- hotel rewritten to 'completed' at ingest, FMS hardcoded (and excluded here by is_booking).
-- Bolt's other failure words — client_did_not_show / driver_did_not_respond /
-- driver_rejected — contain no substring 'cancel' and are outcome='not_completed'.
--
-- KNOWN FLOOR: a session bounded by trips cannot see the log-in before the first job or
-- the log-out after the last. Session length is a LOWER BOUND on online time.
--
-- DISTRUST: (a) on_trip_min SUMS trip intervals, and a driver holding concurrent work
-- across channels (an Uber ride overlapping a hotel booking — normal on the corporate
-- channel) has both counted. idle_min is therefore NOT clamped at zero and on_trip_pct
-- is allowed past 100: a negative idle_min means overlap, and overlapping_trips names how
-- many rows caused it. Clamping would have hidden the condition on exactly the busiest
-- sessions. (b) revenue_aed is structurally NULL on every Uber row, so read
-- aed_per_session_hour only next to priced_trip_pct.
WITH params AS (SELECT 90 AS gap_min, 30 AS assumed_trip_min),
b AS (
  SELECT t.person_key, t.external_id, t.platform, t.driver_ext_id, t.driver_name,
         t.fleet_id, t.plate, t.requested_at,
         CASE
           WHEN t.ended_at IS NOT NULL AND t.ended_at > t.requested_at THEN t.ended_at
           -- Bolt never writes ended_at; assume a nominal trip length for completed rows only
           WHEN n.outcome = 'completed' THEN t.requested_at + make_interval(mins => p.assumed_trip_min)
           ELSE t.requested_at
         END AS end_est,
         (t.ended_at IS NOT NULL AND t.ended_at > t.requested_at) AS end_measured,
         n.outcome, n.has_fare, n.has_distance, t.price, t.distance_km
    FROM trip_norm n
    JOIN trip t ON t.platform = n.platform AND t.external_id = n.external_id
    CROSS JOIN params p
   WHERE n.is_booking
     AND (t.requested_at AT TIME ZONE 'Asia/Dubai')::date BETWEEN :start::date AND :end::date
     AND coalesce(btrim(t.driver_name), '') <> ''
),
marked AS (
  SELECT b.*,
         max(b.end_est) OVER (PARTITION BY b.person_key ORDER BY b.requested_at, b.external_id
                              ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_end
    FROM b
),
flagged AS (
  SELECT m.*,
         CASE WHEN m.prev_end IS NULL OR m.requested_at - m.prev_end > make_interval(mins => p.gap_min)
              THEN 1 ELSE 0 END AS is_break
    FROM marked m CROSS JOIN params p
),
sess AS (
  SELECT f.*, sum(f.is_break) OVER (PARTITION BY f.person_key ORDER BY f.requested_at, f.external_id
                                    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS session_no
    FROM flagged f
),
agg AS (
  SELECT s.person_key, s.session_no,
         max(s.driver_name) AS driver_name,
         max(s.fleet_id)    AS fleet_id,
         min(s.requested_at) AS started_at,
         max(s.end_est)      AS ended_at,
         count(*)::int                                        AS bookings,
         count(*) FILTER (WHERE s.outcome = 'completed')::int  AS completed,
         count(*) FILTER (WHERE s.outcome = 'not_completed')::int AS not_completed,
         count(*) FILTER (WHERE s.end_measured)::int           AS trips_with_measured_end,
         -- trips that began before the previous one was estimated to end: the reason
         -- on_trip_min can exceed the session and idle_min can go negative
         count(*) FILTER (WHERE s.prev_end IS NOT NULL AND s.requested_at < s.prev_end)::int AS overlapping_trips,
         -- how much of the money side of this session is even in scope
         count(*) FILTER (WHERE s.has_fare)::int               AS priced_trips,
         round(100.0 * count(*) FILTER (WHERE s.has_fare)
               / nullif(count(*), 0)::numeric, 1)              AS priced_trip_pct,
         -- on-trip minutes: only over completed rows, using measured end where present
         round((sum(extract(epoch FROM s.end_est - s.requested_at))
                FILTER (WHERE s.outcome = 'completed') / 60.0)::numeric, 1) AS on_trip_min,
         round(sum(s.price)       FILTER (WHERE s.has_fare)::numeric, 2)     AS revenue_aed,
         round(sum(s.distance_km) FILTER (WHERE s.has_distance)::numeric, 1) AS km,
         array_agg(DISTINCT s.platform ORDER BY s.platform)   AS platforms,
         -- empty array, not SQL NULL, when no trip in the session named a plate
         coalesce(array_agg(DISTINCT s.plate) FILTER (WHERE s.plate IS NOT NULL), '{}') AS plates
    FROM sess s
   GROUP BY s.person_key, s.session_no
)
SELECT a.person_key, a.driver_name, a.fleet_id, a.platforms, a.plates,
       (a.started_at AT TIME ZONE 'Asia/Dubai')                       AS started_local,
       (a.ended_at   AT TIME ZONE 'Asia/Dubai')                       AS ended_local,
       (a.started_at AT TIME ZONE 'Asia/Dubai')::date                 AS local_day,
       to_char(a.started_at AT TIME ZONE 'Asia/Dubai', 'Dy')          AS dow,
       extract(hour FROM a.started_at AT TIME ZONE 'Asia/Dubai')::int AS start_hour,
       extract(hour FROM a.ended_at   AT TIME ZONE 'Asia/Dubai')::int AS end_hour,
       round((extract(epoch FROM a.ended_at - a.started_at) / 60.0)::numeric, 1) AS session_min,
       a.bookings, a.completed, a.not_completed, a.trips_with_measured_end, a.overlapping_trips,
       a.on_trip_min,
       -- dead time inside the shift: session length minus time with a passenger.
       -- NOT clamped at zero — a negative value is the overlap condition reporting itself
       round((extract(epoch FROM a.ended_at - a.started_at) / 60.0)::numeric, 1) - a.on_trip_min AS idle_min,
       round(100.0 * a.on_trip_min
             / nullif(round((extract(epoch FROM a.ended_at - a.started_at) / 60.0)::numeric, 1), 0), 1) AS on_trip_pct,
       a.revenue_aed, a.km, a.priced_trips, a.priced_trip_pct,
       -- revenue is NULL on every Uber row (no fare column in the export); this is
       -- AED per session hour for the hotel/Yango/Bolt part of the session only, and
       -- priced_trip_pct says how much of the session that is
       round(a.revenue_aed / nullif(extract(epoch FROM a.ended_at - a.started_at) / 3600.0, 0)::numeric, 2) AS aed_per_session_hour
  FROM agg a
 WHERE a.completed > 0                 -- a session of nothing but cancellations is not a shift worth listing
 ORDER BY a.person_key, a.started_at;
```

**How to read it.** This is the method everything person-level in the module is built on, because telemetry has no driver key and provider hours are Yango-only. One row per derived shift.

`trips_with_measured_end` against `bookings` tells you how much of the session is measured and how much is assumed: a Bolt-only session is 100% assumption, because Bolt writes no `ended_at` on any row, ever. `overlapping_trips` above zero means the driver held concurrent work across channels — normal on the hotel/corporate side — and in that case `on_trip_pct` can exceed 100 and `idle_min` can go **negative**. That is deliberate. The earlier version clamped `idle_min` at zero with `greatest(...)`, which made dead time read as exactly zero for precisely the busiest sessions; a negative number here is the query telling you the interval sum is not a union, not a defect in the driver. Finally, read `aed_per_session_hour` only alongside `priced_trip_pct`: the numerator is structurally NULL on every Uber row while the denominator includes the Uber part of the shift, so at a low `priced_trip_pct` the figure is not a low earnings rate, it is a missing fare column.

#### B5. First and last trip of the day, by weekday

Everything from here on uses the pack's **service day** — sometimes called the shift day — and it will confuse you if you read it as a calendar date. The clock is shifted back four hours: `service_day = ((requested_at AT TIME ZONE 'Asia/Dubai') - interval '4 hours')::date`, and `shift_hour` 0 means **04:00 local**. A job at 01:30 on Tuesday therefore belongs to Monday's service day, which is the night it was actually worked. Without this, a fleet peaking 20:00–02:00 has every night split across two calendar dates and every start/stop median destroyed — the top driver's 01:04 median start would read as an early morning rather than a late night. To convert back: `clock_hour = (shift_hour + 4) mod 24`, and the query emits both. Calendar-day grouping (`trip_norm.local_day`) is kept elsewhere in the pack for volume and rollup-comparable work; start/stop, streak and season statistics use the service day.

```sql
-- B5  FIRST / LAST TRIP OF DAY, per driver, by weekday, Dubai local. WHEN DO THEY
-- CLOCK ON AND OFF — on the 04:00-anchored SERVICE DAY, so a 01:30 job belongs to the
-- night it was worked and not to the calendar morning after it.
-- Fix: the row filter was on the CALENDAR Dubai day while the grouping key is the
--      04:00-anchored service day, so trips 00:00-04:00 on :start were assigned to
--      service_day :start-1 — a night whose evening half lay outside the filter —
--      and the night of :end lost its 00:00-04:00 tail. Those truncated nights
--      reported spuriously late first hours and short spans and were pooled into
--      the medians. The fetch now runs one calendar day past :end and the result
--      is restricted on the SERVICE day, so every night reported is a whole one.
-- Also adds medians computed over multi-trip days only, beside the pooled ones,
-- because on a single-trip day first == last by construction.
WITH b AS (
  SELECT t.person_key,
         t.driver_name,
         ((t.requested_at AT TIME ZONE 'Asia/Dubai') - interval '4 hours')::date AS service_day,
         (t.requested_at AT TIME ZONE 'Asia/Dubai')                              AS local_ts,
         extract(hour FROM ((t.requested_at AT TIME ZONE 'Asia/Dubai') - interval '4 hours'))::int AS shift_hour,
         extract(hour FROM  (t.requested_at AT TIME ZONE 'Asia/Dubai'))::int     AS clock_hour,
         n.has_fare, n.price
    FROM trip_norm n
    JOIN trip t ON t.platform = n.platform AND t.external_id = n.external_id
   WHERE n.is_booking
     AND n.outcome = 'completed'
     -- one extra calendar day so the last service night is complete; the index
     -- expression is still character-for-character the one schema_v7/v27 built
     AND (t.requested_at AT TIME ZONE 'Asia/Dubai')::date BETWEEN :start::date AND :end::date + 1
     AND coalesce(btrim(t.driver_name), '') <> ''
),
day_edges AS (
  SELECT person_key,
         max(driver_name)                       AS driver_name,
         service_day,
         extract(dow FROM service_day)::int     AS service_dow,
         count(*)::int                          AS trips,
         min(shift_hour)                        AS first_shift_hour,
         max(shift_hour)                        AS last_shift_hour,
         min(local_ts)                          AS first_trip_local,
         max(local_ts)                          AS last_trip_local,
         round((extract(epoch FROM max(local_ts) - min(local_ts)) / 60.0)::numeric, 1) AS first_to_last_min,
         round(sum(price) FILTER (WHERE has_fare)::numeric, 2) AS revenue_aed
    FROM b
   WHERE service_day BETWEEN :start::date AND :end::date   -- whole nights only
   GROUP BY person_key, service_day
)
SELECT d.person_key,
       max(d.driver_name) AS driver_name,
       d.service_dow,
       to_char(date '2024-01-07' + d.service_dow, 'Dy') AS dow,   -- 2024-01-07 is a Sunday = dow 0
       count(*)::int      AS driver_days,
       count(*) FILTER (WHERE d.trips = 1)::int AS singleton_days,
       sum(d.trips)::int  AS trips,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY d.first_shift_hour)::numeric, 1) AS median_first_shift_hour,
       mod((round(percentile_cont(0.5) WITHIN GROUP (ORDER BY d.first_shift_hour))::int + 4), 24) AS median_first_clock_hour,
       round(percentile_cont(0.25) WITHIN GROUP (ORDER BY d.first_shift_hour)::numeric, 1) AS p25_first_shift_hour,
       round(percentile_cont(0.75) WITHIN GROUP (ORDER BY d.first_shift_hour)::numeric, 1) AS p75_first_shift_hour,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY d.last_shift_hour)::numeric, 1)  AS median_last_shift_hour,
       mod((round(percentile_cont(0.5) WITHIN GROUP (ORDER BY d.last_shift_hour))::int + 4), 24) AS median_last_clock_hour,
       -- same two medians over days with more than one job, where first <> last
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY d.first_shift_hour)
             FILTER (WHERE d.trips > 1)::numeric, 1) AS median_first_shift_hour_multi,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY d.last_shift_hour)
             FILTER (WHERE d.trips > 1)::numeric, 1) AS median_last_shift_hour_multi,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY d.first_to_last_min)::numeric, 1) AS median_span_min,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY d.first_to_last_min)
             FILTER (WHERE d.trips > 1)::numeric, 1) AS median_span_min_multi,
       round(avg(d.trips)::numeric, 2) AS mean_trips_per_day,
       round(sum(d.revenue_aed)::numeric, 2) AS revenue_aed_where_priced
  FROM day_edges d
 GROUP BY d.person_key, d.service_dow
HAVING count(*) >= 4
 ORDER BY d.person_key, d.service_dow;
```

**How to read it.** `median_first_clock_hour` and `median_last_clock_hour` are the ones to quote — they are in ordinary Dubai wall-clock terms. A driver with a first clock hour around 17:00–20:00 and a last around 02:00–04:00 is a night worker, and that is the fleet's dominant shape.

Two guards are worth understanding before you compare drivers. The fetch runs one calendar day past `:end` and the result is then restricted on the *service* day, so no partially-observed night is pooled into a median — without that, the night straddling `:start` would report a spuriously late first hour and a very short span, and `HAVING count(*) >= 4` would not have excluded it. And on a single-trip day `first == last` by construction, so `singleton_days` warns you and the `_multi` medians give you the same statistics over days with more than one job. Where `singleton_days` is a large share of `driver_days`, the `_multi` columns are the real answer and `median_span_min` is meaningless.

#### B6. Week-hour activity heatmap and schedule divergence — **headline test**: do the top ten work the right hours?

```sql
-- B6  WEEK-HOUR ACTIVITY HEATMAP AND SCHEDULE DIVERGENCE. HEADLINE TEST: do the top
-- ten work MORE hours, or the RIGHT hours? Each driver's 168-cell week against the
-- fleet's, scored.
-- Fixes: (a) LEAVE-ONE-OUT baseline. The fleet vector previously included the
--        driver being compared, so a top-10 driver dragged fleet_share toward
--        their own shape — depressing TVD and inflating cosine similarity for
--        exactly the cohort under test. fleet_share is now (fleet - driver);
--        it still sums to 1 by construction;
--        (b) the peak-cell definition is built on the full 168-cell spine rather
--        than only the cells that happened to be observed, so the denominator is
--        stable between windows;
--        (c) week_hours_worked renamed to what it actually counts.
WITH b AS (
  SELECT t.person_key, t.driver_name, n.local_dow, n.local_hour, n.has_fare, n.price
    FROM trip_norm n
    JOIN trip t ON t.platform = n.platform AND t.external_id = n.external_id
   WHERE n.is_booking
     AND n.outcome = 'completed'
     AND (t.requested_at AT TIME ZONE 'Asia/Dubai')::date BETWEEN :start::date AND :end::date
     AND coalesce(btrim(t.driver_name), '') <> ''
),
drv_tot AS (
  SELECT person_key, max(driver_name) AS driver_name, count(*)::numeric AS trips,
         round(sum(price) FILTER (WHERE has_fare)::numeric, 2) AS revenue_aed_where_priced
    FROM b GROUP BY person_key
),
spine AS (
  SELECT g.dow AS local_dow, h.hour AS local_hour
    FROM generate_series(0, 6) g(dow) CROSS JOIN generate_series(0, 23) h(hour)
),
fleet_cell AS (
  SELECT sp.local_dow, sp.local_hour,
         coalesce(count(b.person_key), 0)::numeric AS n,
         (ntile(5) OVER (ORDER BY coalesce(count(b.person_key), 0) DESC) = 1) AS is_peak_cell
    FROM spine sp
    LEFT JOIN b ON b.local_dow = sp.local_dow AND b.local_hour = sp.local_hour
   GROUP BY sp.local_dow, sp.local_hour
),
fleet_tot AS (SELECT sum(n) AS n FROM fleet_cell),
drv_cell AS (
  SELECT person_key, local_dow, local_hour, count(*)::numeric AS n
    FROM b GROUP BY person_key, local_dow, local_hour
),
cells AS (
  SELECT dt.person_key, dt.driver_name, dt.trips AS driver_trips, dt.revenue_aed_where_priced,
         fc.local_dow, fc.local_hour, fc.is_peak_cell,
         coalesce(dc.n, 0) / nullif(dt.trips, 0)                       AS drv_share,
         -- LEAVE-ONE-OUT: the fleet WITHOUT this driver
         (fc.n - coalesce(dc.n, 0)) / nullif(ft.n - dt.trips, 0)       AS fleet_share_loo,
         fc.n / nullif(ft.n, 0)                                        AS fleet_share_all
    FROM drv_tot dt
    CROSS JOIN fleet_cell fc
    CROSS JOIN fleet_tot ft
    LEFT JOIN drv_cell dc
           ON dc.person_key = dt.person_key
          AND dc.local_dow  = fc.local_dow
          AND dc.local_hour = fc.local_hour
   WHERE dt.trips >= 30
)
SELECT c.person_key,
       max(c.driver_name)                     AS driver_name,
       max(c.driver_trips)::int               AS completed_trips,
       max(c.revenue_aed_where_priced)        AS revenue_aed_where_priced,
       rank() OVER (ORDER BY max(c.driver_trips) DESC) AS trips_rank,
       (rank() OVER (ORDER BY max(c.driver_trips) DESC) <= 10) AS in_top10_cohort,
       -- measured against the fleet EXCLUDING this driver
       round(sum(abs(c.drv_share - c.fleet_share_loo)) / 2, 4) AS schedule_divergence_tvd,
       round(sum(c.drv_share * c.fleet_share_loo)
             / nullif(sqrt(sum(power(c.drv_share, 2))) * sqrt(sum(power(c.fleet_share_loo, 2))), 0), 4) AS cosine_similarity,
       -- the naive self-inclusive figures, kept so the size of the bias is visible
       round(sum(abs(c.drv_share - c.fleet_share_all)) / 2, 4) AS schedule_divergence_tvd_self_included,
       round(100 * sum(c.drv_share)       FILTER (WHERE c.is_peak_cell), 1) AS pct_trips_in_fleet_peak_cells,
       round(100 * sum(c.fleet_share_all) FILTER (WHERE c.is_peak_cell), 1) AS fleet_pct_in_peak_cells,
       round(100 * sum(c.fleet_share_loo) FILTER (WHERE c.is_peak_cell), 1) AS fleet_ex_driver_pct_in_peak_cells,
       count(*) FILTER (WHERE c.drv_share > 0)::int AS week_hours_with_any_trip,
       (array_agg(to_char(date '2024-01-07' + c.local_dow, 'Dy') || ':' || lpad(c.local_hour::text, 2, '0')
                  ORDER BY c.drv_share DESC, c.local_dow, c.local_hour))[1:3] AS top3_week_hours
  FROM cells c
 GROUP BY c.person_key
 ORDER BY completed_trips DESC;
```

**How to read it.** This is the module's central claim and the correction below changed its sign, so read the two divergence columns together.

`schedule_divergence_tvd` is total-variation distance across the 168 week-hour cells: 0 means the driver's week is shaped exactly like the fleet's, 1 means no overlap at all. `cosine_similarity` says the same thing from the other side. The baseline is **leave-one-out** — the fleet vector this driver is compared against excludes that driver's own trips. It has to be: a top-10 driver contributes a large share of all completed bookings, so a self-inclusive baseline drags the fleet vector toward their own shape, depressing their TVD and inflating their similarity — an artefact that flatters exactly the cohort under test. `schedule_divergence_tvd_self_included` is retained beside it purely so you can see how large that bias is. If the two differ materially for the top ten and barely at all for everyone else, the naive version of this finding was measuring the driver against themselves.

`pct_trips_in_fleet_peak_cells` is the plain-language version: the share of this driver's completed trips landing in the busiest 20% of the week. Compare it against `fleet_ex_driver_pct_in_peak_cells` on the same row — above it means better-timed than the fleet, and *that* is what "works the right hours" means. The peak set is defined on a full 168-cell spine, not on cells that happened to be observed, so the figure is comparable across windows. `week_hours_with_any_trip` is a breadth measure — how many of the 168 cells they touch at all — not a concentration measure; it was renamed for exactly that reason.

#### B7. Utilisation and dead time per driver-month

```sql
-- B7  UTILISATION PER DRIVER-MONTH: on-trip time over online time, three ways, plus
-- the dead time between jobs. The three denominators are NOT interchangeable and are
-- never coalesced into one column.
--
-- Fixes, in order of how badly they moved the numbers:
--
-- 1. utilisation_pct_vs_reported divided an ALL-CHANNEL on-trip numerator by a
--    YANGO-ONLY denominator. driver_payout_day.hours_online is written only where
--    src/sources/yango.js supplied work_time_seconds; the uber and bolt days in the
--    same person-month are NULL and sum() ignored them, so the ratio routinely
--    exceeded 100% while reading as a fleet-wide utilisation — and
--    reported_platforms, taken over ALL payout rows, labelled that Yango-only
--    denominator {bolt,uber,yango}. The denominator is now restricted to
--    hours-bearing rows, the numerator is restricted to the SAME platforms, and
--    reported_hours_platforms / reported_hours_days state the coverage.
--
-- 2. plate_day_online claimed count(DISTINCT date_trunc('minute', captured_at))
--    de-duplicated cabman+fms dual coverage. It does not — the two feeds poll on
--    different minute offsets, so a dual-covered plate scored ~2x the online
--    minutes. Now bucketed onto the poll grid, which really does collapse them.
--
-- 3. `ids` was DISTINCT (person_key, platform, driver_ext_id); one provider id
--    carrying two name spellings matched two person_keys and the payout row was
--    reported in full against both. Now one person_key per provider id.
--
-- 4. The 1440 min/day cap was per PLATE-day; custody is_primary is unique per
--    (plate, day), so a person primary on two plates could exceed 24h. Capped
--    after folding to the person.
WITH params AS (SELECT 90 AS gap_min, 30 AS assumed_trip_min, 5 AS poll_interval_min),
b AS (
  SELECT t.person_key, t.external_id, t.driver_name, t.platform, t.requested_at,
         CASE WHEN t.ended_at IS NOT NULL AND t.ended_at > t.requested_at THEN t.ended_at
              WHEN n.outcome = 'completed' THEN t.requested_at + make_interval(mins => p.assumed_trip_min)
              ELSE t.requested_at END AS end_est,
         n.outcome, n.has_fare, n.price,
         date_trunc('month', (t.requested_at AT TIME ZONE 'Asia/Dubai'))::date AS local_month
    FROM trip_norm n
    JOIN trip t ON t.platform = n.platform AND t.external_id = n.external_id
    CROSS JOIN params p
   WHERE n.is_booking
     AND (t.requested_at AT TIME ZONE 'Asia/Dubai')::date BETWEEN :start::date AND :end::date
     AND coalesce(btrim(t.driver_name), '') <> ''
),
marked AS (
  SELECT b.*, max(b.end_est) OVER (PARTITION BY b.person_key ORDER BY b.requested_at, b.external_id
                                   ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_end
    FROM b
),
sess AS (
  SELECT m.*,
         sum(CASE WHEN m.prev_end IS NULL OR m.requested_at - m.prev_end > make_interval(mins => p.gap_min)
                  THEN 1 ELSE 0 END)
           OVER (PARTITION BY m.person_key ORDER BY m.requested_at, m.external_id
                 ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS session_no
    FROM marked m CROSS JOIN params p
),
session_agg AS (
  SELECT person_key, session_no,
         min(local_month) AS local_month,
         max(driver_name) AS driver_name,
         extract(epoch FROM max(end_est) - min(requested_at)) / 3600.0 AS session_h,
         sum(extract(epoch FROM end_est - requested_at)) FILTER (WHERE outcome = 'completed') / 3600.0 AS on_trip_h,
         count(*) FILTER (WHERE outcome = 'completed')::int AS completed,
         count(*) FILTER (WHERE outcome = 'not_completed')::int AS not_completed,
         sum(price) FILTER (WHERE has_fare) AS revenue_aed
    FROM sess GROUP BY person_key, session_no
),
month_sessions AS (
  SELECT person_key, local_month,
         max(driver_name) AS driver_name,
         count(*)::int    AS sessions,
         round(sum(session_h)::numeric, 2) AS session_online_h,
         round(sum(on_trip_h)::numeric, 2) AS on_trip_h,
         sum(completed)::int     AS completed_trips,
         sum(not_completed)::int AS not_completed_trips,
         round(sum(revenue_aed)::numeric, 2) AS revenue_aed_where_priced,
         round(percentile_cont(0.5) WITHIN GROUP (ORDER BY session_h * 60)::numeric, 1) AS median_session_min
    FROM session_agg GROUP BY person_key, local_month
),
-- on-trip hours BY PLATFORM, so a ratio can be built whose numerator and
-- denominator cover the same channels
month_on_trip_platform AS (
  SELECT person_key, local_month, platform,
         sum(extract(epoch FROM end_est - requested_at)) FILTER (WHERE outcome = 'completed') / 3600.0 AS on_trip_h
    FROM b GROUP BY 1, 2, 3
),
-- ---- telemetry denominator: the person's PRIMARY vehicle on each day ----
custody AS (
  SELECT DISTINCT v.person_key, v.day, upper(replace(replace(v.plate, ' ', ''), '-', '')) AS plate_key
    FROM vehicle_driver_day v
   WHERE v.is_primary
     AND v.day BETWEEN :start::date AND :end::date
     AND coalesce(btrim(v.person_key), '') <> ''
),
plate_day_online AS (
  SELECT upper(replace(replace(s.plate, ' ', ''), '-', '')) AS plate_key,
         (s.captured_at AT TIME ZONE 'Asia/Dubai')::date    AS day,
         -- distinct POLL SLOTS, not distinct minutes: cabman and fms land on
         -- different minute offsets, so distinct minutes double-counted them
         least(1440, (SELECT poll_interval_min FROM params)
                     * count(DISTINCT floor(extract(epoch FROM s.captured_at)
                                            / ((SELECT poll_interval_min FROM params) * 60))))::numeric AS online_min
    FROM telemetry_snapshot s
   WHERE s.plate IS NOT NULL
     AND s.source IN ('cabman', 'fms')
     AND (s.captured_at AT TIME ZONE 'Asia/Dubai')::date BETWEEN :start::date AND :end::date
     AND (s.ignition IS TRUE OR lower(coalesce(s.status, '')) IN ('active', 'engaged', 'moving'))
   GROUP BY 1, 2
),
person_day_online AS (
  -- cap at the PERSON-day, not the plate-day
  SELECT c.person_key, c.day, least(1440, sum(p.online_min))::numeric AS online_min
    FROM custody c JOIN plate_day_online p ON p.plate_key = c.plate_key AND p.day = c.day
   GROUP BY 1, 2
),
month_telemetry AS (
  SELECT person_key, date_trunc('month', day)::date AS local_month,
         round(sum(online_min) / 60.0, 2) AS telemetry_online_h,
         count(*)::int                    AS telemetry_days
    FROM person_day_online GROUP BY 1, 2
),
-- ---- provider-reported denominator (in practice Yango only) ----
ids AS (
  -- exactly ONE person_key per provider id — the one that names it most often —
  -- so a payout row can never be reported against two people
  SELECT DISTINCT ON (platform, driver_ext_id) platform, driver_ext_id, person_key
    FROM (SELECT platform, driver_ext_id, person_key, count(*) AS n
            FROM trip
           WHERE coalesce(btrim(driver_ext_id), '') <> ''
             AND coalesce(btrim(driver_name), '')   <> ''
           GROUP BY 1, 2, 3) z
   ORDER BY platform, driver_ext_id, n DESC, person_key
),
hours_rows AS (
  -- ONLY rows that actually carry hours. This is the denominator's true extent.
  SELECT i.person_key, d.platform, date_trunc('month', d.day)::date AS local_month,
         sum(d.hours_online)                                        AS reported_online_h,
         count(*)::int                                              AS reported_hours_days
    FROM driver_payout_day d
    JOIN ids i ON i.platform = d.platform AND i.driver_ext_id = d.driver_ext_id
   WHERE d.day BETWEEN :start::date AND :end::date
     AND d.hours_online IS NOT NULL
   GROUP BY 1, 2, 3
),
month_reported AS (
  SELECT person_key, local_month,
         round(sum(reported_online_h)::numeric, 2)          AS reported_online_h,
         sum(reported_hours_days)::int                      AS reported_hours_days,
         array_agg(DISTINCT platform ORDER BY platform)     AS reported_hours_platforms
    FROM hours_rows GROUP BY 1, 2
),
matched_numerator AS (
  -- on-trip hours restricted to the platforms that supplied the hours
  SELECT o.person_key, o.local_month,
         round(sum(o.on_trip_h)::numeric, 2) AS on_trip_h_on_hours_platforms
    FROM month_on_trip_platform o
    JOIN hours_rows h ON h.person_key = o.person_key
                     AND h.local_month = o.local_month
                     AND h.platform    = o.platform
   GROUP BY 1, 2
),
month_payout_all AS (
  -- money and trips over ALL platforms, kept separate from the hours denominator
  SELECT i.person_key, date_trunc('month', d.day)::date AS local_month,
         round(sum(d.trips)::numeric, 1)    AS reported_trips,
         round(sum(d.earnings)::numeric, 2) AS reported_earnings_aed,
         array_agg(DISTINCT d.platform ORDER BY d.platform) AS payout_platforms,
         round(sum(d.hours_on_trip)::numeric, 2) AS reported_on_trip_h  -- no writer: expect NULL
    FROM driver_payout_day d
    JOIN ids i ON i.platform = d.platform AND i.driver_ext_id = d.driver_ext_id
   WHERE d.day BETWEEN :start::date AND :end::date
   GROUP BY 1, 2
)
SELECT m.person_key, m.driver_name, m.local_month,
       m.sessions, m.median_session_min,
       m.completed_trips, m.not_completed_trips,
       m.session_online_h, m.on_trip_h,
       round(100 * m.on_trip_h / nullif(m.session_online_h, 0), 1) AS utilisation_pct_vs_sessions,
       round(60 * (m.session_online_h - m.on_trip_h) / nullif(m.completed_trips, 0), 1) AS dead_min_per_completed_trip,
       round(60 * (m.session_online_h - m.on_trip_h), 1)           AS dead_min_total,
       -- telemetry arm: denominator is the CAR (primary vehicle), numerator is
       -- the person across all channels; telemetry_days is the honesty column
       t.telemetry_online_h, t.telemetry_days,
       round(100 * m.on_trip_h / nullif(t.telemetry_online_h, 0), 1) AS utilisation_pct_vs_telemetry,
       -- reported arm: numerator and denominator now cover the SAME platforms
       r.reported_online_h, r.reported_hours_days, r.reported_hours_platforms,
       mn.on_trip_h_on_hours_platforms,
       round(100 * mn.on_trip_h_on_hours_platforms / nullif(r.reported_online_h, 0), 1) AS utilisation_pct_vs_reported,
       -- the old, unmatched ratio, kept only so the size of the error is visible
       round(100 * m.on_trip_h / nullif(r.reported_online_h, 0), 1) AS utilisation_pct_vs_reported_UNMATCHED,
       -- two separate comparisons, never coalesced into one ambiguous column
       round(m.session_online_h / nullif(r.reported_online_h, 0), 3)  AS session_h_over_reported_h,
       round(m.session_online_h / nullif(t.telemetry_online_h, 0), 3) AS session_h_over_telemetry_h,
       pa.reported_trips, pa.reported_earnings_aed, pa.payout_platforms, pa.reported_on_trip_h,
       m.revenue_aed_where_priced
  FROM month_sessions m
  LEFT JOIN month_telemetry   t  ON t.person_key  = m.person_key AND t.local_month  = m.local_month
  LEFT JOIN month_reported    r  ON r.person_key  = m.person_key AND r.local_month  = m.local_month
  LEFT JOIN matched_numerator mn ON mn.person_key = m.person_key AND mn.local_month = m.local_month
  LEFT JOIN month_payout_all  pa ON pa.person_key = m.person_key AND pa.local_month = m.local_month
 ORDER BY m.local_month, m.completed_trips DESC;
```

**How to read it.** Three utilisation ratios, three different denominators, and they are deliberately never merged into one column.

`utilisation_pct_vs_sessions` is the usable one: on-trip hours over derived session hours, all channels, same population top and bottom. `utilisation_pct_vs_telemetry` divides a person's all-channel on-trip hours by their *primary vehicle's* observed ignition time — read `telemetry_days` next to it, because a low value means no tracker on that car, not a short month. `utilisation_pct_vs_reported` is the fragile one: its denominator is provider-reported hours, which in practice means Yango and only Yango, so the numerator is restricted to the same platforms and `reported_hours_platforms` and `reported_hours_days` state exactly what that covers. `utilisation_pct_vs_reported_UNMATCHED` is the old all-channel-over-Yango-only ratio, kept solely so the size of that error is visible — where it reads well above 100% you are seeing what a null-blind denominator does.

`dead_min_per_completed_trip` is the operational number: session minutes not spent on a trip, per completed job. There is no break, meal, or "available but not dispatched" state anywhere in the schema, so dead time cannot distinguish waiting for a dispatch from sitting at home with the engine running. `reported_on_trip_h` is expected to be NULL on every row — `driver_payout_day.hours_on_trip` has no writer in any collector, despite being rendered on the driver page. Do not divide `reported_earnings_aed` by any hours column here: `api/income_sql.js` chooses a different basis per platform — hotel reports gross fare, Uber reports net payout — so the money is not one measure and a per-hour figure built from it would be meaningless.

#### B8. Consecutive days worked and rest-day pattern

```sql
-- B8  CONSECUTIVE DAYS WORKED AND REST-DAY PATTERN. Streaks, rest days and which
-- weekday the rest lands on — on the SERVICE day, because on calendar days a night
-- worker never appears to rest.
-- Fix: the day grain was the CALENDAR Dubai day while this fleet peaks 20:00-02:00
--      and B5/B9 already use an 04:00-anchored service day. One night shift
--      20:00 -> 02:00 stamps two consecutive calendar days, so the rest day after
--      a night shift vanished: streaks were inflated, rest days understated, and
--      most_common_rest_dow shifted by a day for every night worker. Now on the
--      service day, with the fetch widened one calendar day so the last night is
--      whole and the result trimmed back on the service day.
-- Also: rest_by_dow is now a complete 7-value profile — weekdays with zero rest
--      days previously produced no row and were silently absent from the string.
WITH b AS (
  SELECT t.person_key, t.driver_name,
         ((t.requested_at AT TIME ZONE 'Asia/Dubai') - interval '4 hours')::date AS day,
         n.has_fare, n.price
    FROM trip_norm n
    JOIN trip t ON t.platform = n.platform AND t.external_id = n.external_id
   WHERE n.is_booking
     AND n.outcome = 'completed'
     AND (t.requested_at AT TIME ZONE 'Asia/Dubai')::date BETWEEN :start::date AND :end::date + 1
     AND coalesce(btrim(t.driver_name), '') <> ''
),
bw AS (SELECT * FROM b WHERE day BETWEEN :start::date AND :end::date),
drv AS (
  SELECT person_key, max(driver_name) AS driver_name,
         count(*)::int AS completed_trips,
         round(sum(price) FILTER (WHERE has_fare)::numeric, 2) AS revenue_aed_where_priced,
         min(day) AS first_day, max(day) AS last_day,
         count(DISTINCT day)::int AS days_worked,
         rank() OVER (ORDER BY count(*) DESC) AS trips_rank
    FROM bw GROUP BY person_key
),
d AS (SELECT DISTINCT person_key, day FROM bw),
g AS (
  SELECT person_key, day,
         day - (row_number() OVER (PARTITION BY person_key ORDER BY day))::int AS grp
    FROM d
),
streak AS (
  SELECT person_key, min(day) AS from_day, max(day) AS to_day, count(*)::int AS days
    FROM g GROUP BY person_key, grp
),
streak_stat AS (
  SELECT person_key,
         max(days)                          AS longest_streak_days,
         count(*)::int                      AS streaks,
         round(avg(days)::numeric, 2)       AS mean_streak_days,
         round(percentile_cont(0.5) WITHIN GROUP (ORDER BY days)::numeric, 1) AS median_streak_days,
         count(*) FILTER (WHERE days >= 14)::int AS streaks_14d_plus
    FROM streak GROUP BY person_key
),
cal AS (SELECT generate_series(:start::date, :end::date, interval '1 day')::date AS day),
rest AS (
  SELECT dr.person_key,
         extract(dow FROM c.day)::int AS dow,
         count(*)::int                AS rest_days
    FROM drv dr
    JOIN cal c ON c.day BETWEEN dr.first_day AND dr.last_day   -- tenure only
    LEFT JOIN d ON d.person_key = dr.person_key AND d.day = c.day
   WHERE d.day IS NULL
   GROUP BY 1, 2
),
rest_spine AS (
  -- every driver x every weekday, so a weekday with no rest day is a zero, not a gap
  SELECT dr.person_key, s.dow, coalesce(r.rest_days, 0) AS rest_days
    FROM drv dr
    CROSS JOIN generate_series(0, 6) s(dow)
    LEFT JOIN rest r ON r.person_key = dr.person_key AND r.dow = s.dow
),
rest_roll AS (
  SELECT person_key,
         sum(rest_days)::int AS rest_days_in_tenure,
         string_agg(to_char(date '2024-01-07' + dow, 'Dy') || '=' || rest_days, ' ' ORDER BY dow) AS rest_by_dow,
         (array_agg(to_char(date '2024-01-07' + dow, 'Dy') ORDER BY rest_days DESC, dow))[1] AS most_common_rest_dow,
         max(rest_days)::int AS rest_days_on_that_dow,
         -- is the "most common rest day" actually distinctive, or a tie?
         (count(*) FILTER (WHERE rest_days = max(rest_days) OVER ()))::int AS dows_tied_at_max
    FROM rest_spine GROUP BY person_key
)
SELECT dr.person_key, dr.driver_name, dr.trips_rank,
       (dr.trips_rank <= 10) AS in_top10_cohort,
       dr.completed_trips, dr.revenue_aed_where_priced,
       dr.first_day AS first_service_day, dr.last_day AS last_service_day,
       (dr.last_day - dr.first_day + 1)  AS tenure_days,
       dr.days_worked,
       round(100.0 * dr.days_worked / nullif(dr.last_day - dr.first_day + 1, 0)::numeric, 1) AS pct_days_worked_in_tenure,
       s.longest_streak_days, s.median_streak_days, s.mean_streak_days, s.streaks, s.streaks_14d_plus,
       coalesce(rr.rest_days_in_tenure, 0) AS rest_days_in_tenure,
       round(7.0 * coalesce(rr.rest_days_in_tenure, 0)
             / nullif(dr.last_day - dr.first_day + 1, 0)::numeric, 2) AS rest_days_per_week,
       rr.most_common_rest_dow, rr.rest_days_on_that_dow, rr.rest_by_dow
  FROM drv dr
  LEFT JOIN streak_stat s ON s.person_key = dr.person_key
  LEFT JOIN rest_roll  rr ON rr.person_key = dr.person_key
 WHERE dr.completed_trips >= 30
 ORDER BY dr.trips_rank;
```

**How to read it.** `pct_days_worked_in_tenure` and `longest_streak_days` are the headline pair, and both are computed on the **service day** defined at B5. That is load-bearing here: on calendar days, a single 20:00→02:00 shift stamps two consecutive dates, so a driver working alternate nights reads as an unbroken streak and the rest day after a night shift is invisible. On calendar grain this query inflates every streak, understates every rest day, and shifts `most_common_rest_dow` by one for every night worker.

`rest_by_dow` is a complete seven-value profile — weekdays with no rest day appear as an explicit zero rather than being silently absent — so it can be compared between drivers directly. Check `dows_tied_at_max` before quoting `most_common_rest_dow`: a value above 1 means the "rest day" is a tie broken by weekday order, not a pattern. Tenure is measured from the driver's first to last observed service day, so `rest_days_in_tenure` counts only gaps inside their working life, not the months before they joined.

#### B9. Cohort versus fleet by season — do the top ten move their schedule?

```sql
-- B9  TOP-10 COHORT vs FLEET, BY SEASON. Do the top ten start earlier, work longer,
-- or move their schedule during Ramadan / summer / high season — against the rest of
-- the fleet and against themselves in other seasons?
-- Fixes: (a) the season join was an INNER JOIN against a calendar running only
--        :start..:end, while the join key is the 04:00-anchored service day. Every
--        session starting 00:00-04:00 on :start has service day :start-1, had no
--        calendar row, and was DROPPED rather than labelled — silently deleting
--        exactly the small-hours sessions this query characterises. The spine now
--        spans :start-1 .. :end+1 and the trim is explicit;
--        (b) the trip fetch runs one calendar day past :end so the final night is
--        whole, matching B5;
--        (c) the cohort cut is row_number, not rank, so 'top10' is ten people;
--        (d) the per-session rates are computed from totals, so they are weighted
--        the same way as mean_completed_per_session beside them.
WITH params AS (SELECT 90 AS gap_min, 30 AS assumed_trip_min),
b AS (
  SELECT t.person_key, t.external_id, t.driver_name, t.requested_at,
         CASE WHEN t.ended_at IS NOT NULL AND t.ended_at > t.requested_at THEN t.ended_at
              WHEN n.outcome = 'completed' THEN t.requested_at + make_interval(mins => p.assumed_trip_min)
              ELSE t.requested_at END AS end_est,
         n.outcome, n.has_fare, n.price
    FROM trip_norm n
    JOIN trip t ON t.platform = n.platform AND t.external_id = n.external_id
    CROSS JOIN params p
   WHERE n.is_booking
     AND (t.requested_at AT TIME ZONE 'Asia/Dubai')::date BETWEEN :start::date AND :end::date + 1
     AND coalesce(btrim(t.driver_name), '') <> ''
),
cohort AS (
  SELECT person_key, count(*) FILTER (WHERE outcome = 'completed') AS completed_trips,
         row_number() OVER (ORDER BY count(*) FILTER (WHERE outcome = 'completed') DESC, person_key) AS trips_rank
    FROM b GROUP BY person_key
),
marked AS (
  SELECT b.*, max(b.end_est) OVER (PARTITION BY b.person_key ORDER BY b.requested_at, b.external_id
                                   ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_end
    FROM b
),
sess AS (
  SELECT m.*,
         sum(CASE WHEN m.prev_end IS NULL OR m.requested_at - m.prev_end > make_interval(mins => p.gap_min)
                  THEN 1 ELSE 0 END)
           OVER (PARTITION BY m.person_key ORDER BY m.requested_at, m.external_id
                 ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS session_no
    FROM marked m CROSS JOIN params p
),
session_agg AS (
  SELECT s.person_key, s.session_no,
         max(s.driver_name) AS driver_name,
         min(s.requested_at) AS started_at,
         max(s.end_est)      AS ended_at,
         count(*) FILTER (WHERE s.outcome = 'completed')::int AS completed,
         sum(extract(epoch FROM s.end_est - s.requested_at)) FILTER (WHERE s.outcome = 'completed') / 60.0 AS on_trip_min,
         sum(s.price) FILTER (WHERE s.has_fare) AS revenue_aed
    FROM sess s GROUP BY s.person_key, s.session_no
  HAVING count(*) FILTER (WHERE s.outcome = 'completed') > 0
),
-- spine widened by a day on each side so no service day is unlabelled
cal AS (SELECT generate_series(:start::date - 1, :end::date + 1, interval '1 day')::date AS day),
season AS (
  SELECT c.day, coalesce(w.code, 'baseline') AS season
    FROM cal c
    LEFT JOIN LATERAL (
      SELECT e.code
        FROM world_event e
       WHERE e.code IN ('ramadan', 'eid_fitr', 'summer', 'high_season',
                        'school_summer_break', 'school_winter_break')
         AND c.day BETWEEN e.starts_on AND coalesce(e.ends_on, e.starts_on)
       ORDER BY CASE e.code WHEN 'ramadan' THEN 1 WHEN 'eid_fitr' THEN 2 WHEN 'summer' THEN 3
                            WHEN 'high_season' THEN 4 ELSE 5 END,
                e.confidence DESC NULLS LAST
       LIMIT 1
    ) w ON true
),
labelled AS (
  SELECT CASE WHEN co.trips_rank <= 10 THEN 'top10' ELSE 'rest_of_fleet' END AS cohort,
         se.season,
         sa.person_key, sa.driver_name, sa.completed, sa.on_trip_min, sa.revenue_aed,
         extract(hour FROM ((sa.started_at AT TIME ZONE 'Asia/Dubai') - interval '4 hours'))::int AS start_shift_hour,
         extract(epoch FROM sa.ended_at - sa.started_at) / 60.0 AS session_min
    FROM session_agg sa
    JOIN cohort co ON co.person_key = sa.person_key
    JOIN season se ON se.day = ((sa.started_at AT TIME ZONE 'Asia/Dubai') - interval '4 hours')::date
   -- explicit trim on the SERVICE day: the truncated nights at each edge are
   -- excluded deliberately rather than lost to a missing calendar row
   WHERE se.day BETWEEN :start::date AND :end::date
)
SELECT cohort, season,
       count(*)::int                      AS sessions,
       count(DISTINCT person_key)::int    AS drivers,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY start_shift_hour)::numeric, 1) AS median_start_shift_hour,
       mod((round(percentile_cont(0.5) WITHIN GROUP (ORDER BY start_shift_hour))::int + 4), 24) AS median_start_clock_hour,
       round(percentile_cont(0.25) WITHIN GROUP (ORDER BY start_shift_hour)::numeric, 1) AS p25_start_shift_hour,
       round(percentile_cont(0.75) WITHIN GROUP (ORDER BY start_shift_hour)::numeric, 1) AS p75_start_shift_hour,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY session_min)::numeric, 1) AS median_session_min,
       round(percentile_cont(0.9) WITHIN GROUP (ORDER BY session_min)::numeric, 1) AS p90_session_min,
       round(avg(completed)::numeric, 2)  AS mean_completed_per_session,
       -- rates from totals, so they are weighted like the mean beside them
       round(60 * sum(completed)::numeric / nullif(sum(session_min), 0)::numeric, 2) AS completed_trips_per_session_hour,
       round(100 * sum(on_trip_min)::numeric / nullif(sum(session_min), 0)::numeric, 1) AS on_trip_pct,
       round(sum(revenue_aed)::numeric, 2) AS revenue_aed_where_priced,
       count(*) FILTER (WHERE revenue_aed IS NOT NULL)::int AS sessions_with_any_fare
  FROM labelled
 GROUP BY cohort, season
 ORDER BY cohort, sessions DESC;
```

**How to read it.** Rows are cohort x season, with `sessions` and `drivers` on every row so you always know the population behind a median. Compare down the `top10` block first — the cohort against itself across seasons — and only then across to `rest_of_fleet` in the same season. A cohort that keeps `median_start_clock_hour` steady while the fleet's drifts is a scheduling result; a cohort whose `median_session_min` rises in Ramadan while the fleet's falls is a behavioural one.

The seasons come from `world_event`, the seeded seasonality calendar, because `calendar_day` is unusable as a calendar dimension — only today's row is ever written and `is_holiday`/`holiday_name` are declared and never populated. Consequence: UAE public holidays other than Eid al-Fitr are not labelled and Eid al-Adha has no code, so those days fall into `baseline`. The cohort is a hard cut of ten by `row_number` rather than `rank`, so a tie at tenth place cannot quietly produce an eleven-person "top ten"; note that the cohort is fixed over the whole window while the comparison is per-season, so a driver who was top ten on the strength of one season carries that label into every season. The per-session rates (`completed_trips_per_session_hour`, `on_trip_pct`) are computed from totals rather than as ratios of means, so they are weighted the same way as `mean_completed_per_session` sitting beside them.

---

### MODULE C — SPATIAL: WHERE THEY PICK UP, WHERE THEY DROP

> Every query in this module uses the same area heuristic: `split_part(addr, ' - ', 2)` — the second segment of the address string, which is the district in Dubai addressing ("Marina Gate 1 **- Dubai Marina -** Dubai"). This is the same `areaOf` heuristic your own API uses. **It is a text heuristic, not geodata.** Run C1 first.

#### C1. Location coverage audit — run before anything spatial

```sql
-- C1  LOCATION COVERAGE AUDIT. What fraction of each channel's rows carry a location at all.
-- Expected: coordinates exist ONLY on hotel bookings and FMS telematics. Uber and Yango give
-- free-text addresses and no coordinate. BOLT GIVES NEITHER — bolt.js maps no address and no
-- lat/lng field at all, so Bolt is structurally invisible to every spatial query below.
-- Read pct_with_pickup_area before trusting any area ranking: an area share computed over 40%
-- coverage is a statement about the 40%, not about the driver.
SELECT n.platform,
       n.is_booking,
       count(*)                                                                    AS rows_in_window,
       count(*) FILTER (WHERE coalesce(btrim(n.pickup_addr), '') <> '')            AS with_pickup_addr,
       round(100.0 * count(*) FILTER (WHERE coalesce(btrim(n.pickup_addr), '') <> '')
             / nullif(count(*), 0)::numeric, 1)                                    AS pct_with_pickup_addr,
       count(*) FILTER (WHERE coalesce(btrim(n.dropoff_addr), '') <> '')           AS with_dropoff_addr,
       -- the area heuristic only works when the address actually has a ' - ' segment
       count(*) FILTER (WHERE nullif(btrim(split_part(n.pickup_addr, ' - ', 2)), '') IS NOT NULL)
                                                                                   AS with_pickup_area,
       round(100.0 * count(*) FILTER (WHERE nullif(btrim(split_part(n.pickup_addr, ' - ', 2)), '') IS NOT NULL)
             / nullif(count(*), 0)::numeric, 1)                                    AS pct_with_pickup_area,
       count(*) FILTER (WHERE n.pickup_lat IS NOT NULL AND n.pickup_lng IS NOT NULL) AS with_pickup_coords,
       round(100.0 * count(*) FILTER (WHERE n.pickup_lat IS NOT NULL)
             / nullif(count(*), 0)::numeric, 1)                                    AS pct_with_pickup_coords,
       count(*) FILTER (WHERE n.dropoff_lat IS NOT NULL)                           AS with_dropoff_coords,
       count(*) FILTER (WHERE coalesce(btrim(n.zone), '') <> '')                   AS with_zone,
       count(*) FILTER (WHERE n.deadhead_km IS NOT NULL)                           AS with_approach_deadhead,
       count(*) FILTER (WHERE n.return_deadhead_km IS NOT NULL)                    AS with_return_deadhead,
       count(*) FILTER (WHERE coalesce(btrim(n.pickup_addr), '') = ''
                          AND n.pickup_lat IS NULL)                                AS with_NO_location_at_all
  FROM trip_norm n
 WHERE (n.requested_at AT TIME ZONE 'Asia/Dubai')::date BETWEEN :start::date AND :end::date
 GROUP BY n.platform, n.is_booking
 ORDER BY n.is_booking DESC, rows_in_window DESC;
```

#### C2. Top pickup and dropoff areas per driver

```sql
-- C2  TOP PICKUP AND DROPOFF AREAS PER DRIVER, cohort-labelled.
-- Area = second ' - ' segment of the address (the district), falling back to the whole trimmed
-- address when the string has no segment. Uber, Yango and hotel only — Bolt carries no address.
-- addr_coverage_pct is the honesty column: it is the share of that driver's completed bookings
-- that had a usable pickup area. Everything to its right describes only those rows.
WITH b AS (
  SELECT t.person_key, t.driver_name, n.platform,
         nullif(btrim(split_part(n.pickup_addr,  ' - ', 2)), '')  AS pickup_area_raw,
         nullif(btrim(split_part(n.dropoff_addr, ' - ', 2)), '')  AS dropoff_area_raw,
         nullif(btrim(n.pickup_addr),  '')                        AS pickup_addr,
         nullif(btrim(n.dropoff_addr), '')                        AS dropoff_addr,
         n.has_fare, n.price, n.has_distance, n.distance_km
    FROM trip_norm n
    JOIN trip t ON t.platform = n.platform AND t.external_id = n.external_id
   WHERE n.is_booking
     AND n.outcome = 'completed'
     AND (t.requested_at AT TIME ZONE 'Asia/Dubai')::date BETWEEN :start::date AND :end::date
     AND coalesce(t.person_key, '') <> ''
),
labelled AS (
  SELECT person_key, driver_name, platform, has_fare, price, has_distance, distance_km,
         lower(coalesce(pickup_area_raw,  pickup_addr))  AS pickup_area,
         lower(coalesce(dropoff_area_raw, dropoff_addr)) AS dropoff_area
    FROM b
),
drv AS (
  SELECT person_key, max(driver_name) AS driver_name,
         count(*)                                              AS completed_trips,
         count(*) FILTER (WHERE pickup_area IS NOT NULL)        AS trips_with_pickup_area,
         count(*) FILTER (WHERE dropoff_area IS NOT NULL)       AS trips_with_dropoff_area,
         rank() OVER (ORDER BY count(*) DESC)                   AS trips_rank
    FROM labelled GROUP BY person_key
),
pick AS (
  SELECT person_key, pickup_area AS area, count(*) AS n,
         round(sum(distance_km) FILTER (WHERE has_distance)::numeric
               / nullif(count(*) FILTER (WHERE has_distance), 0), 2) AS avg_km,
         round(sum(price) FILTER (WHERE has_fare)
               / nullif(count(*) FILTER (WHERE has_fare), 0), 2)     AS avg_aed_where_priced,
         row_number() OVER (PARTITION BY person_key ORDER BY count(*) DESC, pickup_area) AS rn
    FROM labelled WHERE pickup_area IS NOT NULL GROUP BY person_key, pickup_area
),
drop_ AS (
  SELECT person_key, dropoff_area AS area, count(*) AS n,
         row_number() OVER (PARTITION BY person_key ORDER BY count(*) DESC, dropoff_area) AS rn
    FROM labelled WHERE dropoff_area IS NOT NULL GROUP BY person_key, dropoff_area
)
SELECT d.person_key, d.driver_name, d.trips_rank,
       (d.trips_rank <= 10) AS in_top10_by_trips,
       d.completed_trips,
       d.trips_with_pickup_area,
       round(100.0 * d.trips_with_pickup_area / nullif(d.completed_trips, 0)::numeric, 1) AS addr_coverage_pct,
       -- top 5 pickup districts, with each one's share of the driver's LOCATED trips
       string_agg(p.area || ' (' || p.n || ', '
                  || round(100.0 * p.n / nullif(d.trips_with_pickup_area, 0)::numeric, 1) || '%)',
                  ' | ' ORDER BY p.rn) FILTER (WHERE p.rn <= 5)                    AS top5_pickup_areas,
       max(p.n) FILTER (WHERE p.rn = 1)                                            AS top_pickup_area_trips,
       round(100.0 * max(p.n) FILTER (WHERE p.rn = 1)
             / nullif(d.trips_with_pickup_area, 0)::numeric, 1)                    AS top_pickup_area_share_pct,
       -- concentration: how many districts hold this driver's work
       count(DISTINCT p.area)                                                      AS distinct_pickup_areas,
       max(dp.area) FILTER (WHERE dp.rn = 1)                                       AS top_dropoff_area,
       round(100.0 * max(dp.n) FILTER (WHERE dp.rn = 1)
             / nullif(d.trips_with_dropoff_area, 0)::numeric, 1)                   AS top_dropoff_area_share_pct
  FROM drv d
  LEFT JOIN pick  p  ON p.person_key  = d.person_key AND p.rn  <= 5
  LEFT JOIN drop_ dp ON dp.person_key = d.person_key AND dp.rn <= 5
 WHERE d.completed_trips >= 30
 GROUP BY d.person_key, d.driver_name, d.trips_rank, d.completed_trips,
          d.trips_with_pickup_area, d.trips_with_dropoff_area
 ORDER BY d.trips_rank;
```

#### C3. Corridor pairs — top cohort vs the rest

```sql
-- C3  CORRIDOR PAIRS (pickup district -> dropoff district), cohort against the rest of the fleet.
-- The question this settles: are the top ten running a small set of high-yield corridors while
-- the fleet scatters? Compare cohort_share_pct with rest_share_pct on the same corridor.
-- avg_min is NOT computed: trip.duration_s is NULL on every row of every platform, and Bolt
-- never sets ended_at, so any duration would be one channel's assumption.
WITH b AS (
  SELECT t.person_key, n.platform, n.outcome, n.has_fare, n.price, n.has_distance, n.distance_km,
         lower(coalesce(nullif(btrim(split_part(n.pickup_addr,  ' - ', 2)), ''), nullif(btrim(n.pickup_addr),  ''))) AS pickup_area,
         lower(coalesce(nullif(btrim(split_part(n.dropoff_addr, ' - ', 2)), ''), nullif(btrim(n.dropoff_addr), ''))) AS dropoff_area,
         date_trunc('month', (t.requested_at AT TIME ZONE 'Asia/Dubai'))::date AS month
    FROM trip_norm n
    JOIN trip t ON t.platform = n.platform AND t.external_id = n.external_id
   WHERE n.is_booking
     AND (t.requested_at AT TIME ZONE 'Asia/Dubai')::date BETWEEN :start::date AND :end::date
     AND coalesce(t.person_key, '') <> ''
),
dm AS (
  SELECT month, person_key, count(*) FILTER (WHERE outcome = 'completed') AS completed_trips
    FROM b GROUP BY 1, 2
),
lb AS (
  SELECT dm.*, rank() OVER (PARTITION BY month ORDER BY completed_trips DESC, person_key) AS rank_trips
    FROM dm WHERE completed_trips > 0
),
cohort AS (
  SELECT person_key,
         CASE WHEN count(*) FILTER (WHERE rank_trips <= 10) >= 10 THEN 'A_permanent_top10'
              WHEN count(*) FILTER (WHERE rank_trips <= 10) >= 4  THEN 'B_volatile_high_performer'
              WHEN count(*) FILTER (WHERE rank_trips <= 10) >= 1  THEN 'C_spike_only'
              WHEN min(rank_trips) <= 30                          THEN 'D_chaser_11_to_30'
              ELSE 'E_rest_of_fleet' END AS cohort
    FROM lb GROUP BY person_key
),
grp AS (
  SELECT CASE WHEN c.cohort = 'A_permanent_top10' THEN 'permanent_top10' ELSE 'rest_of_fleet' END AS grp,
         b.pickup_area, b.dropoff_area, b.has_fare, b.price, b.has_distance, b.distance_km
    FROM b JOIN cohort c ON c.person_key = b.person_key
   WHERE b.outcome = 'completed'
     AND b.pickup_area IS NOT NULL AND b.dropoff_area IS NOT NULL
),
tot AS (SELECT grp, count(*)::numeric AS n FROM grp GROUP BY 1),
corr AS (
  SELECT g.grp, g.pickup_area, g.dropoff_area,
         count(*)                                                            AS trips,
         round(100.0 * count(*) / nullif(t.n, 0), 2)                         AS share_pct,
         round(sum(g.distance_km) FILTER (WHERE g.has_distance)::numeric
               / nullif(count(*) FILTER (WHERE g.has_distance), 0), 2)       AS avg_km,
         count(*) FILTER (WHERE g.has_fare)                                  AS priced_trips,
         round(sum(g.price) FILTER (WHERE g.has_fare)
               / nullif(count(*) FILTER (WHERE g.has_fare), 0), 2)           AS avg_aed_where_priced
    FROM grp g JOIN tot t ON t.grp = g.grp
   GROUP BY g.grp, g.pickup_area, g.dropoff_area, t.n
)
SELECT c.pickup_area || '  ->  ' || c.dropoff_area                       AS corridor,
       max(c.trips)     FILTER (WHERE c.grp = 'permanent_top10')          AS cohort_trips,
       max(c.share_pct) FILTER (WHERE c.grp = 'permanent_top10')          AS cohort_share_pct,
       max(c.trips)     FILTER (WHERE c.grp = 'rest_of_fleet')            AS rest_trips,
       max(c.share_pct) FILTER (WHERE c.grp = 'rest_of_fleet')            AS rest_share_pct,
       round(coalesce(max(c.share_pct) FILTER (WHERE c.grp = 'permanent_top10'), 0)
             - coalesce(max(c.share_pct) FILTER (WHERE c.grp = 'rest_of_fleet'), 0), 2) AS cohort_minus_rest_pp,
       max(c.avg_km)                AS avg_km,
       max(c.avg_aed_where_priced)  AS avg_aed_where_priced,
       (c.pickup_area = c.dropoff_area) AS same_district_round_trip
  FROM corr c
 GROUP BY c.pickup_area, c.dropoff_area
HAVING coalesce(max(c.trips) FILTER (WHERE c.grp = 'permanent_top10'), 0)
     + coalesce(max(c.trips) FILTER (WHERE c.grp = 'rest_of_fleet'), 0) >= 25
 ORDER BY cohort_minus_rest_pp DESC NULLS LAST
 LIMIT 40;
```

#### C4. Airport specialisation

```sql
-- C4  AIRPORT SPECIALISATION — does the top cohort live off the airport run?
-- Match is on the address text: 'airport', 'dxb', 'terminal', 'al maktoum', 'dwc'.
-- KNOWN FALSE POSITIVE: 'terminal' also matches bus and marine terminals. The two columns
-- airport_strict (airport|dxb|dwc|al maktoum) and airport_loose (adds 'terminal') are reported
-- separately so you can see how much the loose rule adds before believing it.
WITH b AS (
  SELECT t.person_key, t.driver_name, n.platform, n.outcome,
         n.has_fare, n.price, n.has_distance, n.distance_km, n.local_hour,
         lower(coalesce(n.pickup_addr,  '')) AS pu,
         lower(coalesce(n.dropoff_addr, '')) AS du,
         date_trunc('month', (t.requested_at AT TIME ZONE 'Asia/Dubai'))::date AS month
    FROM trip_norm n
    JOIN trip t ON t.platform = n.platform AND t.external_id = n.external_id
   WHERE n.is_booking
     AND (t.requested_at AT TIME ZONE 'Asia/Dubai')::date BETWEEN :start::date AND :end::date
     AND coalesce(t.person_key, '') <> ''
),
dm AS (SELECT month, person_key, count(*) FILTER (WHERE outcome = 'completed') AS completed_trips FROM b GROUP BY 1, 2),
lb AS (SELECT dm.*, rank() OVER (PARTITION BY month ORDER BY completed_trips DESC, person_key) AS rank_trips FROM dm WHERE completed_trips > 0),
cohort AS (
  SELECT person_key,
         CASE WHEN count(*) FILTER (WHERE rank_trips <= 10) >= 10 THEN 'A_permanent_top10'
              WHEN count(*) FILTER (WHERE rank_trips <= 10) >= 4  THEN 'B_volatile_high_performer'
              WHEN count(*) FILTER (WHERE rank_trips <= 10) >= 1  THEN 'C_spike_only'
              WHEN min(rank_trips) <= 30                          THEN 'D_chaser_11_to_30'
              ELSE 'E_rest_of_fleet' END AS cohort
    FROM lb GROUP BY person_key
),
flagged AS (
  SELECT b.*, c.cohort,
         (b.pu ~ '(airport|dxb|dwc|al maktoum)') AS pu_air_strict,
         (b.du ~ '(airport|dxb|dwc|al maktoum)') AS du_air_strict,
         (b.pu ~ '(airport|dxb|dwc|al maktoum|terminal)') AS pu_air_loose,
         (b.du ~ '(airport|dxb|dwc|al maktoum|terminal)') AS du_air_loose,
         (coalesce(btrim(b.pu), '') <> '' OR coalesce(btrim(b.du), '') <> '') AS has_any_addr
    FROM b JOIN cohort c ON c.person_key = b.person_key
   WHERE b.outcome = 'completed'
)
SELECT cohort,
       count(*)                                                                 AS completed_trips,
       count(DISTINCT person_key)                                               AS drivers,
       count(*) FILTER (WHERE has_any_addr)                                     AS trips_with_an_address,
       round(100.0 * count(*) FILTER (WHERE has_any_addr) / nullif(count(*), 0)::numeric, 1) AS addr_coverage_pct,
       -- STRICT
       count(*) FILTER (WHERE pu_air_strict)                                    AS pickups_at_airport,
       count(*) FILTER (WHERE du_air_strict)                                    AS dropoffs_at_airport,
       round(100.0 * count(*) FILTER (WHERE pu_air_strict OR du_air_strict)
             / nullif(count(*) FILTER (WHERE has_any_addr), 0)::numeric, 1)     AS pct_airport_touching_strict,
       -- LOOSE (adds 'terminal' — compare with strict before believing the gap)
       round(100.0 * count(*) FILTER (WHERE pu_air_loose OR du_air_loose)
             / nullif(count(*) FILTER (WHERE has_any_addr), 0)::numeric, 1)     AS pct_airport_touching_loose,
       -- the classic airport wave: 00:00-05:00 Dubai is its own band in trip_ext.daypart
       round(100.0 * count(*) FILTER (WHERE (pu_air_strict OR du_air_strict) AND local_hour < 5)
             / nullif(count(*) FILTER (WHERE pu_air_strict OR du_air_strict), 0)::numeric, 1) AS pct_of_airport_trips_before_0500,
       round(sum(distance_km) FILTER (WHERE has_distance AND (pu_air_strict OR du_air_strict))::numeric
             / nullif(count(*) FILTER (WHERE has_distance AND (pu_air_strict OR du_air_strict)), 0), 2) AS avg_km_airport,
       round(sum(distance_km) FILTER (WHERE has_distance AND NOT (pu_air_strict OR du_air_strict))::numeric
             / nullif(count(*) FILTER (WHERE has_distance AND NOT (pu_air_strict OR du_air_strict)), 0), 2) AS avg_km_non_airport,
       round(sum(price) FILTER (WHERE has_fare AND (pu_air_strict OR du_air_strict))
             / nullif(count(*) FILTER (WHERE has_fare AND (pu_air_strict OR du_air_strict)), 0), 2) AS avg_aed_airport_where_priced,
       round(sum(price) FILTER (WHERE has_fare AND NOT (pu_air_strict OR du_air_strict))
             / nullif(count(*) FILTER (WHERE has_fare AND NOT (pu_air_strict OR du_air_strict)), 0), 2) AS avg_aed_non_airport_where_priced
  FROM flagged
 GROUP BY GROUPING SETS ((cohort), ())
 ORDER BY cohort NULLS LAST;
```

#### C5. Coordinate hotspots — hotel bookings and FMS journeys only

```sql
-- C5  COORDINATE HOTSPOTS. The only real geography in the database.
-- COVERAGE: pickup_lat/lng and dropoff_lat/lng are populated ONLY by the hotel channel
-- (startLat/startLon) and by FMS telematics (StartLat/StartLon). Uber, Yango and Bolt are
-- entirely absent. So this describes the corporate/property channel plus every GPS journey —
-- it does NOT describe your Uber demand.
-- Grid: 0.01 degrees is roughly 1.1 km north-south in Dubai. Widen to 0.02 for a coarser map.
WITH cells AS (
  SELECT n.platform,
         n.is_booking,
         round(n.pickup_lat::numeric, 2)  AS lat_cell,
         round(n.pickup_lng::numeric, 2)  AS lng_cell,
         n.pickup_addr, n.zone,
         n.has_fare, n.price, n.has_distance, n.distance_km,
         n.local_hour,
         t.person_key, t.driver_name, n.plate
    FROM trip_norm n
    LEFT JOIN trip t ON t.platform = n.platform AND t.external_id = n.external_id
   WHERE (n.requested_at AT TIME ZONE 'Asia/Dubai')::date BETWEEN :start::date AND :end::date
     AND n.pickup_lat IS NOT NULL AND n.pickup_lng IS NOT NULL
     AND n.pickup_lat BETWEEN 24.0 AND 26.5      -- sanity box around Dubai; a 0,0 fix is a bad fix
     AND n.pickup_lng BETWEEN 54.0 AND 56.5
)
SELECT platform,
       CASE WHEN is_booking THEN 'booking' ELSE 'telematics journey' END AS row_kind,
       lat_cell, lng_cell,
       count(*)                                        AS pickups,
       count(DISTINCT person_key)                      AS distinct_drivers,
       count(DISTINCT plate)                           AS distinct_plates,
       round(avg(local_hour)::numeric, 1)              AS mean_hour,
       mode() WITHIN GROUP (ORDER BY local_hour)       AS modal_hour,
       (array_agg(DISTINCT zone) FILTER (WHERE coalesce(btrim(zone), '') <> ''))[1:3] AS zones_seen,
       (array_agg(pickup_addr ORDER BY pickup_addr))[1]                              AS example_address,
       round(sum(distance_km) FILTER (WHERE has_distance)::numeric
             / nullif(count(*) FILTER (WHERE has_distance), 0), 2)                    AS avg_km,
       round(sum(price) FILTER (WHERE has_fare)
             / nullif(count(*) FILTER (WHERE has_fare), 0), 2)                        AS avg_aed_where_priced
  FROM cells
 GROUP BY platform, is_booking, lat_cell, lng_cell
HAVING count(*) >= 10
 ORDER BY pickups DESC
 LIMIT 60;
```

#### C6. Chain gap and repositioning — do the top ten turn round faster?

```sql
-- C6  CHAIN GAP AND REPOSITIONING. Between one completed job and the next: how long the driver
-- waited, and whether the next pickup was in the district where the last one dropped.
-- This is the direct test of "top performers reposition faster / better".
--   same_district_pct  high + gap low  = they stay in a dense pocket and get re-dispatched
--   same_district_pct  low  + gap low  = they are moving deliberately to the next demand pocket
--   gap high                            = they are waiting where the work is not
-- Only chains inside one service day and under 240 minutes are counted — beyond that it is not
-- a repositioning decision, it is the end of a shift.
-- Gap uses measured ended_at where present; where a channel omits it (Bolt: always) the
-- documented 30-minute assumption applies, and gaps_with_measured_end says how many are real.
WITH b AS (
  SELECT t.person_key, t.driver_name, t.external_id, n.platform,
         t.requested_at,
         CASE WHEN t.ended_at IS NOT NULL AND t.ended_at > t.requested_at THEN t.ended_at
              ELSE t.requested_at + interval '30 minutes' END AS end_est,
         (t.ended_at IS NOT NULL AND t.ended_at > t.requested_at) AS end_measured,
         ((t.requested_at AT TIME ZONE 'Asia/Dubai') - interval '4 hours')::date AS service_day,
         date_trunc('month', (t.requested_at AT TIME ZONE 'Asia/Dubai'))::date   AS month,
         lower(coalesce(nullif(btrim(split_part(n.pickup_addr,  ' - ', 2)), ''), nullif(btrim(n.pickup_addr),  ''))) AS pickup_area,
         lower(coalesce(nullif(btrim(split_part(n.dropoff_addr, ' - ', 2)), ''), nullif(btrim(n.dropoff_addr), ''))) AS dropoff_area,
         n.outcome, n.has_distance, n.distance_km
    FROM trip_norm n
    JOIN trip t ON t.platform = n.platform AND t.external_id = n.external_id
   WHERE n.is_booking
     AND (t.requested_at AT TIME ZONE 'Asia/Dubai')::date BETWEEN :start::date AND :end::date
     AND coalesce(t.person_key, '') <> ''
),
dm AS (SELECT month, person_key, count(*) FILTER (WHERE outcome = 'completed') AS completed_trips FROM b GROUP BY 1, 2),
lb AS (SELECT dm.*, rank() OVER (PARTITION BY month ORDER BY completed_trips DESC, person_key) AS rank_trips FROM dm WHERE completed_trips > 0),
cohort AS (
  SELECT person_key,
         CASE WHEN count(*) FILTER (WHERE rank_trips <= 10) >= 10 THEN 'A_permanent_top10'
              WHEN count(*) FILTER (WHERE rank_trips <= 10) >= 4  THEN 'B_volatile_high_performer'
              WHEN count(*) FILTER (WHERE rank_trips <= 10) >= 1  THEN 'C_spike_only'
              WHEN min(rank_trips) <= 30                          THEN 'D_chaser_11_to_30'
              ELSE 'E_rest_of_fleet' END AS cohort
    FROM lb GROUP BY person_key
),
done AS (SELECT * FROM b WHERE outcome = 'completed'),
chained AS (
  SELECT d.*,
         lead(d.requested_at)  OVER w AS next_requested_at,
         lead(d.pickup_area)   OVER w AS next_pickup_area,
         lead(d.platform)      OVER w AS next_platform,
         lead(d.service_day)   OVER w AS next_service_day
    FROM done d
  WINDOW w AS (PARTITION BY d.person_key ORDER BY d.requested_at, d.external_id)
),
gaps AS (
  SELECT c.person_key, co.cohort, c.month, c.platform, c.next_platform,
         extract(epoch FROM c.next_requested_at - c.end_est) / 60.0 AS gap_min,
         c.end_measured,
         c.dropoff_area, c.next_pickup_area,
         (c.dropoff_area IS NOT NULL AND c.next_pickup_area IS NOT NULL
          AND c.dropoff_area = c.next_pickup_area)                  AS same_district,
         (c.dropoff_area IS NOT NULL AND c.next_pickup_area IS NOT NULL) AS both_areas_known,
         (c.platform <> c.next_platform)                            AS platform_switch
    FROM chained c
    JOIN cohort co ON co.person_key = c.person_key
   WHERE c.next_requested_at IS NOT NULL
     AND c.service_day = c.next_service_day
     AND extract(epoch FROM c.next_requested_at - c.end_est) / 60.0 BETWEEN -30 AND 240
)
SELECT coalesce(cohort, 'ALL_DRIVERS') AS cohort,
       count(*)                                                                  AS chained_pairs,
       count(DISTINCT person_key)                                                AS drivers,
       count(*) FILTER (WHERE end_measured)                                      AS gaps_with_measured_end,
       round(100.0 * count(*) FILTER (WHERE end_measured) / nullif(count(*), 0)::numeric, 1) AS pct_gaps_measured,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY gap_min)::numeric, 1)   AS median_gap_min,
       round(percentile_cont(0.25) WITHIN GROUP (ORDER BY gap_min)::numeric, 1)  AS p25_gap_min,
       round(percentile_cont(0.75) WITHIN GROUP (ORDER BY gap_min)::numeric, 1)  AS p75_gap_min,
       round(100.0 * count(*) FILTER (WHERE gap_min <= 10) / nullif(count(*), 0)::numeric, 1) AS pct_back_to_back_under_10min,
       count(*) FILTER (WHERE both_areas_known)                                  AS pairs_with_both_areas,
       round(100.0 * count(*) FILTER (WHERE same_district)
             / nullif(count(*) FILTER (WHERE both_areas_known), 0)::numeric, 1)  AS same_district_pct,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY gap_min)
             FILTER (WHERE same_district)::numeric, 1)                           AS median_gap_same_district,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY gap_min)
             FILTER (WHERE both_areas_known AND NOT same_district)::numeric, 1)  AS median_gap_moved_district,
       round(100.0 * count(*) FILTER (WHERE platform_switch) / nullif(count(*), 0)::numeric, 1) AS pct_next_job_on_another_platform
  FROM gaps
 GROUP BY GROUPING SETS ((cohort), ())
 ORDER BY cohort NULLS LAST;
```

---

### MODULE D — RECENCY: LAST TRIP, MONTH ON MONTH

#### D1. Month-on-month activity and last trip

```sql
-- D1  MONTH-ON-MONTH ACTIVITY AND LAST TRIP, per driver.
-- One row per driver per month IN THEIR OWN TENURE (first to last active month), so a month
-- with no work shows as a zero row rather than disappearing — which is the whole point of a
-- "when was the last trip, month on month" question.
-- days_since_previous_trip is measured across the month boundary, so a driver who worked on the
-- 2nd and then not again until the 27th shows the gap, not just the monthly count.
WITH b AS (
  SELECT t.person_key, t.driver_name, n.platform, t.fleet_id, t.plate,
         t.requested_at,
         (t.requested_at AT TIME ZONE 'Asia/Dubai')::date                      AS local_day,
         date_trunc('month', (t.requested_at AT TIME ZONE 'Asia/Dubai'))::date AS month,
         n.outcome, n.has_fare, n.price
    FROM trip_norm n
    JOIN trip t ON t.platform = n.platform AND t.external_id = n.external_id
   WHERE n.is_booking
     AND n.outcome = 'completed'
     AND (t.requested_at AT TIME ZONE 'Asia/Dubai')::date BETWEEN :start::date AND :end::date
     AND coalesce(t.person_key, '') <> ''
),
months AS (
  SELECT gs::date AS month, row_number() OVER (ORDER BY gs)::int AS month_idx
    FROM generate_series(date_trunc('month', :start::date),
                         date_trunc('month', :end::date), interval '1 month') gs
),
dm AS (
  SELECT month, person_key, max(driver_name) AS driver_name,
         count(*)::int                       AS completed_trips,
         count(DISTINCT local_day)::int      AS active_days,
         min(local_day)                      AS first_trip_day,
         max(local_day)                      AS last_trip_day,
         max(requested_at)                   AS last_trip_at,
         round(sum(price) FILTER (WHERE has_fare)::numeric, 2) AS revenue_aed_where_priced,
         array_agg(DISTINCT platform ORDER BY platform)        AS platforms,
         array_agg(DISTINCT fleet_id) FILTER (WHERE fleet_id IS NOT NULL) AS fleets,
         mode() WITHIN GROUP (ORDER BY plate)                  AS modal_plate
    FROM b GROUP BY 1, 2
),
tenure AS (
  SELECT person_key, max(driver_name) AS driver_name,
         min(m.month_idx) AS first_idx, max(m.month_idx) AS last_idx
    FROM dm JOIN months m ON m.month = dm.month GROUP BY person_key
),
grid AS (
  SELECT te.person_key, te.driver_name, m.month, m.month_idx,
         coalesce(dm.completed_trips, 0) AS completed_trips,
         coalesce(dm.active_days, 0)     AS active_days,
         dm.first_trip_day, dm.last_trip_day, dm.last_trip_at,
         dm.revenue_aed_where_priced, dm.platforms, dm.fleets, dm.modal_plate
    FROM tenure te
    JOIN months m ON m.month_idx BETWEEN te.first_idx AND te.last_idx
    LEFT JOIN dm ON dm.person_key = te.person_key AND dm.month = m.month
)
SELECT g.person_key, g.driver_name, g.month,
       g.completed_trips, g.active_days,
       g.first_trip_day, g.last_trip_day,
       g.revenue_aed_where_priced, g.platforms, g.fleets, g.modal_plate,
       -- the running "last trip as of the end of this month"
       max(g.last_trip_day) OVER (PARTITION BY g.person_key ORDER BY g.month_idx
                                  ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS last_trip_day_to_date,
       (g.month + interval '1 month' - interval '1 day')::date
         - max(g.last_trip_day) OVER (PARTITION BY g.person_key ORDER BY g.month_idx
                                      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS days_dark_at_month_end,
       -- the gap across the month boundary
       g.first_trip_day - lag(g.last_trip_day IGNORE NULLS) OVER (PARTITION BY g.person_key ORDER BY g.month_idx)
                                                                                    AS days_since_previous_trip,
       lag(g.completed_trips) OVER (PARTITION BY g.person_key ORDER BY g.month_idx) AS prev_month_trips,
       round(100.0 * (g.completed_trips - lag(g.completed_trips) OVER (PARTITION BY g.person_key ORDER BY g.month_idx))::numeric
             / nullif((g.completed_trips + lag(g.completed_trips) OVER (PARTITION BY g.person_key ORDER BY g.month_idx))::numeric / 2, 0), 1)
                                                                                    AS mom_change_pct_symmetric,
       (g.completed_trips = 0) AS blank_month_inside_tenure
  FROM grid g
 ORDER BY g.person_key, g.month;
```

> Note: `lag(... IGNORE NULLS)` requires PostgreSQL 16+. On an older server, replace that one expression with `g.first_trip_day - max(g.last_trip_day) OVER (PARTITION BY g.person_key ORDER BY g.month_idx ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)`.

#### D2. Recency ladder — who is still here, who has gone quiet

```sql
-- D2  RECENCY LADDER. Whole-history last trip, not window-bounded, so a driver who stopped in
-- November is not reported as "last seen November" when they in fact drove for you in 2024.
-- last_fleet / last_plate come from the driver's most recent booking (DISTINCT ON), the same way
-- driver_lifetime derives them — "whose driver is this" for somebody who has left.
-- COST: the lifetime CTE scans the whole trip heap. See §5.
WITH lifetime AS (
  SELECT t.person_key,
         max(t.driver_name)                    AS driver_name,
         count(*) FILTER (WHERE n.is_booking)  AS lifetime_bookings,
         max(t.requested_at) FILTER (WHERE n.is_booking) AS last_ever_at,
         min(t.requested_at) FILTER (WHERE n.is_booking) AS first_ever_at
    FROM trip t
    JOIN trip_norm n ON n.platform = t.platform AND n.external_id = t.external_id
   WHERE coalesce(t.person_key, '') <> ''
     AND t.requested_at IS NOT NULL
   GROUP BY t.person_key
),
last_row AS (
  SELECT DISTINCT ON (t.person_key)
         t.person_key, t.fleet_id AS last_fleet, t.plate AS last_plate,
         t.platform AS last_platform, t.requested_at AS last_at
    FROM trip t
    JOIN trip_norm n ON n.platform = t.platform AND n.external_id = t.external_id
   WHERE n.is_booking AND coalesce(t.person_key, '') <> '' AND t.requested_at IS NOT NULL
   ORDER BY t.person_key, t.requested_at DESC
),
in_window AS (
  SELECT t.person_key,
         count(*) FILTER (WHERE n.outcome = 'completed')                 AS completed_trips_in_window,
         count(DISTINCT date_trunc('month', (t.requested_at AT TIME ZONE 'Asia/Dubai'))::date) AS months_active_in_window,
         count(DISTINCT (t.requested_at AT TIME ZONE 'Asia/Dubai')::date) AS days_active_in_window,
         array_agg(DISTINCT n.platform ORDER BY n.platform)               AS platforms_in_window
    FROM trip_norm n
    JOIN trip t ON t.platform = n.platform AND t.external_id = n.external_id
   WHERE n.is_booking
     AND (t.requested_at AT TIME ZONE 'Asia/Dubai')::date BETWEEN :start::date AND :end::date
     AND coalesce(t.person_key, '') <> ''
   GROUP BY t.person_key
),
state AS (   -- can this person legally take work at all? A driver who CANNOT earn is not idle.
  SELECT s.person_key,
         array_agg(DISTINCT s.platform || ':' || coalesce(s.state, 'unknown') ORDER BY s.platform || ':' || coalesce(s.state, 'unknown')) AS platform_states,
         bool_or(s.can_earn) AS can_earn_somewhere
    FROM driver_platform_state s
   WHERE coalesce(s.person_key, '') <> ''
   GROUP BY s.person_key
)
SELECT l.person_key, l.driver_name,
       lr.last_fleet, lr.last_plate, lr.last_platform,
       (l.last_ever_at AT TIME ZONE 'Asia/Dubai')::date          AS last_trip_day,
       :end::date - (l.last_ever_at AT TIME ZONE 'Asia/Dubai')::date AS days_since_last_trip,
       (l.first_ever_at AT TIME ZONE 'Asia/Dubai')::date         AS first_trip_ever,
       l.lifetime_bookings,
       coalesce(w.completed_trips_in_window, 0)                  AS completed_trips_in_window,
       coalesce(w.months_active_in_window, 0)                    AS months_active_in_window,
       coalesce(w.days_active_in_window, 0)                      AS days_active_in_window,
       w.platforms_in_window,
       st.platform_states, st.can_earn_somewhere,
       CASE
         WHEN :end::date - (l.last_ever_at AT TIME ZONE 'Asia/Dubai')::date <= 7   THEN '0_active_this_week'
         WHEN :end::date - (l.last_ever_at AT TIME ZONE 'Asia/Dubai')::date <= 30  THEN '1_active_this_month'
         WHEN :end::date - (l.last_ever_at AT TIME ZONE 'Asia/Dubai')::date <= 60  THEN '2_slipping_30_60d'
         WHEN :end::date - (l.last_ever_at AT TIME ZONE 'Asia/Dubai')::date <= 120 THEN '3_dormant_60_120d'
         WHEN :end::date - (l.last_ever_at AT TIME ZONE 'Asia/Dubai')::date <= 365 THEN '4_gone_this_year'
         ELSE '5_historic'
       END                                                       AS recency_band
  FROM lifetime l
  LEFT JOIN last_row  lr ON lr.person_key = l.person_key
  LEFT JOIN in_window w  ON w.person_key  = l.person_key
  LEFT JOIN state     st ON st.person_key = l.person_key
 WHERE l.lifetime_bookings >= 10
 ORDER BY recency_band, completed_trips_in_window DESC, days_since_last_trip;
```

#### D3. Monthly retention by cohort

```sql
-- D3  MONTHLY RETENTION BY COHORT. Of the drivers active in month M, what share were still
-- active in M+1 and in M+3? Split by the same cohort rule as A3/A6/A7.
-- The last month of the window has no M+1 to check and the last three have no M+3, so those
-- cells are NULL by construction, not zero. observable_for_m1 / observable_for_m3 say so.
WITH months AS (
  SELECT gs::date AS month, row_number() OVER (ORDER BY gs)::int AS month_idx,
         count(*) OVER () AS n_months
    FROM generate_series(date_trunc('month', :start::date),
                         date_trunc('month', :end::date), interval '1 month') gs
),
dm AS (
  SELECT date_trunc('month', (t.requested_at AT TIME ZONE 'Asia/Dubai'))::date AS month,
         t.person_key, max(t.driver_name) AS driver_name,
         count(*) FILTER (WHERE n.outcome = 'completed') AS completed_trips
    FROM trip_norm n
    JOIN trip t ON t.platform = n.platform AND t.external_id = n.external_id
   WHERE n.is_booking
     AND (t.requested_at AT TIME ZONE 'Asia/Dubai')::date BETWEEN :start::date AND :end::date
     AND coalesce(t.person_key, '') <> ''
   GROUP BY 1, 2
),
lb AS (
  SELECT m.month_idx, m.n_months, dm.*,
         rank() OVER (PARTITION BY dm.month ORDER BY dm.completed_trips DESC, dm.person_key) AS rank_trips
    FROM months m JOIN dm ON dm.month = m.month
   WHERE dm.completed_trips > 0
),
cohort AS (
  SELECT person_key,
         CASE WHEN count(*) FILTER (WHERE rank_trips <= 10) >= 10 THEN 'A_permanent_top10'
              WHEN count(*) FILTER (WHERE rank_trips <= 10) >= 4  THEN 'B_volatile_high_performer'
              WHEN count(*) FILTER (WHERE rank_trips <= 10) >= 1  THEN 'C_spike_only'
              WHEN min(rank_trips) <= 30                          THEN 'D_chaser_11_to_30'
              ELSE 'E_rest_of_fleet' END AS cohort
    FROM lb GROUP BY person_key
),
active AS (SELECT DISTINCT person_key, month_idx, n_months FROM lb)
SELECT m.month,
       c.cohort,
       count(*)                                                          AS active_this_month,
       (max(a.n_months) - max(a.month_idx) >= 1)                         AS observable_for_m1,
       (max(a.n_months) - max(a.month_idx) >= 3)                         AS observable_for_m3,
       count(*) FILTER (WHERE nx1.person_key IS NOT NULL)                AS still_active_next_month,
       CASE WHEN max(a.n_months) - max(a.month_idx) >= 1
            THEN round(100.0 * count(*) FILTER (WHERE nx1.person_key IS NOT NULL)
                       / nullif(count(*), 0)::numeric, 1) END            AS retention_m1_pct,
       count(*) FILTER (WHERE nx3.person_key IS NOT NULL)                AS still_active_in_3_months,
       CASE WHEN max(a.n_months) - max(a.month_idx) >= 3
            THEN round(100.0 * count(*) FILTER (WHERE nx3.person_key IS NOT NULL)
                       / nullif(count(*), 0)::numeric, 1) END            AS retention_m3_pct,
       count(*) FILTER (WHERE pv.person_key IS NULL)                     AS new_or_returning_this_month
  FROM active a
  JOIN months m  ON m.month_idx = a.month_idx
  JOIN cohort c  ON c.person_key = a.person_key
  LEFT JOIN active nx1 ON nx1.person_key = a.person_key AND nx1.month_idx = a.month_idx + 1
  LEFT JOIN active nx3 ON nx3.person_key = a.person_key AND nx3.month_idx = a.month_idx + 3
  LEFT JOIN active pv  ON pv.person_key  = a.person_key AND pv.month_idx  = a.month_idx - 1
 GROUP BY m.month, c.cohort
 ORDER BY m.month, c.cohort;
```

#### D4. Dormancy and churn watch — the operational list

```sql
-- D4  DORMANCY AND CHURN WATCH. Everyone with real history whose last trip is older than
-- :dormant_days (default 45), with what they were doing before they stopped, their last vehicle
-- and fleet, and whether the platform state explains it.
-- THIS IS THE ACTION LIST. A driver who CAN earn and has stopped is a retention problem; one who
-- is suspended or deactivated is a different problem entirely, which is why can_earn is here.
WITH params AS (SELECT 45 AS dormant_days, 20 AS min_lifetime_bookings),
b AS (
  SELECT t.person_key, t.driver_name, t.fleet_id, t.plate, n.platform,
         t.requested_at,
         date_trunc('month', (t.requested_at AT TIME ZONE 'Asia/Dubai'))::date AS month,
         (t.requested_at AT TIME ZONE 'Asia/Dubai')::date                      AS local_day,
         n.outcome, n.has_fare, n.price
    FROM trip_norm n
    JOIN trip t ON t.platform = n.platform AND t.external_id = n.external_id
   WHERE n.is_booking
     AND coalesce(t.person_key, '') <> ''
     AND t.requested_at IS NOT NULL
     AND (t.requested_at AT TIME ZONE 'Asia/Dubai')::date <= :end::date
),
agg AS (
  SELECT person_key, max(driver_name) AS driver_name,
         count(*)                                                            AS lifetime_bookings,
         count(*) FILTER (WHERE outcome = 'completed')                       AS lifetime_completed,
         max(local_day)                                                      AS last_trip_day,
         min(local_day)                                                      AS first_trip_day,
         count(DISTINCT month)                                               AS months_ever_active,
         count(*) FILTER (WHERE outcome = 'completed'
                            AND local_day > :end::date - 180)                AS completed_last_180d,
         count(DISTINCT month) FILTER (WHERE local_day > :end::date - 180)    AS months_active_last_180d,
         array_agg(DISTINCT platform ORDER BY platform)                      AS platforms_ever
    FROM b GROUP BY person_key
),
last_row AS (
  SELECT DISTINCT ON (person_key) person_key, fleet_id AS last_fleet, plate AS last_plate,
         platform AS last_platform, local_day AS last_day
    FROM b ORDER BY person_key, requested_at DESC
),
-- what were they averaging in the 3 months BEFORE they went dark?
pre AS (
  SELECT b.person_key,
         round(count(*) FILTER (WHERE b.outcome = 'completed')::numeric
               / nullif(count(DISTINCT b.month), 0), 1) AS trips_per_month_before_stopping
    FROM b JOIN agg a ON a.person_key = b.person_key
   WHERE b.local_day BETWEEN a.last_trip_day - 90 AND a.last_trip_day
   GROUP BY b.person_key
),
state AS (
  SELECT s.person_key,
         array_agg(DISTINCT s.platform || ':' || coalesce(s.state_raw, s.state, 'unknown')) AS platform_states,
         bool_or(s.can_earn) AS can_earn_somewhere,
         max(s.state_reason) AS a_state_reason
    FROM driver_platform_state s
   WHERE coalesce(s.person_key, '') <> ''
   GROUP BY s.person_key
),
lic AS (
  SELECT c.driver_ext_id, c.full_name, min(c.licence_expires) AS licence_expires
    FROM driver_compliance c
   WHERE c.licence_expires IS NOT NULL
   GROUP BY 1, 2
)
SELECT a.person_key, a.driver_name,
       lr.last_fleet, lr.last_plate, lr.last_platform,
       a.last_trip_day,
       :end::date - a.last_trip_day                       AS days_dark,
       a.lifetime_completed, a.months_ever_active,
       a.completed_last_180d, a.months_active_last_180d,
       p.trips_per_month_before_stopping,
       -- the number that says how much this costs you per month it continues
       round(p.trips_per_month_before_stopping, 1)        AS monthly_trips_at_risk,
       a.platforms_ever,
       st.platform_states, st.can_earn_somewhere, st.a_state_reason,
       CASE
         WHEN st.can_earn_somewhere IS FALSE THEN 'blocked - state does not permit work'
         WHEN st.can_earn_somewhere IS TRUE  THEN 'CAN EARN AND IS NOT WORKING - chase'
         ELSE 'no roster record - identity or offboarding gap'
       END                                                AS verdict
  FROM agg a
  CROSS JOIN params pr
  LEFT JOIN last_row lr ON lr.person_key = a.person_key
  LEFT JOIN pre      p  ON p.person_key  = a.person_key
  LEFT JOIN state    st ON st.person_key = a.person_key
 WHERE a.lifetime_bookings >= pr.min_lifetime_bookings
   AND :end::date - a.last_trip_day > pr.dormant_days
 ORDER BY p.trips_per_month_before_stopping DESC NULLS LAST, days_dark;
```

---

### MODULE E — SEASONALITY, PEAK/OFF SEASON AND SHOCKS

#### E1. The season calendar

```sql
-- E1  THE SEASON CALENDAR. One row per Dubai day with its season label, event flags and weather.
-- Every other query in this module leans on the same priority rule:
--   ramadan > eid_fitr > summer > high_season > school breaks > baseline
-- world_event is the only usable calendar. calendar_day writes only TODAY's row on each collector
-- run and its is_holiday / holiday_name columns are DECLARED AND NEVER WRITTEN, so UAE public
-- holidays other than Eid al-Fitr are simply not labelled anywhere in this database and Eid
-- al-Adha has no code at all.
-- weather_daily is a rolling past-30 + forecast-7 window, so weather is NULL for almost the whole
-- year. It is joined for completeness, not for analysis.
WITH cal AS (SELECT generate_series(:start::date, :end::date, interval '1 day')::date AS day),
lab AS (
  SELECT c.day, coalesce(w.code, 'baseline') AS season, w.title AS season_title
    FROM cal c
    LEFT JOIN LATERAL (
      SELECT e.code, e.title
        FROM world_event e
       WHERE e.code IN ('ramadan','eid_fitr','summer','high_season',
                        'school_summer_break','school_winter_break')
         AND c.day BETWEEN e.starts_on AND coalesce(e.ends_on, e.starts_on)
       ORDER BY CASE e.code WHEN 'ramadan' THEN 1 WHEN 'eid_fitr' THEN 2 WHEN 'summer' THEN 3
                            WHEN 'high_season' THEN 4 ELSE 5 END,
                e.confidence DESC NULLS LAST
       LIMIT 1
    ) w ON true
),
flags AS (
  SELECT c.day,
         coalesce(bool_or(e.code = 'ramadan'), false)                       AS is_ramadan,
         coalesce(bool_or(e.code = 'eid_fitr'), false)                      AS is_eid,
         coalesce(bool_or(e.code = 'summer'), false)                        AS is_dubai_summer,
         coalesce(bool_or(e.code = 'high_season'), false)                   AS is_high_season,
         coalesce(bool_or(e.code = 'school_summer_break'), false)           AS is_school_summer,
         coalesce(bool_or(e.code = 'school_winter_break'), false)           AS is_school_winter,
         coalesce(bool_or(e.category = 'geopolitical'
                          AND coalesce(e.confidence, 0) >= 0.5), false)     AS geopolitical_headline,
         count(*) FILTER (WHERE e.source = 'news' AND coalesce(e.confidence, 0) >= 0.5) AS news_events,
         (array_agg(DISTINCT e.title) FILTER (WHERE e.source = 'news'
                                                AND coalesce(e.confidence, 0) >= 0.6))[1:3] AS top_headlines
    FROM cal c
    LEFT JOIN world_event e
      ON c.day BETWEEN e.starts_on AND coalesce(e.ends_on, e.starts_on)
   GROUP BY c.day
),
vol AS (
  SELECT (t.requested_at AT TIME ZONE 'Asia/Dubai')::date AS day,
         count(*) FILTER (WHERE n.outcome = 'completed')  AS completed_trips,
         count(DISTINCT t.person_key) FILTER (WHERE n.outcome = 'completed'
                                                AND coalesce(t.person_key, '') <> '') AS drivers
    FROM trip_norm n
    JOIN trip t ON t.platform = n.platform AND t.external_id = n.external_id
   WHERE n.is_booking
     AND (t.requested_at AT TIME ZONE 'Asia/Dubai')::date BETWEEN :start::date AND :end::date
   GROUP BY 1
)
SELECT l.day,
       to_char(l.day, 'Dy')       AS dow,
       l.season, l.season_title,
       f.is_ramadan, f.is_eid, f.is_dubai_summer, f.is_high_season,
       f.is_school_summer, f.is_school_winter,
       f.geopolitical_headline, f.news_events, f.top_headlines,
       coalesce(v.completed_trips, 0) AS completed_trips,
       coalesce(v.drivers, 0)         AS drivers,
       round(coalesce(v.completed_trips, 0)::numeric / nullif(v.drivers, 0), 2) AS trips_per_active_driver,
       wd.temp_max, wd.precipitation, wd.is_forecast   -- rolling 30d window only; NULL for most of the year
  FROM lab l
  JOIN flags f ON f.day = l.day
  LEFT JOIN vol v          ON v.day = l.day
  LEFT JOIN weather_daily wd ON wd.day = l.day
 ORDER BY l.day;
```

#### E2. Fleet monthly market shape

```sql
-- E2  FLEET MONTHLY MARKET SHAPE, from the pre-aggregated rollup — cheap, and the number your
-- dashboard already shows, so the two cannot disagree.
-- rollup_month's '*'/'*' row is COMPUTED at month grain via GROUPING SETS, never summed from the
-- platform rows, because count(DISTINCT) is not summable. bookings excludes FMS telematics.
-- Read market_vs_year_pct as the shape of your demand year; every driver-level index in Modules
-- A and E is measured against this.
WITH m AS (
  SELECT rm.month, rm.trips, rm.bookings, rm.telematics, rm.drivers,
         rm.vehicles, rm.earning_vehicles, rm.revenue, rm.priced_trips,
         rm.km, rm.measured_trips, rm.completed, rm.not_completed, rm.outcome_n,
         rm.first_day, rm.last_day, rm.booking_platforms
    FROM rollup_month rm
   WHERE rm.platform = '*' AND rm.fleet_id = '*'
     AND rm.month BETWEEN date_trunc('month', :start::date)::date
                      AND date_trunc('month', :end::date)::date
),
ev AS (
  SELECT date_trunc('month', gs)::date AS month,
         (SELECT array_agg(DISTINCT e.code)
            FROM world_event e
           WHERE e.starts_on <= (gs + interval '1 month' - interval '1 day')::date
             AND coalesce(e.ends_on, e.starts_on) >= gs::date
             AND e.code IS NOT NULL) AS event_codes,
         (SELECT count(*) FROM world_event e
           WHERE e.source = 'news' AND coalesce(e.confidence, 0) >= 0.5
             AND e.starts_on BETWEEN gs::date AND (gs + interval '1 month' - interval '1 day')::date) AS news_events
    FROM generate_series(date_trunc('month', :start::date),
                         date_trunc('month', :end::date), interval '1 month') gs
),
brk AS (
  SELECT b.period_to AS month,
         round(avg(b.change_pct)::numeric, 1)                AS detected_change_pct,
         round(avg(b.driver_change_pct)::numeric, 1)         AS driver_change_pct,
         round(avg(b.productivity_change_pct)::numeric, 1)   AS productivity_change_pct,
         (array_agg(b.attribution ORDER BY abs(b.change_pct) DESC))[1] AS attribution
    FROM metric_break b
   WHERE b.metric = 'trips' AND b.grain = 'month'
   GROUP BY b.period_to
)
SELECT m.month,
       (m.last_day - m.first_day + 1)                                        AS days_observed,
       m.bookings, m.telematics, m.drivers, m.earning_vehicles,
       m.completed, m.outcome_n,
       round(100.0 * m.completed / nullif(m.outcome_n, 0)::numeric, 1)       AS completion_pct,
       round(m.revenue, 2)                                                   AS revenue_aed_where_priced,
       m.priced_trips,
       round(m.bookings::numeric / nullif(m.drivers, 0), 1)                  AS bookings_per_active_driver,
       round(100.0 * (m.bookings::numeric / nullif(avg(m.bookings) OVER (), 0) - 1), 1) AS market_vs_year_pct,
       round(100.0 * (m.bookings - lag(m.bookings) OVER (ORDER BY m.month))::numeric
             / nullif(lag(m.bookings) OVER (ORDER BY m.month), 0), 1)        AS mom_change_pct,
       rank() OVER (ORDER BY m.bookings DESC)                                AS busiest_month_rank,
       m.booking_platforms,
       ev.event_codes, ev.news_events,
       b.detected_change_pct, b.driver_change_pct, b.productivity_change_pct, b.attribution
  FROM m
  LEFT JOIN ev ON ev.month = m.month
  LEFT JOIN brk b ON b.month = m.month
 ORDER BY m.month;
```

#### E3. Per-driver seasonality beta — **headline test**

```sql
-- E3  PER-DRIVER SEASONALITY BETA. Does this driver move with the market, ignore it, or amplify it?
-- Both series are expressed RELATIVE TO THEIR OWN MEAN, so beta is a pure elasticity:
--   beta ~ 1.0  the driver moves exactly with the market
--   beta ~ 0    IMMUNE to seasonality — the profile you want to reproduce
--   beta > 1.3  amplifies the market: great in high season, collapses in summer
--   beta < 0    counter-cyclical (usually a channel or daypart switch) — worth an interview
--   r2 < 0.2    the beta is meaningless; their volume is driven by something else
-- Zero-filled inside each driver's own tenure: a month taken off is a zero, not missing data.
-- Months before they joined are absence, not volatility, and are excluded.
WITH months AS (
  SELECT gs::date AS month, row_number() OVER (ORDER BY gs)::int AS month_idx
    FROM generate_series(date_trunc('month', :start::date),
                         date_trunc('month', :end::date), interval '1 month') gs
),
dm AS (
  SELECT date_trunc('month', (t.requested_at AT TIME ZONE 'Asia/Dubai'))::date AS month,
         t.person_key, max(t.driver_name) AS driver_name,
         count(*) FILTER (WHERE n.outcome = 'completed') AS completed_trips
    FROM trip_norm n
    JOIN trip t ON t.platform = n.platform AND t.external_id = n.external_id
   WHERE n.is_booking
     AND (t.requested_at AT TIME ZONE 'Asia/Dubai')::date BETWEEN :start::date AND :end::date
     AND coalesce(t.person_key, '') <> ''
   GROUP BY 1, 2
),
lb AS (
  SELECT m.month_idx, dm.*, rank() OVER (PARTITION BY dm.month ORDER BY dm.completed_trips DESC, dm.person_key) AS rank_trips
    FROM months m JOIN dm ON dm.month = m.month WHERE dm.completed_trips > 0
),
cohort AS (
  SELECT person_key, max(driver_name) AS driver_name,
         CASE WHEN count(*) FILTER (WHERE rank_trips <= 10) >= 10 THEN 'A_permanent_top10'
              WHEN count(*) FILTER (WHERE rank_trips <= 10) >= 4  THEN 'B_volatile_high_performer'
              WHEN count(*) FILTER (WHERE rank_trips <= 10) >= 1  THEN 'C_spike_only'
              WHEN min(rank_trips) <= 30                          THEN 'D_chaser_11_to_30'
              ELSE 'E_rest_of_fleet' END AS cohort,
         min(month_idx) AS first_idx, max(month_idx) AS last_idx
    FROM lb GROUP BY person_key
),
market AS (
  SELECT dm.month, sum(dm.completed_trips)::numeric AS fleet_trips,
         count(*)::numeric                          AS active_drivers,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY dm.completed_trips) AS median_trips
    FROM dm WHERE dm.completed_trips > 0 GROUP BY 1
),
market_rel AS (
  SELECT month, fleet_trips, active_drivers, median_trips,
         fleet_trips / nullif(avg(fleet_trips) OVER (), 0) AS mkt_rel
    FROM market
),
series AS (
  SELECT c.person_key, c.driver_name, c.cohort, m.month, m.month_idx,
         coalesce(lb.completed_trips, 0)::numeric AS trips,
         mr.mkt_rel, mr.fleet_trips
    FROM cohort c
    JOIN months m ON m.month_idx BETWEEN c.first_idx AND c.last_idx
    LEFT JOIN lb ON lb.person_key = c.person_key AND lb.month = m.month
    JOIN market_rel mr ON mr.month = m.month
),
dstat AS (
  SELECT person_key, avg(trips) AS mean_trips, count(*) AS months_in_tenure
    FROM series GROUP BY person_key
),
rel AS (
  SELECT s.*, s.trips / nullif(d.mean_trips, 0) AS drv_rel, d.mean_trips, d.months_in_tenure
    FROM series s JOIN dstat d ON d.person_key = s.person_key
)
SELECT r.person_key,
       max(r.driver_name)                                            AS driver_name,
       max(r.cohort)                                                 AS cohort,
       count(*)                                                      AS months_in_tenure,
       count(*) FILTER (WHERE r.trips > 0)                           AS months_worked,
       round(max(r.mean_trips), 1)                                   AS mean_trips_per_month,
       round(regr_slope(r.drv_rel, r.mkt_rel)::numeric, 3)           AS seasonality_beta,
       round(regr_r2(r.drv_rel, r.mkt_rel)::numeric, 3)              AS r2,
       round(regr_intercept(r.drv_rel, r.mkt_rel)::numeric, 3)       AS intercept,
       round(corr(r.drv_rel, r.mkt_rel)::numeric, 3)                 AS corr_with_market,
       round(stddev_samp(r.drv_rel)::numeric, 3)                     AS sd_of_own_relative_volume,
       round(stddev_samp(r.mkt_rel)::numeric, 3)                     AS sd_of_market,
       CASE
         WHEN count(*) < 6                                    THEN 'too few months to judge'
         WHEN regr_r2(r.drv_rel, r.mkt_rel) < 0.20            THEN 'NO RELATIONSHIP - volume driven by something other than the market'
         WHEN regr_slope(r.drv_rel, r.mkt_rel) < 0            THEN 'COUNTER-CYCLICAL - busier when the fleet is quiet'
         WHEN regr_slope(r.drv_rel, r.mkt_rel) <= 0.4         THEN 'SEASON-IMMUNE - the market moves, they do not'
         WHEN regr_slope(r.drv_rel, r.mkt_rel) <= 1.3         THEN 'MOVES WITH THE MARKET'
         ELSE 'AMPLIFIES THE MARKET - high season carries them'
       END                                                           AS beta_verdict
  FROM rel r
 GROUP BY r.person_key
HAVING count(*) >= 4
 ORDER BY max(r.cohort), seasonality_beta;
```

#### E4. Summer-trough retention ratio — **headline test**

```sql
-- E4  SUMMER-TROUGH RETENTION RATIO. Do they hold up through the Dubai off-season?
-- Two ratios, both per driver:
--   raw_retention_ratio = mean monthly trips in SUMMER / mean monthly trips in HIGH SEASON
--   share_retention_ratio = the same on the seasonality-adjusted index (share of the market)
-- Ratio >= 0.95 : they retain their volume/share through the off-season.
-- Ratio 0.70-0.95 : normal fade.
-- Ratio < 0.70 : a high-season driver whose annual top-10 place rests on four good months.
-- Ratio > 1.15 : they GAIN share in summer (competitors take leave) — your most valuable people
--                in the months you earn least.
-- A month is assigned to a season by where the MAJORITY of its Dubai days fall, so a month that
-- straddles the summer boundary is not double-counted.
WITH months AS (
  SELECT gs::date AS month,
         (gs + interval '1 month' - interval '1 day')::date AS month_end,
         row_number() OVER (ORDER BY gs)::int AS month_idx
    FROM generate_series(date_trunc('month', :start::date),
                         date_trunc('month', :end::date), interval '1 month') gs
),
cal AS (SELECT generate_series(:start::date, :end::date, interval '1 day')::date AS day),
day_season AS (
  SELECT c.day, coalesce(w.code, 'baseline') AS season
    FROM cal c
    LEFT JOIN LATERAL (
      SELECT e.code FROM world_event e
       WHERE e.code IN ('ramadan','eid_fitr','summer','high_season',
                        'school_summer_break','school_winter_break')
         AND c.day BETWEEN e.starts_on AND coalesce(e.ends_on, e.starts_on)
       ORDER BY CASE e.code WHEN 'ramadan' THEN 1 WHEN 'eid_fitr' THEN 2 WHEN 'summer' THEN 3
                            WHEN 'high_season' THEN 4 ELSE 5 END,
                e.confidence DESC NULLS LAST
       LIMIT 1) w ON true
),
month_season AS (   -- majority season of the month's observed days
  SELECT m.month, m.month_idx,
         (SELECT ds.season FROM day_season ds
           WHERE ds.day BETWEEN m.month AND m.month_end
           GROUP BY ds.season ORDER BY count(*) DESC, ds.season LIMIT 1) AS season,
         count(*) FILTER (WHERE ds2.season = 'summer')       AS summer_days,
         count(*) FILTER (WHERE ds2.season = 'high_season')  AS high_season_days,
         count(*)                                            AS days_in_month_observed
    FROM months m
    LEFT JOIN day_season ds2 ON ds2.day BETWEEN m.month AND m.month_end
   GROUP BY m.month, m.month_idx
),
dm AS (
  SELECT date_trunc('month', (t.requested_at AT TIME ZONE 'Asia/Dubai'))::date AS month,
         t.person_key, max(t.driver_name) AS driver_name,
         count(*) FILTER (WHERE n.outcome = 'completed') AS completed_trips
    FROM trip_norm n
    JOIN trip t ON t.platform = n.platform AND t.external_id = n.external_id
   WHERE n.is_booking
     AND (t.requested_at AT TIME ZONE 'Asia/Dubai')::date BETWEEN :start::date AND :end::date
     AND coalesce(t.person_key, '') <> ''
   GROUP BY 1, 2
),
lb AS (
  SELECT m.month_idx, dm.*, rank() OVER (PARTITION BY dm.month ORDER BY dm.completed_trips DESC, dm.person_key) AS rank_trips
    FROM months m JOIN dm ON dm.month = m.month WHERE dm.completed_trips > 0
),
cohort AS (
  SELECT person_key, max(driver_name) AS driver_name,
         CASE WHEN count(*) FILTER (WHERE rank_trips <= 10) >= 10 THEN 'A_permanent_top10'
              WHEN count(*) FILTER (WHERE rank_trips <= 10) >= 4  THEN 'B_volatile_high_performer'
              WHEN count(*) FILTER (WHERE rank_trips <= 10) >= 1  THEN 'C_spike_only'
              WHEN min(rank_trips) <= 30                          THEN 'D_chaser_11_to_30'
              ELSE 'E_rest_of_fleet' END AS cohort,
         min(month_idx) AS first_idx, max(month_idx) AS last_idx
    FROM lb GROUP BY person_key
),
market AS (
  SELECT dm.month, percentile_cont(0.5) WITHIN GROUP (ORDER BY dm.completed_trips) AS median_trips
    FROM dm WHERE dm.completed_trips > 0 GROUP BY 1
),
series AS (   -- zero-filled inside tenure, labelled with the month's season
  SELECT c.person_key, c.driver_name, c.cohort, ms.month, ms.season,
         coalesce(lb.completed_trips, 0)::numeric                              AS trips,
         coalesce(lb.completed_trips, 0)::numeric / nullif(mk.median_trips, 0) AS adj_index
    FROM cohort c
    JOIN month_season ms ON ms.month_idx BETWEEN c.first_idx AND c.last_idx
    LEFT JOIN lb ON lb.person_key = c.person_key AND lb.month = ms.month
    LEFT JOIN market mk ON mk.month = ms.month
)
SELECT person_key,
       max(driver_name)                                                 AS driver_name,
       max(cohort)                                                      AS cohort,
       count(*)                                                         AS months_in_tenure,
       count(*) FILTER (WHERE season = 'summer')                        AS summer_months,
       count(*) FILTER (WHERE season = 'high_season')                   AS high_season_months,
       round(avg(trips) FILTER (WHERE season = 'summer'), 1)            AS mean_trips_summer,
       round(avg(trips) FILTER (WHERE season = 'high_season'), 1)       AS mean_trips_high_season,
       round(avg(trips), 1)                                             AS mean_trips_all,
       CASE WHEN count(*) FILTER (WHERE season = 'summer') > 0
             AND count(*) FILTER (WHERE season = 'high_season') > 0
            THEN round(avg(trips) FILTER (WHERE season = 'summer')
                       / nullif(avg(trips) FILTER (WHERE season = 'high_season'), 0), 3) END
                                                                        AS raw_retention_ratio,
       round(avg(adj_index) FILTER (WHERE season = 'summer'), 3)        AS index_summer,
       round(avg(adj_index) FILTER (WHERE season = 'high_season'), 3)   AS index_high_season,
       CASE WHEN count(*) FILTER (WHERE season = 'summer') > 0
             AND count(*) FILTER (WHERE season = 'high_season') > 0
            THEN round(avg(adj_index) FILTER (WHERE season = 'summer')
                       / nullif(avg(adj_index) FILTER (WHERE season = 'high_season'), 0), 3) END
                                                                        AS share_retention_ratio,
       count(*) FILTER (WHERE season = 'summer' AND trips = 0)          AS summer_months_not_worked,
       CASE
         WHEN count(*) FILTER (WHERE season = 'summer') = 0
           OR count(*) FILTER (WHERE season = 'high_season') = 0
           THEN 'UNJUDGED - no summer or no high-season month in tenure'
         WHEN avg(adj_index) FILTER (WHERE season = 'summer')
              / nullif(avg(adj_index) FILTER (WHERE season = 'high_season'), 0) > 1.15
           THEN 'GAINS SHARE IN SUMMER - most valuable in the quiet months'
         WHEN avg(adj_index) FILTER (WHERE season = 'summer')
              / nullif(avg(adj_index) FILTER (WHERE season = 'high_season'), 0) >= 0.95
           THEN 'HOLDS THROUGH THE OFF-SEASON'
         WHEN avg(adj_index) FILTER (WHERE season = 'summer')
              / nullif(avg(adj_index) FILTER (WHERE season = 'high_season'), 0) >= 0.70
           THEN 'normal summer fade'
         ELSE 'HIGH-SEASON DRIVER - annual rank rests on the peak months'
       END                                                              AS retention_verdict
  FROM series
 GROUP BY person_key
HAVING count(*) >= 4
 ORDER BY max(cohort), share_retention_ratio DESC NULLS LAST;
```

#### E5. Shock drawdown and recovery — **headline test**

```sql
-- E5  SHOCK DRAWDOWN AND RECOVERY. How far each driver fell in a shock month, and how long they
-- took to get back.
-- A "shock month" is either (a) a detected month-over-month structural break of -15% or worse in
-- metric_break, or (b) a month carrying a high-confidence geopolitical headline in world_event.
-- CAVEAT ON (b): the news tier stores one-day rows (ends_on = starts_on) capped at 30 per
-- collector run, so this flags "a headline landed", NOT "the month was at war". Treat a
-- headline-only shock as a hypothesis; a metric_break shock is measured.
-- baseline = mean of the 3 months before; trough = worst of the shock month and the 2 after;
-- recovered = the first later month back at >= 90% of baseline.
WITH months AS (
  SELECT gs::date AS month, row_number() OVER (ORDER BY gs)::int AS month_idx,
         (gs + interval '1 month' - interval '1 day')::date AS month_end
    FROM generate_series(date_trunc('month', :start::date),
                         date_trunc('month', :end::date), interval '1 month') gs
),
dm AS (
  SELECT date_trunc('month', (t.requested_at AT TIME ZONE 'Asia/Dubai'))::date AS month,
         t.person_key, max(t.driver_name) AS driver_name,
         count(*) FILTER (WHERE n.outcome = 'completed') AS completed_trips
    FROM trip_norm n
    JOIN trip t ON t.platform = n.platform AND t.external_id = n.external_id
   WHERE n.is_booking
     AND (t.requested_at AT TIME ZONE 'Asia/Dubai')::date BETWEEN :start::date AND :end::date
     AND coalesce(t.person_key, '') <> ''
   GROUP BY 1, 2
),
lb AS (
  SELECT m.month_idx, dm.*, rank() OVER (PARTITION BY dm.month ORDER BY dm.completed_trips DESC, dm.person_key) AS rank_trips
    FROM months m JOIN dm ON dm.month = m.month WHERE dm.completed_trips > 0
),
cohort AS (
  SELECT person_key, max(driver_name) AS driver_name,
         CASE WHEN count(*) FILTER (WHERE rank_trips <= 10) >= 10 THEN 'A_permanent_top10'
              WHEN count(*) FILTER (WHERE rank_trips <= 10) >= 4  THEN 'B_volatile_high_performer'
              WHEN count(*) FILTER (WHERE rank_trips <= 10) >= 1  THEN 'C_spike_only'
              WHEN min(rank_trips) <= 30                          THEN 'D_chaser_11_to_30'
              ELSE 'E_rest_of_fleet' END AS cohort,
         min(month_idx) AS first_idx, max(month_idx) AS last_idx
    FROM lb GROUP BY person_key
),
grid AS (   -- zero-filled inside tenure
  SELECT c.person_key, c.driver_name, c.cohort, m.month, m.month_idx,
         coalesce(lb.completed_trips, 0)::numeric AS trips
    FROM cohort c
    JOIN months m ON m.month_idx BETWEEN c.first_idx AND c.last_idx
    LEFT JOIN lb ON lb.person_key = c.person_key AND lb.month = m.month
),
shocks AS (
  SELECT b.period_to AS shock_month, 'metric_break' AS shock_kind,
         round(min(b.change_pct)::numeric, 1) AS fleet_change_pct,
         (array_agg(b.attribution ORDER BY b.change_pct))[1] AS attribution
    FROM metric_break b
   WHERE b.metric = 'trips' AND b.grain = 'month'
     AND b.change_pct <= -15
     AND b.period_to BETWEEN date_trunc('month', :start::date)::date AND date_trunc('month', :end::date)::date
   GROUP BY b.period_to
  UNION
  SELECT date_trunc('month', e.starts_on)::date, 'geopolitical_headline', NULL, NULL
    FROM world_event e
   WHERE e.category = 'geopolitical' AND coalesce(e.confidence, 0) >= 0.6
     AND e.starts_on BETWEEN :start::date AND :end::date
   GROUP BY 1
),
shock_idx AS (SELECT s.*, m.month_idx AS shock_idx FROM shocks s JOIN months m ON m.month = s.shock_month),
base AS (
  SELECT s.shock_month, s.shock_kind, s.fleet_change_pct, s.attribution, s.shock_idx,
         g.person_key, max(g.driver_name) AS driver_name, max(g.cohort) AS cohort,
         avg(g.trips) FILTER (WHERE g.month_idx BETWEEN s.shock_idx - 3 AND s.shock_idx - 1) AS baseline_trips,
         count(*)     FILTER (WHERE g.month_idx BETWEEN s.shock_idx - 3 AND s.shock_idx - 1) AS baseline_months,
         min(g.trips) FILTER (WHERE g.month_idx BETWEEN s.shock_idx AND s.shock_idx + 2)     AS trough_trips,
         count(*)     FILTER (WHERE g.month_idx BETWEEN s.shock_idx AND s.shock_idx + 2)     AS shock_window_months
    FROM shock_idx s
    JOIN grid g ON g.person_key IS NOT NULL
   GROUP BY 1, 2, 3, 4, 5, g.person_key
),
rec AS (
  SELECT b.*,
         (SELECT min(g2.month_idx) FROM grid g2
           WHERE g2.person_key = b.person_key
             AND g2.month_idx > b.shock_idx
             AND g2.trips >= 0.9 * b.baseline_trips) AS recovered_idx
    FROM base b
   WHERE b.baseline_months >= 2 AND b.shock_window_months >= 1 AND b.baseline_trips > 0
)
SELECT r.shock_month, r.shock_kind, r.fleet_change_pct, r.attribution,
       r.person_key, r.driver_name, r.cohort,
       round(r.baseline_trips, 1)  AS baseline_trips_per_month,
       r.trough_trips,
       round(100.0 * (r.baseline_trips - r.trough_trips) / nullif(r.baseline_trips, 0), 1) AS drawdown_pct,
       r.recovered_idx - r.shock_idx AS months_to_recover,
       (SELECT m2.month FROM months m2 WHERE m2.month_idx = r.recovered_idx) AS recovered_month,
       CASE
         WHEN r.recovered_idx IS NULL THEN 'NEVER RECOVERED inside the window'
         WHEN 100.0 * (r.baseline_trips - r.trough_trips) / nullif(r.baseline_trips, 0) < 15
              AND r.recovered_idx - r.shock_idx <= 1 THEN 'SHOCK-PROOF'
         WHEN 100.0 * (r.baseline_trips - r.trough_trips) / nullif(r.baseline_trips, 0) <= 35
              AND r.recovered_idx - r.shock_idx <= 2 THEN 'normal - fell and came back'
         WHEN 100.0 * (r.baseline_trips - r.trough_trips) / nullif(r.baseline_trips, 0) > 50
           THEN 'FRAGILE - halved by the shock'
         ELSE 'slow recovery'
       END AS shock_verdict
  FROM rec r
 WHERE r.baseline_trips >= 10        -- a baseline of 3 trips makes every percentage meaningless
 ORDER BY r.shock_month, r.cohort, drawdown_pct DESC;
```

#### E6. Ramadan and season daypart shift

```sql
-- E6  DO THEY CHANGE WHEN THEY WORK, RATHER THAN HOW MUCH?
-- Uses trip_ext.daypart, the view's own Dubai-hour banding: night <5, morning <10, midday <15,
-- evening <20, else late. The 00:00-05:00 band is deliberately separate because the airport wave
-- starts before dawn.
-- Read across a cohort's rows: if the SHARE of trips in 'night' and 'late' rises during Ramadan
-- while the total barely moves, the driver is re-timing rather than working more. That is the
-- adaptive behaviour worth teaching to everyone else.
-- trip_ext does not expose person_key either (same frozen-view reason as trip_norm), so base
-- `trip` is joined back on (platform, external_id).
WITH cal AS (SELECT generate_series(:start::date, :end::date, interval '1 day')::date AS day),
day_season AS (
  SELECT c.day, coalesce(w.code, 'baseline') AS season
    FROM cal c
    LEFT JOIN LATERAL (
      SELECT e.code FROM world_event e
       WHERE e.code IN ('ramadan','eid_fitr','summer','high_season',
                        'school_summer_break','school_winter_break')
         AND c.day BETWEEN e.starts_on AND coalesce(e.ends_on, e.starts_on)
       ORDER BY CASE e.code WHEN 'ramadan' THEN 1 WHEN 'eid_fitr' THEN 2 WHEN 'summer' THEN 3
                            WHEN 'high_season' THEN 4 ELSE 5 END,
                e.confidence DESC NULLS LAST
       LIMIT 1) w ON true
),
b AS (
  SELECT t.person_key, t.driver_name, x.daypart, x.local_hour, x.ext_local_day AS local_day,
         date_trunc('month', x.ext_local_day)::date AS month,
         x.outcome, x.has_fare, x.price, x.has_distance, x.distance_km, x.platform
    FROM trip_ext x
    JOIN trip t ON t.platform = x.platform AND t.external_id = x.external_id
   WHERE x.is_booking
     AND (t.requested_at AT TIME ZONE 'Asia/Dubai')::date BETWEEN :start::date AND :end::date
     AND coalesce(t.person_key, '') <> ''
),
dm AS (SELECT month, person_key, count(*) FILTER (WHERE outcome = 'completed') AS completed_trips FROM b GROUP BY 1, 2),
lb AS (SELECT dm.*, rank() OVER (PARTITION BY month ORDER BY completed_trips DESC, person_key) AS rank_trips FROM dm WHERE completed_trips > 0),
cohort AS (
  SELECT person_key,
         CASE WHEN count(*) FILTER (WHERE rank_trips <= 10) >= 10 THEN 'A_permanent_top10'
              WHEN count(*) FILTER (WHERE rank_trips <= 10) >= 4  THEN 'B_volatile_high_performer'
              WHEN count(*) FILTER (WHERE rank_trips <= 10) >= 1  THEN 'C_spike_only'
              WHEN min(rank_trips) <= 30                          THEN 'D_chaser_11_to_30'
              ELSE 'E_rest_of_fleet' END AS cohort
    FROM lb GROUP BY person_key
),
lab AS (
  SELECT b.*, c.cohort, ds.season
    FROM b
    JOIN cohort c ON c.person_key = b.person_key
    JOIN day_season ds ON ds.day = b.local_day
   WHERE b.outcome = 'completed'
),
tot AS (SELECT cohort, season, count(*)::numeric AS n, count(DISTINCT local_day) AS days FROM lab GROUP BY 1, 2)
SELECT l.cohort, l.season,
       max(t.n)::int                                                    AS completed_trips,
       max(t.days)::int                                                 AS days_in_season,
       count(DISTINCT l.person_key)                                     AS drivers,
       round(max(t.n) / nullif(max(t.days), 0), 1)                      AS trips_per_day,
       round(100.0 * count(*) FILTER (WHERE l.daypart = 'night')   / nullif(max(t.n), 0), 1) AS pct_night_0000_0459,
       round(100.0 * count(*) FILTER (WHERE l.daypart = 'morning') / nullif(max(t.n), 0), 1) AS pct_morning_0500_0959,
       round(100.0 * count(*) FILTER (WHERE l.daypart = 'midday')  / nullif(max(t.n), 0), 1) AS pct_midday_1000_1459,
       round(100.0 * count(*) FILTER (WHERE l.daypart = 'evening') / nullif(max(t.n), 0), 1) AS pct_evening_1500_1959,
       round(100.0 * count(*) FILTER (WHERE l.daypart = 'late')    / nullif(max(t.n), 0), 1) AS pct_late_2000_2359,
       round(avg(l.local_hour)::numeric, 2)                             AS mean_hour,
       mode() WITHIN GROUP (ORDER BY l.local_hour)                      AS modal_hour,
       round(sum(l.distance_km) FILTER (WHERE l.has_distance)::numeric
             / nullif(count(*) FILTER (WHERE l.has_distance), 0), 2)    AS avg_km,
       round(sum(l.price) FILTER (WHERE l.has_fare)
             / nullif(count(*) FILTER (WHERE l.has_fare), 0), 2)        AS avg_aed_where_priced
  FROM lab l JOIN tot t ON t.cohort = l.cohort AND t.season = l.season
 GROUP BY l.cohort, l.season
 ORDER BY l.cohort, max(t.n) DESC;
```

---

## 5. Running it

### Parameters

Every query takes `:start` and `:end` — inclusive Dubai calendar dates. Defaults: `2025-09-01` and `2026-08-27`.

- **psql:** `psql -v start="'2025-09-01'" -v end="'2026-08-27'" -f query.sql` — the inner single quotes matter, because the variable is substituted literally.
- **node-postgres / JDBC / DBeaver:** pass them as ordinary bind parameters. Module A writes `CAST(:start AS date)`, Modules B–E write `:start::date`; these are the same thing.
- Module D4 has two extra tunables in its own `params` CTE: `dormant_days` (45) and `min_lifetime_bookings` (20). Modules B2/B4/B7/B9 have `gap_min`, `assumed_trip_min`, `poll_interval_min` in theirs.

### Run order

**Step 0 — the coverage check. Do not skip this.** Before anything else, confirm you are not looking at a collection hole:

```sql
-- Which platform-days are missing? A missing day here is a COLLECTION GAP, not a quiet day,
-- and every rate computed across it is wrong.
SELECT source, count(DISTINCT day) AS days_with_rows,
       min(day) AS first_day, max(day) AS last_day,
       (:end::date - :start::date + 1) - count(DISTINCT day) AS days_missing
  FROM source_day_coverage
 WHERE day BETWEEN :start::date AND :end::date
 GROUP BY source ORDER BY days_missing DESC;

-- Runs that half-landed. rows_written > 0 WITH status='partial' is the shape that once hid a
-- 299-day Uber gap: the run reported rows, so nothing looked broken.
SELECT source, fleet_id, status, count(*) AS runs, sum(chunks_failed) AS failed_windows,
       min(window_start) AS from_day, max(window_end) AS to_day
  FROM collection_run
 WHERE coalesce(window_end, started_at::date) >= :start::date
 GROUP BY 1,2,3 HAVING status <> 'ok' ORDER BY failed_windows DESC;

-- An expired credential returns {err:null, rows:[]} — the exact shape of a week nobody drove.
SELECT provider, fleet_id, credential, state, last_ok_at, checked_at, detail
  FROM credential_state WHERE state <> 'ok' ORDER BY provider;
```

If a channel is missing days, every A/E index for the drivers on that channel is depressed for those months and **the seasonality-adjusted index will not cancel it** (it cancels fleet-wide gaps only).

**Then, in this order:**

| # | Query | Why here |
|---|---|---|
| 1 | **B1** online_time_source_audit | Decides whether any hours_online number in the pack is usable. Everything downstream depends on the answer. |
| 2 | **C1** location_coverage_audit | Decides whether Module C is worth running. If Uber pickup-area coverage is under ~50%, treat C2–C4 as indicative. |
| 3 | **E2** fleet_monthly_market_shape | Reads the pre-aggregated rollup. Gives you the demand year in one screen — the backdrop every driver-level result is read against. |
| 4 | **A1 → A2 → A3 → A4** | A1 is the measurement-coverage audit; A2–A4 build the leaderboard, the stability profile and the cohort. A4's cohort labels are re-derived identically in A7, A8, C3, C4, C6, D3, E3, E4, E5, E6. |
| 5 | **A5** | The headline test. Run it right after A4 and read the two together. |
| 6 | **A6, A7, A8, A9** | Gap, volatility, event-month, churn. |
| 7 | **E1, E3, E4, E5, E6** | Season calendar then the three remaining headline tests. |
| 8 | **D1 → D2 → D3 → D4** | Recency. D4 is the action list. |
| 9 | **B4 → B5 → B6 → B8 → B9** | Trip-derived online behaviour. B4 first; B5/B6/B8/B9 are independent of each other. |
| 10 | **B3** | Run once, after B4, to see how much of B4's answer is the 90-minute parameter. |
| 11 | **B2, B7, C5** | The telemetry-touching queries. Run last, and see the cost notes. |
| 12 | **C2, C3, C4, C6** | Spatial, only if C1 showed usable coverage. |

### Expected row volumes

| Query | Rows | Notes |
|---|---|---|
| A1 | 5–15 | coverage audit, one row per platform/measure |
| A2 | ~300–600 | 12 months × up to 25 per ranking, deduplicated |
| A3, A4, A5 | one per driver seen in the window (~150–250) | |
| A6, A7 | 4–6 | band/cohort summary |
| A8, A9, E2 | 12 | one per month |
| B1 | 5–12 | one per source × platform |
| B2 | **tens of thousands** | one per vehicle-session over a year |
| B3 | 10 | 2 methods × 5 thresholds |
| B4 | **20k–80k** | one per person-shift over a year |
| B5 | ~7 × drivers (~1,000) | HAVING ≥4 observations |
| B6, B8 | one per driver with ≥30 trips | |
| B7 | drivers × 12 (~2,000) | |
| B9 | ~12 | 2 cohorts × seasons present |
| C1 | ~6–10 | |
| C2 | one per driver ≥30 trips | |
| C3 | ≤40 (LIMIT) | |
| C4 | 6 | 5 cohorts + total |
| C5 | ≤60 (LIMIT) | |
| C6 | 6 | |
| D1 | drivers × tenure months (~1,500–2,500) | |
| D2 | one per person with ≥10 lifetime bookings | |
| D3 | 12 × 5 cohorts = ~60 | |
| D4 | the dormant list — expect 20–80 | |
| E1 | 362 | one per day |
| E3, E4 | one per driver with ≥4 tenure months | |
| E5 | shocks × drivers — can be several thousand; add `AND r.cohort = 'A_permanent_top10'` to focus | |
| E6 | ~25 | cohorts × seasons |

### The expensive ones

**B2 (telemetry sessions) and B7 (utilisation) scan a year of `telemetry_snapshot`** — your fastest-growing table, roughly 12k rows per 5-minute collection cycle across ~130 vehicles. Both use the Dubai-day expression index (`telemetry_local_day_idx`, schema_v27) **only because the expression is written character-for-character as the index defines it**. If you edit that expression at all, the index stops being used and the query goes from minutes to hours.

Before running either at full width:

```sql
-- how big is the scan you are about to do?
SELECT count(*) FROM telemetry_snapshot
 WHERE (captured_at AT TIME ZONE 'Asia/Dubai')::date BETWEEN :start::date AND :end::date
   AND source IN ('cabman','fms');
```

If that is over ~20 million, run B2 one month at a time, or add a plate filter (`AND s.plate IN (...)`) restricted to the top-10 cohort's vehicles from A4 + `vehicle_current_driver`.

**D2 (recency ladder) scans the whole `trip` heap** — ~279k rows, ~371 MB, because `raw` JSONB is ~1.3 kB per row. It runs in seconds but do not put it in a loop. It is deliberately not window-bounded: window-bounding it would report a driver who last drove in 2024 as "last seen" at the window start.

**E5** cross-joins shocks against the driver grid. If you have more than four or five shock months it multiplies out; filter to one cohort or one shock month while exploring.

**A1–A9, E3–E6, C2–C6, D1, D3, D4** all read `trip` + `trip_norm` over a 12-month window and use the trip Dubai-day expression index. Each should return in seconds to low tens of seconds at your data shape.

**E2 is nearly free** — it reads `rollup_month`, which is a small pre-aggregated table. Use it as your smoke test that the parameters are being substituted correctly.

**Freshness:** every rollup this pack reads is dated. Check before you present anything:

```sql
SELECT name, status, finished_at, covers_from, covers_to, rows_written,
       round(extract(epoch FROM now() - finished_at)/60) AS age_min
  FROM rollup_state ORDER BY name;
```

---

## 6. What to do with the answers

Six hypotheses. Each one names the query that settles it, what "true" looks like in the output, and what you change if it is true.

### H1 — "The top ten are consistent because they are genuinely better, not because the market carries them"

**Settled by:** A5 `consistency_verdict`, cross-read with A7 `avg_cv_trips` and E3 `seasonality_beta`.

**True looks like:** most of the permanent cohort labelled `REAL consistency`, cohort A's `avg_cv_trips` materially below the other cohorts (not just a bigger `avg_mean_trips`), and betas clustered below 0.5.

**If true:** the behaviour is transferable and worth codifying. Take the cohort's B5 start hours, B6 week-hour profile, B8 rest pattern and C2 area concentration, and write them up as a one-page operating standard. Pair each chaser (cohort D) with a permanent driver whose vehicle and shift pattern they can actually copy.

**If false** — cohort A's cv is the same as everyone else's, and A5 mostly says `MARKET-CARRIED` — then your "top ten" is a leaderboard artefact of who happened to be on shift in the busy months. Stop paying for it. Re-anchor any bonus on the **adjusted index**, not raw trip count, so a driver is rewarded for beating the month they actually worked in.

### H2 — "Top performers work the same hours as everyone else but reposition faster"

**Settled by:** B6 (`schedule_divergence_tvd`, `pct_trips_in_fleet_peak_cells`) against C6 (`median_gap_min`, `same_district_pct`).

**True looks like:** cohort A's TVD **low** (their week looks like everyone else's) but C6 `median_gap_min` materially lower and `pct_back_to_back_under_10min` materially higher.

**If true:** the lever is dispatch and positioning, not rostering. Publish the C3 corridors where cohort A's share exceeds the rest by the largest margin, and brief the bottom two quartiles on where to sit after a drop-off in each district. Given that C6 also reports `pct_next_job_on_another_platform`, check whether the top cohort's speed comes from running two apps — if so, multi-apping is your actual finding and the action is to make sure everyone is onboarded on both.

### H3 — "Top performers work the right hours, not more hours"

**Settled by:** B6 `pct_trips_in_fleet_peak_cells` vs `fleet_pct_in_peak_cells`, plus B4/B9 `median_session_min` and B8 `pct_days_worked_in_tenure`.

**True looks like:** cohort A's peak-cell share well above the fleet's, while their median session length and days worked are **within a few percent of the fleet's**.

**If true:** the message to the fleet is "shift your start time", not "work longer" — and B5's `median_first_clock_hour` per driver tells you exactly who to talk to and by how many hours. This is the cheapest intervention in the whole pack: it costs nothing and does not increase anyone's hours.

**If false** — cohort A simply has more `active_days` and longer sessions (A6 `avg_active_days_per_month`, B4 `session_min`) — then you are looking at endurance, not skill, and your real exposures are burnout and licence/vehicle downtime. Check B8 `rest_days_per_week`: a top-ten cohort resting under 0.5 days a week is a churn event waiting to happen, and D4's `monthly_trips_at_risk` tells you what each one will cost when it fires.

### H4 — "Top performers are airport specialists"

**Settled by:** C4, strict rule, cohort A vs `ALL`.

**True looks like:** `pct_airport_touching_strict` for cohort A meaningfully above the fleet, with `avg_km_airport` well above `avg_km_non_airport` — i.e. they are taking the long, high-value runs.

**If true:** airport access, queue position and terminal permits become a fleet-level asset worth managing rather than a driver-level habit. Also check `pct_of_airport_trips_before_0500` — if the cohort's airport work is the pre-dawn wave, your rostering question is specifically about who is available at 03:00, and B5's `median_first_clock_hour` identifies them.

**Caution before acting:** C1 will tell you the address coverage this rests on, and the strict-vs-loose gap in C4 tells you how much of the effect is the word "terminal". If strict and loose differ by more than a few points, the airport finding is partly a string match on bus stations.

### H5 — "Top performers adapt their schedule during Ramadan and summer rather than just doing less"

**Settled by:** E6 daypart shares by cohort × season, plus B9 `median_start_clock_hour` by season, with E4 `share_retention_ratio` as the outcome measure.

**True looks like:** cohort A's `pct_night_0000_0459` and `pct_late_2000_2359` rising in Ramadan while `trips_per_day` holds, and their `share_retention_ratio` staying near or above 1.0.

**If true:** publish a Ramadan and a summer shift pattern derived directly from the cohort's own behaviour and roster the rest of the fleet onto it. This is the single most repeatable finding in the pack, because it is a scheduling change rather than a skill change.

**A8 is the guard on this one.** If `n_permanent_worked` drops sharply relative to `permanent_cohort_size` in Ramadan, then the cohort did not adapt — half of them took the month off and the strong half carried the index. In that case the action is leave planning, not re-rostering.

### H6 — "The top ten survive shocks; the rest do not"

**Settled by:** E5 `drawdown_pct` and `months_to_recover`, grouped by cohort.

**True looks like:** cohort A's median drawdown under 15% and recovery in ≤1 month, against 30%+ and 2–3 months for everyone else.

**If true:** you have a measured resilience profile. The operational move is to protect it — the cohort's vehicles should be first in line for maintenance and their documents (`vehicle_document.expires_at`, `driver_compliance.licence_expires`) should never be the thing that stops them. Run this alongside D4: a permanent-cohort driver going dormant is worth `monthly_trips_at_risk` per month, and that number is on the row.

**If false** — everyone falls the same amount — then the shock is demand-side and no driver behaviour fixes it. The response is commercial: channel mix (E2's `booking_platforms`) and the corporate/hotel channel, which is contracted rather than hailed and is the least shock-exposed revenue you have.

### One thing to check before acting on any of the six

A6's `not_completed_pct` by band. If cohort A's cancellation rate is *higher* than the fleet's, part of their volume advantage is accepting jobs they then abandon, which costs you rider satisfaction on the platforms that measure it. That is the one finding in this pack that would turn a "copy them" conclusion into a "correct them" one, and it costs nothing to look at.

---

## 7. Gaps and next collection steps

Ranked by how much analysis each one unlocks per unit of engineering effort. The first three are all cases where the data already exists at the provider and is simply not wired up.

### 1. Online / offline sessions — the biggest single gap

Nothing in this database records when a driver went online. Two of the pieces are already sitting there unused:

- **`getPerformanceReport`** is the Uber operation that carries `hoursOnline`, `hoursOnJob`, `hoursOnTrip`, `acceptanceRate` and `cancellationRate`. It is named in the header comment of `src/sources/uber.js` and **called nowhere** — grep finds it only in that comment.
- **`REPORT_TYPE_DRIVER_ACTIVITY`** (Time online / Time on trip) is probed for existence in `api/probe.js` and never collected.

Wiring either one fills `driver_performance.hours_online` and `hours_on_trip` for the channel that is most of your volume, and turns every "session" in Module B from a derived floor into a measurement. It also makes `vehicle_utilisation` — which already declares the complete model, `hours_online / hours_on_job / hours_on_trip / hours_to_trip / hours_available / utilisation / trips_per_online_hour / earnings_per_hour` — writable for the first time. Two places in your product (`src/insights.js:122`, `api/vehicle_routes.js:312`) already read that table and today silently return nothing.

Bolt writes no hours at all; check whether the Fleet Owner Portal exposes an activity report before assuming it cannot.

### 2. Trip duration — a two-line fix

`trip.duration_s` is NULL on every row of every platform, yet FMS's `GetTripPassenger` **returns `Trip Duration`**, `src/probe.js:162` already declares the alias `'Trip Duration': 'duration_s'` (so `/api/schema/raw-fields` reports the field as mapped when it is not), and `src/util.js:98` `hmsToSeconds()` was written to do exactly this conversion and is **exported and referenced nowhere in the codebase**.

Mapping it would: make corridor `avg_min` computable (it is null in every window today), remove the 30-minute assumption from B4/B7/C6, and revive a dead branch in `reconcile.js:153`.

### 3. Bolt is half-blind

Bolt writes no `ended_at` on any row ever, no `driver_ext_id`, no address, no coordinate, no distance. The consequences run through this whole pack: every Bolt booking gets an invented 30-minute window in the reconciler, Bolt drivers exist only as names, and Bolt is entirely absent from Module C. Check whether `orderHistory/getTable` exposes a drop-off timestamp, a driver id, or an address column that simply is not being mapped in `src/sources/bolt.js:219-224` — the row object there has five keys.

### 4. Uber fares

The Uber trip export has no fare column, so `trip.price` is NULL on ~30k rows and no per-trip revenue analysis covers your largest channel. Uber money exists only at report-window grain. If the supplier GraphQL surface exposes a per-trip fare — or if the trip export can be requested with additional columns — that single change makes revenue-per-trip, revenue-per-hour and revenue-per-km computable fleet-wide for the first time.

### 5. Geography — geocode the addresses you already have

You have ~30k Uber and Yango addresses as text and no coordinates for any of them. Two options, cheapest first:

- **Build a district lookup table.** Extract the distinct second-`' - '` segments from `pickup_addr`/`dropoff_addr` (C2 does this at query time), clean them once by hand into a `district` dimension, and store the district id on `trip`. Cheap, offline, no API, and it turns C2/C3/C6 from a heuristic into a dimension.
- **Geocode properly** and store `pickup_lat/lng` for the Uber and Yango rows. More work, but it makes the coordinate hotspot analysis (C5) cover your whole business rather than the hotel channel plus GPS traces.

Either one unlocks the zone/corridor analysis that the schema has no table for today — there is no PostGIS, no geometry type, no H3 or geohash column, no zone dimension anywhere.

### 6. Egari seat sensors

`seat_occupied` — the only true "passenger aboard" signal in the fleet — is written by **cabman only**, and cabman is configured for Ecosine only (`config.js:43`: *"Egari DT credentials can be added here once provided"*). Adding those credentials roughly doubles the coverage of `occupancy_segment`, which is both your unauthorised-use detector and by far the best available numerator for a real on-trip-time measure. It also fixes the ~15 dead trackers problem partially, by adding a second feed on plates that currently have one.

### 7. Acceptance, cancellation and completion rates

`driver_performance.acceptance_rate`, `cancellation_rate` and `completion_rate` are declared and no collector writes any of them. Uber's versions exist as org-level `org_value`/`target_value` plus a flagged-driver JSON array in `platform_recommendation` — a different grain that cannot be joined to a driver-month. Until these land per driver, "was this driver online and declining work" is unanswerable, and A6's `not_completed_pct` is the only proxy.

### 8. Cost, rental and pay-rate per driver

`trip.cost` and `trip.margin` are effectively always NULL. Nothing in this pack — or in your database — speaks to whether a driver is *profitable*, only whether they are *productive*. A per-driver monthly cost line (vehicle rental, fuel/charging, Salik, insurance allocation) would turn every volume ranking in Module A into a margin ranking, which is a different and usually shorter list.

### 9. Public holidays

`calendar_day.is_holiday` and `holiday_name` are declared and never written, and only today's row is ever inserted. `world_event` covers Ramadan and Eid al-Fitr but has no code for Eid al-Adha, National Day, or any other UAE public holiday. A one-off insert of `source='manual'` rows into `world_event` for the UAE holiday calendar — a few dozen rows — would make E1/E4/E6 substantially sharper for almost no effort, and it uses a table and a code vocabulary that already exist.
