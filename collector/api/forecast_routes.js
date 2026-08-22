/* What next month looks like, and what to do about it.
   ──────────────────────────────────────────────────────────────────────────
   Two endpoints that answer the two questions an operations team actually
   asks on the first of the month: how much work is coming, and what should we
   do this week to get more of it.

   The honesty problem specific to this fleet, which shapes everything below:
   THE UBER TRIP EXPORT CARRIES NO FARE. Not a null column — no column. 13,911
   Uber bookings in the last sixty days, none of them priced. So a figure in
   AED can only ever describe the hotel, Bolt and Yango rows, and the entire
   Uber side of the business has to be expressed in trips and kilometres.

   Anything that converts Uber trips into money is an assumption wearing a
   number's clothes. The playbook therefore takes an explicit `aed_per_trip`
   and reports modelled money ONLY when the caller supplies one — never
   silently, never mixed into a measured total, and always beside the
   assumption that produced it. */

import { forecastMonths, weekdayShares, forecastDays, regimeWindow } from '../src/forecast.js';

export function forecastRoutes(app, { q, wrap, DAYWIN }) {
  /* ── the forecast ─────────────────────────────────────────────────────── */
  app.get('/api/forecast', wrap(async (req, res) => {
    const horizon = Math.min(24, Math.max(1, Number(req.query.horizon) || 12));

    /* Whole Dubai-local months of BOOKINGS. Telematics journeys are the same
       physical trips seen by the tracker; forecasting the sum of both predicts
       a quantity that does not exist. */
    const months = await q(
      `SELECT to_char(local_month,'YYYY-MM') AS m,
              count(*) FILTER (WHERE is_booking)::int trips,
              count(DISTINCT driver_ext_id) FILTER (WHERE is_booking)::int drivers,
              count(DISTINCT plate) FILTER (WHERE is_booking)::int vehicles,
              round(sum(price) FILTER (WHERE has_fare)::numeric,0) revenue,
              count(*) FILTER (WHERE has_fare)::int priced_trips,
              min(local_day) AS first_day, max(local_day) AS last_day
       FROM trip_norm
       WHERE ($1::text IS NULL OR platform = $1)
       GROUP BY 1 ORDER BY 1`, [req.query.platform || null]);

    if (!months.length) {
      return res.json({ ok: false, reason: 'No booking has ever been collected.', months: [] });
    }

    /* Mark the months the record only partly covers. They are short by
       construction — collection starts and stops mid-month — and fitting one
       as though it were whole drags the whole line toward zero. */
    const [{ a: spanFrom, b: spanTo } = {}] = await q(
      `SELECT to_char(min(local_day),'YYYY-MM-DD') a, to_char(max(local_day),'YYYY-MM-DD') b
       FROM trip_norm WHERE is_booking AND ($1::text IS NULL OR platform = $1)`,
      [req.query.platform || null]);
    const lastOf = (ym) => {
      const [y, mo] = ym.split('-').map(Number);
      return `${ym}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, '0')}`;
    };
    for (const m of months) {
      m.partial_month = (spanFrom && spanFrom > `${m.m}-01`) || (spanTo && spanTo < lastOf(m.m));
      m.no_data = !m.trips;
    }

    const fc = forecastMonths(months, { horizon });

    /* ── the month in progress, as a live check on the forecast ──────────
       The current month is partial and therefore not fitted — but its run rate
       is the only out-of-sample evidence available, and a forecast nobody ever
       checks is a decoration. Reported as what it is: a projection of the days
       so far onto the whole month, which assumes the rest of the month
       resembles it. */
    const current = months[months.length - 1];
    let inProgress = null;
    if (current?.partial_month && current.trips > 0 && spanTo) {
      const daysSoFar = Number(spanTo.slice(8, 10));
      const daysTotal = Number(lastOf(current.m).slice(8, 10));
      const runRate = current.trips / daysSoFar;
      const projected = Math.round(runRate * daysTotal);
      const fcRow = (fc.forecast || []).find((r) => r.m === current.m);
      inProgress = {
        m: current.m, days_so_far: daysSoFar, days_total: daysTotal,
        trips_so_far: current.trips,
        per_day: +runRate.toFixed(1),
        projected,
        forecast: fcRow ? fcRow.point : null,
        low: fcRow ? fcRow.low : null,
        high: fcRow ? fcRow.high : null,
        // Did the forecast contain what the month is actually doing?
        within_interval: fcRow && fcRow.low != null
          ? projected >= fcRow.low && projected <= fcRow.high : null,
      };
    }

    /* ── the shape of a month, measured over recent complete weeks ──────── */
    const days = await q(
      `SELECT to_char(local_day,'YYYY-MM-DD') AS day, count(*)::int trips
       FROM trip_norm
       WHERE is_booking AND ($1::text IS NULL OR platform = $1)
         AND local_day > (SELECT max(local_day) FROM trip_norm WHERE is_booking) - 70
       GROUP BY 1 ORDER BY 1`, [req.query.platform || null]);
    /* Drop the trailing partial week: the record stops mid-week, so the last
       few days are complete days but an incomplete cycle, and averaging them
       in tilts every weekday share toward whichever days happened to fall at
       the end. */
    const shares = weekdayShares(days.slice(0, Math.floor(days.length / 7) * 7));

    const next = (fc.forecast || [])[0];
    const daily = next && shares ? forecastDays(next.m, next.point, shares) : [];

    res.json({
      ...fc,
      observed: months,
      in_progress: inProgress,
      weekday_shares: shares,
      next_month: next ? next.m : null,
      daily,
      /* The year, as the sum of what is forecast — labelled, because most of
         it is extrapolation and adding twelve extrapolations does not make a
         budget. */
      year_ahead: (fc.forecast || []).length >= 12 ? {
        total: (fc.forecast || []).slice(0, 12).reduce((a, r) => a + r.point, 0),
        low: (fc.forecast || []).slice(0, 12).reduce((a, r) => a + (r.low ?? r.point), 0),
        high: (fc.forecast || []).slice(0, 12).reduce((a, r) => a + (r.high ?? r.point), 0),
        forecast_months: (fc.forecast || []).slice(0, 12).filter((r) => r.kind === 'forecast').length,
      } : null,
      /* Money, only where money exists. */
      revenue_note: 'The Uber trip export carries no fare column at all, so every AED figure in this '
        + 'product describes the hotel, Bolt and Yango rows only. A booking forecast is in bookings.',
    });
  }));
}
