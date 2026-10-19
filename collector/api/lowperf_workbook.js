/* The Low performers page and a watch list, as .xlsx files.
   ═════════════════════════════════════════════════════════════════════════
   What the pages show, so ops can sort and filter the whole list: the list
   with every figure the row carries, the fortnight-style grid (each day's
   fares, and each day as a share of that day's target, "off" where they were
   active and did not drive), and the weeks. Plain numbers (src/xlsx_write.js).

   2026-10-19, the operator on the grid: "this should have average of all the
   days shown for the driver as well. and more granular data" — so each grid
   ends in the two averages (a day active, a day off counting as nothing; a
   day driven) and carries the list's and everyone else's day under its head,
   and four sheets follow: Day detail (one row a driver a day: start, finish,
   hours on jobs, Uber hours online, km, AED an hour and a trip, abandoned and
   declined, platforms, car), Why below target (each measured cause against
   everyone else's middle value), Weekdays and Hours.

   A class the reader's role does not hold in full is written "(withheld)" in
   every cell of it — the Today and Month target workbooks' rule: the access
   layer shapes JSON and never sees the inside of a file. */
import { Workbook } from '../src/xlsx_write.js';
import { BANDS, TREND_POINTS, WEEK_MIN_ACTIVE, MOSTLY_HOTEL } from './lowperf.js';

export const LOWPERF_FILE_CLASSES = ['ID', 'EARN', 'BK', 'REV', 'VEH', 'CASH', 'COND'];
const W = '(withheld)';
const BAND = Object.fromEntries(BANDS.map((b) => [b.key, b.label]));
const HOTEL = {
  hide: 'Drivers who drove only for the hotel channel are left out.',
  mostly: `Drivers with more than ${MOSTLY_HOTEL}% of their bookings on the hotel channel are left out.`,
  show: 'Every driver, hotel drivers included.',
};
const FLEET = { ecosine: 'Ecosine', egari: 'Egari' };
const VERDICT = { improving: 'improving', steady: 'steady', slipping: 'slipping' };

const RULE = 'A driver’s target for a day is that day’s plan — the month target spread over its days by the cars that earned the week '
  + 'before and the weekday — shared equally among the drivers active that day (a completed trip in the 8 Dubai days to it). '
  + 'A day they were active and did not drive still asks its share. Only settled days count: every channel delivered and 99% of '
  + 'bookings priced, in a month with a target. Gross is their fares on every platform, before any commission. '
  + 'These are the Month target page’s own figures for the same days.';
const TREND_RULE = `Improving or slipping: the person’s share of target moved at least ${TREND_POINTS} points more, or less, than `
  + `everyone else’s between the two spans; steady otherwise. A span needs ${WEEK_MIN_ACTIVE} active days to say (one when it is a single day).`;

const hider = (hide) => (cls, x) => (hide.has(cls) ? W : x);
/* A day's cell as a share of that day's target: "off" for a day active and
   not driven, "—" for a day that asked nothing of them. */
const dayPct = (c) => (c.share == null ? null : c.trips > 0 || c.fares > 0 ? Math.round((1000 * c.fares) / c.share) / 10 : 'off');

/** Pure: the list's workbook, from the view the route (or the mock, or a test)
    already holds. */
