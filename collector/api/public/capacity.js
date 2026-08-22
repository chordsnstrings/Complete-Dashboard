/* Which shifts to add, and which to stop paying for.
   ──────────────────────────────────────────────────────────────────────────
   The forecast says how much work is coming. The slot pages say who covers
   each hour now. This is the join: for every weekday-hour, next month's
   projected bookings against what the drivers who actually work that hour have
   historically delivered in it.

   The number it produces is a division, not a capacity claim, and the page
   says so in as many words. A driver's throughput in an hour is a measurement
   taken under whatever demand there was — a quiet hour makes its drivers look
   unproductive and a frantic one makes them look heroic. Presenting that as
   "how much a driver can do" would turn an artefact of demand into a
   performance judgement about people. */

import { empty, fmt, heatmap } from './charts.js';
import { el, esc, panel, loading, tableFrom, kpiRow, note, pill } from './ui.js';
import { q, href } from './data.js';

const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = (m) => {
  const [y, mm] = String(m).slice(0, 7).split('-');
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+mm - 1]} ${y.slice(2)}`;
};
const slotLink = (r) => href('slot', String(r.dow), String(r.hour));
const hhmm = (h) => `${String(h).padStart(2, '0')}:00`;

export async function renderCapacity(root) {
  root.innerHTML = '';
  loading(root);
  const d = await q('/api/capacity');
  root.innerHTML = '';

  if (!d.ok) {
    root.append(el('div', 'empty', `<b>Cannot plan a rota yet</b>${esc(d.reason || '')}`));
    return;
  }

  const t = d.totals || {};
  root.append(kpiRow([
    { label: `Bookings expected in ${MONTH(d.target_month)}`, value: fmt(d.target_bookings),
      sub: d.target_low != null ? `${fmt(d.target_low)} – ${fmt(d.target_high)}` : null,
      tone: d.forecast_kind === 'extrapolation' ? 'warn' : null },
    { label: 'Hours needing more people', value: fmt(t.cells_short),
      sub: 'at the rate their own drivers currently work them',
      tone: t.cells_short ? 'warn' : 'good' },
    { label: 'Hours with people to spare', value: fmt(t.cells_spare),
      sub: 'covered beyond what the projection needs' },
    { label: 'Busiest single hour', value: t.drivers_needed_peak ? `${t.drivers_needed_peak} drivers` : '—',
      sub: 'the most any one weekday-hour would need' },
    { label: 'Hours with too little history', value: fmt(t.cells_thin),
      sub: 'seen fewer than four times — shown, not planned on', tone: t.cells_thin ? 'warn' : null },
  ]));

  if (d.forecast_kind === 'extrapolation') {
    root.append(el('div', 'note err',
      `${MONTH(d.target_month)} is beyond the third forecast month, so its total is an extrapolation rather `
      + 'than a forecast. Every figure below inherits that: read them as a shape, not as a rota.'));
  }

  /* ── where the gap is ─────────────────────────────────────────────────── */
  const g = el('div', 'grid g2'); root.append(g);

  const { panel: sp, body: sb } = panel('Add people here',
    'Hours where the projection exceeds what the drivers who currently work them have been delivering. '
    + 'Ordered by the size of the gap.');
  g.append(sp);
  if (!d.shortfall.length) empty(sb, 'No hour is projected to need more than it currently gets.');
  else {
    sb.append(gapTable(d.shortfall));
    const worst = d.shortfall[0];
    sb.append(el('p', 'note',
      `The largest gap is ${DOW[worst.dow]} at ${hhmm(worst.hour)}: ${fmt(worst.expected_per_occurrence, 1)} `
      + `bookings expected each time it comes round, against ${fmt(worst.drivers_per_occurrence, 1)} drivers `
      + `who between them have been doing ${fmt(worst.bookings_per_driver, 1)} each. That is `
      + `${fmt(worst.drivers_needed, 1)} people at the current rate — about `
      + `${Math.ceil(worst.driver_gap)} more than turn up now.`));
  }

  const { panel: pp, body: pb } = panel('Cover to spare here',
    'Hours covered beyond what the projection needs. Worth checking before adding people elsewhere — '
    + 'moving somebody is cheaper than recruiting.');
  g.append(pp);
  if (!d.surplus.length) empty(pb, 'No hour is covered beyond its projection.');
  else pb.append(gapTable(d.surplus));

  /* ── the whole week ───────────────────────────────────────────────────── */
  const { panel: hp, body: hb } = panel('Every hour of the week',
    'Darker means more people needed at the current rate. Click an hour to open it.');
  root.append(hp);
  const grid = d.cells.map((c) => ({ dow: c.dow, h: c.hour, trips: c.drivers_needed ?? 0 }));
  heatmap(hb, grid, { onClick: (c) => { location.hash = href('slot', String(c.dow), String(c.h)); } });
  hb.append(el('p', 'cap',
    'The scale is drivers needed, not bookings — an hour with modest demand and nobody on it matters more '
    + 'to a rota than a busy hour that is already staffed.'));

  /* ── the arithmetic, in full ──────────────────────────────────────────── */
  const { panel: ap, body: ab } = panel('Every hour, with the arithmetic',
    `Shares measured over the trailing ${d.window_days} days — the fleet that produced last year's hours is `
    + 'not the one rostering next month, and a shape averaged across a 76% collapse describes neither.');
  root.append(ap);
  ab.append(tableFrom(
    [...d.cells].sort((a, b) => (b.driver_gap ?? -99) - (a.driver_gap ?? -99)).slice(0, 60), [
      { label: 'Hour', key: '_s', render: (r) => `<a href="${slotLink(r)}">${SHORT[r.dow]} ${hhmm(r.hour)}</a>`
        + (r.thin ? ' <span class="tag warn">thin history</span>' : '') },
      { label: 'Share of the month', key: 'share_pct', num: true, render: (r) => `${r.share_pct}%` },
      { label: 'Expected', key: 'expected_month', num: true,
        render: (r) => `${fmt(r.expected_month)} <small class="dim">${fmt(r.expected_per_occurrence, 1)}/time</small>` },
      { label: 'Drivers now', key: 'drivers_per_occurrence', num: true, render: (r) => fmt(r.drivers_per_occurrence, 1) },
      { label: 'Each doing', key: 'bookings_per_driver', num: true,
        render: (r) => (r.bookings_per_driver == null ? '—' : fmt(r.bookings_per_driver, 1)) },
      { label: 'Needed at that rate', key: 'drivers_needed', num: true,
        render: (r) => (r.drivers_needed == null ? '—' : fmt(r.drivers_needed, 1)) },
      { label: 'Gap', key: 'driver_gap', num: true, render: (r) => (r.driver_gap == null ? '—'
        : `<span class="pill ${r.driver_gap >= 0.5 ? 'bad' : r.driver_gap <= -0.5 ? 'ok' : ''}">`
          + `${r.driver_gap > 0 ? '+' : ''}${fmt(r.driver_gap, 1)}</span>`) },
    ]));

  root.append(note(esc(d.caveat)));
  root.append(el('p', 'cap',
    `<a href="${href('forecast')}">Where the monthly total comes from</a> · `
    + `<a href="${href('playbook')}">What else to do about it</a> · `
    + `<a href="${href('retention')}">Whether the people to fill these hours are still here</a>`));
}

function gapTable(rows) {
  return tableFrom(rows, [
    { label: 'Hour', key: '_s', render: (r) => `<a href="${slotLink(r)}">${DOW[r.dow]} ${hhmm(r.hour)}</a>` },
    { label: 'Expected each time', key: 'expected_per_occurrence', num: true,
      render: (r) => fmt(r.expected_per_occurrence, 1) },
    { label: 'Drivers now', key: 'drivers_per_occurrence', num: true, render: (r) => fmt(r.drivers_per_occurrence, 1) },
    { label: 'Needed', key: 'drivers_needed', num: true, render: (r) => fmt(r.drivers_needed, 1) },
    { label: 'Gap', key: 'driver_gap', num: true,
      render: (r) => `<span class="pill ${r.driver_gap > 0 ? 'bad' : 'ok'}">${r.driver_gap > 0 ? '+' : ''}${fmt(r.driver_gap, 1)}</span>` },
  ], { compact: true });
}
