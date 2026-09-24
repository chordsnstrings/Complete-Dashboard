/* What next month looks like, and how much of that is a guess.
   ──────────────────────────────────────────────────────────────────────────
   A forecast is the easiest thing in this product to render dishonestly: a
   line, a number, and nothing that says how much scatter it was drawn through.
   Four things keep it honest here.

   The INTERVAL is drawn, not mentioned. A point estimate on five months of a
   recovering series is a number with a range around it wide enough to change
   what you would do, and hiding the range is the whole failure mode.

   The MONTHS IT REFUSED TO FIT are named. This fleet's bookings ran at 24,000
   a month until February and 4,203 in March; a line through that break
   predicts a recovery to 20,000 that nothing supports. The page says which
   months were excluded and why, so the choice can be argued with.

   The FORECAST CHECKS ITSELF against the month in progress, which is the only
   out-of-sample evidence there is. A forecast nobody ever scores is a
   decoration.

   And — new, and the reason most of this file changed — THE COMPARISON IS
   WITH THE SAME MONTH A YEAR EARLIER, NEVER WITH LAST MONTH. Measured on
   production 2026-09-22:

     September 2026, forecast by the straight line   14,700 (11,100–18,300)
     September 2026, first 21 whole days             16,095
     the same 21 days of September 2025              19,867
     September 2026 completing on last year's shape  ~23,975

   The line was 39% low on the month it was predicting, and the month was
   outside the interval the page had published for it. Not scatter: August to
   September is the sharpest seasonal step in Dubai's year, and a line fitted
   to March..August has no term that can express it.

   TWO MODELS ARE SHOWN AND NEITHER IS DECLARED THE WINNER, because the
   evidence does not support declaring one. The scoreboard panel below is the
   reason, and it is printed whichever way it falls — on the live series the
   straight line wins both months that can be scored. The page says that in as
   many words rather than quietly dropping the number that embarrasses the new
   model.

   AND A FLEET THAT SHRANK IS NOT A FLEET THAT GOT QUIETER. Bookings are
   active vehicles times the work each one does, exactly, and those two moved
   in opposite directions here: at August 2026 the fleet was at 86% of its
   year-ago size and each vehicle was doing 15% MORE. A page that shows only
   the total reports "flat" about that. Every year-on-year row carries both
   halves and says which one moved the number. */

import { empty, fmt, barChart, scatter, drawnAs, gapBars } from './charts.js';
import { el, esc, panel, loading, tableFrom, kpiRow, note, pill, dayStr, dateStr,
  countOf, plural, sourceLabel, signed, verdict } from './ui.js';
import { q, href, hrefFilter, state } from './data.js';
import { contract, glance, glanceBand, bandTiles, absenceBand, pageFoot } from './ui.js';

