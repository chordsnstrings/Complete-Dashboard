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

/* Trip-weighted shares of each payout period, one row per (plate, day).

   `$1..$2` are the window bounds as dates. The window is applied to the
   vehicle-DAY, not to the payout period: a weekly period straddling the edge
   contributes only the days inside, which is what makes a 7-day view and a
   30-day view of the same car consistent.

   Weights are computed over the driver's WHOLE period, not only the part
   inside the window — otherwise a period half outside would have its inside
   half scaled up to 100% and the car would appear to have earned the full
   week's pay in three days. */
export const attributedEarnings = ({ platformFilter = '', extra = '' } = {}) => `
  WITH pay AS (
    SELECT platform, driver_ext_id, period_start, period_end,
           earnings, cash_earnings
    FROM driver_performance
    WHERE earnings IS NOT NULL AND earnings > 0
      AND period_end >= $1::date AND period_start <= $2::date
      ${platformFilter}
  ),
  /* Every vehicle-day belonging to a period, including the days outside the
     requested window — they are needed for the denominator, and dropped after
     the weight is known. */
  vd AS (
    SELECT p.platform, p.driver_ext_id, p.period_start, p.period_end,
           p.earnings, p.cash_earnings,
           d.plate, d.day, d.driver_name, d.fleet_id,
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
     basis to prefer one. Recorded as such via basis below. */
  den AS (
    SELECT platform, driver_ext_id, period_start, period_end,
           sum(trips) AS total_trips, count(*) AS n_days
    FROM vd GROUP BY 1,2,3,4
  )
  SELECT vd.plate, vd.day, vd.platform, vd.driver_ext_id, vd.driver_name, vd.fleet_id,
         vd.trips, vd.km,
         vd.period_start, vd.period_end,
         vd.earnings AS period_earnings,
         CASE WHEN den.total_trips > 0 THEN vd.trips::numeric / den.total_trips
              ELSE 1.0 / nullif(den.n_days, 0) END AS share,
         vd.earnings * CASE WHEN den.total_trips > 0 THEN vd.trips::numeric / den.total_trips
                            ELSE 1.0 / nullif(den.n_days, 0) END AS attributed,
         vd.cash_earnings * CASE WHEN den.total_trips > 0 THEN vd.trips::numeric / den.total_trips
                                 ELSE 1.0 / nullif(den.n_days, 0) END AS attributed_cash,
         CASE WHEN den.total_trips > 0 THEN 'trips' ELSE 'even' END AS basis
  FROM vd
  JOIN den USING (platform, driver_ext_id, period_start, period_end)
  WHERE vd.day BETWEEN $1::date AND $2::date
  ${extra}`;

/* The other half of the ledger: payout periods that could not be placed on any
   vehicle, because the driver has no vehicle-day inside the period. Reported
   beside the attributed total so a page can say "AED 12,400 across these cars,
   and AED 900 we could not place" instead of quietly showing the smaller
   number as if it were everything. */
export const unattributedEarnings = ({ platformFilter = '' } = {}) => `
  SELECT p.platform,
         count(*)::int periods,
         count(DISTINCT p.driver_ext_id)::int drivers,
         round(sum(p.earnings)::numeric, 2) AS earnings
  FROM driver_performance p
  WHERE p.earnings IS NOT NULL AND p.earnings > 0
    AND p.period_end >= $1::date AND p.period_start <= $2::date
    ${platformFilter}
    AND NOT EXISTS (
      SELECT 1 FROM vehicle_driver_day d
      WHERE d.driver_ext_id = p.driver_ext_id AND d.platform = p.platform
        AND d.day BETWEEN p.period_start AND p.period_end)
  GROUP BY 1`;