export function lowperfWorkbookOf(v, { now = new Date(), hide = new Set() } = {}) {
  const hid = hider(hide);
  const wb = new Workbook({ created: now });
  const t = v.totals;
  const s1 = wb.sheet('Summary', { widths: [40, 24, 90] });
  s1.text(`Low performers — ${v.from} to ${v.to}`, 'title');
  s1.text(`Every driver below their target over the period. ${HOTEL[v.hotel] || ''} ${v.fleet ? `${FLEET[v.fleet] || v.fleet} only.` : 'Both fleets.'}`, 'dim');
  for (const n of v.notes || []) s1.text(n, 'dim');
  s1.blank();
  if (v.why) s1.text(v.why, 'wrap');
  const pairs = [
    ['Days counted', v.counted_days, 'int', v.left_out.length ? `Left out: ${v.left_out.map((d) => `${d.label} (${d.why})`).join('; ')}` : 'Every day of the period is settled.'],
    ['Drivers measured', t.population, 'int', 'Active on a counted day of the period, after the hotel and fleet settings.'],
    ['Below target', t.below, 'int', null],
    ...BANDS.map((b) => [`  ${b.label}`, t.bands[b.key], 'int', null]),
    ['On or above target', t.on_target, 'int', null],
    ['Hotel-only drivers left out', t.hidden_hotel_only, 'int', null],
    ['Mostly-hotel drivers left out', t.hidden_mostly_hotel, 'int', null],
    ['Plan for the counted days (AED)', hid('REV', t.plan), 'money', 'What the fleet was asked on those days. Every active driver’s target adds up to it.'],
    ['Below-target drivers: earned (AED)', hid('EARN', t.below_gross), 'money', null],
    ['Below-target drivers: asked (AED)', hid('EARN', t.below_target), 'money', null],
    ['Below-target drivers: short by (AED)', hid('EARN', t.below_short), 'money', null],
    ['Everyone else, % of target', hid('EARN', v.yardstick.rest.pct), 'num1', `${v.yardstick.rest.people} drivers.`],
    ['Improving / steady / slipping / too few days', `${t.trend.improving} / ${t.trend.steady} / ${t.trend.slipping} / ${t.trend.unknown}`, 'text',
      `Over ${v.weeks[1].label} against ${v.weeks[2].label}, held against everyone else.`],
  ];
  for (const [label, x, kind, note] of pairs) s1.push([[label, 'bold'], [x, kind], [note, 'dim']]);
  s1.blank();
  s1.text('How a driver’s target is set', 'bold');
  s1.text(RULE, 'wrap');
  s1.text(TREND_RULE, 'wrap');

  const head = ['#', 'Driver', 'Driver id', 'Fleet', 'Car', 'Platforms', 'Hotel %', 'Band', '% of target', 'Gross (AED)',
    'Target (AED)', 'Short by (AED)', 'Days active', 'Days driven', 'Days off', 'AED a day driven', 'Target a day (AED)',
    'Trips', 'Trips target', 'Trips %', 'Completed %', 'Cash rides %', 'Uber hours online', 'Last booking',
    ...v.weeks.map((w) => `% ${w.label}`), 'Trend', 'Change (points)', 'Everyone else (points)', 'Trend note',
    ...MORE.map(([h]) => h)];
  const kinds = ['int', 'text', 'text', 'text', 'text', 'text', 'num1', 'text', 'num1', 'money', 'money', 'money', 'int', 'int', 'int',
    'money', 'money', 'int', 'int', 'num1', 'num1', 'num1', 'num1', 'date', ...v.weeks.map(() => 'num1'), 'text', 'num1', 'num1', 'wrap',
    ...MORE.map(([, k]) => k)];
  const s2 = wb.sheet('Below target', { widths: [5, 30, 22, 9, 10, 18, 8, 22, 10, 12, 12, 12, 8, 8, 8, 11, 11, 7, 8, 8, 9, 9, 9, 11, 13, 13, 13, 11, 9, 11, 50,
    ...MORE.map(([, , w]) => w)] });
  s2.header(head, kinds);
  v.rows.forEach((r, i) => s2.row([i + 1, hid('ID', r.name), hid('ID', r.driver_ext_id), FLEET[r.fleet] || r.fleet, hid('VEH', r.plate),
    (r.platforms || []).join(', '), r.hotel_share, BAND[r.band] || null, hid('EARN', r.gross_pct), hid('EARN', r.gross),
    hid('EARN', r.gross_target), hid('EARN', r.gross_short), r.days_active, r.days_driven, r.days_off, hid('EARN', r.per_day_driven),
    hid('EARN', r.per_day_target), hid('BK', r.trips), r.trips_target, hid('BK', r.trips_pct), hid('BK', r.completion_pct),
    hid('CASH', r.cash_pct), hid('COND', r.online_h), hid('BK', r.last_booking),
    ...r.weeks.map((w) => hid('EARN', w.pct)), VERDICT[r.trend.verdict] || '—', hid('EARN', r.trend.change),
    hid('EARN', r.trend.rest_change), r.trend.why, ...more(r, hid)]));

  gridSheets(wb, v.days, v.rows, hid);
  detailSheet(wb, v.days, v.rows, hid);
  causesSheet(wb, v, hid);
  patternSheets(wb, v, hid);
  const name = `low-performers-${v.from}-to-${v.to}.xlsx`;
  return { wb, name, rows: v.rows.length, days: v.days.length };
}

