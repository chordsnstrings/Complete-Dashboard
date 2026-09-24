/* Who joins, who stays, who quietly stops.
   ──────────────────────────────────────────────────────────────────────────
   The earning driver count on this fleet ran 110, then 50, then 88. That
   single number is compatible with two opposite businesses — one that keeps
   its people and stopped recruiting, and one that recruits hard and cannot
   keep anybody — and the remedy for each makes the other worse. This page
   exists to separate them, which a headcount cannot do and a cohort can. */

import { empty, fmt, areaChart } from './charts.js';
import { el, esc, panel, loading, tableFrom, kpiRow, note, pill, entity,
  countOf, plural, sourceLabel, signed, verdict, contract, glance, glanceBand, bandTiles, absenceBand, pageFoot, delta, foldRows } from './ui.js';
import { q, href } from './data.js';

/* "Aug 25" is how every other page in this product writes a DATE — the 25th of
   August — and this page used the same form to mean August 2025. On a screen
   whose siblings print "Aug 25" beside a trip count, a month label has to be
   unmistakable, so the year is written out in full. */
const MONTH = (m) => {
  const [y, mm] = String(m).slice(0, 7).split('-');
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+mm - 1]} ${y}`;
};

/* ── arrivals above the line, departures below it ─────────────────────────
   Four categorical series, so the categorical palette: new, returning, left,
   and the headcount they add up to drawn as a line across them. No dual axis —
   every series here is a count of people. */
function flowChart(host, flow, { ak = false } = {}) {
  host.innerHTML = '';
  /* Under the page contract the headcount is its own chart (SPEC §4 forbids
     the dual axis this one drew), and the flow is achromatic: arrivals an
     ink/grey pair above the line, departures ink below it — position, not a
     semantic fill, says which way a person went. */
  const C = ak ? { j: '--ink', r: '--grey', l: '--ink' } : { j: '--s1', r: '--s4', l: '--s2' };
  if (!flow.length) return empty(host);
  const W = 900, H = 260, P = { l: 46, r: 14, t: 18, b: 40 };
  const up = flow.map((f) => (f.joined || 0) + (f.returning || 0));
  const down = flow.map((f) => f.left || 0);
  const act = flow.map((f) => f.active || 0);
  const maxFlow = Math.max(1, ...up, ...down);
  const maxAct = Math.max(1, ...act);
  const iw = W - P.l - P.r, ih = H - P.t - P.b;
  const mid = P.t + ih / 2;
  const step = iw / flow.length, bw = Math.min(step * 0.5, 34);
  const Y = (v) => mid - (v / maxFlow) * (ih / 2);
  const out = [`<svg viewBox="0 0 ${W} ${H}" role="img">`];
  [-maxFlow, -maxFlow / 2, 0, maxFlow / 2, maxFlow].forEach((v) => {
    out.push(`<line class="gl" x1="${P.l}" x2="${W - P.r}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/>`);
    out.push(`<text x="${P.l - 7}" y="${Y(v) + 4}" class="axis" text-anchor="end">${fmt(Math.abs(Math.round(v)))}</text>`);
  });
  flow.forEach((f, i) => {
    const x = P.l + step * i + (step - bw) / 2;
    const j = f.joined || 0, rt = f.returning || 0, lf = f.left || 0;
    const hJ = (j / maxFlow) * (ih / 2), hR = (rt / maxFlow) * (ih / 2), hL = (lf / maxFlow) * (ih / 2);
    if (j) {
      out.push(`<rect x="${x.toFixed(1)}" y="${(mid - hJ).toFixed(1)}" width="${bw.toFixed(1)}" height="${hJ.toFixed(1)}"
        rx="2" fill="var(${C.j})" data-rise><title>${esc(MONTH(f.m))} — ${j} genuinely new</title></rect>`);
    }
    if (rt) {
      out.push(`<rect x="${x.toFixed(1)}" y="${(mid - hJ - hR).toFixed(1)}" width="${bw.toFixed(1)}" height="${hR.toFixed(1)}"
        rx="2" fill="var(${C.r})" data-rise><title>${esc(MONTH(f.m))} — ${rt} returning after a gap</title></rect>`);
    }
    if (lf) {
      out.push(`<rect x="${x.toFixed(1)}" y="${mid.toFixed(1)}" width="${bw.toFixed(1)}" height="${hL.toFixed(1)}"
        rx="2" fill="var(${C.l})" data-rise><title>${esc(MONTH(f.m))} — ${lf} stopped</title></rect>`);
    }
  });
  // The headcount, overlaid — scaled to its own range and labelled as such,
  // because a second axis would invite reading the two against each other.
  const lx = (i) => P.l + step * i + step / 2;
  const ly = (v) => P.t + 4 + (1 - v / maxAct) * (ih - 8);
  if (!ak) out.push(`<path d="${act.map((v, i) => `${i ? 'L' : 'M'} ${lx(i).toFixed(1)} ${ly(v).toFixed(1)}`).join(' ')}"
    fill="none" stroke="var(--grey)" stroke-width="1.5" stroke-dasharray="4,3" data-draw/>`);
  if (!ak) act.forEach((v, i) => {
    out.push(`<circle cx="${lx(i).toFixed(1)}" cy="${ly(v).toFixed(1)}" r="7" fill="transparent">`
      + `<title>${esc(MONTH(flow[i].m))} — ${fmt(v)} drivers earning</title></circle>`);
  });
  out.push(`<line x1="${P.l}" x2="${W - P.r}" y1="${mid}" y2="${mid}" stroke="var(--rule-strong)"/>`);
  const every = Math.max(1, Math.ceil(flow.length / 12));
  flow.forEach((f, i) => {
    if (i % every && i !== flow.length - 1) return;
    out.push(`<text x="${lx(i).toFixed(1)}" y="${H - 10}" class="axis" text-anchor="middle">${esc(MONTH(f.m))}</text>`);
  });
  out.push('</svg>');
  host.innerHTML = out.join('');
  if (ak) {
    host.append(el('div', 'legend', `
      <span><i class="sw" style="background:var(--ink)"></i>genuinely new (above the line)</span>
      <span><i class="sw" style="background:var(--grey)"></i>returning after a gap (above)</span>
      <span><i class="sw" style="background:var(--ink)"></i>stopped (below the line)</span>`));
    return;
  }
  host.append(el('div', 'legend', `
    <span><i class="sw" style="background:var(--s1)"></i>genuinely new</span>
    <span><i class="sw" style="background:var(--s4)"></i>returning after a gap</span>
    <span><i class="sw" style="background:var(--s2)"></i>stopped</span>
    <span><i class="sw" style="background:var(--grey)"></i>drivers earning (dashed, its own scale — a
      headcount and a flow are different quantities and do not share an axis)</span>`));
}

