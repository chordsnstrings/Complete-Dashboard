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
import { yearOnYear, seasonalForecast, scoreModels, tourismFit, decompose,
  sameDaysYearAgo, lastYear } from '../src/seasonal.js';
import { VISITORS, NOT_PUBLISHED, AGGREGATES, CHECKS, reconcile, CONTEXT,
  CALENDAR, CALENDAR_SOURCE, CALENDAR_DISAGREEMENTS } from '../src/dubai_tourism.js';
import { peopleCount } from './custody_sql.js';
import { rollupGrainSql } from '../src/rollup.js';
import { dubaiIso } from '../src/util.js';

export function forecastRoutes(app, { q, wrap, DAYWIN }) {
  /* ── the forecast ─────────────────────────────────────────────────────── */
  app.get('/api/forecast', wrap(async (req, res) => {
    const horizon = Math.min(24, Math.max(1, Number(req.query.horizon) || 12));
    /* The fleet chip was written into the address and honoured by nothing:
       every query below pinned fleet_id = '*', so /api/forecast&fleet=egari
       was byte-identical to unfiltered on a two-fleet operator. The rollup
       carries a row per fleet at each grain (src/rollup.js GROUPING SETS), so
       narrowing is a bind rather than a new aggregation. */
    const pl = req.query.platform || null;
    const fl = req.query.fleet || null;

    /* Whole Dubai-local months of BOOKINGS. Telematics journeys are the same
       physical trips seen by the tracker; forecasting the sum of both predicts
       a quantity that does not exist. */
    /* From rollup_month. This grouped every trip ever collected, with no
       window to narrow it and no index that could help, and cost 12.4 seconds
       on every load — identically for every viewer, because the answer does
       not depend on anything in the request. src/rollup.js computes it when
       the collector writes, which is the only time it changes.

       Falls back to computing the grain from the same SQL the rollup is built
       from, so a fresh database or a failed rollup is slow rather than empty,
       and the fast path and the slow path cannot become different answers. */
    const monthShape = `to_char(month,'YYYY-MM') AS m, bookings AS trips, drivers,
              earning_vehicles AS vehicles, round(revenue,0) AS revenue, priced_trips`;
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

    if (!months.length) {
      /* Name the filter that caused the refusal. #forecast?platform=bolt
         rendered "No booking has ever been collected." over the whole product,
         about a channel Ecosine is refused on (COMPANIES_NOT_ALLOWED) and
         whose Egari token expired — a sentence that reads as "this business
         has no data" when it means "this one channel does not". */
      const who = [pl && `${pl} `, fl && `${fl}'s `].filter(Boolean).join('');
      return res.json({
        ok: false,
        reason: pl || fl
          ? `No ${who}booking has ever been collected. See Data sources for what each `
            + 'channel last reported.'
          : 'No booking has ever been collected.',
        filtered: !!(pl || fl), platform: pl, fleet: fl, months: [],
      });
    }

    /* Mark the months the record only partly covers. They are short by
       construction — collection starts and stops mid-month — and fitting one
       as though it were whole drags the whole line toward zero. */
    /* From rollup_day — a few thousand rows — rather than a min/max over every
       trip. `is_booking` is a computed predicate, so the index on local_day
       cannot serve the original and it scanned the table. */
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

    const fc = forecastMonths(months, { horizon });

    /* ── the channel mix per month, which decides what may be compared ───
       A year-on-year comparison is only a comparison when both months are the
       same business. This record starts in a different month for every
       channel — Uber 2025-04, Yango 2025-09, the hotel channel 2026-07 — so
       January 2026 against January 2025 is Uber + Bolt + Yango against BOLT
       ALONE, and reports +481% growth that is a fact about when we started
       collecting Uber. src/seasonal.js decides comparability from this mix and
       names the channel in its refusal; without it, it says so instead of
       assuming the months match. Same rollup, one extra grain. */
    const mixShape = `to_char(month,'YYYY-MM') AS m, platform, bookings`;
    let mixRows = await q(
      `SELECT ${mixShape} FROM rollup_month
       WHERE platform <> '*' AND fleet_id = coalesce($2,'*') AND bookings > 0
         AND ($1::text IS NULL OR platform = $1)
       ORDER BY month`, [pl, fl]);
    if (!mixRows.length) {
      mixRows = await q(
        `SELECT ${mixShape} FROM (${rollupGrainSql('month')}) g
         WHERE platform <> '*' AND fleet_id = coalesce($2,'*') AND bookings > 0
           AND ($1::text IS NULL OR platform = $1)
         ORDER BY month`, [pl, fl]);
    }
    /* Null rather than an empty Map when the grain is genuinely unavailable.
       An empty Map reads as "every month carried no channels", which would
       make every pair incomparable for a reason that is not the true one; null
       makes seasonal.js report the check as not performed. */
    const byPlatform = mixRows.length
      ? mixRows.reduce((acc, r) => {
        if (!acc.has(r.m)) acc.set(r.m, new Map());
        acc.get(r.m).set(r.platform, Number(r.bookings) || 0);
        return acc;
      }, new Map())
      : null;

    /* ── the month in progress, as a live check on the forecast ──────────
       The current month is partial and therefore not fitted — but its run rate
       is the only out-of-sample evidence available, and a forecast nobody ever
       checks is a decoration. Reported as what it is: a projection of the days
       so far onto the whole month, which assumes the rest of the month
       resembles it. */
    const current = months[months.length - 1];

    /* ── the shape of a month, measured over recent complete weeks ──────── */
    /* Moved ahead of the in-progress check below, which now needs the day
       grain to find the last WHOLE day rather than trusting the last day that
       has any booking on it at all. */
    // From rollup_day, same reasoning as the months above.
    const dayShape = `to_char(day,'YYYY-MM-DD') AS day, bookings AS trips`;
    let days = await q(
      `SELECT ${dayShape} FROM rollup_day
       WHERE platform = coalesce($1,'*') AND fleet_id = coalesce($2,'*')
         AND day > (SELECT max(day) FROM rollup_day WHERE platform = '*' AND fleet_id = '*') - 70
       ORDER BY day`, [pl, fl]);
    if (!days.length) {
      days = await q(
        `SELECT ${dayShape} FROM (${rollupGrainSql('day')}) g
         WHERE platform = coalesce($1,'*') AND fleet_id = coalesce($2,'*')
           AND day > (SELECT max(local_day) FROM trip_norm WHERE is_booking) - 70
         ORDER BY day`, [pl, fl]);
    }

    /* THE RUN RATE WAS DIVIDING BY A DAY THAT WAS STILL BEING COLLECTED.
       ──────────────────────────────────────────────────────────────────────
       `spanTo` is the latest day carrying any booking, so on 2026-09-22 it was
       the 22nd and the projection divided September's 16,166 bookings by 22
       days. The 22nd held 71 bookings — the collector had run once that
       morning — against a trailing norm near 766. So the denominator was a day
       too long and the numerator three quarters of a day short, and production
       published 734.8/day and "on track for 22,045" where the whole days alone
       give 766.4/day and 22,992.

       An 8-lower projection sounds harmless and is not: this figure is the
       page's only out-of-sample score of its own forecast, so an understated
       run rate makes a forecast that is too low look better than it is.

       The last whole day is the last day that is not today in Dubai. Today is
       the only day collection can still be part-way through — the incremental
       pass runs every thirty minutes over a three-day window, so yesterday is
       settled — and naming the rule that way keeps it a statement about
       collection rather than a threshold somebody tuned. */
    const todayDubai = dubaiIso();
    const monthDays = days.filter((d) => d.day.slice(0, 7) === current?.m);
    const wholeDays = monthDays.filter((d) => d.day < todayDubai);
    const lastWhole = wholeDays.length ? wholeDays[wholeDays.length - 1].day : null;

    let inProgress = null;
    if (current?.partial_month && current.trips > 0 && spanTo) {
      /* Fall back to the old behaviour rather than refusing when the day grain
         is unavailable — and say which one was used, because the two differ
         and a reader is entitled to know which number they are looking at. */
      const wholeTrips = wholeDays.reduce((a, d) => a + (Number(d.trips) || 0), 0);
      const haveWhole = !!lastWhole && wholeTrips > 0;
      const daysSoFar = haveWhole ? Number(lastWhole.slice(8, 10)) : Number(spanTo.slice(8, 10));
      const tripsSoFar = haveWhole ? wholeTrips : current.trips;
      const daysTotal = Number(lastOf(current.m).slice(8, 10));
      const runRate = tripsSoFar / daysSoFar;
      const projected = Math.round(runRate * daysTotal);
      /* The month in progress is no longer in the horizon — the horizon starts
         at the first month that has NOT started — so its prediction comes from
         the field that exists for exactly this check. */
      const fcRow = (fc.current_month?.m === current.m ? fc.current_month : null)
        || (fc.forecast || []).find((r) => r.m === current.m);
      inProgress = {
        m: current.m, days_so_far: daysSoFar, days_total: daysTotal,
        trips_so_far: tripsSoFar,
        /* The whole month's bookings including the day still being collected,
           kept beside the figure the rate is built from so the two are not
           confused and the difference is visible. */
        trips_including_today: current.trips,
        last_whole_day: haveWhole ? lastWhole : null,
        basis: haveWhole
          ? 'whole days only — today is still being collected and is excluded'
          : 'every day carrying a booking, including the one still being collected, because the '
            + 'day-by-day grain was not available',
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
    /* Drop the trailing partial week: the record stops mid-week, so the last
       few days are complete days but an incomplete cycle, and averaging them
       in tilts every weekday share toward whichever days happened to fall at
       the end. */
    const shares = weekdayShares(days.slice(0, Math.floor(days.length / 7) * 7));

    const next = (fc.forecast || [])[0];
    const daily = next && shares ? forecastDays(next.m, next.point, shares) : [];

    /* ── the same days, a year earlier ──────────────────────────────────── */
    /* The run rate above assumes the rest of the month resembles the part
       collected. September in Dubai does not: demand climbs all the way
       through it, so a flat run rate understates a month that is still
       ramping. The same days of the same month a year earlier carry that
       within-month shape, so the comparison is like with like and the month
       can be completed on last year's profile instead of on a straight line
       through it. Measured 2026-09-22: 16,095 bookings over the first 21 whole
       days against 19,867 over the same 21 days of September 2025, which were
       67.1% of that month — so September 2026 completes near 23,975 where the
       flat rate says 22,992 and the fitted line says 14,700.

       Still a check and not a better forecast: it assumes the shape repeats. */
    let sameDays = null;
    if (current?.partial_month && lastWhole) {
      const lyM = lastYear(current.m);
      const lyDays = await q(
        `SELECT ${dayShape} FROM rollup_day
         WHERE platform = coalesce($1,'*') AND fleet_id = coalesce($2,'*')
           AND day >= $3::date AND day <= $4::date
         ORDER BY day`, [pl, fl, `${lyM}-01`, lastOf(lyM)]);
      sameDays = sameDaysYearAgo(monthDays, lyDays, { lastWholeDay: lastWhole });
      if (sameDays) sameDays.ly_m = lyM;
    }

    /* ── month against the same month a year earlier ────────────────────── */
    const yoy = yearOnYear(months, { byPlatform });
    const yoyRows = yoy.map((r) => ({ ...r, split: decompose(r) }));
    /* The break the straight line refuses to fit across, reused here so the
       two models agree about where the current regime starts rather than each
       carrying its own idea of it. */
    const regimeFrom = (fc.months_used || [])[0] || null;
    const seasonal = seasonalForecast(months, { horizon, byPlatform, regimeFrom });
    /* Every method, scored one step ahead on the months that can be scored,
       using only the months before each target. It is expected to be an
       uncomfortable table and it is published whichever way it falls: on the
       live series the straight line wins the two scorable months, both of
       which sit inside the recovery where a lagged year-on-year ratio is
       biased low by construction. September — the one month in this record
       with a large seasonal step — is the reverse, and two scored months
       cannot settle that. The page says so rather than picking a winner it
       cannot demonstrate. */
    const scores = scoreModels(months, { byPlatform, regimeFrom });

    /* ── Dubai's visitor numbers, as a regressor with its fit stated ────── */
    const tourism = tourismFit(months, VISITORS, { byPlatform });
    const tourismSeries = months
      .filter((m) => !m.no_data)
      .map((m) => ({
        m: m.m,
        visitors: VISITORS.get(m.m)?.visitors ?? null,
        source: VISITORS.get(m.m)?.source ?? null,
        basis: VISITORS.get(m.m)?.basis ?? null,
        /* Absent WITH THE REASON, never as a zero and never as a twelfth of an
           annual figure. The six months of 2026 that Dubai published only
           inside a year-to-date total are the whole point of this field. */
        reason: VISITORS.get(m.m) ? null : (NOT_PUBLISHED.get(m.m)?.reason
          ?? 'No published Dubai visitor figure has been recorded for this month.'),
        trips: m.trips,
        vehicles: m.vehicles,
        per_vehicle: m.vehicles ? +(m.trips / m.vehicles).toFixed(1) : null,
        partial_month: !!m.partial_month,
      }));

    res.json({
      ...fc,
      observed: months,
      in_progress: inProgress,
      same_days_year_ago: sameDays,
      /* Every observed month against the same month a year earlier, carrying
         both sides of the three figures the operator asked to see side by
         side — bookings, active vehicles, and bookings per active vehicle —
         plus the channel-mix verdict that says whether the pair is a
         comparison at all. */
      yoy: yoyRows,
      seasonal,
      model_scores: scores,
      tourism: {
        ...tourism,
        series: tourismSeries,
        /* The aggregates Dubai published as aggregates, kept as aggregates.
           A monthly regressor invented by dividing one of these by the months
           it covers is exactly the "reason that is not the true one" this
           product exists to refuse. */
        aggregates: AGGREGATES,
        /* The list is hand-transcribed, so it is checked against figures the
           same authority published separately. Served beside the fit so a
           reader can see the table reconciles rather than taking it on
           trust — the same reasoning as serving the shape of the data next to
           a headline. */
        reconciliation: reconcile(),
        checks: CHECKS.map((c) => c.label),
        context: CONTEXT,
        note: 'International overnight visitors, published by Dubai’s Department of Economy and '
          + 'Tourism. Nothing in this system can reach that authority — there is no feed and no '
          + 'credential — so the series is transcribed by hand and reconciled against three totals '
          + 'the department published separately. Months it has not published individually are '
          + 'absent with that as the reason, never estimated.',
      },
      /* Named by a language model, and labelled as such everywhere it is
         shown. It annotates months; it never multiplies a number. */
      calendar: {
        ...CALENDAR_SOURCE,
        months: [...CALENDAR.entries()].map(([m, v]) => ({ m, ...v,
          disagrees_with_measurement: CALENDAR_DISAGREEMENTS.includes(m) })),
      },
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
      /* Money, only where money exists — and where it exists has moved.
         This read "every AED figure in this product describes the hotel, Bolt
         and Yango rows only", which was true of the trip export and is no
         longer true of the record: Uber's payments report prices its rides and
         the collector walks it a week at a time. What stays true is that the
         coverage is partial while that walk is behind, so the note reports the
         state rather than asserting a permanent absence. */
      revenue_note: 'The Uber trip export carries no fare column; Uber\'s fares come from its separate '
        + 'payments report, which is collected a week at a time, so an AED figure here covers the hotel, '
        + 'Bolt and Yango rows in full and the Uber rows only as far back as that walk has reached. '
        + 'A booking forecast is in bookings and is unaffected.',
    });
  }));
}