/* The person's further figures on the list sheet: the two averages and what
   the causes are judged on. [header, kind, width, (row, hid) => value]. */
const hm = (m) => (m == null ? null : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
const CAUSE_WORD = { days_off: 'days off', short_days: 'short days', low_rate: 'low AED an hour', late_start: 'late starts', few_trips: 'few trips', abandons: 'abandoned jobs' };
const causeText = (r) => (r.causes ? Object.keys(r.causes).map((k) => CAUSE_WORD[k] || k).join(', ') || 'no single cause' : null);
const MORE = [
  ['Average a day active (AED)', 'money', 12, (r, h) => h('EARN', r.avg_active)],
  ['Average a day active, % of target', 'num1', 11, (r, h) => h('EARN', r.avg_active_pct)],
  ['Average a day driven (AED)', 'money', 12, (r, h) => h('EARN', r.avg_driven)],
  ['Average a day driven, % of target', 'num1', 11, (r, h) => h('EARN', r.avg_driven_pct)],
  ['Hours on jobs a day driven', 'num1', 10, (r, h) => h('BK', r.job_h_day)],
  ['AED an hour on jobs', 'money', 10, (r, h) => h('EARN', r.aed_per_job_h)],
  ['AED a trip', 'money', 9, (r, h) => h('EARN', r.trips ? Math.round((100 * r.gross) / r.trips) / 100 : null)],
  ['Trips a day driven', 'num1', 9, (r, h) => h('BK', r.trips_day)],
  ['Typical first request', 'text', 9, (r, h) => h('BK', hm(r.start_med))],
  ['Typical last drop-off', 'text', 9, (r, h) => h('BK', hm(r.finish_med))],
  ['Km a day driven', 'num1', 9, (r, h) => h('BK', r.km_day)],
  ['Uber online a day (h)', 'num1', 9, (r, h) => h('COND', r.online_h_day)],
  ['Abandoned after accepting', 'int', 9, (r, h) => h('COND', r.abandoned)],
  ['Declined offers', 'int', 9, (r, h) => h('COND', r.declined)],
  ['Abandoned, % of accepted', 'num1', 9, (r, h) => h('COND', r.abandon_pct)],
  ['Why below target', 'wrap', 36, (r) => causeText(r)],
];
const more = (r, hid) => MORE.map(([, , , f]) => f(r, hid));
const mean = (xs) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null);
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);

/* The two grids: each day's fares, and each day against that day's target,
   each ending in the person's two averages, the list's and everyone else's
   day under the head. */