export async function renderRetention(root) {
  root.innerHTML = '';
  loading(root);
  const d = await q('/api/retention');
  root.innerHTML = '';

  if (!d.ok) return empty(root, d.reason || 'Not enough history to follow a cohort.');

  const flowLast = d.flow[d.flow.length - 1] || {};
  const t = d.tenure || {};
  /* Under the page contract (plan §4 retention): the verdict as the 00
     statement — its sub-line and meta written as months, not the raw ISO
     "2026-08" — with the tiles untoned; the headcount as its own chart, the
     arrivals and departures on one count axis with no headcount line (SPEC §4:
     no dual axis), the flow table's New/Stopped as signed words, not pills;
     the cohort grid in the achromatic ramp with its exact percentages; the
     Stopped and Started tables unchanged; a † band. */
  const ak = contract();
  const AKB = ak ? glanceBand(root, null) : null;

  /* Fields read off /api/retention on production before the sentence was
     written: flow carries {m, active, joined, returning, left, net} per month
     and last_complete_month names the last one that is whole.

     A headcount cannot tell "people are leaving" from "nobody is arriving",
     and those need opposite responses. That distinction is the page. */
  {
    const f = flowLast;
    const net = f.net == null ? null : +f.net;
    const joined = (+f.joined || 0) + (+f.returning || 0);
    const left = +f.left || 0;
    let claim, figure, unit, tone = null, recommend = null;
    if (net != null && net < 0) {
      tone = 'bad';
      claim = left > joined * 2
        ? `The roster shrank because people left — ${countOf(left, 'leaver')} against ${fmt(joined)} joining`
        : `The roster shrank because hiring stalled — ${fmt(joined)} joined against ${countOf(left, 'leaver')}`;
      figure = signed(net); unit = 'net drivers';
      recommend = left > joined * 2
        ? 'Retention, not recruitment. The cohorts below show how long people last before they go.'
        : 'Recruitment, not retention. Leavers are normal at this rate; arrivals are not replacing them.';
    } else if (net != null) {
      claim = `${fmt(f.active)} drivers active — ${signed(net)} on the month before`;
      figure = signed(net); unit = 'net drivers';
    } else {
      claim = `${fmt(f.active)} drivers active`;
      figure = fmt(f.active); unit = 'active';
    }
    verdict(ak ? AKB.vHost : root, {
      claim, figure, unit, tone, recommend,
      meta: d.last_complete_month ? `to ${ak ? MONTH(d.last_complete_month) : d.last_complete_month}` : null,
      sub: `${fmt(joined)} arrived and ${fmt(left)} stopped in ${ak ? MONTH(f.m) : f.m}.`
        + (d.current_month_excluded
          ? ' The month in progress is left out — a partial month always looks like a collapse.'
          : ''),
    });
  }
  const real = d.cohorts.filter((c) => !c.is_left_censored);
  const recruited = real.reduce((a, c) => a + c.size, 0);
  const kept = real.reduce((a, c) => a + c.still_active, 0);

  const RET_TILES = [
    { label: `Earning in ${MONTH(d.last_complete_month)}`, value: fmt(flowLast.active),
      sub: flowLast.net == null ? null
        : `${signed(flowLast.net)} on the month`,
      tone: flowLast.net < 0 ? 'critical' : flowLast.net > 0 ? 'good' : null },
    { label: 'Stopped that month', value: fmt(d.stopped_last_month.length),
      sub: 'worked the month before and not this one',
      tone: d.stopped_last_month.length ? 'warn' : 'good',
      cohort: d.stopped_last_month.length ? 'retention-stopped' : null },
    { label: 'Started that month', value: fmt(d.started_last_month.length),
      sub: 'first booking anywhere',
      tone: d.started_last_month.length < d.stopped_last_month.length ? 'warn' : 'good',
      cohort: d.started_last_month.length ? 'retention-started' : null },
    /* This tile could never be green: the tone was `< 0.4 ? critical : warn`,
       so a fleet keeping every single recruit still read as a warning. A rate
       that has no good value is not a measurement, it is a mood. */
    { label: 'Recruits still working', value: recruited ? `${fmt(kept)} of ${fmt(recruited)}` : '—',
      sub: recruited ? `${Math.round((kept / recruited) * 100)}% of everybody who joined since the record began` : null,
      tone: !recruited ? null
        : kept / recruited >= 0.6 ? 'good' : kept / recruited >= 0.4 ? 'warn' : 'critical' },
    /* Both halves of the tenure, on the tile.
       ─────────────────────────────────────────────────────────────────────
       "Typical run before stopping: 5 months" on its own describes a fleet
       that turns over twice a year. It is a median over the 122 people who
       HAVE stopped, and the 107 still working are ten months in and counting —
       the payload has carried both since it was built, and only the leavers'
       half was on the tile. The other half was in a note at the very bottom of
       the page, below three tables, which is not where anybody reading a KPI
       row is looking. */
    { label: 'Typical run before stopping', value: t.median_months_leavers != null
      ? `${t.median_months_leavers} month${t.median_months_leavers === 1 ? '' : 's'}` : '—',
      sub: `over ${fmt(t.leavers)} people who have stopped`
        + (t.median_months_so_far_stayers != null
          ? ` · the ${fmt(t.stayers)} still working are ${t.median_months_so_far_stayers} months `
            + 'in and counting' : '')
        + (d.people_total ? ` · ${fmt(d.people_total)} people on record` : '') },
  ];
  if (ak) {
    const vf = AKB.vHost.querySelector('.vdct-fig > b')?.textContent.trim() || null;
    /* Against the month before, from flow[] — the month before's own
       leavers and new joiners; more people stopping is the worse direction.
       And the headcount against its peak, named. */
    const prevF = d.flow[d.flow.length - 2] || null;
    const peak = d.flow.reduce((a, f) => ((+f.active || 0) > (+a.active || 0) ? f : a), d.flow[0] || {});
    const DL = {
      0: flowLast.net != null ? { value: +flowLast.net, kind: 'change', d: 0, of: 'on the month before' } : null,
      1: prevF ? { value: d.stopped_last_month.length - (+prevF.left || 0), kind: 'change', d: 0, invert: true, of: `on ${MONTH(prevF.m)}` } : null,
      2: prevF ? { value: d.started_last_month.length - (+prevF.joined || 0), kind: 'change', d: 0, of: `on ${MONTH(prevF.m)}` } : null,
    };
    RET_TILES[0] = { ...RET_TILES[0], hero: true,
      sub: peak && peak.m && peak.m !== flowLast.m ? `against the peak of ${fmt(peak.active)} in ${MONTH(peak.m)}` : 'the peak of the record' };
    glance(AKB.tilesHost, bandTiles(RET_TILES.map((x, i) => (DL[i] ? { ...x, delta: DL[i] } : x)), { figure: vf,
      reasons: { 'Recruits still working': 'nobody has joined since the record began', 'Typical run before stopping': 'nobody has stopped yet' } }).tiles);
    retHeadcount(root, d.flow);
  } else root.append(kpiRow(RET_TILES));

  /* The question the headcount cannot answer, answered — over the months where
     arriving MEANS something.
     ───────────────────────────────────────────────────────────────────────
     Everybody earning in the first month of the record appears to have joined
     in it, including people who had been driving for years. Counting that
     month's 112 as arrivals made 165 arrivals and 170 departures read as "277
     arrived, 170 left. More arrived than left" — the exact opposite of what
     the eleven months underneath say, and of what the KPI four lines above
     already computes by excluding the same month. The cohort table flags it
     "roster at start"; this sentence did not. */
  const censored = d.cohorts.find((c) => c.is_left_censored);
  const firstMonth = d.flow[0]?.m;
  const flow = censored && firstMonth === censored.cohort ? d.flow.slice(1) : d.flow;
  const joined = flow.reduce((a, f) => a + (f.joined || 0), 0);
  const returning = flow.reduce((a, f) => a + (f.returning || 0), 0);
  const inflow = joined + returning;
  const outflow = flow.reduce((a, f) => a + (f.left || 0), 0);
  let flowNote = null;
  if (inflow || outflow) {
    (ak ? (x) => { flowNote = x; } : (x) => root.append(x))(el(ak ? 'p' : 'div', ak ? 'cap' : 'note',
      `Across ${countOf(flow.length, 'month')}, ${fmt(inflow)} driver-months arrived (${fmt(joined)} `
      + `genuinely new, ${fmt(returning)} returning after a gap) and ${fmt(outflow)} left. `
      + (outflow > inflow
        ? 'More left than arrived, so the fall in headcount is people going, not recruitment stopping — '
          + 'and hiring alone will not hold the number up while the back door is open.'
        : outflow === inflow
          ? 'Arrivals and departures balance exactly, so the headcount is flat by churn rather than by '
            + 'stability — the same number of people is being replaced each month.'
          : 'More arrived than left, so the headcount is being held up by intake rather than by retention.')
      + (flow.length < d.flow.length
        ? ` ${MONTH(d.flow[0].m)} is excluded: everybody earning in the first month of the record looks `
          + 'like a new joiner, including people who had been driving for years, so counting it as intake '
          + 'inverts this sentence.'
        : '')));
  }

  /* ── the flow ─────────────────────────────────────────────────────────── */
  const { panel: fp, body: fb } = panel('Drivers joining and leaving each month',
    'Arrivals split into genuinely new and returning after a gap. A driver counts as active in a month '
    + 'when they took at least one booking in it.');
  root.append(fp);
  /* The DECOMPOSITION, drawn. The chart plotted `active` — the one
     undecomposed number this whole page exists to replace — while joined,
     returning and left sat in the same payload and appeared only as a table.
     A diverging bar puts arrivals above the line and departures below it, so
     the month where the two cross is visible rather than arithmetic. */
  flowChart(fb, d.flow, { ak });
  if (flowNote) fb.append(flowNote);
  const flowTbl = tableFrom(d.flow, [
    { label: 'Month', key: 'm', render: (r) => MONTH(r.m) },
    { label: 'Earning', key: 'active', num: true },
    { label: 'New', key: 'joined', num: true,
      render: (r) => (r.joined ? (ak ? delta(r.joined, { d: 0 }) : `<span class="pill ok">+${r.joined}</span>`) : '—') },
    { label: 'Returned', key: 'returning', num: true,
      render: (r) => (r.returning ? `+${r.returning}` : '—') },
    { label: 'Stopped', key: 'left', num: true,
      render: (r) => (r.left ? (ak ? delta(-r.left, { d: 0 }) : `<span class="pill bad">−${r.left}</span>`) : '—') },
    { label: 'Net', key: 'net', num: true,
      render: (r) => (r.net == null ? '—' : esc(signed(r.net))) },
  ], { compact: true, sortable: true, sortId: 'flow', defaultSort: { key: 'm', dir: 'asc' } });
  /* The chart's table twin, folded under the contract. */
  if (ak) foldRows(fb, flowTbl, { shown: 6, total: d.flow.length, noun: 'month', key: 'ret-flow' });
  else fb.append(flowTbl);

  /* ── the cohort table ─────────────────────────────────────────────────── */
  const { panel: cp, body: cb } = panel('How long each month’s new drivers stayed',
    'Each row follows one intake group. Reading down a column compares groups at the same age.');
  root.append(cp);

  const maxOffset = Math.max(...d.cohorts.map((c) => c.months_observed));
  /* .tscroll, which is the class that actually scrolls — `.tbl-wrap` was
     defined nowhere in app.css, so this cohort grid was a bare div and its
     twelve month-columns pushed the panel 60px past its own edge and the
     document 137px past the window. Every table built through tableFrom() gets
     .tscroll for exactly this reason; this one is hand-built and was missing
     it. */
  const tbl = el('div', 'tscroll');
  const cells = d.cohorts.map((c) => {
    const tds = [];
    for (let k = 0; k < maxOffset; k++) {
      const r = c.retained[k];
      if (!r) { tds.push('<td class="num dim">·</td>'); continue; }
      /* A cohort of NOBODY has no retention rate. June 2026 has size 0 —
         nobody started that month — so the API correctly returns pct: null,
         and this printed the four-letter word "null" followed by a percent
         sign, twice, in the middle of a heat grid. A rate over an empty
         denominator is not a number and must not be drawn as one: no shading,
         and the cell says what it means. */
      if (r.pct == null) {
        tds.push(`<td class="num dim" title="${esc(MONTH(r.m))}: nobody started in `
          + `${esc(MONTH(c.cohort))}, so there is no rate to compute">—</td>`);
        continue;
      }
      // Intensity from the retention itself, so the shape is readable at a glance.
      const a = 0.08 + 0.62 * (r.pct / 100);
      /* Under the contract the achromatic ramp: --b400 is Uber's identity
         blue, and a cohort is not Uber. Paper text on the darker half. */
      tds.push(ak
        ? `<td class="num" style="background:color-mix(in srgb, var(--ink) ${Math.round(a * 100)}%, transparent);${a > 0.45 ? 'color:var(--paper)' : ''}"
        title="${esc(MONTH(r.m))}: ${r.n} of ${c.size}">${r.pct}%</td>`
        : `<td class="num" style="background:color-mix(in srgb, var(--b400) ${Math.round(a * 100)}%, transparent)"
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
    const anyPlate = d.stopped_last_month.some((r) => r.last_plate || (r.plates || []).length);
    sb.append(tableFrom(d.stopped_last_month.slice(0, 40), [
      { label: 'Driver', key: 'name', render: (r) => entity('driver', r.driver_ext_id, r.name) },
      { label: 'Months worked', key: 'months_active', num: true },
      { label: 'First', key: 'first_month', render: (r) => MONTH(r.first_month) },
      { label: 'Last', key: 'last_month', render: (r) => MONTH(r.last_month) },
      { label: 'Channels', key: 'platforms',
        absent: 'rollup_person_month stores the platforms a person worked, and no row in this '
          + 'cohort has one — the monthly rollup that fills it has not run over these months',
        render: (r) => ((r.platforms || []).map(sourceLabel).join(', ')
          || '<span class="ent-off" title="no platform named on their bookings">—</span>') },
      /* Which car they walked away from. A leaver who still holds a vehicle is
         a different phone call from one who does not, and the plate was the
         one fact this table could have carried and did not. */
      ...(anyPlate ? [{ label: 'Last vehicle', key: 'last_plate',
        render: (r) => {
          const p2 = r.last_plate || (r.plates || [])[0];
          return p2 ? entity('vehicle', p2, p2)
            : '<span class="ent-off" title="no custody record on their last month">—</span>';
        } }] : []),
      { label: 'Lifetime bookings', key: 'lifetime_bookings', num: true, render: (r) => fmt(r.lifetime_bookings) },
    ], { compact: true, sortable: true, sortId: 'stopped',
      defaultSort: { key: 'lifetime_bookings', dir: 'desc' } }));
    if (d.stopped_last_month.length > 40) {
      sb.append(el('p', 'cap',
        `Showing 40 of ${countOf(d.stopped_last_month.length, 'leaver')}, the most productive first.`));
    }
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
    ], { compact: true, sortable: true, sortId: 'started', defaultSort: { key: 'bookings', dir: 'desc' } }));
    if (d.started_last_month.length > 40) {
      nb.append(el('p', 'cap',
        `Showing 40 of ${countOf(d.started_last_month.length, 'new driver')}, busiest first.`));
    }
  }

  if (ak) { retAbsence(root, d, t); return; }
  root.append(note(`Tenure: people who have stopped ran a median of ${t.median_months_leavers ?? '—'} months; `
    + `people still working are ${t.median_months_so_far_stayers ?? '—'} months in and counting. ${t.note} `
    + (d.current_month_excluded
      ? `${MONTH(d.current_month_excluded)} is excluded from every figure on this page — the record stops `
        + 'inside it, and a driver who has not worked yet this week has not left.'
      : '')));
}

/* ── #retention under the page contract ──────────────────────────────────── */
/* The headcount as its own mark, peak and low named — it was a dashed line on
   a second, unlabelled scale over the flow. */
function retHeadcount(root, flow) {
  const p = panel('Drivers earning, month by month', 'A driver counts when they took at least one booking that month', 'ret-headcount');
  root.append(p.panel);
  if (!flow.length) { empty(p.body, 'Not enough history to draw.'); return; }
  areaChart(p.body, flow.map((f) => ({ m: MONTH(f.m), n: Number(f.active) || 0 })), { x: 'm', y: 'n', color: '--ink',
    aria: 'Drivers earning, month by month' });
  const hi = flow.reduce((a, f) => ((+f.active || 0) > (+a.active || 0) ? f : a), flow[0]);
  const lo = flow.reduce((a, f) => ((+f.active || 0) < (+a.active || 0) ? f : a), flow[0]);
  p.body.append(el('p', 'cap', `The peak was ${fmt(hi.active)} in ${MONTH(hi.m)}; the low ${fmt(lo.active)} in ${MONTH(lo.m)}.`));
}
function retAbsence(root, d, t) {
  const ids = (d.stopped_last_month || []).map((r) => r.driver_ext_id).filter(Boolean);
  const dup = ids.length - new Set(ids).size;
  const absHost = el('div'); root.append(absHost);
  absenceBand(absHost, [
    /* Its own sentence, not d.caveat: the plan named the caveat as this
       cell's text, and the caveat is the DEFINITION of active (a booking in
       the month, never a platform's "active" flag) — kept where it was, under
       the cohort grid. */
    { label: 'Why anybody left', fig: null, none: 'Not recorded',
      why: 'No feed this product reads files a reason when somebody stops working. A roster standing records a state, and carries a reason only on a suspension.' },
    { label: 'Leavers listed twice', hl: dup > 0, fig: dup ? `${fmt(dup)} of ${fmt(ids.length)}` : null, none: 'None',
      why: dup ? 'The same driver id appears more than once among the leavers — one person, filed twice, counted as two.' : 'Every leaver is listed once.' },
    { label: 'The month in progress', fig: d.current_month_excluded ? MONTH(d.current_month_excluded) : null, none: 'None excluded',
      why: d.current_month_excluded ? 'Excluded from every figure: the record stops inside it, and a driver who has not worked yet this week has not left.'
        : 'No month is excluded.' },
    { label: 'Tenure, both halves', fig: t.median_months_leavers != null ? `${t.median_months_leavers} months` : null, none: 'Not measured',
      why: `People who have stopped ran a median of ${t.median_months_leavers ?? '—'} months; people still working are ${t.median_months_so_far_stayers ?? '—'} months in and counting. ${t.note || ''}` },
  ]);
  pageFoot({ colophon: [d.last_complete_month ? `to ${MONTH(d.last_complete_month)}` : 'no complete month', `${fmt(d.people_total)} people on record`] }, root);
}
