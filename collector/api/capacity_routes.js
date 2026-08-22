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

export function capacityRoutes(app, { q, wrap }) {
  app.get('/api/capacity', wrap(async (req, res) => {
    /* ── how much work is coming ──────────────────────────────────────── */
    const months = await q(
      `SELECT to_char(local_month,'YYYY-MM') AS m,
              count(*) FILTER (WHERE is_booking)::int trips,
              min(local_day) AS first_day, max(local_day) AS last_day
       FROM trip_norm GROUP BY 1 ORDER BY 1`);
    if (!months.length) return res.json({ ok: false, reason: 'No booking has been collected.' });

    const [{ a: spanFrom, b: spanTo } = {}] = await q(
      `SELECT to_char(min(local_day),'YYYY-MM-DD') a, to_char(max(local_day),'YYYY-MM-DD') b
       FROM trip_norm WHERE is_booking`);
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

    const target = fc.forecast[0];

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
         GROUP BY 1,2,3)
       SELECT dow, slot_hour AS hour,
              sum(bookings)::int bookings,
              count(*)::int occurrences,
              round(avg(bookings)::numeric, 2) AS bookings_per_occurrence,
              round(avg(drivers)::numeric, 2) AS drivers_per_occurrence,
              max(drivers)::int AS most_drivers_seen,
              round(avg(bookings::numeric / nullif(drivers, 0)), 2) AS bookings_per_driver
        FROM c GROUP BY 1,2 ORDER BY 1,2`, [WINDOW_DAYS]);

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
    // Weight of each cell in a month, given how often its weekday occurs.
    const weightOf = (c) => (c.bookings / totalBookings) * 1;
    const totalWeighted = cells.reduce((a, c) => a + weightOf(c), 0);

    const rows = cells.map((c) => {
      const share = weightOf(c) / totalWeighted;
      const expectedMonth = target.point * share;
      const occurrences = dowCount[c.dow] || 0;
      const expectedPerOccurrence = occurrences ? expectedMonth / occurrences : null;
      const perDriver = Number(c.bookings_per_driver) || null;
      const haveDrivers = Number(c.drivers_per_occurrence) || 0;
      /* At the rate this cell's own drivers have actually worked it, how many
         would serve the projected demand. Not a capacity claim — a division. */
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
      target_month: target.m,
      target_bookings: target.point,
      target_low: target.low,
      target_high: target.high,
      forecast_kind: target.kind,
      window_days: WINDOW_DAYS,
      observed_bookings: totalBookings,
      cells: rows,
      shortfall: short.slice(0, 20),
      surplus: spare.slice(0, 20),
      /* The whole-month arithmetic, so the cell-level numbers can be checked
         against something. */
      totals: {
        drivers_needed_peak: rows.length
          ? Math.max(...rows.map((r) => r.drivers_needed || 0)).toFixed(1) : null,
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
