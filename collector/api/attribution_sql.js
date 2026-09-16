/* Attributing a driver's payout to the vehicle that earned it.
   ─────────────────────────────────────────────────────────────────────────
   Uber is 90% of this fleet's bookings and its trip export carries no fare at
   all. Its money arrives somewhere else entirely: driver_performance, one row
   per driver per payout period. So every page keyed on a VEHICLE could see the
   work and none of the money. One car showed 266 trips, 3,586 km and AED 525
   over thirty days — the 525 being ten hotel bookings, the only trips in the
   set that carry a price. The other 256 were Uber, and read as free.

   The join that closes it already exists: vehicle_driver_day says who drove
   which plate on which day. A payout is spread across the vehicle-days its
   driver actually worked, in proportion to the trips done on each — so a
   driver who did thirty trips on one car and ten on another sends three
   quarters of that period's pay to the first.

   Three rules this must not break:

   1. It is ATTRIBUTED money, never a measured fare, and every surface that
      shows it has to say so. A fare is what a rider paid for one trip; this is
      a share of a weekly net payout, after the platform's commission, inferred
      from custody. Summing the two into one "revenue" figure would be the same
      category error the Revenue page was built to avoid.

   2. Nothing is invented. A payout whose driver has no vehicle-day inside the
      period cannot be placed on any car, and is reported as unattributed
      rather than dropped or spread evenly over the fleet. Dropping it makes
      the vehicle pages quietly sum to less than the Revenue page, which is how
      a reconciliation stops being possible.

   3. The shares add up. Every period's weights sum to exactly 1 across its
      vehicle-days, so the attributed total over all plates equals the payout
      total minus the unattributed remainder. That is an arithmetic identity,
      and test/attribution.test.mjs asserts it rather than trusting it. */

/* The name fold, for the ONE count in this file that cannot read a stored
   person key — see unattributedEarnings below for why. */
import { peopleCount } from './custody_sql.js';

/* Trip-weighted shares of each payout period, one row per (plate, day).

   `$1..$2` are the window bounds as dates. The window is applied to the
   vehicle-DAY, not to the payout period: a weekly period straddling the edge
   contributes only the days inside, which is what makes a 7-day view and a
   30-day view of the same car consistent.

   Weights are computed over the driver's WHOLE period, not only the part
   inside the window — otherwise a period half outside would have its inside
   half scaled up to 100% and the car would appear to have earned the full
   week's pay in three days.

   The source is driver_payout, not driver_performance. The raw table is a log
   of REPORT WINDOWS and its key is the window, so the same payout week arrives
   twice whenever a backfill and a catch-up ask on different grids — and one
   driver's twenty-eight weeks were held as sixty-seven rows summing to more
   than double the truth. driver_payout is the same periods with the overlaps
   resolved, and its `earnings` is the part of the period no finer report
   already accounts for. See sql/schema_v23.sql.

   Spreading is over the days the driver actually DROVE, never over the
   calendar: a week's pay earned across three days of custody belongs to those
   three days. Dividing it by seven first and then dropping the four days with
   no custody record would quietly delete more than half of it. */
