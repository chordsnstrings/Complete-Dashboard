/* Payouts at day grain, with overlapping report windows resolved.
   ─────────────────────────────────────────────────────────────────────────
   driver_performance is a log of REPORT WINDOWS, and its key is the window. It
   was never a set of disjoint periods, and every query that summed it assumed
   it was.

   The Uber collector asked for seven-day ranges anchored to whenever the run
   began, so a backfill starting on a Saturday and a catch-up starting on a
   Thursday stored the same payout week twice, six days apart, under two
   different keys. Neither row is wrong — they are answers to two overlapping
   questions — but adding them counts the same money twice. Bolt and Yango do
   it differently and no less: a backfill writes one 31-day row and the
   catch-ups write 4-day rows inside it.

   Measured on the live database before this: one driver's twenty-eight weeks
   were held as sixty-seven rows summing to AED 128,357 against AED 57,110 on a
   single grid. Every vehicle earnings figure the product showed carried that.

   The resolution is per DAY, because a day is the only grain every window
   shape has in common. Each period is spread evenly across the days it covers,
   and each day then takes exactly one period: the SHORTEST one covering it,
   because a four-day report of a week is a finer measurement than a thirty-one
   day report of a month, and a tie goes to whatever was ingested most recently.
   No day is counted twice and no day is dropped — a month-long row still
   supplies every day no shorter row covers.

   Even spreading is an estimate and the product must say so: a driver earns
   nothing on a rest day and the week's pay is not seven equal parts. It is the
   right estimate for a WINDOW total, which is what every caller here asks for,
   and it is exact whenever the window contains whole periods.

   src/util.js now pins the Uber collector to Monday-anchored calendar weeks so
   new rows land on one grid and the upsert replaces rather than accumulates.
   This view is what makes the numbers right in the meantime, and what keeps
   them right when a provider answers on a grid of its own. */
CREATE OR REPLACE VIEW driver_payout_day AS
SELECT DISTINCT ON (p.platform, p.driver_ext_id, d.day)
       p.platform, p.fleet_id, p.driver_ext_id, p.driver_name,
       d.day::date                                   AS day,
       p.period_start, p.period_end,
       (p.period_end - p.period_start + 1)           AS period_days,
       p.earnings                                    AS period_earnings,
       p.earnings      / (p.period_end - p.period_start + 1)  AS earnings,
       p.cash_earnings / (p.period_end - p.period_start + 1)  AS cash_earnings,
       p.trips::numeric/ (p.period_end - p.period_start + 1)  AS trips,
       p.distance_km   / (p.period_end - p.period_start + 1)  AS distance_km,
       p.hours_online  / (p.period_end - p.period_start + 1)  AS hours_online,
       p.hours_on_trip / (p.period_end - p.period_start + 1)  AS hours_on_trip,
       /* Carried through undivided: these are RATES and a rate is not a
          quantity to share out across days. Averaged over days rather than
          over report windows they are also better weighted — a 31-day summary
          and a 4-day one used to count the same in an avg(). */
       p.acceptance_rate, p.cancellation_rate, p.completion_rate, p.rating,
       p.currency, p.ingested_at
FROM driver_performance p
CROSS JOIN LATERAL generate_series(p.period_start, p.period_end, interval '1 day') AS d(day)
ORDER BY p.platform, p.driver_ext_id, d.day,
         /* Finest measurement first, then most recently collected. Both keys
            are needed: without the first a month-long summary would displace
            the weeks inside it; without the second the winner between two
            equal-length overlapping windows would be whatever the planner
            happened to emit first, and the same query could answer differently
            twice in a row. */
         (p.period_end - p.period_start) ASC,
         p.ingested_at DESC NULLS LAST,
         p.period_start ASC;

/* The periods that actually contribute, one row per window that won at least
   one of its days. This is what a page should LIST — showing driver_performance
   directly put sixty-seven overlapping rows in front of a reader as if they
   were sixty-seven weeks of work. */
CREATE OR REPLACE VIEW driver_payout AS
SELECT platform, fleet_id, driver_ext_id, driver_name,
       period_start, period_end, period_days,
       min(day)                        AS first_day_used,
       max(day)                        AS last_day_used,
       count(*)::int                   AS days_used,
       max(period_earnings)            AS period_earnings,
       sum(earnings)                   AS earnings,
       sum(cash_earnings)              AS cash_earnings,
       sum(trips)                      AS trips,
       sum(distance_km)                AS distance_km,
       sum(hours_online)               AS hours_online,
       sum(hours_on_trip)              AS hours_on_trip,
       max(acceptance_rate)            AS acceptance_rate,
       max(cancellation_rate)          AS cancellation_rate,
       max(completion_rate)            AS completion_rate,
       max(rating)                     AS rating,
       currency
FROM driver_payout_day
GROUP BY platform, fleet_id, driver_ext_id, driver_name,
         period_start, period_end, period_days, currency;

/* The lateral expansion scans driver_performance by (platform, driver_ext_id)
   and the existing perf_period_idx is on (period_start, period_end), which
   cannot serve it. */
CREATE INDEX IF NOT EXISTS perf_driver_period_idx
  ON driver_performance (platform, driver_ext_id, period_start);
