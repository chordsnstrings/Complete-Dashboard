/* Who did well last week, who did not, and what the difference looks like.
   ─────────────────────────────────────────────────────────────────────────
     #top-performers      the people the week went well for
     #low-performers      the people it did not
     #performer/<id>      one person's week, day by day

   Both lists rank the same population by the same metric in opposite
   directions, and the interesting part of either page is the drill-down.

   FIVE THINGS THIS PAGE REFUSES TO DO, each of which it would otherwise do
   wrongly:

   1. IT DOES NOT RANK ON A BLENDED TOTAL. api/income_sql.js picks a basis per
      channel: the hotel channel reports a fare, which is gross — what the
      property was charged. Uber reports a payout, which is net of commission
      and of the cash the driver already pocketed. Adding them and sorting puts
      a hotel driver above an Uber driver who earned more, and the page would
      have no way to show it. The money column names its parts.

   2. IT DOES NOT RANK A PARTIAL WEEK. The window is the last COMPLETE Monday
      to Sunday, because ranking people on a day that is four hours old rewards
      whoever starts early.

   3. IT DOES NOT CALL A LOW EARNER A BAD DRIVER. The data cannot tell a
      person who worked and earned little from one who was on leave, whose car
      was off the road, or whose licence had lapsed — so the row carries days
      worked, standing, and licence state beside the money, and the page says
      in words what it cannot distinguish.

   4. IT DOES NOT RANK ON A RATE WITHOUT EXPOSURE. One good day is not a good
      week. Below the threshold a rate is noise, and those people are listed
      separately rather than sorted among the rest.

   5. IT DOES NOT CALL AN ON-TRIP HOUR AN ONLINE HOUR. Uber reports no online
      hours at all — 232 of 241 people have none — so what is shown is time
      carrying someone, measured from the trips, and it is labelled that. */
import { hbars } from './charts.js';
import { el, esc, panel, loading, tableFrom, kpiRow, note, pill, entity, money,
  fmt, empty } from './ui.js';
import { q, href, state } from './data.js';

/* Enough of a week to rank on. Two thirds of a working week: below it a
   per-day rate is one or two shifts wearing a week's clothing. */
const MIN_DAYS = 4;
const MIN_BOOKINGS = 15;

const eligible = (r) => (r.days_worked || 0) >= MIN_DAYS && (r.bookings || 0) >= MIN_BOOKINGS;

const rate = (r) => (r.days_worked ? (r.money || 0) / r.days_worked : null);

function whyNotRanked(r) {
  if (!r.days_worked) return 'did not drive';
  if ((r.days_worked || 0) < MIN_DAYS) return `${r.days_worked}d worked`;
  if ((r.bookings || 0) < MIN_BOOKINGS) return `${r.bookings} bookings`;
  return null;
}