export const attributedEarnings = ({ platformFilter = '', extra = '' } = {}) => `
  WITH pay AS (
    SELECT platform, driver_ext_id, period_start, period_end,
           earnings, cash_earnings
    FROM driver_payout
    WHERE earnings IS NOT NULL AND earnings > 0
      AND period_end >= $1::date AND period_start <= $2::date
      ${platformFilter}
  ),
  /* Every vehicle-day belonging to a period, including the days outside the
     requested window — they are needed for the denominator, and dropped after
     the weight is known. */
  /* person_key comes up with the custody row, and it changes NOTHING about the
     arithmetic.
     ───────────────────────────────────────────────────────────────────────
     THE DEFECT it closes is downstream: three call sites counted
     count(DISTINCT driver_ext_id) over these rows and called the answer
     drivers — /api/vehicle/kpis (attributed_drivers, rendered on the phone as
     a tile headed "Drivers · held this car") and /api/economics/assets
     (payout_drivers). The DESKTOP tile for the same car uses peopleCount() and
     is folded, so one vehicle answered two different driver counts depending
     on which shell asked.

     vehicle_driver_day carries the generated person_key (sql/schema_v53.sql)
     and this CTE already joins that table, so exposing it costs one column on
     a row set that is already being built.

     THE WEIGHTING MUST STAY ON driver_ext_id AND DOES. A payout is filed per
     ACCOUNT — driver_payout is grouped on (platform, driver_ext_id, period) —
     so the share of a period that belongs to a vehicle-day is a question about
     that account's days and trips, and folding two accounts together here
     would pool two separate statements into one denominator and silently
     change every attributed amount. Only the COUNT folds. The WINDOW clause
     below still partitions on driver_ext_id; nothing in the weight expression
     mentions person_key. */
  vd AS (
    SELECT p.platform, p.driver_ext_id, p.period_start, p.period_end,
           p.earnings, p.cash_earnings,
           d.plate, d.day, d.driver_name, d.fleet_id, d.person_key,
           greatest(coalesce(d.trips, 0), 0) AS trips,
           coalesce(d.km, 0) AS km
    FROM pay p
    JOIN vehicle_driver_day d
      ON d.driver_ext_id = p.driver_ext_id
     AND d.platform = p.platform
     AND d.day BETWEEN p.period_start AND p.period_end
  ),
  /* The denominator, per period. A period whose vehicle-days record no trips
     at all still has to divide by something, so it falls back to an equal
     split across those days — the driver was in those cars, we simply have no
     basis to prefer one. Recorded as such via basis below.

     A WINDOW, not a self-join back onto an aggregate of the same CTE.
     ─────────────────────────────────────────────────────────────────────
     It used to be a den CTE, SELECT ... FROM vd GROUP BY 1,2,3,4, joined back
     with USING (platform, driver_ext_id, period_start, period_end). That join
     is where the endpoint died under a platform filter. The planner has no
     statistics for a CTE scan: it estimated ONE row on each side of the join
     — the real numbers were 7,507 and 1,223 — and one row against one row
     makes a nested loop with a join filter look free. Measured at production
     shape on /api/economics/assets?days=365&platform=uber: Rows Removed by
     Join Filter: 9,158,540, and 308 SECONDS against 1.2 for the same page with
     no filter. The unfiltered call escaped only because a wider estimate
     bought it a hash join by luck, which is not a property to rely on.

     The rows are already grouped the way the denominator needs them, so there
     is nothing to join TO: one partitioned pass computes both aggregates and
     leaves each row carrying its own period's totals. All four partition
     columns are NOT NULL on driver_payout_day and are grouped by in the
     driver_payout view, so the join could never have dropped a row either —
     the values are identical, and now they cost one sort instead of a
     quadratic. Same query, filtered: 308s to 0.36s.

     The window is computed BEFORE the day filter below, which is the whole
     point of the two levels — the weights must divide by the driver's WHOLE
     period, including the days outside the requested window. WHERE runs
     before window functions, so filtering here would silently rescale a
     straddling period to 100% inside the window. */
  weighted AS (
    SELECT vd.*,
           sum(vd.trips) OVER period AS total_trips,
           count(*)      OVER period AS n_days
    FROM vd
    WINDOW period AS (PARTITION BY vd.platform, vd.driver_ext_id,
                                   vd.period_start, vd.period_end)
  )
  SELECT vd.plate, vd.day, vd.platform, vd.driver_ext_id, vd.driver_name, vd.fleet_id,
         vd.person_key,
         vd.trips, vd.km,
         vd.period_start, vd.period_end,
         vd.earnings AS period_earnings,
         CASE WHEN vd.total_trips > 0 THEN vd.trips::numeric / vd.total_trips
              ELSE 1.0 / nullif(vd.n_days, 0) END AS share,
         vd.earnings * CASE WHEN vd.total_trips > 0 THEN vd.trips::numeric / vd.total_trips
                            ELSE 1.0 / nullif(vd.n_days, 0) END AS attributed,
         vd.cash_earnings * CASE WHEN vd.total_trips > 0 THEN vd.trips::numeric / vd.total_trips
                                 ELSE 1.0 / nullif(vd.n_days, 0) END AS attributed_cash,
         CASE WHEN vd.total_trips > 0 THEN 'trips' ELSE 'even' END AS basis
  FROM weighted vd
  WHERE vd.day BETWEEN $1::date AND $2::date
  ${extra}`;

/* The other half of the ledger: payout periods that could not be placed on any
   vehicle, because the driver has no vehicle-day inside the period. Reported
   beside the attributed total so a page can say "AED 12,400 across these cars,
   and AED 900 we could not place" instead of quietly showing the smaller
   number as if it were everything.

   Reads driver_payout for the same reason attributedEarnings does — the two
   halves have to partition ONE set of periods or their sum is not the payout
   total, which is the only property that makes either number checkable. */
export const unattributedEarnings = ({ platformFilter = '' } = {}) => `
  SELECT p.platform,
         count(*)::int periods,
         /* PEOPLE, computed rather than read — the one place in this file that
            has to pay for the fold.
            ──────────────────────────────────────────────────────────────
            driver_payout is a VIEW (sql/schema_v23.sql:147) grouped on
            (platform, fleet_id, driver_ext_id, driver_name, period…), and it
            does not project person_key: the column is on driver_payout_day
            underneath, and the view's SELECT list was written without it. So
            this count cannot read the stored key the way its sibling above now
            can, and it was count(DISTINCT driver_ext_id) under the name
            drivers.

            It is not read from driver_payout_day instead, and that is
            deliberate: this half and attributedEarnings() must PARTITION ONE
            SET OF PERIODS or their sum is not the payout total, which is the
            only property that makes either number checkable (see the header
            above). Changing the source of one half to get a nicer count would
            break the identity test/attribution.test.mjs asserts.

            So personKey() computes the fold from the name the view does carry.
            That is the per-row double regexp_replace, and it is affordable
            here and nowhere else in this file: these are the payout periods
            whose driver has NO vehicle-day inside them — the remainder, tens
            of rows on this fleet, not the hundreds of thousands
            sql/schema_v20.sql measured the regex against. personKey() also
            carries identityCase, so the verified merge register applies,
            which is what the stored column would have given.

            Both readings, both named: a payout is filed per account, so
            driver_accounts is what reconciles against a provider's line count
            and drivers is how many humans are behind it. */
         ${peopleCount('p.driver_ext_id', 'p.driver_name')}::int drivers,
         count(DISTINCT p.driver_ext_id)::int driver_accounts,
         round(sum(p.earnings)::numeric, 2) AS earnings
  FROM driver_payout p
  WHERE p.earnings IS NOT NULL AND p.earnings > 0
    AND p.period_end >= $1::date AND p.period_start <= $2::date
    ${platformFilter}
    AND NOT EXISTS (
      SELECT 1 FROM vehicle_driver_day d
      WHERE d.driver_ext_id = p.driver_ext_id AND d.platform = p.platform
        AND d.day BETWEEN p.period_start AND p.period_end)
  GROUP BY 1`;