function gridSheets(wb, days, rows, hid) {
  const widths = [30, 9, ...days.map(() => 9), 12, 12];
  const counted = (k) => r2(mean(days.filter((d) => d.counted && d[k] != null).map((d) => d[k])));
  const pctOf = (x, d) => (x == null || !d.share ? null : Math.round((1000 * x) / d.share) / 10);
  const g1 = wb.sheet('Day by day (AED)', { widths });
  g1.text('Each day’s fares. Under the head: what that day asked of each active driver (a day without a share was not counted), '
    + 'then the day’s average among the people below target and among everyone else active on it, a day off counting as nothing. '
    + 'Each row ends in the person’s average a day active (a day off counting as nothing — the base the target is judged on) and a day driven.', 'dim');
  g1.header(['Driver', 'Fleet', ...days.map((d) => d.label), 'Average a day active', 'Average a day driven'],
    ['text', 'text', ...days.map(() => 'money'), 'money', 'money']);
  g1.push([['Each active driver’s share', 'bold'], [null], ...days.map((d) => [hid('REV', d.share), 'money']), [hid('REV', counted('share')), 'money'], [null]]);
  if (days.some((d) => d.list_avg != null)) g1.push([['Their average', 'bold'], [null], ...days.map((d) => [hid('EARN', d.list_avg), 'money']), [hid('EARN', counted('list_avg')), 'money'], [null]]);
  if (days.some((d) => d.rest_avg != null)) g1.push([['Everyone else', 'bold'], [null], ...days.map((d) => [hid('EARN', d.rest_avg), 'money']), [hid('EARN', counted('rest_avg')), 'money'], [null]]);
  for (const r of rows) g1.row([hid('ID', r.name), FLEET[r.fleet] || r.fleet, ...r.days.map((c) => hid('EARN', c.fares)), hid('EARN', r.avg_active), hid('EARN', r.avg_driven)]);
  const g2 = wb.sheet('Day by day (% of target)', { widths });
  g2.text('Each day as a share of that day’s target. “off”: active that day and did not drive. Blank: the day asked nothing of them. '
    + 'Each row ends in the person’s two averages as a share of their target a day.', 'dim');
  g2.header(['Driver', 'Fleet', ...days.map((d) => d.label), 'Average a day active, %', 'Average a day driven, %'],
    ['text', 'text', ...days.map(() => 'num1'), 'num1', 'num1']);
  const pctRow = (label, k) => [[label, 'bold'], [null], ...days.map((d) => [hid('EARN', pctOf(d[k], d)), 'num1']),
    [hid('EARN', r1(mean(days.filter((d) => d.counted).map((d) => pctOf(d[k], d)).filter((x) => x != null)))), 'num1'], [null]];
  if (days.some((d) => d.list_avg != null)) g2.push(pctRow('Their average', 'list_avg'));
  if (days.some((d) => d.rest_avg != null)) g2.push(pctRow('Everyone else', 'rest_avg'));
  for (const r of rows) g2.row([hid('ID', r.name), FLEET[r.fleet] || r.fleet, ...r.days.map((c) => hid('EARN', dayPct(c))), hid('EARN', r.avg_active_pct), hid('EARN', r.avg_driven_pct)]);
}

/* One row a driver a day: every day they were active or drove. */
function detailSheet(wb, days, rows, hid) {
  const s = wb.sheet('Day detail', { widths: [30, 9, 12, 9, 11, 11, 8, 7, 9, 8, 8, 9, 9, 8, 10, 9, 10, 9, 16, 10] });
  s.text('Every day each driver was active or drove. First request and last drop-off in Dubai time; hours on jobs: request to drop-off, summed; '
    + 'Uber online: the hours Uber filed them online; abandoned: accepted then cancelled by the driver; declined: offers turned down (Bolt).', 'dim');
  s.header(['Driver', 'Fleet', 'Day', 'Counted', 'Asked (AED)', 'Fares (AED)', '% of day', 'Trips', 'Bookings', 'First request', 'Last drop-off',
    'Hours on jobs', 'Uber online (h)', 'Km', 'AED an hour on jobs', 'AED a trip', 'Abandoned', 'Declined', 'Platforms', 'Car'],
  ['text', 'text', 'date', 'text', 'money', 'money', 'num1', 'int', 'int', 'text', 'text', 'num1', 'num1', 'num1', 'money', 'money', 'int', 'int', 'text', 'text']);
  for (const r of rows) {
    r.days.forEach((c, i) => {
      if (c.share == null && !c.trips && !c.bookings) return;
      const d = days[i];
      s.row([hid('ID', r.name), FLEET[r.fleet] || r.fleet, d.day, d.counted ? 'yes' : 'no', hid('REV', c.share), hid('EARN', c.fares),
        hid('EARN', c.share ? Math.round((1000 * c.fares) / c.share) / 10 : null), hid('BK', c.trips), hid('BK', c.bookings),
        hid('BK', hm(c.first)), hid('BK', hm(c.last)), hid('BK', c.job_min == null ? null : r1(c.job_min / 60)),
        hid('COND', c.online_min == null ? null : r1(c.online_min / 60)), hid('BK', c.km),
        hid('EARN', c.job_min ? r2(c.fares / (c.job_min / 60)) : null), hid('EARN', c.trips ? r2(c.fares / c.trips) : null),
        hid('COND', c.abandoned), hid('COND', c.declined), (c.platforms || []).join(', '), hid('VEH', c.plate)]);
    });
  }
}