export async function renderPerformers(root, band) {
  const top = band === 'top';
  const head = el('div'); root.append(head);
  const kh = el('div', 'kpis'); root.append(kh);
  const listP = panel(top ? 'Ranked highest' : 'Ranked lowest',
    `Money in per day worked, over the last complete week. At least ${MIN_DAYS} days `
    + `and ${MIN_BOOKINGS} bookings — click any row for the week in detail.`);
  root.append(listP.panel);
  const shapeP = panel('What the two ends look like',
    'The same measures for the ranked group, best and worst, side by side');
  root.append(shapeP.panel);
  const outP = panel('Not ranked', 'Too little of the week to carry a rate — listed, not sorted');
  root.append(outP.panel);
  [kh, listP.body, shapeP.body, outP.body].forEach(loading);

  const weeks = await q('/api/performer/weeks').catch(() => ({ weeks: [] }));
  const wk = state.week || weeks.latest_complete;
  const d = await q('/api/economics/drivers', wk ? { from: wk, to: weekEnd(wk) } : {});
  const rows = (d.rows || []).filter((r) => (r.days_worked || 0) > 0);

  head.innerHTML = '';
  const wkNote = el('div', 'note info');
  wkNote.innerHTML = `The week of <b>${esc(wk || '—')}</b> to <b>${esc(weekEnd(wk) || '—')}</b>, `
    + 'Dubai days, the last one that finished. A part-finished week ranks whoever started earliest.';
  head.append(wkNote);

  const ranked = rows.filter(eligible).filter((r) => rate(r) != null);
  ranked.sort((a, b) => (top ? rate(b) - rate(a) : rate(a) - rate(b)));
  const rest = rows.filter((r) => !eligible(r) || rate(r) == null);

  const t = d.totals || {};
  kh.replaceWith(kpiRow([
    { label: 'People ranked', value: fmt(ranked.length),
      sub: `of ${fmt(rows.length)} who drove — the rest did too little of the week` },
    { label: top ? 'Best per day' : 'Lowest per day',
      value: ranked.length ? money(rate(ranked[0])) : '—',
      sub: ranked.length ? esc(ranked[0].driver_name) : 'nobody cleared the threshold' },
    { label: 'Fleet per day worked', value: money(t.aed_per_day_worked),
      sub: 'every person, every day anyone drove' },
    { label: 'Spread', value: ranked.length > 1
      ? `${Math.round((rate(ranked[0]) || 0) / (rate(ranked[ranked.length - 1]) || 1) * 10) / 10}×` : '—',
      sub: 'best to worst among the ranked' },
  ]));

  listP.body.innerHTML = '';
  if (!ranked.length) {
    empty(listP.body, `Nobody worked enough of this week to be ranked. The gate is ${MIN_DAYS} days and ${MIN_BOOKINGS} bookings.`);
  } else {
    listP.body.append(tableFrom(ranked.slice(0, 40).map((r, i) => ({ ...r, rank: i + 1 })), [
      /* tableFrom's render takes the ROW only — no index. The rank is stamped
         onto the row before it gets here, which is also what makes it survive
         a column sort: the number means position in THIS ranking, not the
         order the browser happens to be showing. */
      { label: '#', key: 'rank', num: true },
      { label: 'Driver', key: 'driver_name',
        render: (r) => entity('driver', r.driver_ext_id, r.driver_name) },
      { label: 'Fleet', key: 'fleet_id', render: (r) => (r.fleet_id ? pill(r.fleet_id) : '—') },
      { label: 'Platforms', key: 'platforms',
        render: (r) => (r.platforms || []).map((x) => pill(x)).join(' ') || '—' },
      { label: 'Per day', key: '_rate', num: true, render: (r) => money(rate(r)) },
      { label: 'Money in', key: 'money', num: true,
        render: (r) => `${money(r.money)}<span class="dim" title="payout where the channel pays one, fare where it prices the trip"> ${
          r.payouts && r.fares ? 'both' : r.payouts ? 'payout' : 'fare'}</span>` },
      { label: 'Days', key: 'days_worked', num: true },
      { label: 'Bookings', key: 'bookings', num: true },
      { label: 'Per booking', key: 'aed_per_booking', num: true, render: (r) => money(r.aed_per_booking) },
      { label: 'Km', key: 'km', num: true, render: (r) => fmt(r.km) },
      { label: 'Completed', key: 'completion_pct', num: true,
        render: (r) => (r.completion_pct == null ? '—' : `${fmt(r.completion_pct)}%`) },
      { label: 'Standing', key: 'state',
        render: (r) => (r.state ? pill(r.state, r.can_earn === false ? 'warn' : null) : '—') },
    ], { onRow: (r) => { location.hash = `#performer/${encodeURIComponent(r.driver_ext_id)}`; } }));
  }

  shapeP.body.innerHTML = '';
  if (ranked.length > 3) {
    const n = Math.min(5, Math.floor(ranked.length / 2));
    const best = ranked.slice(0, n);
    const worst = ranked.slice(-n);
    const avg = (list, f) => list.reduce((a, x) => a + (f(x) || 0), 0) / list.length;
    const cmp = [
      ['Per day worked', avg(best, rate), avg(worst, rate), money],
      ['Bookings a day', avg(best, (x) => x.bookings_per_day), avg(worst, (x) => x.bookings_per_day), (v) => fmt(v, 1)],
      ['Per booking', avg(best, (x) => x.aed_per_booking), avg(worst, (x) => x.aed_per_booking), money],
      ['Km a day', avg(best, (x) => (x.km || 0) / (x.days_worked || 1)), avg(worst, (x) => (x.km || 0) / (x.days_worked || 1)), (v) => `${fmt(v)} km`],
      ['Days worked', avg(best, (x) => x.days_worked), avg(worst, (x) => x.days_worked), (v) => fmt(v, 1)],
      ['Completed', avg(best, (x) => x.completion_pct), avg(worst, (x) => x.completion_pct), (v) => `${fmt(v)}%`],
    ];
    shapeP.body.append(tableFrom(cmp.map(([m, a, b, f]) => ({
      measure: m, best: f(a), worst: f(b),
      gap: b ? `${Math.round((a / b) * 10) / 10}×` : '—',
    })), [
      { label: 'Measure', key: 'measure' },
      { label: `Top ${n}`, key: 'best', num: true },
      { label: `Bottom ${n}`, key: 'worst', num: true },
      { label: 'Ratio', key: 'gap', num: true },
    ]));
    shapeP.body.append(el('p', 'cap',
      'Read down the ratio column: where it is near 1 the two ends do the same thing, and '
      + 'wherever it is not is where the difference actually lives.'));
  } else empty(shapeP.body, 'Too few ranked people to compare the two ends.');

  outP.body.innerHTML = '';
  if (!rest.length) empty(outP.body, 'Everyone who drove cleared the threshold.');
  else {
    outP.body.append(tableFrom(rest.slice(0, 40).map((r) => ({ ...r, why: whyNotRanked(r) })), [
      { label: 'Driver', key: 'driver_name',
        render: (r) => entity('driver', r.driver_ext_id, r.driver_name) },
      { label: 'Days', key: 'days_worked', num: true },
      { label: 'Bookings', key: 'bookings', num: true },
      { label: 'Money in', key: 'money', num: true, render: (r) => money(r.money) },
      { label: 'Why not ranked', key: 'why' },
    ]));
  }

  if (!top) {
    root.append(note(
      'This page ranks money against days worked. It cannot tell a person who worked and '
      + 'earned little from one who was on leave, whose vehicle was off the road, or whose '
      + 'licence had lapsed — the standing and days columns are there for exactly that, and '
      + 'they should be read before anyone is spoken to.', 'warn'));
  }
  const cov = d.coverage;
  if (cov && cov.note) root.append(el('p', 'cap', esc(cov.note)));
  if (t.hours_note) root.append(el('p', 'cap', esc(t.hours_note)));
}

