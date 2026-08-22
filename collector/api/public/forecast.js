/* What next month looks like, and how much of that is a guess.
   ──────────────────────────────────────────────────────────────────────────
   A forecast is the easiest thing in this product to render dishonestly: a
   line, a number, and nothing that says how much scatter it was drawn through.
   Three things keep it honest here.

   The INTERVAL is drawn, not mentioned. A point estimate on five months of a
   recovering series is a number with a range around it wide enough to change
   what you would do, and hiding the range is the whole failure mode.

   The MONTHS IT REFUSED TO FIT are named. This fleet's bookings ran at 24,000
   a month until February and 4,203 in March; a line through that break
   predicts a recovery to 20,000 that nothing supports. The page says which
   months were excluded and why, so the choice can be argued with.

   And the FORECAST CHECKS ITSELF against the month in progress, which is the
   only out-of-sample evidence there is. A forecast nobody ever scores is a
   decoration. */

import { empty, fmt, barChart } from './charts.js';
import { el, esc, panel, loading, tableFrom, kpiRow, note, pill, dayStr } from './ui.js';
import { q, href } from './data.js';

const MONTH = (m) => {
  const [y, mm] = String(m).slice(0, 7).split('-');
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+mm - 1]} ${y.slice(2)}`;
};
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export async function renderForecast(root) {
  root.innerHTML = '';
  loading(root);
  const d = await q('/api/forecast', { horizon: 12 });
  root.innerHTML = '';

  if (!d.ok) {
    root.append(el('div', 'empty', `<b>Not enough to forecast from</b>${esc(d.reason || '')}`));
    if (d.months_used?.length) {
      root.append(note(`Months that would have been used: ${d.months_used.join(', ')}.`));
    }
    return;
  }

  const next = d.forecast[0];
  const ip = d.in_progress;

  root.append(kpiRow([
    { label: `Bookings in ${MONTH(next.m)}`, value: fmt(next.point),
      sub: next.low != null ? `somewhere between ${fmt(next.low)} and ${fmt(next.high)}` : 'no interval available',
      tone: null },
    { label: 'Trend', value: `${d.slope_per_month > 0 ? '+' : ''}${fmt(d.slope_per_month)}/month`,
      sub: `over ${d.n} months since the last break`,
      tone: d.slope_per_month > 0 ? 'good' : 'critical' },
    { label: 'How well the line fits', value: d.r2 == null ? '—' : d.r2.toFixed(2),
      sub: `typical month sits ${fmt(d.typical_error)} bookings off it`,
      tone: d.r2 == null ? null : d.r2 >= 0.8 ? 'good' : d.r2 >= 0.5 ? 'warn' : 'critical' },
    { label: 'Flat baseline', value: fmt(d.flat_baseline),
      sub: d.beats_flat ? 'the trend explains more than this does' : 'the trend does NOT beat this',
      tone: d.beats_flat ? null : 'warn' },
    d.year_ahead ? { label: 'Next twelve months', value: fmt(d.year_ahead.total),
      sub: `${d.year_ahead.forecast_months} forecast, ${12 - d.year_ahead.forecast_months} extrapolated`,
      tone: 'warn' } : null,
  ]));

  if (!d.beats_flat) {
    root.append(el('div', 'note err',
      `The fitted line explains less than half the month-to-month variation (r² ${d.r2}). On this evidence `
      + `"next month looks like the last three" — ${fmt(d.flat_baseline)} bookings — is as good a plan as the `
      + 'trend, and a good deal easier to defend. The trend is still drawn, because it may be real and simply '
      + 'not yet demonstrable on this many months.'));
  }

  /* ── the forecast checking itself ──────────────────────────────────────── */
  if (ip) {
    const { panel: p, body } = panel(`${MONTH(ip.m)} so far — the forecast marking its own work`,
      'The month in progress is the only out-of-sample evidence there is. A forecast nobody ever scores is a decoration.');
    root.append(p);
    body.append(kpiRow([
      { label: 'Bookings so far', value: fmt(ip.trips_so_far), sub: `over ${ip.days_so_far} of ${ip.days_total} days` },
      { label: 'Running at', value: `${fmt(ip.per_day, 1)}/day`, sub: 'across the days collected' },
      { label: 'On track for', value: fmt(ip.projected),
        sub: 'if the rest of the month resembles it' },
      ip.forecast != null ? { label: 'The forecast said', value: fmt(ip.forecast),
        sub: ip.low != null ? `${fmt(ip.low)} – ${fmt(ip.high)}` : null } : null,
      ip.within_interval != null ? { label: 'Inside the interval?',
        value: ip.within_interval ? 'yes' : 'no',
        sub: ip.within_interval ? 'the method is holding up' : 'the method missed this month',
        tone: ip.within_interval ? 'good' : 'critical' } : null,
    ]));
    body.append(el('p', 'cap',
      'The projection assumes the remaining days resemble the ones collected, which a month containing a '
      + 'holiday or a heat spike will not. It is a check on the forecast, not a better forecast.'));
  }

  /* ── observed and forecast on one axis ────────────────────────────────── */
  const used = new Set(d.months_used);
  const hist = d.observed.filter((m) => !m.no_data);
  const { panel: tp, body: tb } = panel('Bookings by month, observed and forecast',
    'Hatched bars are forecast. The months the fit refused to use are drawn in full, because hiding them '
    + 'would hide the reason the forecast starts where it does.');
  root.append(tp);
  const series = [
    ...hist.map((m) => ({ label: MONTH(m.m), n: m.trips,
      kind: m.partial_month ? 'partial' : used.has(m.m) ? 'fitted' : 'excluded' })),
    ...d.forecast.map((f) => ({ label: MONTH(f.m), n: f.point, kind: f.kind })),
  ];
  barChart(tb, series, { x: 'label', y: 'n', label: 'bookings',
    colorFor: (r) => ({ fitted: '--b500', excluded: '--ink-3', partial: '--ink-3',
      forecast: '--s3', extrapolation: '--s5' }[r.kind] || '--b400') });
  tb.append(el('div', 'legend', [
    ['--b500', `fitted (${d.n} months)`],
    ['--ink-3', 'not used — before the break, or a partial month'],
    ['--s3', 'forecast (3 months)'],
    ['--s5', 'extrapolation — a line, not a forecast'],
  ].map(([c, t]) => `<span><i class="sw" style="background:var(${c})"></i>${t}</span>`).join('')));

  if (d.break) {
    tb.append(el('p', 'note',
      `The fit starts at ${MONTH(d.break.to)}. Between ${MONTH(d.break.from)} and it, bookings moved `
      + `${d.break.change_pct}% and did not come back — a line drawn through that predicts a recovery to the `
      + `old level that nothing in the data supports. ${d.months_excluded.length} earlier month(s) were `
      + `excluded: ${d.months_excluded.map(MONTH).join(', ')}.`));
  }

  /* ── the months themselves, with their intervals ──────────────────────── */
  const { panel: mp, body: mb } = panel('Month by month',
    'Every figure is a range. The point estimate is the least informative thing about a forecast.');
  root.append(mp);
  mb.append(tableFrom(d.forecast, [
    { label: 'Month', key: 'm', render: (r) => MONTH(r.m) },
    { label: 'Kind', key: 'kind', render: (r) => pill(r.kind, r.kind === 'forecast' ? null : 'warn') },
    { label: 'Days', key: 'days', num: true },
    { label: 'Expected', key: 'point', num: true, render: (r) => fmt(r.point) },
    { label: 'Range', key: '_r', num: true,
      render: (r) => (r.low == null ? '—' : `${fmt(r.low)} – ${fmt(r.high)}`) },
    { label: 'Width', key: '_w', num: true,
      render: (r) => (r.low == null ? '—'
        : `<span class="dim">±${Math.round(((r.high - r.low) / 2 / Math.max(1, r.point)) * 100)}%</span>`) },
    { label: 'If flat instead', key: 'flat', num: true, render: (r) => fmt(r.flat) },
  ]));
  mb.append(el('p', 'cap',
    'The last column is what you would predict by assuming next month looks like the last three. Where the '
    + 'two disagree by less than the range, the trend is not telling you anything the flat line was not.'));

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
      + 'above — a day is not more certain than the month it sits in.'));

    if (d.weekday_shares) {
      db.append(tableFrom(d.weekday_shares, [
        { label: 'Weekday', key: 'dow', render: (r) => DOW[r.dow] },
        { label: 'Average bookings', key: 'mean', num: true, render: (r) => fmt(r.mean, 1) },
        { label: 'Share of a week', key: 'share', num: true, render: (r) => `${(r.share * 100).toFixed(1)}%` },
        { label: 'Weeks measured', key: 'n', num: true },
      ], { compact: true }));
    }
  }

  root.append(note(esc(d.revenue_note)));
  root.append(el('p', 'cap',
    `Method: ordinary least squares over ${d.n} whole months since the last regime change, with a 95% `
    + 'prediction interval for a NEW month rather than for the fitted line — operations plans against what '
    + 'next month will be, and on this few points the two differ by a factor that matters. Months three and '
    + 'beyond are extrapolation and labelled as such. '
    + `<a href="${href('causes')}">Why the numbers moved</a> · `
    + `<a href="${href('playbook')}">What to do about it</a>`));
}