/* Each measured cause against everyone else's middle value. */
function causesSheet(wb, v, hid) {
  if (!v.cause_rules) return;
  const md = v.medians || {};
  const s = wb.sheet('Why below target', { widths: [30, 9, 10, 12, 12, 12, 12, 12, 12, 40] });
  s.text(`Each cause is a measurement held against everyone else’s middle value — the ${md.people ?? 0} drivers on or over target, the same days and settings. `
    + 'Rate-type measures need three days driven.', 'dim');
  for (const c of v.cause_rules) s.push([[c.label, 'bold'], [v.totals.causes?.[c.key] ?? 0, 'int'], [c.rule, 'wrap']]);
  s.push([['No single cause', 'bold'], [v.totals.no_cause ?? 0, 'int'], ['The gap is spread across days, hours and rate.', 'wrap']]);
  s.blank();
  const head = ['Driver', 'Fleet', '% of target', 'Days off, % of active', 'Hours on jobs a day', 'AED an hour on jobs', 'First request',
    'Trips a day driven', 'Abandoned, % of accepted', 'Causes'];
  const kinds = ['text', 'text', 'num1', 'num1', 'num1', 'money', 'text', 'num1', 'num1', 'wrap'];
  s.header(head, kinds);
  s.push([['Everyone else’s middle value', 'bold'], [null], [null], [md.off_share, 'num1'], [hid('BK', md.job_h_day), 'num1'],
    [hid('EARN', md.aed_per_job_h), 'money'], [hid('BK', hm(md.start_med)), 'text'], [hid('BK', md.trips_day), 'num1'], [hid('COND', md.abandon_pct), 'num1'], [null]]);
  for (const r of v.rows) {
    s.row([hid('ID', r.name), FLEET[r.fleet] || r.fleet, hid('EARN', r.gross_pct), r.days_active ? r1((100 * r.days_off) / r.days_active) : null,
      hid('BK', r.job_h_day), hid('EARN', r.aed_per_job_h), hid('BK', hm(r.start_med)), hid('BK', r.trips_day), hid('COND', r.abandon_pct), causeText(r)]);
  }
}

/* Share of target by weekday, and completed trips by the hour requested. */
function patternSheets(wb, v, hid) {
  if (!v.weekdays) return;
  const wd = v.weekdays.below.map((w) => w.label);
  const s = wb.sheet('Weekdays', { widths: [30, 9, ...wd.map(() => 9)] });
  s.text('Fares as a share of their own targets on each weekday, over the counted days of the period.', 'dim');
  s.header(['Driver', 'Fleet', ...wd.map((x) => `${x} %`)], ['text', 'text', ...wd.map(() => 'num1')]);
  s.push([['Below target', 'bold'], [null], ...v.weekdays.below.map((w) => [hid('EARN', w.pct), 'num1'])]);
  s.push([['Everyone else', 'bold'], [null], ...v.weekdays.rest.map((w) => [hid('EARN', w.pct), 'num1'])]);
  for (const r of v.rows) s.row([hid('ID', r.name), FLEET[r.fleet] || r.fleet, ...(r.weekdays || []).map((w) => hid('EARN', w.pct))]);
  const hrs = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'));
  const h = wb.sheet('Hours', { widths: [30, 9, ...hrs.map(() => 6)] });
  h.text('Completed trips by the Dubai hour they were requested, over the period; the fleet row counts every booking.', 'dim');
  h.header(['Driver', 'Fleet', ...hrs], ['text', 'text', ...hrs.map(() => 'int')]);
  h.push([['Below target', 'bold'], [null], ...(v.hours?.below || []).map((x) => [hid('BK', x), 'int'])]);
  h.push([['Everyone else', 'bold'], [null], ...(v.hours?.rest || []).map((x) => [hid('BK', x), 'int'])]);
  h.push([['Fleet bookings', 'bold'], [null], ...(v.hours?.fleet || []).map((x) => [hid('BK', x), 'int'])]);
  for (const r of v.rows) h.row([hid('ID', r.name), FLEET[r.fleet] || r.fleet, ...(r.hours || []).map((x) => hid('BK', x))]);
}

