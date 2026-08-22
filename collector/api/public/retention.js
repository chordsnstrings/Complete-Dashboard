/* Who joins, who stays, who quietly stops.
   ──────────────────────────────────────────────────────────────────────────
   The earning driver count on this fleet ran 110, then 50, then 88. That
   single number is compatible with two opposite businesses — one that keeps
   its people and stopped recruiting, and one that recruits hard and cannot
   keep anybody — and the remedy for each makes the other worse. This page
   exists to separate them, which a headcount cannot do and a cohort can. */

import { empty, fmt, barChart } from './charts.js';
import { el, esc, panel, loading, tableFrom, kpiRow, note, pill, entity } from './ui.js';
import { q, href } from './data.js';

const MONTH = (m) => {
  const [y, mm] = String(m).slice(0, 7).split('-');
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+mm - 1]} ${y.slice(2)}`;
};

export async function renderRetention(root) {
  root.innerHTML = '';
  loading(root);
  const d = await q('/api/retention');
  root.innerHTML = '';

  if (!d.ok) return empty(root, d.reason || 'Not enough history to follow a cohort.');

  const flowLast = d.flow[d.flow.length - 1] || {};
  const t = d.tenure || {};
  const real = d.cohorts.filter((c) => !c.is_left_censored);
  const recruited = real.reduce((a, c) => a + c.size, 0);
  const kept = real.reduce((a, c) => a + c.still_active, 0);

  root.append(kpiRow([
    { label: `Earning in ${MONTH(d.last_complete_month)}`, value: fmt(flowLast.active),
      sub: flowLast.net == null ? null
        : `${flowLast.net >= 0 ? '+' : ''}${flowLast.net} on the month`,
      tone: flowLast.net < 0 ? 'critical' : flowLast.net > 0 ? 'good' : null },
    { label: 'Stopped that month', value: fmt(d.stopped_last_month.length),
      sub: 'worked the month before and not this one',
      tone: d.stopped_last_month.length ? 'warn' : 'good' },
    { label: 'Started that month', value: fmt(d.started_last_month.length),
      sub: 'first booking anywhere',
      tone: d.started_last_month.length < d.stopped_last_month.length ? 'warn' : 'good' },
    { label: 'Recruits still working', value: recruited ? `${fmt(kept)} of ${fmt(recruited)}` : '—',
      sub: recruited ? `${Math.round((kept / recruited) * 100)}% of everybody who joined since the record began` : null,
      tone: recruited && kept / recruited < 0.4 ? 'critical' : 'warn' },
    { label: 'Typical run before stopping', value: t.median_months_leavers != null
      ? `${t.median_months_leavers} month${t.median_months_leavers === 1 ? '' : 's'}` : '—',
      sub: `over ${fmt(t.leavers)} people who have stopped` },
  ]));

  /* The question the headcount cannot answer, answered. */
  const inflow = d.flow.reduce((a, f) => a + (f.joined || 0) + (f.returning || 0), 0);
  const outflow = d.flow.reduce((a, f) => a + (f.left || 0), 0);
  if (inflow || outflow) {
    root.append(el('div', 'note',
      `Across the record ${fmt(inflow)} driver-months arrived (${fmt(d.flow.reduce((a, f) => a + f.joined, 0))} `
      + `genuinely new, ${fmt(d.flow.reduce((a, f) => a + f.returning, 0))} returning after a gap) and `
      + `${fmt(outflow)} left. `
      + (outflow > inflow
        ? 'More left than arrived, so the fall in headcount is people going, not recruitment stopping — '
          + 'and hiring alone will not hold the number up while the back door is open.'
        : 'More arrived than left, so the headcount is being held up by intake rather than by retention.')));
  }

  /* ── the flow ─────────────────────────────────────────────────────────── */
  const { panel: fp, body: fb } = panel('Where the headcount goes each month',
    'Arrivals split into genuinely new and returning after a gap. A driver counts as active in a month '
    + 'when they took at least one booking in it.');
  root.append(fp);
  barChart(fb, d.flow.map((f) => ({ label: MONTH(f.m), n: f.active })),
    { x: 'label', y: 'n', label: 'drivers earning' });
  fb.append(tableFrom(d.flow, [
    { label: 'Month', key: 'm', render: (r) => MONTH(r.m) },
    { label: 'Earning', key: 'active', num: true },
    { label: 'New', key: 'joined', num: true,
      render: (r) => (r.joined ? `<span class="pill ok">+${r.joined}</span>` : '—') },
    { label: 'Returned', key: 'returning', num: true,
      render: (r) => (r.returning ? `+${r.returning}` : '—') },
    { label: 'Stopped', key: 'left', num: true,
      render: (r) => (r.left ? `<span class="pill bad">−${r.left}</span>` : '—') },
    { label: 'Net', key: 'net', num: true,
      render: (r) => (r.net == null ? '—' : `${r.net > 0 ? '+' : ''}${r.net}`) },
  ], { compact: true }));

  /* ── the cohort table ─────────────────────────────────────────────────── */
  const { panel: cp, body: cb } = panel('Of the drivers who started in each month, how many were still working later',
    'Each row follows one intake group. Reading down a column compares groups at the same age.');
  root.append(cp);

  const maxOffset = Math.max(...d.cohorts.map((c) => c.months_observed));
  const tbl = el('div', 'tbl-wrap');
  const cells = d.cohorts.map((c) => {
    const tds = [];
    for (let k = 0; k < maxOffset; k++) {
      const r = c.retained[k];
      if (!r) { tds.push('<td class="num dim">·</td>'); continue; }
      // Intensity from the retention itself, so the shape is readable at a glance.
      const a = 0.08 + 0.62 * (r.pct / 100);
      tds.push(`<td class="num" style="background:color-mix(in srgb, var(--b400) ${Math.round(a * 100)}%, transparent)"
        title="${esc(MONTH(r.m))}: ${r.n} of ${c.size}">${r.pct}%</td>`);
    }
    return `<tr>
      <td>${esc(MONTH(c.cohort))}${c.is_left_censored ? ' <span class="tag warn">roster at start</span>' : ''}</td>
      <td class="num">${c.size}</td>${tds.join('')}</tr>`;
  }).join('');
  tbl.innerHTML = `<table><thead><tr><th>Started</th><th class="num">People</th>
    ${Array.from({ length: maxOffset }, (_, k) => `<th class="num">${k === 0 ? 'that month' : `+${k}`}</th>`).join('')}
    </tr></thead><tbody>${cells}</tbody></table>`;
  cb.append(tbl);

  if (d.cohorts.some((c) => c.is_left_censored)) {
    cb.append(el('p', 'note',
      `The ${MONTH(d.cohorts[0].cohort)} row is not an intake group. Everybody earning in the first month of `
      + 'the record appears to have started then, including people who had been driving for years, so its '
      + 'curve describes the roster that already existed rather than recruitment. It is shown rather than '
      + 'hidden, because dropping the largest group on the page raises more questions than it settles.'));
  }
  cb.append(el('p', 'cap', esc(d.caveat)));

  /* ── who stopped ──────────────────────────────────────────────────────── */
  const g = el('div', 'grid g2'); root.append(g);
  const { panel: sp, body: sb } = panel(`Stopped in ${MONTH(d.last_complete_month)}`,
    'Worked the month before and not this one. Ordered by lifetime bookings — the most productive leaver first, '
    + 'because that is the one worth a phone call.');
  g.append(sp);
  if (!d.stopped_last_month.length) empty(sb, 'Nobody who worked the previous month stopped.');
  else {
    sb.append(tableFrom(d.stopped_last_month.slice(0, 40), [
      { label: 'Driver', key: 'name', render: (r) => entity('driver', r.driver_ext_id, r.name) },
      { label: 'Months worked', key: 'months_active', num: true },
      { label: 'First', key: 'first_month', render: (r) => MONTH(r.first_month) },
      { label: 'Last', key: 'last_month', render: (r) => MONTH(r.last_month) },
      { label: 'Lifetime bookings', key: 'lifetime_bookings', num: true, render: (r) => fmt(r.lifetime_bookings) },
    ], { compact: true }));
    const big = d.stopped_last_month.filter((s) => s.lifetime_bookings >= 200).length;
    if (big) {
      sb.append(el('p', 'note err',
        `${big} of them had taken 200 or more bookings. Somebody who has driven that much and then stops is a `
        + 'retention question with a name attached, not a statistic.'));
    }
  }

  const { panel: np, body: nb } = panel(`Started in ${MONTH(d.last_complete_month)}`,
    'First booking anywhere — not a platform account created, which is a different thing and is on the roster page.');
  g.append(np);
  if (!d.started_last_month.length) {
    empty(nb, 'Nobody took a first booking that month.');
    nb.append(el('p', 'note err',
      'No intake at all in the most recent complete month. Whatever the retention curve looks like, a fleet '
      + 'with no arrivals shrinks by exactly the number of people who stop.'));
  } else {
    nb.append(tableFrom(d.started_last_month.slice(0, 40), [
      { label: 'Driver', key: 'name', render: (r) => entity('driver', r.driver_ext_id, r.name) },
      { label: 'Bookings in their first month', key: 'bookings', num: true, render: (r) => fmt(r.bookings) },
    ], { compact: true }));
  }

  root.append(note(`Tenure: people who have stopped ran a median of ${t.median_months_leavers ?? '—'} months; `
    + `people still working are ${t.median_months_so_far_stayers ?? '—'} months in and counting. ${t.note} `
    + (d.current_month_excluded
      ? `${MONTH(d.current_month_excluded)} is excluded from every figure on this page — the record stops `
        + 'inside it, and a driver who has not worked yet this week has not left.'
      : '')));
}
