/* The Low performers page and a watch list, as .xlsx files.
   ═════════════════════════════════════════════════════════════════════════
   What the pages show, so ops can sort and filter the whole list: the list
   with every figure the row carries, the fortnight-style grid (each day's
   fares, and each day as a share of that day's target, "off" where they were
   active and did not drive), and the weeks. Plain numbers (src/xlsx_write.js).

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
    ...v.weeks.map((w) => `% ${w.label}`), 'Trend', 'Change (points)', 'Everyone else (points)', 'Trend note'];
  const kinds = ['int', 'text', 'text', 'text', 'text', 'text', 'num1', 'text', 'num1', 'money', 'money', 'money', 'int', 'int', 'int',
    'money', 'money', 'int', 'int', 'num1', 'num1', 'num1', 'num1', 'date', ...v.weeks.map(() => 'num1'), 'text', 'num1', 'num1', 'wrap'];
  const s2 = wb.sheet('Below target', { widths: [5, 30, 22, 9, 10, 18, 8, 22, 10, 12, 12, 12, 8, 8, 8, 11, 11, 7, 8, 8, 9, 9, 9, 11, 13, 13, 13, 11, 9, 11, 50] });
  s2.header(head, kinds);
  v.rows.forEach((r, i) => s2.row([i + 1, hid('ID', r.name), hid('ID', r.driver_ext_id), FLEET[r.fleet] || r.fleet, hid('VEH', r.plate),
    (r.platforms || []).join(', '), r.hotel_share, BAND[r.band] || null, hid('EARN', r.gross_pct), hid('EARN', r.gross),
    hid('EARN', r.gross_target), hid('EARN', r.gross_short), r.days_active, r.days_driven, r.days_off, hid('EARN', r.per_day_driven),
    hid('EARN', r.per_day_target), hid('BK', r.trips), r.trips_target, hid('BK', r.trips_pct), hid('BK', r.completion_pct),
    hid('CASH', r.cash_pct), hid('COND', r.online_h), hid('BK', r.last_booking),
    ...r.weeks.map((w) => hid('EARN', w.pct)), VERDICT[r.trend.verdict] || '—', hid('EARN', r.trend.change),
    hid('EARN', r.trend.rest_change), r.trend.why]));

  gridSheets(wb, v.days, v.rows, hid);
  const name = `low-performers-${v.from}-to-${v.to}.xlsx`;
  return { wb, name, rows: v.rows.length, days: v.days.length };
}

/* The two grids: each day's fares, and each day against that day's target. */
function gridSheets(wb, days, rows, hid) {
  const widths = [30, 9, ...days.map(() => 9)];
  const g1 = wb.sheet('Day by day (AED)', { widths });
  g1.text('Each day’s fares. The second row is what that day asked of each active driver; a day without a share was not counted.', 'dim');
  g1.push([['Each active driver’s share', 'bold'], [null], ...days.map((d) => [hid('REV', d.share), 'money'])]);
  g1.header(['Driver', 'Fleet', ...days.map((d) => d.label)], ['text', 'text', ...days.map(() => 'money')]);
  for (const r of rows) g1.row([hid('ID', r.name), FLEET[r.fleet] || r.fleet, ...r.days.map((c) => hid('EARN', c.fares))]);
  const g2 = wb.sheet('Day by day (% of target)', { widths });
  g2.text('Each day as a share of that day’s target. “off”: active that day and did not drive. Blank: the day asked nothing of them.', 'dim');
  g2.header(['Driver', 'Fleet', ...days.map((d) => d.label)], ['text', 'text', ...days.map(() => 'num1')]);
  for (const r of rows) g2.row([hid('ID', r.name), FLEET[r.fleet] || r.fleet, ...r.days.map((c) => hid('EARN', dayPct(c)))]);
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
  const slug = String(v.watch.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'list';
  return { wb, name: `watch-list-${slug}-${v.to}.xlsx`, rows: v.rows.length };
}