/** Pure: a watch list's workbook. */
export function watchWorkbookOf(v, { now = new Date(), hide = new Set() } = {}) {
  const hid = hider(hide);
  const wb = new Workbook({ created: now });
  const s1 = wb.sheet('Watch list', { widths: [40, 24, 90] });
  s1.text(`Watch list — ${v.watch.name}`, 'title');
  s1.text(`Saved ${v.watch.saved_day}${v.watch.period_from ? `, from the period ${v.watch.period_from} to ${v.watch.period_to}` : ''}. `
    + `${HOTEL[v.watch.hotel] || ''} ${v.watch.fleet ? `${FLEET[v.watch.fleet] || v.watch.fleet} only.` : 'Both fleets.'}`, 'dim');
  s1.blank();
  const pairs = [
    ['Members', v.rows.length, 'int', v.missing.length ? `${v.missing.length} not found on any day shown.` : null],
    [`The list, ${v.a.label}`, hid('EARN', v.list.a.pct), 'num1', '% of target.'],
    [`The list, ${v.b.label}`, hid('EARN', v.list.b.pct), 'num1', '% of target.'],
    ['The list moved (points)', hid('EARN', v.list.change), 'num1', null],
    [`Everyone else, ${v.a.label}`, hid('EARN', v.rest.a.pct), 'num1', `${v.rest.people} drivers.`],
    [`Everyone else, ${v.b.label}`, hid('EARN', v.rest.b.pct), 'num1', null],
    ['Everyone else moved (points)', hid('EARN', v.rest.change), 'num1', null],
    ['Improving / steady / slipping / too few days', `${v.moves.improving} / ${v.moves.steady} / ${v.moves.slipping} / ${v.moves.unknown}`, 'text', null],
  ];
  for (const [label, x, kind, note] of pairs) s1.push([[label, 'bold'], [x, kind], [note, 'dim']]);
  s1.blank();
  s1.text(RULE, 'wrap');
  s1.text(TREND_RULE, 'wrap');

  const s2 = wb.sheet('Members', { widths: [30, 22, 9, 10, 12, 12, 10, 12, 12, 10, 10, 10, 10, 11, 50] });
  s2.header(['Driver', 'Driver id', 'Fleet', 'Car', `Gross ${v.a.label}`, `Target ${v.a.label}`, `% ${v.a.label}`,
    `Gross ${v.b.label}`, `Target ${v.b.label}`, `% ${v.b.label}`, 'Change (points)', 'Everyone else (points)', 'Beyond everyone else',
    'Verdict', 'Note'],
  ['text', 'text', 'text', 'text', 'money', 'money', 'num1', 'money', 'money', 'num1', 'num1', 'num1', 'num1', 'text', 'wrap']);
  for (const r of v.rows) {
    s2.row([hid('ID', r.name), hid('ID', r.driver_ext_id), FLEET[r.fleet] || r.fleet, hid('VEH', r.plate),
      hid('EARN', r.a.gross), hid('EARN', r.a.target), hid('EARN', r.a.pct), hid('EARN', r.b.gross), hid('EARN', r.b.target),
      hid('EARN', r.b.pct), hid('EARN', r.move.change), hid('EARN', r.move.rest_change), hid('EARN', r.move.relative),
      VERDICT[r.move.verdict] || '—', r.move.why]);
  }
  gridSheets(wb, v.days, v.rows, hid);
  detailSheet(wb, v.days, v.rows, hid);
  const slug = String(v.watch.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'list';
  return { wb, name: `watch-list-${slug}-${v.to}.xlsx`, rows: v.rows.length };
}
