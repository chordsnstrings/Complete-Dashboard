/* A day whose money a finer report already stated must not state it twice.
   ─────────────────────────────────────────────────────────────────────────
   schema_v23 resolves overlapping report windows per driver-DAY, taking the
   shortest period covering each day. That is right whenever the grains
   describe the same money at different resolutions. Uber's do not.

   MEASURED, against the operator's own bank statements for August 2026 —
   ENBD for Ecosine and ADCB for Egari, ten Uber credits, AED 440,445.31
   received. Over 27 July to 30 August, this is what driver_payout_day was
   made of:

       span   driver-days   drivers        earnings
        1d          2,423        94      440,726.21
        2d            317       116          397.27
        3d            108       104           99.08
        4d            212       113          955.78
        7d          5,130       216       23,745.20
                                        ------------
                                          465,923.54   +5.78% over the bank

   The 1-day rows alone are +0.06% of what the bank actually paid. Everything
   coarser is 25,197.33 on top of a figure that was already right.

   Read the driver counts, because they are the whole argument. The weekly grid
   names 216 drivers and the daily grid 94. If the 122 drivers who appear only
   weekly had genuinely earned that 23,745, the daily-only total would be SHORT
   by it. It is over by 281. The weekly rows are not the missing half of the
   money — they are a restatement of a week that the daily grid already
   accounts for, and 23,745 spread over 216 drivers and five weeks is AED 110
   each, which is not a month's pay for anybody.

   ── what changes, and what deliberately does not ─────────────────────────
   The coarse row is NOT dropped. schema_v23's expansion is the only source of
   hours_online, hours_on_trip and the acceptance/cancellation/completion/
   rating scorecard, and those come from a DIFFERENT report — REPORT_TYPE_
   DRIVER_QUALITY, written by pullDriverQuality on its own weekly grid. A rule
   that deleted the superseded week would take a driver's hours and rating with
   its money, which the grain bug never touched. So the row stays, its money
   columns go NULL, and it says why.

   That is also the house rule. A figure that cannot be measured renders absent
   with a reason, never as zero and never by vanishing — see
   api/alert_coverage_sql.js. `grain_reason` is that reason, on the row, in the
   server's words.

   ── the superseding grain is the DAY, and only the day ───────────────────
   `finer` here means period_days = 1, not "any shorter span". Uber files 2, 3
   and 4-day windows too — 1,452.13 between them over the measured window — and
   a stray 4-day backfill row must not be allowed to vouch for a week's
   coverage or to suppress it. Only the daily grid, which is the one that
   reconciles, supersedes anything.

   ── and only where that grid actually ran ────────────────────────────────
   The daily grid has a horizon: src/sources/uber.js bounds it at
   UBER_EARNER_HORIZON_DAYS + UBER_EARNER_ASK_MARGIN_DAYS, roughly 192 days,
   while the weekly grid reaches further back. Before that horizon there IS no
   daily row and the weekly row is the only record of the money — suppressing
   it there would delete history the bank did pay. So the test is per
   (platform, fleet_id, day): the coarse row loses its money only on days where
   that fleet's daily grid demonstrably ran. Outside the horizon nothing
   changes and every older month reads exactly as it does today.

   ── why a new name, and not a replacement ────────────────────────────────
   Both containers replay every file in sql/ on every boot, and schema_v23 runs
   before this one. CREATE OR REPLACE VIEW may append a column but may never
   remove one, so v23 replacing a view this file had already widened is
   `cannot drop columns from view` — the boot after the deploy, not the deploy
   itself. test/route_smoke.test.mjs replays the whole directory a second time
   for exactly this, and caught it.

   Editing v23 in place would fix the replay and buy a worse failure: the
   migration ledger skips a file whose sha is unchanged, so the next edit to
   v23 would re-run v23 alone, with this file skipped, and silently put the
   21-column view back under a rollup that inserts 22. A new name cannot be
   reverted by anything v23 does. The old view is dropped at the foot of this
   file rather than left standing, so there is one view answering this question
   and not two that disagree.

   ── scope ───────────────────────────────────────────────────────────────
   Every platform, by construction, because the rule is about grains and not
   about Uber. In practice only Uber files more than one: Bolt, the hotel
   channel and Yango send a single grain each, so their rows can never be
   superseded and their figures do not move. */