/* Anchored at NOON, not midnight. Adding six days to a midnight and reading
   the UTC date back is one boundary away from returning the wrong day; from
   noon, no offset any calendar uses can cross either midnight. test/timezone
   .test.mjs enforces exactly this and caught the midnight version. */
const weekEnd = (mon) => {
  if (!mon) return null;
  const d = new Date(`${mon}T12:00:00Z`);
  return new Date(d.getTime() + 6 * 864e5).toISOString().slice(0, 10);
};

export { weekEnd, MIN_DAYS, MIN_BOOKINGS };

/* One person's week. This is the page the two lists exist to reach: a rank is
   a claim, and this is the evidence for it.

   The three clocks are kept apart on purpose. ON TRIP is measured, from
   request to dropoff, over the bookings that carry an end time. ELAPSED is
   first request to last dropoff and contains every gap — it is not a shift and
   is never called one. ONLINE is what Uber does not report, and where a
   platform status happens to exist it is shown as observations, not hours. */
export async function renderPerformer(root, id) {
  const kh = el('div', 'kpis'); root.append(kh);
  const g = el('div', 'grid g23'); root.append(g);
  const dayP = panel('The week, day by day',
    'Bookings, distance and time carrying someone — one row per Dubai day');
  g.append(dayP.panel);
  const platP = panel('Where the work came from', 'Per channel, with what each one reports');
  g.append(platP.panel);
  const areaP = panel('Where they picked up',
    'Areas parsed from the address text each channel returns — a grouping, not a coordinate');
  root.append(areaP.panel);
  const statusP = panel('What the platform said',
    'Uber driver status, polled every five minutes — present only where the fleet has it');
  root.append(statusP.panel);
  [kh, dayP.body, platP.body, areaP.body, statusP.body].forEach(loading);

  const p = await q('/api/performer', { id });
  const days = p.days || [];
  const onTrip = p.on_trip_min || 0;
  const elapsed = days.reduce((a, d) => a + (d.elapsed_min || 0), 0);

  kh.replaceWith(kpiRow([
    { label: 'Days worked', value: fmt(days.length), sub: `week of ${esc((p.week || [])[0] || '—')}` },
    { label: 'Bookings', value: fmt(p.bookings), sub: `${fmt(days.reduce((a, d) => a + (d.completed || 0), 0))} completed` },
    { label: 'Carrying someone', value: onTrip ? `${fmt(onTrip / 60, 1)} h` : '—',
      sub: p.duration_coverage_pct != null
        ? `measured over ${p.duration_coverage_pct}% of bookings that report an end`
        : 'no booking reports an end time' },
    { label: 'Of time on the road', value: elapsed ? `${Math.round((onTrip / elapsed) * 100)}%` : '—',
      sub: 'on-trip against first request to last dropoff — the rest is waiting or repositioning' },
  ]));

  dayP.body.innerHTML = '';
  if (!days.length) empty(dayP.body, 'No booking in this week.');
  else {
    dayP.body.append(tableFrom(days, [
      { label: 'Day', key: 'day', render: (r) => String(r.day).slice(0, 10) },
      { label: 'Bookings', key: 'bookings', num: true },
      { label: 'Cancelled', key: 'cancelled', num: true },
      { label: 'Km', key: 'km', num: true, render: (r) => fmt(r.km) },
      { label: 'First', key: 'first_trip', render: (r) => hhmm(r.first_trip) },
      { label: 'Last', key: 'last_trip', render: (r) => hhmm(r.last_trip) },
      { label: 'On trip', key: 'on_trip_min', num: true,
        render: (r) => (r.on_trip_min ? `${fmt(r.on_trip_min / 60, 1)} h` : '—') },
      { label: 'Elapsed', key: 'elapsed_min', num: true,
        render: (r) => (r.elapsed_min ? `${fmt(r.elapsed_min / 60, 1)} h` : '—') },
      { label: 'Vehicle', key: 'plates',
        render: (r) => (r.plates || []).map((x) => entity('vehicle', x, x)).join(', ') || '—' },
    ]));
    if (p.note) dayP.body.append(el('p', 'cap', esc(p.note)));
  }

  platP.body.innerHTML = '';
  const plats = p.platforms || [];
  const pays = p.payouts || [];
  if (!plats.length) empty(platP.body, 'No booking in this week.');
  else {
    platP.body.append(tableFrom(plats.map((x) => {
      const pay = pays.find((y) => y.platform === x.platform);
      return { ...x, payout: pay ? pay.payout : null, period: pay ? `${String(pay.period_start).slice(0, 10)} → ${String(pay.period_end).slice(0, 10)}` : null };
    }), [
      { label: 'Channel', key: 'platform', render: (r) => pill(r.platform) },
      { label: 'Bookings', key: 'bookings', num: true },
      { label: 'Km', key: 'km', num: true, render: (r) => fmt(r.km) },
      { label: 'Fares', key: 'fares', num: true,
        render: (r) => (r.fares ? `${money(r.fares)}<span class="dim"> · ${fmt(r.priced)}</span>`
          : '<span class="ent-off" title="this channel publishes no fare per trip">—</span>') },
      { label: 'Paid', key: 'payout', num: true,
        render: (r) => (r.payout != null ? money(r.payout)
          : '<span class="ent-off" title="no payout statement covers this week for this channel">—</span>') },
      { label: 'Statement covers', key: 'period', render: (r) => (r.period ? esc(r.period) : '—') },
    ]));
    platP.body.append(el('p', 'cap',
      'A fare is what the rider or property was charged; a payout is what reached the fleet after '
      + 'the channel took its commission and after any cash the driver already holds. They are not '
      + 'added together, and a statement period is quoted whole because no channel reports a day.'));
  }

  areaP.body.innerHTML = '';
  const areas = (p.areas || []).filter((a) => a.picked_up > 0);
  if (!areas.length) empty(areaP.body, 'No pickup address on any booking this week.');
  else {
    hbars(areaP.body, areas.slice(0, 12).map((a) => ({ label: a.area, n: a.picked_up })),
      { valueFmt: (v) => `${fmt(v)} pickups` });
    areaP.body.append(el('p', 'cap',
      'Parsed from free text by taking the second dash-separated segment, which is why some rows '
      + 'are roads or a country. The raw address on each trip is the record; this is a grouping.'));
  }

  statusP.body.innerHTML = '';
  const st = p.platform_status || [];
  if (!st.length) {
    empty(statusP.body, 'No Uber driver-status row covers this person this week. '
      + 'Uber writes status against the vehicle for one org only, and reports no online hours at '
      + 'all — so time logged in is not available, and first trip is not a login.');
  } else {
    statusP.body.append(tableFrom(st, [
      { label: 'Day', key: 'day', render: (r) => String(r.day).slice(0, 10) },
      { label: 'Status', key: 'status', render: (r) => pill(r.status) },
      { label: 'Observations', key: 'n', num: true },
      { label: 'First seen', key: 'first_seen', render: (r) => hhmm(r.first_seen) },
      { label: 'Last seen', key: 'last_seen', render: (r) => hhmm(r.last_seen) },
    ]));
    statusP.body.append(el('p', 'cap',
      'A five-minute poll, not an event log: a session shorter than the interval leaves no trace, '
      + 'and the earliest observation is the first time we looked and saw them, not the moment '
      + 'they logged in.'));
  }
}

const hhmm = (ts) => {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dubai', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
};