const MONTH = (m) => {
  const [y, mm] = String(m).slice(0, 7).split('-');
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+mm - 1]} ${y.slice(2)}`;
};
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/* The month's full name, for prose. The abbreviation is right in a table and
   wrong in a sentence: "the regime has never contained a Oct" is what the
   three-letter form produces, article and all. */
const MONTH_NAME = (m) => ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'][+String(m).slice(5, 7) - 1];
/* A ratio reads better as the percentage move it is. 0.985 is "down 1.5%",
   and a reader asked to do that arithmetic twelve times will do one of them
   wrong. */
const movePct = (r) => (r == null ? null : Math.round((r - 1) * 1000) / 10);
const moveStr = (r) => (r == null ? '—' : signed(movePct(r), { unit: '%', d: 1 }));
const DIRECTION = { up: 'busier than a neutral month', down: 'quieter than a neutral month',
  mixed: 'pulled both ways', neutral: 'about normal' };

export async function renderForecast(root) {
  root.innerHTML = '';
  loading(root);
  const d = await q('/api/forecast', { horizon: 12 });
  root.innerHTML = '';

  if (!d.ok) {
    /* Name the filter that produced the refusal. `#forecast?platform=bolt`
       rendered "No booking has ever been collected." — a claim about the whole
       fleet, on a page describing one channel. The address is hidden on this
       view, so the reader has no way to see that a filter is even set. */
    const box = el('div', 'empty');
    box.innerHTML = `<b>Not enough to forecast from</b>${
      state.platform
        ? `${esc(sourceLabel(state.platform))}: ${esc(d.reason || 'nothing to fit a line through.')} `
          + 'That is a statement about this channel, not about the fleet.'
        : esc(d.reason || '')}`;
    root.append(box);
    if (state.platform) {
      const links = el('p', 'cap');
      links.innerHTML = `<a class="lnk" href="${hrefFilter('forecast', { platform: '' })}">Forecast the whole fleet</a>`
        + ` · <a class="lnk" href="${href('sources')}">why this channel has no bookings</a>`;
      root.append(links);
    }
    if (d.months_used?.length) {
      root.append(note(`Months that would have been used: ${d.months_used.map(MONTH).join(', ')}.`));
    }
    return;
  }

  /* Under the page contract (plan §4 forecast): the verdict and a 00 band
     whose hero is the RANGE for next month — both methods, low to high — not
     a point; the month so far against its forecast, the fit, the months
     fitted; 01 the year ahead with every forecast month hatched and the
     other method as a line; the rest of the page unchanged; a † band. */
  const ak = contract();
  const AKB = ak ? glanceBand(root, `next: ${MONTH(d.next_month || d.forecast[0].m)}`) : null;
  const next = d.forecast[0];
  const ip = d.in_progress;
  const sdy = d.same_days_year_ago;
  const seas = d.seasonal && d.seasonal.ok ? d.seasonal : null;
  const sNext = seas ? seas.forecast.find((r) => r.m === next.m && r.point != null) : null;
  const yoy = Array.isArray(d.yoy) ? d.yoy : [];
  const comparable = yoy.filter((r) => r.comparable !== 'no' && !r.partial && r.ratio != null);
  const latest = comparable[comparable.length - 1] || null;

  /* ── the headline ──────────────────────────────────────────────────────
     Fields verified against /api/forecast on production: slope_per_month, r2,
     typical_error, n, months_used, beats_flat, flat_baseline, and now
     seasonal.*, model_scores.*, yoy[].

     The headline is not the number — it is how much of one it is. And where
     the two methods disagree by more than either of their intervals, THAT is
     the honest headline, because a reader given one of the two and not told
     about the other is being told the disagreement does not exist. */
  {
    const r2 = +d.r2 || 0;
    const err = +d.typical_error || 0;
    const weak = r2 < 0.5 || d.n < 4 || d.beats_flat === false;
    /* Do the two methods actually disagree, or do their ranges overlap? Only
       a real separation earns the alarming headline. */
    const split = sNext && sNext.low != null && next.low != null
      && (sNext.low > next.high || sNext.high < next.low);
    const lo = sNext ? Math.min(sNext.point, next.point) : next.point;
    const hi = sNext ? Math.max(sNext.point, next.point) : next.point;

    if (split) {
      verdict(ak ? AKB.vHost : root, {
        claim: `${MONTH(next.m)} is somewhere between ${fmt(lo)} and ${fmt(hi)} bookings, `
          + 'depending on which method you believe',
        figure: `${fmt(Math.round((hi - lo) / Math.max(1, lo) * 100))}%`,
        unit: 'apart, and the ranges do not overlap',
        tone: 'warn',
        meta: 'two methods, neither proven',
        sub: `The straight line through the ${d.n} months since the break says ${fmt(next.point)}. `
          + `The same month a year earlier, scaled by how this fleet has been running against its own `
          + `year-ago months, says ${fmt(sNext.point)}. They disagree because the line has no seasonal `
          + 'term and the regime it is fitted to has never contained '
          + `${/^[AO]/.test(MONTH_NAME(next.m)) ? 'an' : 'a'} ${MONTH_NAME(next.m)}. `
          + (sdy
            ? `The month in progress is the only evidence between them: it is running at `
              + `${moveStr(sdy.ratio)} against the same days last year, which is `
              + `${fmt(sdy.projected)} for the month.`
            : ''),
        recommend: 'Roster to the lower figure and hold capacity you can call on, rather than '
          + 'committing to either point.',
      });
    } else {
      verdict(ak ? AKB.vHost : root, {
        claim: weak && !sNext
          ? `${MONTH(next.m)} is a guess, not a forecast`
          : `${MONTH(next.m)} lands near ${fmt(sNext ? sNext.point : next.point)} bookings`,
        figure: (sNext || next).low != null
          ? `±${fmt(Math.round(((sNext || next).high - (sNext || next).low) / 2))}`
          : fmt((sNext || next).point),
        unit: (sNext || next).low != null ? 'bookings either way' : 'bookings',
        tone: weak ? 'warn' : null,
        meta: sNext ? `against ${MONTH(sNext.base_m)}` : `fitted to ${d.n} ${plural(d.n, 'month')}`,
        sub: sNext
          ? `Built on ${MONTH(sNext.base_m)}'s ${fmt(sNext.base)} bookings, scaled by the `
            + `${moveStr(seas.ratio)} this fleet has run against its own year-ago months over the `
            + `last ${countOf(seas.k, 'comparable month')}. The straight line says `
            + `${fmt(next.point)} for the same month.`
          : `The fit explains ${Math.round(r2 * 100)}% of the movement and is typically `
            + `${fmt(err)} bookings out.`
            + (d.beats_flat === false
              ? ' It does not beat simply assuming next month looks like last month.' : '')
            + (d.months_excluded?.length
              ? ` ${countOf(d.months_excluded.length, 'month')} excluded as being before the last break.`
              : ''),
        recommend: weak
          ? 'Read the range, not the point — and treat the rota built on it as provisional.'
          : null,
      });
    }
  }

  /* ── the four figures the operator asked to see side by side ─────────── */
  const FC_TILES = [
    { label: `Bookings in ${MONTH(next.m)}`, value: fmt((sNext || next).point),
      sub: (sNext || next).low != null
        ? `somewhere between ${fmt((sNext || next).low)} and ${fmt((sNext || next).high)}`
        : 'no interval available',
      tone: null },
    /* Against the same month a year earlier, never against last month. */
    latest ? { label: `${MONTH(latest.m)} against ${MONTH(latest.ly_m)}`,
      value: moveStr(latest.ratio),
      sub: `${fmt(latest.trips)} bookings against ${fmt(latest.ly_trips)}`,
      tone: latest.ratio >= 1 ? 'good' : latest.ratio >= 0.85 ? null : 'warn' } : null,
    /* The two halves, on their own tiles, because the whole point is that they
       moved in opposite directions and one tile cannot say that. */
    latest && latest.vehicle_ratio != null
      ? { label: 'Active vehicles, then and now', value: fmt(latest.vehicles),
        sub: `${fmt(latest.ly_vehicles)} a year ago · ${moveStr(latest.vehicle_ratio)}`,
        tone: latest.vehicle_ratio >= 1 ? 'good' : 'warn' } : null,
    latest && latest.intensity_ratio != null
      ? { label: 'Bookings per active vehicle', value: fmt(latest.per_vehicle, 1),
        sub: `${fmt(latest.ly_per_vehicle, 1)} a year ago · ${moveStr(latest.intensity_ratio)}`,
        tone: latest.intensity_ratio >= 1 ? 'good' : 'warn' } : null,
    { label: 'How well the line fits', value: d.r2 == null ? '—' : d.r2.toFixed(2),
      sub: `typical month sits ${fmt(d.typical_error)} bookings off it`,
      tone: d.r2 == null ? null : d.r2 >= 0.8 ? 'good' : d.r2 >= 0.5 ? 'warn' : 'critical' },
    /* The range, on the tile. A point estimate shown alone is the failure mode
       this page's own header names, and the twelve-month figure was the one
       number on it printed without its interval — 223,400 with nothing to say
       it sits in 126,200 to 320,500. */
    d.year_ahead ? { label: 'Next twelve months, straight line', value: fmt(d.year_ahead.total),
      sub: (d.year_ahead.low != null
        ? `somewhere between ${fmt(d.year_ahead.low)} and ${fmt(d.year_ahead.high)} · ` : '')
        + `${d.year_ahead.forecast_months} forecast, ${12 - d.year_ahead.forecast_months} extrapolated`,
      tone: 'warn' } : null,
  ];
  if (ak) forecastGlance(AKB, FC_TILES, { d, next, sNext, ip });
  else root.append(kpiRow(FC_TILES));

  if (!d.beats_flat) {
    root.append(el('div', 'note err',
      `The fitted line explains less than half the month-to-month variation (r² ${d.r2}). On this evidence `
      + `"next month looks like the last three" — ${fmt(d.flat_baseline)} bookings — is as good a plan as the `
      + 'trend, and a good deal easier to defend. The trend is still drawn, because it may be real and simply '
      + 'not yet demonstrable on this many months.'));
  }

  /* ── the forecast checking itself ──────────────────────────────────────── */
  if (ip) {
    const { panel: p, body } = panel(`${MONTH(ip.m)} so far, against what was forecast`,
      'The month in progress is the only out-of-sample evidence there is. A forecast nobody ever scores is a decoration.',
      'fc-inprogress');
    root.append(p);
    body.append(kpiRow([
      { label: 'Bookings so far', value: fmt(ip.trips_so_far),
        sub: `over ${ip.days_so_far} whole ${plural(ip.days_so_far, 'day')} of ${ip.days_total}` },
      { label: 'Running at', value: `${fmt(ip.per_day, 1)}/day`, sub: 'across the whole days collected' },
      { label: 'On track for', value: fmt(ip.projected),
        sub: 'if the rest of the month resembles it' },
      /* The same days a year ago, which carry the WITHIN-month shape a flat
         run rate throws away. On a month that climbs all the way through —
         which September in Dubai does — the flat rate is the low answer. */
      sdy ? { label: `Against the same ${sdy.through_day} days of ${MONTH(sdy.ly_m)}`,
        value: moveStr(sdy.ratio),
        sub: `${fmt(sdy.trips_so_far)} against ${fmt(sdy.ly_same_days)}`,
        tone: sdy.ratio >= 1 ? 'good' : sdy.ratio >= 0.85 ? null : 'warn' } : null,
      sdy ? { label: 'On last year’s shape', value: fmt(sdy.projected),
        sub: `${MONTH(sdy.ly_m)} had done ${(sdy.share_of_month_by_now * 100).toFixed(1)}% of itself by now` } : null,
      ip.forecast != null ? { label: 'The straight line said', value: fmt(ip.forecast),
        sub: ip.low != null ? `${fmt(ip.low)} – ${fmt(ip.high)}` : null } : null,
      ip.within_interval != null ? { label: 'Inside the interval?',
        value: ip.within_interval ? 'yes' : 'no',
        sub: ip.within_interval ? 'the method is holding up' : 'the method missed this month',
        tone: ip.within_interval ? 'good' : 'critical' } : null,
    ]));
    /* WHICH DAYS WENT INTO THE RATE, in words. This divided by the last day
       carrying any booking at all — on 2026-09-22 the 22nd, which held 71
       bookings because the collector had run once that morning against a
       trailing norm near 766. A numerator three quarters of a day short over a
       denominator a day too long published 734.8/day where the whole days give
       766.4, and this figure is the only score the page keeps of its own
       forecast, so understating it flatters a forecast that is too low. */
    if (ip.basis) {
      body.append(el('p', 'cap',
        `Run rate taken over ${ip.basis}`
        + (ip.last_whole_day ? `, the last of which is ${dayStr(ip.last_whole_day)}` : '')
        + (ip.trips_including_today > ip.trips_so_far
          ? `. Including the day still being collected the month holds ${fmt(ip.trips_including_today)} `
            + 'bookings, which is the larger number and the wrong denominator.'
          : '.')));
    }
    body.append(el('p', 'cap',
      'A flat run rate assumes the remaining days resemble the ones collected, which a month containing a '
      + 'holiday, a heat spike or a seasonal ramp will not. The column beside it completes the month on the '
      + 'same month last year’s own shape instead. Both are checks on the forecast, not better forecasts.'));
  }

  /* ── every month against the same month a year earlier ─────────────────
     The comparison the operator asked for, and the refusals that make it a
     comparison rather than an arithmetic operation. This record does not start
     at one date — Uber's first month is 2025-04, Yango's 2025-09, the hotel
     channel's 2026-07 — so January 2026 against January 2025 is Uber + Bolt +
     Yango against BOLT ALONE, and reports +481% growth that is a fact about
     when we started collecting Uber. */
  if (yoy.length) {
    /* `comparable !== 'no'`, not merely `ratio != null`.
       ──────────────────────────────────────────────────────────────────────
       A refused pair still CARRIES its ratio — the route computes it before it
       decides the pair is not a comparison, and serves it so the refusal note
       can quote the number it declined to publish. Filtering on the ratio
       alone therefore put January and February 2026 back in the comparable
       table at +601% and +559%, directly under a note explaining that those
       months cannot be compared. Caught by test/forecast_page.test.mjs
       asserting that a refused month is absent from the first table, which is
       the only assertion that could have: every other one on this panel was
       green with both months in it. */
    const usable = yoy.filter((r) => r.ratio != null && r.comparable !== 'no');
    const refused = yoy.filter((r) => r.comparable === 'no' && r.reason);
    const { panel: yp, body: yb } = panel('Every month against the same month a year earlier',
      'Never against last month. A fleet has a season, and month-on-month cannot tell a season from a trend.',
      'fc-yoy');
    root.append(yp);

    if (usable.length) {
      yb.append(tableFrom(usable, [
        /* The year-ago month lives in the Month cell rather than in a column
           of its own. It is always the same month a year earlier, so a whole
           column repeats what the panel title already says — and at 1,440px
           twelve columns pushed "Each car" and "What moved it" off the edge,
           which are the two the panel exists for. */
        { label: 'Month', key: 'm', render: (r) => MONTH(r.m)
          + ` <span class="dim">vs ${esc(MONTH(r.ly_m))}</span>`
          + (r.partial ? ' <span class="tag dim" title="the record stops inside this month">part month</span>' : '')
          + (r.comparable === 'partly'
            ? ' <span class="tag warn" title="a channel runs in one of these months and not the other">mixed channels</span>'
            : '') },
        { label: 'Bookings', key: 'trips', num: true, render: (r) => fmt(r.trips) },
        { label: 'Then', key: 'ly_trips', num: true, render: (r) => fmt(r.ly_trips) },
        { label: 'Change', key: '_ch', num: true,
          sortValue: (r) => r.ratio,
          render: (r) => moveStr(r.ratio) },
        { label: 'Vehicles', key: 'vehicles', num: true, render: (r) => fmt(r.vehicles) },
        { label: 'Then', key: 'ly_vehicles', num: true, render: (r) => fmt(r.ly_vehicles) },
        { label: 'Fleet', key: '_vr', num: true,
          sortValue: (r) => r.vehicle_ratio,
          render: (r) => moveStr(r.vehicle_ratio) },
        { label: 'Per vehicle', key: '_pv', num: true,
          sortValue: (r) => r.per_vehicle,
          render: (r) => (r.per_vehicle == null ? '—' : fmt(r.per_vehicle, 1)) },
        { label: 'Then', key: '_lpv', num: true,
          sortValue: (r) => r.ly_per_vehicle,
          render: (r) => (r.ly_per_vehicle == null ? '—' : fmt(r.ly_per_vehicle, 1)) },
        { label: 'Each car', key: '_ir', num: true,
          sortValue: (r) => r.intensity_ratio,
          render: (r) => moveStr(r.intensity_ratio) },
        /* The column that stops "bookings were flat" being said about a fleet
           that shrank 14% while each car sped up 15%. */
        { label: 'What moved it', key: '_lb',
          render: (r) => (r.split ? esc(r.split.led_by) : '—') },
      ], { compact: true, sortable: true, sortId: 'fcyoy', defaultSort: { key: 'm', dir: 'asc' } }));

      yb.append(el('p', 'cap',
        'Vehicles are ACTIVE vehicles — distinct plates that carried a booking that month, the same '
        + 'definition the rollup and every other page use. Bookings are exactly active vehicles times '
        + 'bookings per active vehicle, so the last three columns multiply out to the Change column and '
        + '"what moved it" is whichever of the two moved further, compared on the log scale because a '
        + 'halving and a doubling are the same size of move.'));
    }

    /* THE REFUSALS, because a missing row with no explanation reads as a page
       that lost some data — but not all of them as rows.

       At the start of any record every month's year-ago month is simply not
       there, and on the live data that is TWELVE identical rows saying "no
       booking was collected for 2024-xx", which buried the four refusals that
       actually say something about the fleet. One fact stated once, with the
       range it covers, and the substantive refusals get the table. */
    const early = refused.filter((r) => /record begins after it/.test(r.reason));
    const substantive = refused.filter((r) => !early.includes(r));
    if (refused.length) {
      const rb = el('div', 'note');
      rb.innerHTML = `<b>${countOf(refused.length, 'month')} cannot be compared with `
        + `${plural(refused.length, 'its', 'their')} year-ago month, and ${plural(refused.length, 'is', 'are')} `
        + 'left out rather than shown as growth.</b>'
        + (early.length
          ? ` ${fmt(early.length)} of ${plural(early.length, 'it', 'them')} — ${MONTH(early[0].m)} to `
            + `${MONTH(early[early.length - 1].m)} — are at the start of the record, where the year `
            + 'before them was never collected at all. That is the one fact, said once, rather than '
            + `${fmt(early.length)} rows of it.`
          : '');
      yb.append(rb);
    }
    /* A guard, NOT an early `return`. This block sits directly in
       renderForecast's body rather than in a nested function, so a bare return
       here would abandon the tourism panel, both forecasts, the scoreboard and
       the calendar — the whole page below this point — on the entirely normal
       day when every refusal is a start-of-record one. */
    if (substantive.length) {
      yb.append(tableFrom(substantive, [
        { label: 'Month', key: 'm', render: (r) => MONTH(r.m) },
        { label: 'vs', key: 'ly_m', render: (r) => MONTH(r.ly_m) },
        { label: 'Bookings', key: 'trips', num: true, render: (r) => fmt(r.trips) },
        { label: 'Then', key: 'ly_trips', num: true,
          render: (r) => (r.ly_trips == null
            ? '<span class="ent-off" title="nothing was collected for that month">—</span>'
            : fmt(r.ly_trips)) },
        { label: 'Why not', key: 'reason', render: (r) => esc(r.reason) },
      ], { compact: true }));
      yb.append(el('p', 'cap',
        'Each of these would have produced a number. Measured on 22 September 2026: January 2026 against '
        + 'January 2025 was 37,100 bookings against 6,384 — a 481% rise that is a fact about the month we '
        + 'started collecting Uber, not about this fleet. The channel mix of both months is measured on '
        + 'every load and the pair is refused when they are not two readings of the same business. '
        + 'A channel missing from the earlier month may be one we had not started collecting, or a '
        + 'collection gap being repaired; either way the refusal lifts by itself once the earlier month '
        + 'carries that channel, because nothing here is a fixed list of dates.'));
    }
  }

  /* ── Dubai's visitors, and what they actually explain ──────────────────
     A regressor rendered without its fit quality is a relationship asserted
     rather than shown, so the r² leads and the scatter is drawn under it. Both
     fits are reported, including the one that is SUPPOSED to be weak: fleet
     size is an operator's decision, not the city's, and if visitors explained
     it as well as they explain per-vehicle work, something would be wrong with
     the first number. */
  if (d.tourism) {
    const t = d.tourism;
    const { panel: tp, body: tb } = panel('Dubai’s visitors, and what they explain',
      'International overnight visitors, published by Dubai’s Department of Economy and Tourism. '
      + 'Brought in as a regressor, with its fit quality stated rather than implied.', 'fc-tourism');
    root.append(tp);

    if (t.ok) {
    /* NO TONE ON THE r² TILES, deliberately.
       `.kpi.t-good .n::before` puts a ▲ in front of the figure (app.css:1350).
       On a page where every other percentage is a year-on-year MOVE, "▲67%"
       reads as "up 67%" rather than as "explains 67% of the variance" — and it
       is the one tile whose whole job is to say how much of a relationship is
       really there. The assessment moves into the sub-line, in words, where it
       cannot be mistaken for a direction. */
      tb.append(kpiRow([
        { label: 'Visitors explain, of work per vehicle',
          value: `${Math.round(t.per_vehicle.r2 * 100)}%`,
          sub: `r² ${t.per_vehicle.r2} over ${countOf(t.n, 'month')} — `
            + (t.per_vehicle.r2 >= 0.6 ? 'a relationship the data supports'
              : t.per_vehicle.r2 >= 0.3 ? 'weak; read it as a hint, not a driver'
                : 'too weak to build on') },
        { label: 'of total bookings', value: `${Math.round(t.bookings.r2 * 100)}%`,
          sub: `r² ${t.bookings.r2}` },
        /* The one that is supposed to be low. */
        { label: 'and of how many vehicles are active',
          value: `${Math.round(t.vehicles.r2 * 100)}%`,
          sub: `r² ${t.vehicles.r2} — fleet size is a decision, not a season`,
          tone: null },
        { label: 'Each million more visitors is worth',
          value: `${fmt(t.per_vehicle.slope * 1000, 0)}`,
          sub: 'more bookings per active vehicle, on the fitted line' },
      ]));

      const dots = t.series.filter((r) => r.visitors != null && r.per_vehicle != null
        && t.months.includes(r.m));
      if (dots.length) {
        /* Its own host, NOT the panel body. `scatter()` opens with
           `host.innerHTML = ''` (charts.js:847) and so does `barChart` — which
           is right for a chart that redraws, and silently destroys anything
           appended to the same node before it. The tile row above this went
           missing exactly that way: four KPIs built, appended, and wiped by the
           next line, with nothing thrown and nothing in the console. Every
           chart on this page that is not the first thing in its panel needs
           its own container. */
        const sc = el('div');
        tb.append(sc);
        scatter(sc, dots.map((r) => ({ ...r, mv: r.visitors / 1e6 })), {
          x: 'mv', y: 'per_vehicle', label: 'm',
          xLabel: 'Dubai visitors that month, millions',
          yLabel: 'bookings per active vehicle',
          xFmt: (v) => `${(+v).toFixed(1)}m`,
          aria: 'Dubai visitors against bookings per active vehicle, one dot per month',
        });
        tb.append(el('p', 'cap',
          `One dot per month, ${fmt(dots.length)} of ${plural(dots.length, 'it', 'them')}. `
          + 'The fitted line is '
          + `${fmt(t.per_vehicle.slope * 1000, 0)} bookings per active vehicle for every million extra `
          + `visitors, and a typical month sits ${fmt(t.per_vehicle.typical_error, 1)} off it. No line is `
          + 'drawn on the chart, because the fit has an intercept and the only line this chart can draw '
          + 'passes through the origin — a line that is not the fitted one is worse than none.'));
      }
    } else {
      tb.append(note(t.reason || 'Not enough months carry both a published visitor figure and a '
        + 'booking count over the same set of channels.'));
    }

    /* The series itself, gaps included and named. */
    if (t.series?.length) {
      tb.append(tableFrom(t.series.filter((r) => r.trips), [
        { label: 'Month', key: 'm', render: (r) => MONTH(r.m)
          + (r.partial_month ? ' <span class="tag dim">part month</span>' : '') },
        { label: 'Dubai visitors', key: 'visitors', num: true,
          render: (r) => (r.visitors == null
            ? `<span class="ent-off" title="${esc(r.reason || '')}">not published</span>`
            : fmt(r.visitors)) },
        { label: 'Bookings', key: 'trips', num: true, render: (r) => fmt(r.trips) },
        { label: 'Active vehicles', key: 'vehicles', num: true, render: (r) => fmt(r.vehicles) },
        { label: 'Per vehicle', key: 'per_vehicle', num: true,
          render: (r) => (r.per_vehicle == null ? '—' : fmt(r.per_vehicle, 1)) },
        { label: 'In the fit?', key: '_in',
          render: (r) => (t.months?.includes(r.m)
            ? pill('fitted')
            : `<span class="dim" title="${esc((t.excluded || []).find((e) => e.m === r.m)?.reason || '')}">no</span>`) },
      ], { compact: true, sortable: true, sortId: 'fctour', defaultSort: { key: 'm', dir: 'asc' } }));
    }

    /* THE MONTHS DUBAI DID NOT PUBLISH. Absent with the true reason, and the
       aggregate they WERE published inside kept as an aggregate. */
    if (t.aggregates?.length) {
      for (const a of t.aggregates) {
        const n = el('div', 'note');
        n.innerHTML = `<b>${esc(a.label)}: ${fmt(a.visitors)} visitors.</b> ${esc(a.note)}`;
        tb.append(n);
      }
    }
    if (t.reconciliation?.length) {
      tb.append(el('p', 'cap',
        'The monthly series is transcribed by hand, because nothing in this system can reach Dubai’s '
        + 'tourism department — there is no feed and no credential. What makes it usable is that it '
        + 'reconciles to totals the department published separately: '
        + t.reconciliation.map((c) => `${esc(c.label)} ${fmt(c.got)} against ${fmt(c.expect)} published`
          + ` (${c.ok ? 'agrees' : 'DISAGREES'})`).join('; ')
        + '. A table that hits all three on the nose is that series or an extraordinary coincidence.'));
    }
    /* The cause of the break, which is not in this database at all. */
    for (const c of (t.context || [])) {
      const n = el('div', 'note');
      n.innerHTML = `<b>${esc(c.headline)}.</b> ${esc(c.detail)}`;
      tb.append(n);
    }
  }

  /* ── observed and forecast on one axis ────────────────────────────────── */
  const used = new Set(d.months_used);
  const hist = d.observed.filter((m) => !m.no_data);
  /* The caption names the treatment the chart DRAWS. It said "Hatched bars
     are forecast" for as long as the bars were solid in a colour of their
     own — nothing on the chart was hatched. Under a form that hatches a
     projection (SPEC §5, the Arkiv skin) that sentence is now true; under the
     old skin's form the forecast bars are solid, and the caption says what
     marks them instead: their own colour, named in the key, and a whisker. */
  const projWord = drawnAs('projected');
  const { panel: tp, body: tb } = panel('Bookings by month, observed and forecast',
    (projWord === 'hatched' ? 'Hatched bars are forecast. '
      : 'The bars after the last observed month are forecast, in the colours the key names. ')
    + 'The months the fit refused to use are drawn in full, because hiding them '
    + 'would hide the reason the forecast starts where it does.');
  root.append(tp);
  /* The forecast drawn is the YEAR-ON-YEAR one where it exists, because that
     is the one the headline is built on and a chart showing a different
     projection from the tile above it is two answers to one question. The
     straight line stays in the month-by-month table and the scoreboard. */
  const drawn = seas ? seas.forecast.filter((r) => r.point != null) : d.forecast;
  const series = [
    ...hist.map((m) => ({ label: MONTH(m.m), n: m.trips,
      kind: m.partial_month ? 'partial' : used.has(m.m) ? 'fitted' : 'excluded' })),
    /* Every forecast bar carries its interval. The caption promised hatching
       and a range and the chart drew a solid bar — a point estimate presented
       as a measurement, which is the exact failure this page's own header
       says it exists to avoid. */
    ...drawn.map((f) => ({ label: MONTH(f.m), n: f.point, kind: f.kind, lo: f.low, hi: f.high })),
  ];
  const PROJECTED = new Set(['forecast', 'extrapolation']);
  barChart(tb, series, { x: 'label', y: 'n', label: 'bookings', lo: 'lo', hi: 'hi',
    projected: (r) => PROJECTED.has(r.kind),
    colorFor: (r) => ({ fitted: '--b500', excluded: '--grey', partial: '--grey',
      forecast: '--s3', extrapolation: '--s5' }[r.kind] || '--b400') });
  /* `sw-proj`: the key's swatch for a projected series, which arkiv.css
     draws as the same hatch the bar gets; the old skin has no rule for it. */
  tb.append(el('div', 'legend', [
    ['--b500', `fitted (${d.n} months)`],
    ['--grey', 'not used — before the break, or a partial month'],
    ['--s3', 'forecast (3 months)', true],
    ['--s5', 'extrapolation — a line, not a forecast', true],
  ].map(([c, t, p]) => `<span><i class="sw${p ? ' sw-proj' : ''}" style="background:var(${c})"></i>${t}</span>`).join('')
    + '<span class="dim">The whisker on a forecast bar is its 95% interval. A month with no whisker is '
    + 'observed, not predicted.</span>'));
  if (seas) {
    tb.append(el('p', 'cap',
      'The forecast bars are the year-on-year projection: each one is the same month a year earlier, '
      + `scaled by ${moveStr(seas.ratio)}. The straight line through the months since the break is in the `
      + 'table below, beside them.'));
  }

  /* What the fitted line is actually made of.
     ───────────────────────────────────────────────────────────────────────
     `drivers` and `vehicles` come back on every observed month and were drawn
     nowhere, so a rising booking count read as growth. Bookings per driver on
     the fitted months ran 60.7 → 72.9 → 118.4 → 135.8 → 96.3: the trend is
     mostly each driver doing more, not more drivers — and the month whose
     driver count rose 45% for a 2.6% rise in bookings is the one that decides
     whether next month is reachable. */
  if (hist.some((m) => m.drivers != null)) {
    const withD = hist.filter((m) => m.drivers != null && m.drivers > 0);
    tb.append(tableFrom(withD, [
      { label: 'Month', key: 'm', render: (m) => MONTH(m.m)
        + (used.has(m.m) ? '' : ' <span class="tag dim" title="excluded from the fit">not fitted</span>') },
      { label: 'Bookings', key: 'trips', num: true, render: (m) => fmt(m.trips) },
      { label: 'Drivers earning', key: 'drivers', num: true, render: (m) => fmt(m.drivers) },
      { label: 'Vehicles earning', key: 'vehicles', num: true,
        render: (m) => (m.vehicles == null
          ? '<span class="ent-off" title="not reported for this month">—</span>'
          : fmt(m.vehicles)) },
      { label: 'Bookings per driver', key: '_pd', num: true,
        sortValue: (m) => (m.drivers ? m.trips / m.drivers : null),
        render: (m) => (m.drivers ? fmt(m.trips / m.drivers, 1) : '—') },
    ], { compact: true, sortable: true, sortId: 'fcmonths', defaultSort: { key: 'm', dir: 'asc' } }));
    const fitted = withD.filter((m) => used.has(m.m));
    if (fitted.length >= 2) {
      const per = (m) => m.trips / m.drivers;
      const dMove = Math.round(((fitted[fitted.length - 1].drivers / fitted[0].drivers) - 1) * 100);
      const pMove = Math.round(((per(fitted[fitted.length - 1]) / per(fitted[0])) - 1) * 100);
      tb.append(el('p', 'cap',
        `Across the fitted months the driver count moved ${signed(dMove, { unit: '%' })} and each `
        + `driver's own output moved ${signed(pMove, { unit: '%' })}. `
        + (Math.abs(pMove) > Math.abs(dMove)
          ? 'The trend this page fits is mostly per-driver intensity, not headcount — which is a ceiling, '
            + 'because a driver cannot keep doubling. Read the forecast against that before rostering to it.'
          : 'The trend this page fits is mostly headcount, which stops when hiring stops.')));
    }
  }

  if (d.break) {
    tb.append(el('p', 'note',
      `The fit starts at ${MONTH(d.break.to)}. Between ${MONTH(d.break.from)} and it, bookings moved `
      + `${signed(d.break.change_pct, { unit: '%' })} and did not come back — a line drawn through that predicts a recovery to the `
      + `old level that nothing in the data supports. ${countOf(d.months_excluded.length, 'earlier month')} `
      + `${plural(d.months_excluded.length, 'was', 'were')} `
      + `excluded: ${d.months_excluded.map(MONTH).join(', ')}.`));
  }

  /* ── the months themselves, with their intervals ──────────────────────── */
  const { panel: mp, body: mb } = panel('Month by month, both methods',
    'Every figure is a range. The point estimate is the least informative thing about a forecast.',
    'fc-months');
  root.append(mp);
  /* One row per horizon month carrying BOTH models, so a reader never has to
     hold one page against another to see that they disagree. */
  const sBy = new Map(seas ? seas.forecast.map((r) => [r.m, r]) : []);
  mb.append(tableFrom(d.forecast, [
    { label: 'Month', key: 'm', render: (r) => MONTH(r.m) },
    { label: 'Kind', key: 'kind', render: (r) => pill(r.kind, r.kind === 'forecast' ? null : 'warn') },
    { label: 'Days', key: 'days', num: true },
    /* No `absent` sentence on this column, deliberately. `tableFrom`'s
       dead-column prune reads the RAW value at `r[key]` rather than the
       renderer's output (ui.js:238 — and it says why it must, since pruning on
       rendering would silently drop columns across the product). `_base` is a
       synthetic key that exists on no row, so declaring `absent` here would
       prune the column on EVERY render, including the ones where it is full.
       The empty case is covered by the "absent" cell text below instead. */
    { label: 'Same month last year', key: '_base', num: true,
      render: (r) => {
        const s = sBy.get(r.m);
        if (!s) return '—';
        return s.base == null
          ? `<span class="ent-off" title="${esc(s.reason || '')}">—</span>`
          : `${fmt(s.base)} <span class="dim">${esc(MONTH(s.base_m))}</span>`;
      } },
    { label: 'Year on year', key: '_seas', num: true,
      render: (r) => {
        const s = sBy.get(r.m);
        if (!s || s.point == null) {
          return `<span class="ent-off" title="${esc(s?.reason || 'no year-ago month')}">absent</span>`;
        }
        return `<b>${fmt(s.point)}</b>`
          + (s.base_post_break
            ? ' <span class="tag warn" title="the base month is itself after the break, so the ratio '
              + 'subtracts the collapse a second time">base post-break</span>'
            : '');
      } },
    { label: 'Its range', key: '_srange', num: true,
      render: (r) => {
        const s = sBy.get(r.m);
        return !s || s.low == null ? '—' : `${fmt(s.low)} – ${fmt(s.high)}`;
      } },
    { label: 'Straight line', key: 'point', num: true, render: (r) => fmt(r.point) },
    { label: 'Its range', key: '_r', num: true,
      render: (r) => (r.low == null ? '—' : `${fmt(r.low)} – ${fmt(r.high)}`) },
    { label: 'If flat instead', key: 'flat', num: true, render: (r) => fmt(r.flat) },
  ]));
  mb.append(el('p', 'cap',
    'The last column is what you would predict by assuming next month looks like the last three. Where the '
    + 'methods disagree by less than their ranges, the trend is not telling you anything the flat line was '
    + 'not. Where they disagree by MORE than their ranges — which October and November do — at least one of '
    + 'them is wrong and the page cannot tell you which.'));
  if (seas && seas.forecast.some((r) => r.base_post_break)) {
    mb.append(el('p', 'note',
      'The months marked "base post-break" are built on a month that is itself after the collapse. The '
      + `ratio was measured as a post-break month over a PRE-break one, so it carries the whole size of the `
      + 'collapse inside it, and applying it to a base that already has the collapse subtracts it twice. '
      + 'Those rows are shown because a plan wants a shape for the year, and flagged because they are '
      + 'almost certainly too low.'));
  }

  /* ── which method, and how wrong each has been ────────────────────────── */
  if (d.model_scores) {
    const ms = d.model_scores;
    const { panel: sp, body: sb } = panel('Which method, and how wrong each one has been',
      'Every method scored one step ahead, on the months that can be scored, using only the months '
      + 'before each target. Published whichever way it falls.', 'fc-scores');
    root.append(sp);
    if (ms.rows?.length) {
      sb.append(tableFrom(ms.rows, [
        { label: 'Month', key: 'm', render: (r) => MONTH(r.m) },
        { label: 'Actual', key: 'actual', num: true, render: (r) => fmt(r.actual) },
        { label: 'Year on year', key: 'seasonal', num: true, render: (r) => fmt(r.seasonal) },
        { label: 'out by', key: 'seasonal_err_pct', num: true,
          render: (r) => (r.seasonal_err_pct == null ? '—' : signed(r.seasonal_err_pct, { unit: '%' })) },
        { label: 'Straight line', key: 'line', num: true, render: (r) => fmt(r.line) },
        { label: 'out by', key: 'line_err_pct', num: true,
          render: (r) => (r.line_err_pct == null ? '—' : signed(r.line_err_pct, { unit: '%' })) },
        { label: 'Flat', key: 'flat', num: true, render: (r) => fmt(r.flat) },
        { label: 'out by', key: 'flat_err_pct', num: true,
          render: (r) => (r.flat_err_pct == null ? '—' : signed(r.flat_err_pct, { unit: '%' })) },
      ], { compact: true }));
      const mp2 = ms.mean_abs_pct || {};
      const best = ['line', 'seasonal', 'flat']
        .filter((k) => mp2[k] != null)
        .sort((a, b) => mp2[a] - mp2[b])[0];
      const NAME = { line: 'the straight line', seasonal: 'the year-on-year model', flat: 'the flat baseline' };
      /* THE UNCOMFORTABLE SENTENCE, written so that it is uncomfortable. The
         new model on this page does not currently win, and a page that led
         with it without saying so would be doing the thing this product
         exists to refuse. */
      sb.append(el('div', 'note err',
        `<b>On the ${countOf(ms.n, 'month')} that can be scored, ${esc(NAME[best])} is the most accurate `
        + `— mean error ${mp2[best]}%.</b> `
        + `Year on year ${mp2.seasonal}%, straight line ${mp2.line}%, flat ${mp2.flat}%. `
        + 'Two months cannot settle this, and they are the wrong two: both sit inside the recovery, where a '
        + 'year-on-year ratio taken from earlier months is biased low by construction because the ratio '
        + 'itself was still climbing. The month in progress is the opposite case — a large seasonal step, '
        + 'where the straight line is the one that misses. Both methods are therefore shown, and this page '
        + 'does not tell you which to believe, because it cannot demonstrate it.'));
    } else {
      sb.append(note('No month in this record can be scored yet: scoring a method one step ahead needs '
        + 'a month that is complete, comparable with its year-ago month, and preceded by enough '
        + 'comparable months to have fitted the method at all.'));
    }
    if (ms.unscorable?.length) {
      sb.append(el('p', 'cap',
        `${countOf(ms.unscorable.length, 'month')} could not be scored. `
        + `${esc(ms.unscorable[ms.unscorable.length - 1].reason)}.`));
    }
  }

  /* ── the shape of next month ──────────────────────────────────────────── */
  if (d.daily?.length) {
    const { panel: dp, body: db } = panel(`${MONTH(d.next_month)}, day by day`,
      'A monthly total is not a rota. Weekday shares are measured over recent complete weeks and weighted by '
      + 'how many of each weekday this particular month contains.');
    root.append(dp);
    barChart(db, d.daily.map((x) => ({
      label: `${x.day.slice(8)} ${DOW[x.dow]}`, n: x.expected, dow: x.dow,
    })), { x: 'label', y: 'n', label: 'expected bookings',
      colorFor: (r) => (r.dow === 5 || r.dow === 6 ? '--s3' : '--b400') });
    const busiest = [...d.daily].sort((a, b) => b.expected - a.expected)[0];
    const quietest = [...d.daily].sort((a, b) => a.expected - b.expected)[0];
    db.append(el('p', 'cap',
      `Busiest expected day is ${dayStr(busiest.day)} (${fmt(busiest.expected)}); quietest is `
      + `${dayStr(quietest.day)} (${fmt(quietest.expected)}). Every one of these inherits the monthly range `
      + 'above — a day is not more certain than the month it sits in. '
      + (sNext
        ? 'These days are spread across the STRAIGHT LINE’s monthly total, which is the lower of the '
          + `two forecasts: the year-on-year model puts the month at ${fmt(sNext.point)}, so scale the rota `
          + `by about ${(sNext.point / Math.max(1, next.point)).toFixed(1)}× if you plan to that one.`
        : '')));

    if (d.weekday_shares) {
      /* The chart above is next month; the shares below were measured on past weeks. Those are
         two different numbers for the same weekday, so carry next month's back into the table
         rather than leaving the reader to wonder which one the panel title refers to. */
      const byDow = new Map();
      for (const x of d.daily) {
        const a = byDow.get(x.dow) || { sum: 0, n: 0 };
        a.sum += x.expected; a.n += 1;
        byDow.set(x.dow, a);
      }
      const expFor = (dow) => {
        const a = byDow.get(dow);
        return a && a.n ? a.sum / a.n : null;
      };
      db.append(tableFrom(d.weekday_shares, [
        { label: 'Weekday', key: 'dow', render: (r) => DOW[r.dow] },
        { label: 'Measured average', key: 'mean', num: true, render: (r) => fmt(r.mean, 1) },
        { label: 'Share of a week', key: 'share', num: true, render: (r) => `${(r.share * 100).toFixed(1)}%` },
        { label: 'Weeks measured', key: 'n', num: true },
        { label: `Expected per ${MONTH(d.next_month)} day`,
          key: 'exp', num: true,
          render: (r) => (expFor(r.dow) == null ? '—' : fmt(expFor(r.dow), 0)) },
        { label: `${MONTH(d.next_month)} days`, key: 'ndays', num: true,
          render: (r) => fmt(byDow.get(r.dow)?.n ?? 0) },
      ], { compact: true }));
      db.append(el('p', 'cap',
        'The measured column is history — the average of that weekday over the complete weeks behind us. '
        + `The expected column is the same weekday inside ${MONTH(d.next_month)}, which is the measured `
        + 'share applied to that month’s forecast total. The two differ by exactly as much as the '
        + 'forecast differs from where the fleet is running now; the chart above plots the expected one.'));
    }
  }

  /* ── the demand calendar, which names events and moves no number ───────
     Here because a regression over six post-break months genuinely cannot know
     that Ramadan moves about eleven days earlier every Gregorian year, and so
     cannot know that the month which held it last year will not hold it next
     year. That is knowledge, not scatter.

     It is labelled everywhere it appears, and the label is not boilerplate:
     the same calendar generated on a second model returned Ramadan 1448 as
     ~17 February 2027, which is 1447's date — a year stale, nine days out, and
     delivered with exactly the same confidence as everything else in the
     reply. Two models, one of them wrong, and no way to tell from the output
     which. So a model may name an event and may not move a number. */
  if (d.calendar?.months?.length) {
    const c = d.calendar;
    const { panel: cp, body: cb } = panel('What is in the calendar for these months',
      'Named by a language model, not measured. No figure on this page is adjusted by any of it.',
      'fc-calendar');
    root.append(cp);
    const warn = el('div', 'note err');
    warn.innerHTML = `<b>This panel is not a measurement.</b> It was written by ${esc(c.model)} on `
      + `${esc(dateStr(c.generated) || c.generated)} and is here to say what is happening in a month, not `
      + 'how much of it. Every number elsewhere on this page comes from the booking record or from '
      + 'Dubai’s published visitor figures; none of them is multiplied, shifted or weighted by '
      + 'anything below.';
    cb.append(warn);
    cb.append(tableFrom(c.months, [
      { label: 'Month', key: 'm', render: (r) => MONTH(r.m) },
      { label: 'Expect', key: 'direction',
        render: (r) => pill(DIRECTION[r.direction] || r.direction,
          r.direction === 'down' ? 'warn' : r.direction === 'up' ? null : 'warn') },
      { label: 'What is on', key: 'events',
        render: (r) => (r.events || []).map((e) => esc(e)).join(' · ') },
      { label: 'Why', key: 'note', render: (r) => esc(r.note) },
    ], { compact: true }));
    if (c.checked) cb.append(el('p', 'cap', esc(c.checked)));
    /* Where the model disagrees with the record, the record wins and the page
       says which is which. */
    const clash = c.months.filter((m) => m.disagrees_with_measurement);
    if (clash.length) {
      cb.append(el('p', 'note',
        `The calendar and the measured record disagree about ${clash.map((m) => MONTH(m.m)).join(', ')}. `
        + 'The model calls it about normal; this fleet’s own history has August to September as the '
        + 'largest seasonal step of its year. Where the two disagree the measurement wins, because one of '
        + 'them is a measurement.'));
    }
  }

  root.append(note(d.revenue_note));
  if (ak) forecastAbsence(root, d);
  root.append(el('p', 'cap',
    `Method. Two forecasts are shown and neither is presented as the answer. The straight line is ordinary `
    + `least squares over ${d.n} whole months since the last regime change, with a 95% prediction interval `
    + 'for a NEW month rather than for the fitted line. '
    + (seas
      ? `The year-on-year model is the same month a year earlier multiplied by ${moveStr(seas.ratio)}, the `
        + `mean of the ${countOf(seas.k, 'most recent comparable month')} — taken over the channels both `
        + `months carry — with a range from the scatter of those ratios (t = ${seas.t_multiplier} on `
        + `${seas.k - 1} degrees of freedom). Fitted to ${seas.months_used.map(MONTH).join(', ')}. `
      : '')
    + 'Months three and beyond are extrapolation and labelled as such. '
    + `<a href="${href('causes')}">Why the numbers moved</a> · `
    + `<a href="${href('playbook')}">What to do about it</a>`));
}