ALTER TABLE driver_payout_day ADD COLUMN IF NOT EXISTS grain_reason TEXT;
COMMENT ON COLUMN driver_payout_day.grain_reason IS
  'Why this day carries no money although its report window does: the provider also filed a per-day report covering it, and that is the one that reconciles. NULL when the row''s money is its own.';

CREATE OR REPLACE VIEW driver_payout_day_finest AS
WITH
/* The days each fleet's DAILY grid actually ran, which is what licenses a
   weekly row to be superseded. One row per (platform, fleet, day) rather than
   per driver-day: a driver absent from the daily grid on a day the grid ran is
   a driver who earned nothing that day, and the bank evidence above is what
   establishes that — the daily-only total is the received total. */
daily_grid AS (
  SELECT DISTINCT platform, fleet_id, period_start AS day
    FROM driver_performance
   WHERE period_end = period_start
     AND (earnings IS NOT NULL OR cash_earnings IS NOT NULL)
),
expanded AS (
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
            quantity to share out across days. */
         p.acceptance_rate, p.cancellation_rate, p.completion_rate, p.rating,
         p.currency, p.ingested_at
  FROM driver_performance p
  CROSS JOIN LATERAL generate_series(p.period_start, p.period_end, interval '1 day') AS d(day)
  WHERE p.earnings IS NOT NULL OR p.cash_earnings IS NOT NULL
     OR p.trips IS NOT NULL OR p.distance_km IS NOT NULL
     OR p.hours_online IS NOT NULL OR p.hours_on_trip IS NOT NULL
  ORDER BY p.platform, p.driver_ext_id, d.day,
           (p.period_end - p.period_start) ASC,
           p.ingested_at DESC NULLS LAST,
           p.period_start ASC
)
SELECT e.platform, e.fleet_id, e.driver_ext_id, e.driver_name, e.day,
       e.period_start, e.period_end, e.period_days, e.period_earnings,
       /* The money, and only the money. A superseded day keeps its hours and
          its scorecard — those came from a different report on a different
          grid and the grain bug never touched them. */
       CASE WHEN g.day IS NULL THEN e.earnings      END AS earnings,
       CASE WHEN g.day IS NULL THEN e.cash_earnings END AS cash_earnings,
       CASE WHEN g.day IS NULL THEN e.trips         END AS trips,
       CASE WHEN g.day IS NULL THEN e.distance_km   END AS distance_km,
       e.hours_online, e.hours_on_trip,
       e.acceptance_rate, e.cancellation_rate, e.completion_rate, e.rating,
       e.currency, e.ingested_at,
       CASE WHEN g.day IS NULL THEN NULL
            ELSE 'not counted here — ' || e.period_days || '-day report of '
                 || to_char(e.period_start, 'DD Mon') || ' to '
                 || to_char(e.period_end, 'DD Mon')
                 || ', and this provider also filed a per-day report for this day. '
                 || 'The daily one is what reconciles to the bank, so counting both '
                 || 'would state the same money twice.'
       END AS grain_reason
  FROM expanded e
  /* Superseded only where the row is COARSER than a day and the fleet's daily
     grid ran on that day. period_days = 1 rows are never their own supersessor
     — the join would otherwise blank every daily row in the table. */
  LEFT JOIN daily_grid g
    ON  e.period_days > 1
    AND g.platform = e.platform
    AND g.fleet_id IS NOT DISTINCT FROM e.fleet_id
    AND g.day = e.day;

COMMENT ON VIEW driver_payout_day_finest IS
  'Report windows expanded to days, one period per driver-day (the shortest covering it), with the money withheld from any window coarser than a day on a day the same fleet''s daily grid also reported. Measured against the August 2026 bank statements: daily-only is +0.06% of what was received, and counting the coarser windows as well was +5.78%. Hours and the scorecard are never withheld — they come from a different report.';

/* schema_v23's view answered the same question without the supersession rule,
   and every reader has moved to the one above. Dropped rather than kept so a
   future query cannot pick the wrong one and quietly restate a week's money.
   v23 recreates it on the next boot and this line removes it again; that is
   the intended steady state, and it is why the two statements are ordered
   create-then-drop rather than the other way round. */
DROP VIEW IF EXISTS driver_payout_day_live;
