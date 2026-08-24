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
   This resolution is what makes the numbers right in the meantime, and what
   keeps them right when a provider answers on a grid of its own.

   TWO relations share the work and the split is deliberate:

   driver_payout_day_live — the VIEW below, the single copy of the rules.
   Computing it expands every report window into its days and sorts the lot,
   which at production volume took a one-vCPU database twenty seconds and more
   per query — and every page's money passes through it, so a cold cache put
   that cost in front of every first reader, and a 720-call audit failed 79 of
   them on timeouts alone.

   driver_payout_day — a TABLE holding the live view's rows, refreshed by
   src/rollup.js inside the same pass (and advisory lock) as the other rollups:
   after every collection and on the quarter-hour, which is exactly as often as
   the answer can change, because payouts move only when a collector writes.
   Everything reads the table; only the refresher reads the live view. The
   refresh is DELETE + INSERT in one transaction, so a reader mid-refresh sees
   the previous complete answer, never a half-built one. */
CREATE OR REPLACE VIEW driver_payout_day_live AS
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
/* Rows that measure nothing are not spread over anything. The Bolt collector
   writes a ROSTER snapshot into this table — who is on the books, with a rating
   and no money, no hours and no trips — and a backfill stamped it with its
   whole year, so each one expanded to 365 rows carrying nulls. On the live
   table that was the majority of the expansion and all of it was noise: a null
   contributes nothing to any sum and cannot win a day it has no measure for.

   Every measure, not earnings alone: a period reporting hours and no money is
   a real observation, and dropping it would take the driver-page utilisation
   figures with it. */
WHERE p.earnings IS NOT NULL OR p.cash_earnings IS NOT NULL
   OR p.trips IS NOT NULL OR p.distance_km IS NOT NULL
   OR p.hours_online IS NOT NULL OR p.hours_on_trip IS NOT NULL
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

/* Transition: earlier deploys created driver_payout_day and driver_payout as
   views. A view cannot become a table in place, so where the old shape exists
   it is dropped first. Idempotent — a transitioned database has nothing to
   drop, and a fresh one never had the views. */
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_views WHERE viewname = 'driver_payout_day') THEN
    DROP VIEW IF EXISTS driver_payout;
    DROP VIEW driver_payout_day;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS driver_payout_day (
  platform          TEXT NOT NULL,
  fleet_id          TEXT,
  driver_ext_id     TEXT NOT NULL,
  driver_name       TEXT,
  day               DATE NOT NULL,
  period_start      DATE NOT NULL,
  period_end        DATE NOT NULL,
  period_days       INT,
  period_earnings   NUMERIC,
  earnings          NUMERIC,
  cash_earnings     NUMERIC,
  trips             NUMERIC,
  distance_km       DOUBLE PRECISION,
  hours_online      DOUBLE PRECISION,
  hours_on_trip     DOUBLE PRECISION,
  acceptance_rate   DOUBLE PRECISION,
  cancellation_rate DOUBLE PRECISION,
  completion_rate   DOUBLE PRECISION,
  rating            DOUBLE PRECISION,
  currency          TEXT,
  ingested_at       TIMESTAMPTZ,
  PRIMARY KEY (platform, driver_ext_id, day)
);
/* The two scans every page makes that the primary key does not serve: money
   over a day range, and one person's history regardless of platform. */
CREATE INDEX IF NOT EXISTS payout_day_day_idx    ON driver_payout_day (day);
CREATE INDEX IF NOT EXISTS payout_day_driver_idx ON driver_payout_day (driver_ext_id, day);

/* The periods that actually contribute, one row per window that won at least
   one of its days. This is what a page should LIST — showing driver_performance
   directly put sixty-seven overlapping rows in front of a reader as if they
   were sixty-seven weeks of work.

   Grouped over the TABLE, so listing periods costs one indexed group-by rather
   than a fresh expansion, and so the list can never disagree with the day sums
   beside it: they are the same rows. */
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
