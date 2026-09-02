/* Where next month's work lands, and whether anybody is rostered for it.
   ──────────────────────────────────────────────────────────────────────────
   The forecast says how much work is coming. The slot pages say who covers
   each hour now. Neither, alone, answers the question an operations lead
   actually has on the first of the month: which shifts to add, and which to
   stop paying for.

   This joins them. For each weekday-hour cell it projects next month's
   bookings from the forecast total and that cell's measured share, then
   compares it against what the drivers currently working that cell have
   historically delivered.

   The honesty problem is the word "capacity". A driver's throughput in an hour
   is not a constant to be looked up — it is a measurement of what happened,
   under whatever demand there was. If an hour was quiet, its drivers look
   unproductive; if it was frantic, they look heroic. So the comparison here is
   deliberately narrow and stated as such: at the rate this cell's drivers have
   ACTUALLY worked in this cell, how many would it take to serve the projected
   demand. That is a rostering arithmetic, not a claim about anybody's limit. */

import { forecastMonths, weekdayShares } from '../src/forecast.js';
import { peopleCount } from './custody_sql.js';
import { rollupGrainSql } from '../src/rollup.js';

export function capacityRoutes(app, { q, wrap }) {
  app.get('/api/capacity', wrap(async (req, res) => {
    /* The platform and fleet chips were displayed, written into the address,
       sent with every request — and pinned to '*' in every query, so
       /api/capacity returned identical bodies for five filter variants. Worse,
       the response cache keys on the URL, so every combination anybody ever
       selected minted a fresh 2.38s computation of the same answer. Honouring
       them makes the cache key mean something as well as making the page true. */
    const pl = req.query.platform || null;
    const fl = req.query.fleet || null;
    /* ── how much work is coming ──────────────────────────────────────── */
    /* From rollup_month, like /api/forecast — the same full-history grouping,
       with nothing in the request that could narrow it. Falls back to computing
       the grain from the SAME SQL the rollup is built from, so a database with
       no rollup yet is slow rather than blank and the two paths cannot become
       different answers. */
    const monthShape = `to_char(month,'YYYY-MM') AS m, bookings AS trips`;
    let months = await q(
      `SELECT ${monthShape}, first_day, last_day FROM rollup_month
       WHERE platform = coalesce($1,'*') AND fleet_id = coalesce($2,'*') ORDER BY month`,
      [pl, fl]);
    if (!months.length) {
      months = await q(
        `SELECT ${monthShape}, NULL::date AS first_day, NULL::date AS last_day
         FROM (${rollupGrainSql('month')}) g
         WHERE platform = coalesce($1,'*') AND fleet_id = coalesce($2,'*') ORDER BY month`,
        [pl, fl]);
    }
    if (!months.length) return res.json({ ok: false, reason: 'No booking has been collected.' });

    /* The span from rollup_day, which is a few thousand rows, rather than a
       min/max over every trip. `is_booking` is a computed predicate, so the
       index on local_day cannot serve the original and it scanned. */
    let [{ a: spanFrom, b: spanTo } = {}] = await q(
      `SELECT to_char(min(day),'YYYY-MM-DD') a, to_char(max(day),'YYYY-MM-DD') b
       FROM rollup_day WHERE platform = coalesce($1,'*') AND fleet_id = coalesce($2,'*')
         AND bookings > 0`, [pl, fl]);
    if (!spanFrom) {
      [{ a: spanFrom, b: spanTo } = {}] = await q(
        `SELECT to_char(min(local_day),'YYYY-MM-DD') a, to_char(max(local_day),'YYYY-MM-DD') b
         FROM trip_norm WHERE is_booking AND ($1::text IS NULL OR platform = $1)
           AND ($2::text IS NULL OR fleet_id = $2)`, [pl, fl]);
    }
    const lastOf = (ym) => {
      const [y, mo] = ym.split('-').map(Number);
      return `${ym}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, '0')}`;
    };
    for (const m of months) {
      m.partial_month = (spanFrom && spanFrom > `${m.m}-01`) || (spanTo && spanTo < lastOf(m.m));
      m.no_data = !m.trips;
    }
    const fc = forecastMonths(months, { horizon: 3 });
    if (!fc.ok) return res.json({ ok: false, reason: fc.reason, break: fc.break });

    /* NEXT month, under a subtitle promising next month. forecast[0] used to be
       the month already in progress — on 2026-08-25 /api/capacity reported
       target_month "2026-08" and built a rota starting 2026-08-01, naming its
       busiest expected day eighteen days in the past. The horizon now begins
       at the first unstarted month, and this guard stays because a caller
       reading forecast[0] must not have to know that. */
    const target = fc.forecast.find((r) => r.m > (fc.horizon_from || '')) || fc.forecast[0];

    /* ── how the work is distributed, and who covers it ────────────────── */
    /* Measured over a trailing window rather than the whole record: the fleet
       that produced 2025's hours is not the fleet rostering next month's, and
       a shape averaged across a 76% collapse describes neither. */
    const WINDOW_DAYS = 84;
    const cells = await q(
      `WITH c AS (
         SELECT local_dow AS dow, local_hour AS slot_hour, local_day AS day,
                count(*)::int bookings,
                ${peopleCount()}::int drivers
         FROM trip_norm
         WHERE is_booking
           AND local_day > (SELECT max(local_day) FROM trip_norm WHERE is_booking) - $1::int
           AND ($2::text IS NULL OR platform = $2) AND ($3::text IS NULL OR fleet_id = $3)
         GROUP BY 1,2,3)
       SELECT dow, slot_hour AS hour,
              sum(bookings)::int bookings,
              count(*)::int occurrences,
              round(avg(bookings)::numeric, 2) AS bookings_per_occurrence,
              round(avg(drivers)::numeric, 2) AS drivers_per_occurrence,
              max(drivers)::int AS most_drivers_seen,
              /* The POOLED rate, not the mean of the per-occurrence ratios.
                 avg(bookings/drivers) is an average of ratios while the two
                 columns printed either side of it on the page are means of
                 their own numerator and denominator, so the row did not
                 reconcile with itself: production on 2026-09-02 showed Sun
                 03:00 with 7.67 bookings, 5.75 drivers and "each doing" 1.4,
                 and 5.75 × 1.4 = 8.05, not 7.67. 26 of the 168 rows were out
                 by more than 2%, always in the direction that an occurrence
                 with few drivers pulls the mean of the ratios about. */
              round(sum(bookings)::numeric / nullif(sum(drivers), 0), 2) AS bookings_per_driver
        FROM c GROUP BY 1,2 ORDER BY 1,2`, [WINDOW_DAYS, pl, fl]);

    if (!cells.length) return res.json({ ok: false, reason: 'No booking in the trailing window.' });

    const totalBookings = cells.reduce((a, c) => a + c.bookings, 0);

    /* How many times each weekday occurs in the target month — a month with
       five Fridays needs a different rota from one with four, and spreading a
       monthly total evenly across cells hides exactly that. */
    const [ty, tm] = target.m.split('-').map(Number);
    const daysInTarget = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
    const dowCount = [0, 0, 0, 0, 0, 0, 0];
    for (let dd = 1; dd <= daysInTarget; dd++) {
      dowCount[new Date(Date.UTC(ty, tm - 1, dd)).getUTCDay()]++;
    }
    /* Weight of each cell in a month, given how often its weekday occurs.
       ─────────────────────────────────────────────────────────────────────
       This was `(c.bookings / totalBookings) * 1` — dowCount was computed
       above and then never used, so each cell kept its raw share of the
       84-day WINDOW, in which every weekday occurs exactly twelve times, and
       line 131 below then divided that fixed share by the TARGET month's
       occurrence count. October 2026 has four Sun–Wed and five Thu–Sat, so
       two hours with identical measured demand came out 5/4 apart per
       occurrence purely by weekday.

       Measured on production at 13:15 UTC on 2026-09-02 (target 2026-10,
       15,500 bookings, 168 cells), expected_per_occurrence ÷ the cell's own
       measured bookings_per_occurrence ran from 1.0997 to 1.4986 — a 36%
       spread manufactured by the arithmetic. At 18:00: Tue 25.83 measured →
       38.4 expected (×1.49) against Thu 28.50 → 33.9 (×1.19), so the BUSIER
       hour was projected as the quieter one. Every one of the ten largest
       gaps on "Add people here" was a Monday, Tuesday or Wednesday, and Thu
       19:00 and Fri 19:00 — the fleet's two busiest hours at 29.0 and 28.5
       bookings per occurrence — were pushed off it.

       A per-occurrence rate times the number of times that weekday comes
       round next month. The share is then a share of the TARGET month rather
       than of a twelve-week window, and expectedPerOccurrence =
       expectedMonth / occurrences collapses to (target × rate ÷ Σweights),
       which is proportional to the measured rate and to nothing else.
       Verified against the production body rather than assumed: reweighting
       its 168 cells sums to 15,500.0000 against a 15,500 target, so the month
       total is conserved exactly, and the multiplier becomes the same constant
       in every cell.

       c.occurrences is days that CARRIED a booking, not days the weekday came
       round — 12 of production's 168 cells were seen 10 or 11 times out of 12.
       That is the same conditioning drivers_per_occurrence is under, and
       drivers_needed divides one by the other, so the two match; using a flat
       12 here would put a rate over all occurrences on top of a rate over
       occurrences with work in them. */
    const weightOf = (c) => (c.bookings / c.occurrences) * (dowCount[c.dow] || 0);
    const totalWeighted = cells.reduce((a, c) => a + weightOf(c), 0);

    const rows = cells.map((c) => {
      const share = weightOf(c) / totalWeighted;
      const expectedMonth = target.point * share;
      const occurrences = dowCount[c.dow] || 0;
      const expectedPerOccurrence = occurrences ? expectedMonth / occurrences : null;
      const perDriver = Number(c.bookings_per_driver) || null;
      const haveDrivers = Number(c.drivers_per_occurrence) || 0;
      /* At the rate this cell's own drivers have actually worked it, how many
         would serve the projected demand. Not a capacity claim — a division.

         With the two arithmetic corrections above in place, this division
         CANCELS, and the page has to be read knowing that. Writing b and d for
         the cell's mean bookings and mean drivers per occurrence:

             perDriver             = Σbookings ÷ Σdrivers = b ÷ d
             expectedPerOccurrence = target × b ÷ Σweights
             needDrivers           = (target × b ÷ Σw) ÷ (b ÷ d)
                                   = d × (target ÷ Σw)

         so drivers_needed is the drivers already on the cell, multiplied by
         one number that is the same in every cell. Measured on production's
         2026-09-02 body re-derived through this code: needed ÷ present ran
         1.3231 to 1.3458 across all 168 cells — the spread is 2-decimal
         rounding of bookings_per_driver, nothing else.

         That is not a defect introduced here; it is what the file's own
         header warns about, followed to its end. Each cell's "throughput" is
         measured from the same bookings the projection rescales, so it
         divides straight back out and no per-hour productivity survives. The
         old avg(bookings/drivers) hid this behind the gap between a mean of
         ratios and a ratio of means — variation that came from unequal
         turnout across occurrences, not from any hour being better worked.
         The honest consequence is stated on the page rather than papered
         over: at this grain the grid ranks hours by the headcount they
         already carry, and min_need_ratio below is that same constant. */
      const needDrivers = perDriver && expectedPerOccurrence != null
        ? expectedPerOccurrence / perDriver : null;
      return {
        dow: c.dow, hour: c.hour,
        observed_bookings: c.bookings,
        occurrences_observed: c.occurrences,
        bookings_per_occurrence: Number(c.bookings_per_occurrence),
        drivers_per_occurrence: haveDrivers,
        most_drivers_seen: c.most_drivers_seen,
        bookings_per_driver: perDriver,
        share_pct: +(share * 100).toFixed(2),
        expected_month: Math.round(expectedMonth),
        occurrences_next: occurrences,
        expected_per_occurrence: expectedPerOccurrence == null ? null : +expectedPerOccurrence.toFixed(1),
        drivers_needed: needDrivers == null ? null : +needDrivers.toFixed(1),
        driver_gap: needDrivers == null ? null : +(needDrivers - haveDrivers).toFixed(1),
        /* A cell seen only a handful of times has a share estimated from very
           little, and a rota built on it is built on noise. Flagged rather
           than dropped: an hour nobody has covered is exactly the hour worth
           looking at, and hiding it would defeat the purpose. */
        thin: c.occurrences < 4,
      };
    });

    const short = rows.filter((r) => r.driver_gap != null && r.driver_gap >= 0.5 && !r.thin)
      .sort((a, b) => b.driver_gap - a.driver_gap);
    const spare = rows.filter((r) => r.driver_gap != null && r.driver_gap <= -0.5 && !r.thin)
      .sort((a, b) => a.driver_gap - b.driver_gap);

    res.json({
      ok: true,
      /* Stated rather than implied. The page's subtitle promises next month and
         the endpoint used to answer about this one. */
      target_month: target.m,
      target_is_next_month: target.m > (fc.horizon_from || ''),
      platform: pl, fleet: fl,
      target_bookings: target.point,
      target_low: target.low,
      target_high: target.high,
      forecast_kind: target.kind,
      window_days: WINDOW_DAYS,
      observed_bookings: totalBookings,
      cells: rows,
      shortfall: short.slice(0, 20),
      /* 93 hours were short and 20 were listed, with nothing saying so. */
      shortfall_total: short.length,
      shortfall_shown: Math.min(20, short.length),
      shortfall_truncated: short.length > 20,
      surplus: spare.slice(0, 20),
      surplus_total: spare.length,
      surplus_shown: Math.min(20, spare.length),
      surplus_truncated: spare.length > 20,
      /* The whole-month arithmetic, so the cell-level numbers can be checked
         against something. */
      totals: {
        drivers_needed_peak: rows.length
          ? Math.max(...rows.map((r) => r.drivers_needed || 0)).toFixed(1) : null,
        /* The smallest ratio of drivers needed to drivers present, across
           every cell that has both.
           ───────────────────────────────────────────────────────────────
           drivers_needed is drivers_now × (projected demand ÷ measured
           demand), so when that ratio is above 1 everywhere, driver_gap
           cannot be negative in ANY cell and `cells_spare` is pinned at zero
           by arithmetic rather than by the rota. On production at 13:15 UTC
           on 2026-09-02 the smallest was 1.057 over all 168 cells — the
           October projection sits 39% above the 84-day rate the shares were
           measured at — and the page printed "Hours with people to spare: 0,
           covered beyond what the projection needs" beside a panel inviting
           the reader to move people out of hours that could not exist.
           Reported so the page can tell an empty result from an impossible
           one. */
        min_need_ratio: (() => {
          const r = rows.filter((x) => x.drivers_needed != null && x.drivers_per_occurrence > 0)
            .map((x) => x.drivers_needed / x.drivers_per_occurrence);
          return r.length ? +Math.min(...r).toFixed(3) : null;
        })(),
        cells_short: short.length,
        cells_spare: spare.length,
        cells_thin: rows.filter((r) => r.thin).length,
      },
      caveat: 'A driver’s throughput in an hour is a MEASUREMENT of what happened under whatever demand '
        + 'there was, not a capacity. A quiet hour makes its drivers look unproductive and a frantic one '
        + 'makes them look heroic, so "drivers needed" is the division — projected bookings divided by what '
        + 'this cell’s own drivers have actually delivered in it — and nothing more. '
        + (target.kind === 'extrapolation'
          ? 'The target month is an extrapolation rather than a forecast; treat the totals as a shape, not a plan.'
          : ''),
    });
  }));
}