/* ── #forecast under the page contract ─────────────────────────────────────
   The hero is a RANGE: the two methods' points for next month, lowest to
   highest, each with its own interval in the sub-line — one point would
   hide that they disagree. The point tile is not drawn (the range carries
   both points); every other old tile is kept, untoned.
   NOT BUILT: hatching every bar of next month's day-by-day chart (it is a
   barChart, which has no hatched form); its caption already says it is a
   projection. */
function forecastGlance(AKB, tiles, { d, next, sNext, ip }) {
  const pts = [next.point, sNext?.point].filter((x) => x != null);
  const lo = Math.min(...pts), hi = Math.max(...pts);
  const iv = (r) => (r.low != null ? ` (${fmt(r.low)}–${fmt(r.high)})` : '');
  const observed = (d.observed || []).filter((m) => !m.no_data).length;
  const head = [
    /* With one method the range is that method's own interval. */
    { label: `The range for ${MONTH(next.m)}`, hero: true,
      value: lo !== hi ? `${fmt(lo)} – ${fmt(hi)}` : next.low != null ? `${fmt(next.low)} – ${fmt(next.high)}` : fmt(lo),
      sub: `the straight line says ${fmt(next.point)}${iv(next)}`
        + (sNext ? `; the same month a year earlier, scaled, says ${fmt(sNext.point)}${iv(sNext)}` : '; no second method can be built for it') },
    ip && ip.forecast != null ? { label: `${MONTH(ip.m)} so far`, value: fmt(ip.projected),
      sub: `projected from ${fmt(ip.per_day, 1)} a day over ${countOf(ip.days_so_far, 'whole day')}; ${ip.within_interval ? 'inside' : 'outside'} the forecast\u2019s range of ${fmt(ip.low)}–${fmt(ip.high)}`,
      delta: { value: ((ip.projected - ip.forecast) / ip.forecast) * 100, unit: '%', of: `against the ${fmt(ip.forecast)} forecast`, d: 1 } }
      : { label: 'The month so far', na: 'no month is in progress inside the forecast horizon' },
    { label: 'Months fitted', value: `${fmt(d.n)} of ${fmt(observed)}`,
      sub: d.months_excluded?.length ? `${countOf(d.months_excluded.length, 'month')} before the last break are not fitted` : 'every observed month' },
  ];
  const rest = tiles.filter(Boolean).filter((x) => !String(x.label).startsWith('Bookings in '));
  glance(AKB.tilesHost, bandTiles([...head, ...rest]).tiles);
  /* 01 — observed months, then the forecast months hatched, with the other
     method as the line over them. */
  const p = panel('The year ahead, and how wide the guess gets', 'Observed months solid; every forecast month hatched — a projection — and so is a month the record only partly covers. The line is the second method where it can be built.', 'fc-year');
  AKB.band.after(p.panel);
  const seasonal = new Map((d.seasonal?.forecast || []).map((r) => [r.m, r.point]));
  const obs = (d.observed || []).slice(-12).map((m) => ({ x: MONTH(m.m), v: m.no_data ? null : +m.trips, none: !!m.no_data,
    part: !!m.partial_month && !m.no_data, other: null, fc: false }));
  const fut = (d.forecast || []).map((r) => ({ x: MONTH(r.m), v: r.point, none: r.point == null, part: false,
    other: seasonal.get(r.m) ?? null, fc: true }));
  gapBars(p.body, [...obs, ...fut], { x: 'x', y: 'v', label: 'bookings', color: '--ink', gapKey: 'none',
    gapLabel: 'no data for this month', bucketNoun: 'months', inProgress: false,
    hatchIf: (r) => r.fc || r.part, hatchNote: 'a projection, or a month the record only partly covers',
    secondary: 'other', secondaryLabel: 'the same month a year earlier, scaled', secondaryLine: { color: '--grey', label: 'year-ago method' },
    valueFmt: (v) => fmt(v) });
  const rows = (d.forecast || []).slice(0, 3).map((r) => `${MONTH(r.m)} ${fmt(r.low)}–${fmt(r.high)}`);
  p.body.append(el('p', 'cap', esc(`The straight line\u2019s range: ${rows.join(' · ')}. The further out, the wider.`)));
}
/* The plan's order for the panels the old page draws in its own order: the
   month so far, bookings by month, both methods, the backtest, the year-ago
   table, the visitors, next month day by day, the calendar. Moved, not
   rebuilt — each panel is the old page's. */
const FC_ORDER = [/so far, against what was forecast$/, /^Bookings by month/, /^Month by month, both methods/, /^Which method/,
  /^Every month against the same month/, /^Dubai.s visitors/, /, day by day$/, /^What is in the calendar/];
function forecastReorder(root) {
  const anchor = root.querySelector('[data-panel="fc-year"]');
  if (!anchor) return;
  const panels = [...root.children].filter((n) => n.classList?.contains('panel'));
  let at = anchor;
  for (const re of FC_ORDER) {
    const p = panels.find((x) => re.test(x.querySelector('h3')?.textContent.trim() || ''));
    if (p && p !== anchor) { at.after(p); at = p; }
  }
}
function forecastAbsence(root, d) {
  forecastReorder(root);
  const extrap = d.year_ahead ? 12 - d.year_ahead.forecast_months : null;
  const absHost = el('div'); root.append(absHost);
  absenceBand(absHost, [
    { label: 'A day\u2019s own uncertainty', fig: null, none: 'Not given',
      why: 'The day-by-day figures share the month\u2019s range out by weekday; no single day carries an interval of its own.' },
    { label: 'Months dropped', fig: fmt((d.months_excluded || []).length),
      why: (d.months_excluded || []).length ? 'Months before the last break are a different regime, and are not fitted.' : 'Every observed month is fitted.' },
    { label: 'Beyond the fitted horizon', fig: extrap != null ? countOf(extrap, 'month') : null, none: 'None',
      why: extrap ? 'The twelve-month total extends the line past the months the forecast can stand on; those are extrapolated, not forecast.' : 'Nothing is extrapolated.' },
    { label: 'Money', fig: null, none: 'Not forecast', why: d.revenue_note || 'Bookings are forecast; money is not.' },
  ]);
  pageFoot({ colophon: [`next: ${MONTH(d.next_month || (d.forecast[0] || {}).m)}`, `${fmt(d.n)} months fitted`] }, root);
}
