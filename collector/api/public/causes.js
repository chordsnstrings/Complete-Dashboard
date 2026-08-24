/* Why the numbers moved.
   ──────────────────────────────────────────────────────────────────────────
   The fleet's volume has swung by 70–170% month over month. Every one of those
   swings has a cause, and the cause determines the fix — losing drivers and
   losing demand look identical on a trip-count chart and need opposite
   responses. This page separates them, and puts the outside world beside them:
   Ramadan, the summer exodus, school terms, regional conflict, weather.

   Three honesty rules run through it:

   1. A month we hold no data for is drawn as a hole, never smoothed over. The
      dashboard previously reported "-82%, drivers 102 → 0" for a stretch where
      nothing had been collected.
   2. Telematics trips carry no driver id, so a month sourced only from FMS
      cannot say how many drivers worked. That reads as "not attributable",
      not as zero.
   3. An overlapping world event is a candidate, not a cause. Nothing here
      claims to have proved anything. */

import { empty } from './charts.js';
import { el, esc, panel, loading, tableFrom, kpiRow, pill, note, dayStr, fmt, pct } from './ui.js';
import { api } from './data.js';

const MONTH = (m) => {
  const [y, mm] = String(m).slice(0, 7).split('-');
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+mm - 1]} ${y.slice(2)}`;
};

/* A cause reads differently depending on which way the number went: the same
   "demand" verdict means the work stopped arriving on a fall and started
   arriving on a rise, and the implied action is opposite. */
const ATTRIBUTION = {
  supply: {
    label: 'Supply', tone: 'warn',
    down: {
      why: 'Fewer drivers working, each doing about as much as before. The fleet lost people, not demand.',
      fix: 'A recruitment and retention problem. More marketing spend will not fix it.',
    },
    up: {
      why: 'More drivers working, each doing about as much as before. The fleet added people and the work was there for them.',
      fix: 'Growth came from headcount, so it will stop when hiring stops. Check the new drivers are earning enough to stay.',
    },
  },
  demand: {
    label: 'Demand', tone: 'bad',
    down: {
      why: 'Roughly the same drivers, each completing far less. The work stopped arriving.',
      fix: 'Look at platform allocation, pricing tier and positioning — adding drivers makes it worse.',
    },
    up: {
      why: 'Roughly the same drivers, each completing far more. More work arrived rather than more people.',
      fix: 'Existing drivers absorbed it. Find the headroom before it becomes a queue — this is when to add capacity.',
    },
  },
  mixed: {
    label: 'Mixed', tone: 'warn',
    down: { why: 'Driver count and per-driver output both fell. Neither explains it alone.',
      fix: 'Split the window finer before acting; the two causes may not have coincided.' },
    up: { why: 'Driver count and per-driver output both rose. Neither explains it alone.',
      fix: 'Split the window finer before crediting either; the two may not have coincided.' },
  },
  unattributable: {
    label: 'Not attributable', tone: null,
    down: { why: 'One side of this comparison has no driver ids, so supply and demand cannot be separated.',
      fix: 'The trip volume moved and that is real; the cause needs a source that names drivers.' },
    up: { why: 'One side of this comparison has no driver ids, so supply and demand cannot be separated.',
      fix: 'The trip volume moved and that is real; the cause needs a source that names drivers.' },
  },
};

/* ── the year at a glance, with holes drawn as holes ─────────────────────── */
function trendChart(host, months, onPick) {
  host.innerHTML = '';
  if (!months.length) return empty(host);
  const W = 900, H = 260, P = { l: 52, r: 14, t: 16, b: 42 };
  const max = Math.max(1, ...months.map((m) => m.trips));
  const iw = W - P.l - P.r, ih = H - P.t - P.b;
  const step = iw / months.length, bw = Math.min(step * 0.66, 46);
  const Y = (v) => P.t + ih - (v / max) * ih;
  const out = [`<svg viewBox="0 0 ${W} ${H}" role="img">`];
  for (let g = 0; g <= 3; g++) {
    const v = (max / 3) * g;
    out.push(`<line x1="${P.l}" x2="${W - P.r}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" stroke="var(--rule)"/>`);
    out.push(`<text x="${P.l - 8}" y="${Y(v) + 4}" font-size="10" fill="var(--ink-3)" text-anchor="end">${fmt(Math.round(v))}</text>`);
  }
  months.forEach((m, i) => {
    const x = P.l + step * i + (step - bw) / 2;
    if (m.no_data) {
      // A hatched placeholder, so the eye reads "nothing here" rather than "zero"
      out.push(`<rect x="${x.toFixed(1)}" y="${P.t}" width="${bw.toFixed(1)}" height="${ih}" rx="3"
        fill="var(--surface-2)" stroke="var(--rule-strong)" stroke-dasharray="3,3"/>
        <text x="${(x + bw / 2).toFixed(1)}" y="${P.t + ih / 2}" font-size="9" fill="var(--ink-3)"
          text-anchor="middle" transform="rotate(-90 ${(x + bw / 2).toFixed(1)} ${P.t + ih / 2})">no data</text>`);
    } else {
      const h = Math.max(1, ih * (m.trips / max));
      out.push(`<rect x="${x.toFixed(1)}" y="${Y(m.trips).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="3"
        fill="var(${m.drivers_known ? '--b500' : '--b300'})" data-rise style="animation-delay:${i * 30}ms"
        data-m="${esc(m.m)}"><title>${MONTH(m.m)} — ${fmt(m.trips)} trips${
        m.drivers_known ? `, ${m.drivers} drivers` : ', no driver attribution'}</title></rect>`);
    }
    out.push(`<text x="${(x + bw / 2).toFixed(1)}" y="${H - 24}" font-size="10" fill="var(--ink-3)" text-anchor="middle">${MONTH(m.m)}</text>`);
  });
  out.push('</svg>');
  host.innerHTML = out.join('');
  if (onPick) host.querySelectorAll('rect[data-m]').forEach((r) => {
    r.style.cursor = 'pointer';
    r.onclick = () => onPick(r.getAttribute('data-m'));
  });
  host.append(el('div', 'legend', `
    <span><i style="background:var(--b500)"></i>trips, drivers named</span>
    <span><i style="background:var(--b300)"></i>trips, no driver attribution</span>
    <span><i style="background:var(--surface-2);border:1px dashed var(--rule-strong)"></i>no data collected</span>`));
}

/* ── one break, decomposed ───────────────────────────────────────────────── */
function breakCard(b) {
  const a = ATTRIBUTION[b.attribution] || ATTRIBUTION.mixed;
  const rose = b.change_pct >= 0;
  const dir = rose ? 'rose' : 'fell';
  const copy = rose ? a.up : a.down;
  const card = el('div', 'breakcard');
  const events = (() => {
    try { return typeof b.candidate_events === 'string' ? JSON.parse(b.candidate_events) : (b.candidate_events || []); }
    catch { return []; }
  })();
  const asPct = (v) => (v == null ? null : `${v > 0 ? '+' : ''}${Math.round(v * 100)}%`);

  card.innerHTML = `
    <div class="bk-head">
      <div>
        <h4>${MONTH(b.period_from)} → ${MONTH(b.period_to)} · trips ${dir} ${Math.abs(Math.round(b.change_pct * 100))}%</h4>
        <p class="cap">${fmt(b.value_from)} → ${fmt(b.value_to)} trips on ${esc(b.platform)}</p>
      </div>
      ${pill(a.label, a.tone)}
    </div>
    <div class="bk-split">
      <div class="bk-half">
        <div class="bk-k">Supply — drivers working</div>
        <div class="bk-v num">${b.drivers_from == null ? '—' : `${b.drivers_from} → ${b.drivers_to}`}</div>
        <div class="bk-d">${asPct(b.driver_change_pct) || 'not comparable'}</div>
      </div>
      <div class="bk-half">
        <div class="bk-k">Demand — trips per driver</div>
        <div class="bk-v num">${b.productivity_change_pct == null ? '—' : asPct(b.productivity_change_pct)}</div>
        <div class="bk-d">${b.productivity_change_pct == null ? 'not comparable' : 'change in per-driver output'}</div>
      </div>
    </div>
    <p class="bk-why">${esc(copy.why)}</p>
    <p class="bk-fix"><b>What this implies</b> ${esc(copy.fix)}</p>
    ${events.length ? `<div class="bk-ev"><div class="bk-k">What else was happening</div>${
      events.map((e) => `<div class="bk-evrow">
        <span class="bk-evt">${esc(e.title)}</span>
        ${pill(String(e.expected_effect || '').replace(/_/g, ' ') || 'unknown',
          e.expected_effect === 'demand_up' ? 'ok' : e.expected_effect === 'demand_down' ? 'warn' : null)}
        <span class="cap">${e.confidence != null ? `confidence ${Math.round(e.confidence * 100)}%` : ''}</span>
      </div>${e.summary ? `<p class="cap">${esc(e.summary)}</p>` : ''}`).join('')
    }<p class="cap">Overlapping in time. Candidates, not proof — nothing here establishes that these caused the move.</p></div>` : ''}`;
  return card;
}

export async function renderCauses(root) {
  const kpiHost = el('div'); root.append(kpiHost); loading(kpiHost);
  const trend = panel('Trips per month', 'Click a month to see what was happening. Hatched columns are months we hold no data for.');
  root.append(trend.panel);
  const gapP = panel('Coverage gaps', 'Stretches with no trips from any source — these are collection holes, not quiet months');
  const g = el('div', 'grid g23'); root.append(g);
  const brk = panel('Structural breaks', 'Month-over-month moves above 30%, split into supply and demand'); g.append(brk.panel);
  g.append(gapP.panel);
  const evP = panel('Known context', 'Seasonal, religious and regional events that move Dubai demand'); root.append(evP.panel);
  [trend.body, brk.body, gapP.body, evP.body].forEach(loading);

  const [t, breaks, events] = await Promise.all([
    api('/api/trend/monthly'),
    api('/api/breaks').catch(() => []),
    api('/api/events?from=2024-01-01&to=2027-12-31').catch(() => []),
  ]);
  const months = t.months || [];
  const observed = months.filter((m) => !m.no_data);
  const attributable = observed.filter((m) => m.drivers_known);
  const totalTrips = observed.reduce((a, m) => a + m.trips, 0);
  const biggest = [...(t.breaks || [])].sort((a, b) => Math.abs(b.change_pct) - Math.abs(a.change_pct))[0];

  kpiHost.replaceWith(kpiRow([
    { label: 'Months observed', value: `${observed.length} of ${months.length}`,
      sub: (t.gaps || []).length ? `${(t.gaps || []).reduce((a, x) => a + x.months, 0)} months with no data` : 'complete run',
      tone: (t.gaps || []).length ? 'warn' : 'good' },
    { label: 'Trips in record', value: fmt(totalTrips), sub: `across ${observed.length} months` },
    { label: 'Driver attribution', value: `${attributable.length} of ${observed.length}`,
      sub: 'months where trips name a driver',
      tone: attributable.length === observed.length ? 'good' : 'warn' },
    { label: 'Structural breaks', value: fmt((t.breaks || []).length), sub: 'moves above 30% between adjacent months' },
    biggest ? { label: 'Largest move', value: `${biggest.change_pct > 0 ? '+' : ''}${biggest.change_pct}%`,
      sub: `${MONTH(biggest.from)} → ${MONTH(biggest.to)}`,
      tone: Math.abs(biggest.change_pct) > 60 ? 'critical' : 'warn' } : null,
  ]));

  /* ── the whole year at once, which was never possible before ───────────
     The Uber history ran 56 days until the backfill finally landed a full
     year. Thirteen unbroken months make one thing visible that no fragment
     could: this fleet did not lose demand, it lost drivers. Trips per driver
     barely moved while the driver count halved and the vehicle count did not.
     Those are opposite problems with opposite fixes, and a trip-count chart
     cannot tell them apart — which is the whole reason this page exists. */
  /* Whole months only. The record starts and ends mid-month, so the first and
     last months hold fewer days than they appear to — collection here begins
     on 21 August, giving that month eleven days. Averaging them into a
     first-third/last-third comparison drags both ends toward zero and
     understates whatever really moved. */
  const supply = observed.filter((m) => m.drivers_known && m.trips > 0 && !m.partial_month);
  const droppedPartial = observed.filter((m) => m.drivers_known && m.trips > 0 && m.partial_month);
  if (supply.length >= 6) {
    const per = (m) => (m.drivers ? m.trips / m.drivers : null);
    const firstThird = supply.slice(0, Math.max(1, Math.floor(supply.length / 3)));
    const lastThird = supply.slice(-Math.max(1, Math.floor(supply.length / 3)));
    const mean = (rows, f) => {
      const v = rows.map(f).filter((x) => x != null && Number.isFinite(x));
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    };
    const t0 = mean(firstThird, (m) => m.trips), t1 = mean(lastThird, (m) => m.trips);
    const d0 = mean(firstThird, (m) => m.drivers), d1 = mean(lastThird, (m) => m.drivers);
    const v0 = mean(firstThird, (m) => m.earning_vehicles), v1 = mean(lastThird, (m) => m.earning_vehicles);
    const p0 = mean(firstThird, per), p1 = mean(lastThird, per);
    const move = (a, b) => (a ? Math.round(((b - a) / a) * 100) : null);

    const { panel: sp, body: sb } = panel('Supply or demand, over the whole record',
      `First ${firstThird.length} attributable months against the last ${lastThird.length}. `
      + 'Trips per driver is the number that separates the two: it holds steady when the fleet '
      + 'loses people and falls when the work stops arriving.');
    root.append(sp);
    sb.append(tableFrom([
      { k: 'Bookings per month', a: t0, b: t1, d: move(t0, t1), fmtN: 0 },
      { k: 'Drivers earning', a: d0, b: d1, d: move(d0, d1), fmtN: 0 },
      { k: 'Vehicles earning', a: v0, b: v1, d: move(v0, v1), fmtN: 0 },
      { k: 'Bookings per driver', a: p0, b: p1, d: move(p0, p1), fmtN: 1 },
    ], [
      { label: '', key: 'k' },
      { label: `${MONTH(firstThird[0].m)}–${MONTH(firstThird[firstThird.length - 1].m)}`,
        key: 'a', num: true, render: (r) => (r.a == null ? '—' : fmt(r.a, r.fmtN)) },
      { label: `${MONTH(lastThird[0].m)}–${MONTH(lastThird[lastThird.length - 1].m)}`,
        key: 'b', num: true, render: (r) => (r.b == null ? '—' : fmt(r.b, r.fmtN)) },
      { label: 'Move', key: 'd', num: true, render: (r) => (r.d == null ? '—'
        : `<span class="pill ${Math.abs(r.d) < 10 ? '' : r.d < 0 ? 'bad' : 'ok'}">${r.d > 0 ? '+' : ''}${r.d}%</span>`) },
    ]));

    /* State the reading, and state what would falsify it. A verdict with no
       stated alternative is an assertion; one that names the number that would
       change its mind is a finding. */
    const dMove = move(d0, d1), pMove = move(p0, p1), tMove = move(t0, t1);
    if (tMove != null && Math.abs(tMove) >= 15) {
      const supplyLed = dMove != null && pMove != null
        && Math.abs(dMove) > Math.abs(pMove) * 1.5;
      const demandLed = pMove != null && dMove != null
        && Math.abs(pMove) > Math.abs(dMove) * 1.5;
      sb.append(el('p', 'note',
        supplyLed
          ? `Bookings moved ${tMove}% and the driver count moved ${dMove}%, while each driver's own `
            + `output moved only ${pMove}%. That is a SUPPLY move: the people changed, the work per `
            + 'person did not. Recruitment and retention, not marketing. It would be wrong if bookings '
            + 'per driver were the thing that had moved — that number is in the table above and can be checked.'
          : demandLed
            ? `Each driver's output moved ${pMove}% while the driver count moved only ${dMove}%. That is a `
              + 'DEMAND move: the same people are getting less work. Adding drivers would make it worse.'
            : `Bookings moved ${tMove}%, drivers ${dMove}%, output per driver ${pMove}%. Both sides moved `
              + 'together, so neither explains the other on this evidence alone.'));
      if (v1 != null && v0 != null && Math.abs(move(v0, v1)) < 15 && dMove != null && dMove < -15) {
        sb.append(el('p', 'note err',
          `The vehicle count barely moved (${move(v0, v1)}%) while the driver count fell ${dMove}%. `
          + 'The fleet is still holding the cars it is no longer staffing — that is idle capital with a '
          + 'registration and an insurance policy attached, and it is on the balance sheet either way.'));
      }
    }
    sb.append(el('p', 'cap',
      'Attributable whole months only: a month sourced entirely from telematics carries no driver id and '
      + 'cannot be compared on this axis, and a month the record only partly covers holds fewer days than '
      + 'it looks like it does. Bookings exclude telematics journeys, which are the same physical trips '
      + 'seen by the tracker.'
      + (droppedPartial.length
        ? ` ${droppedPartial.map((m) => MONTH(m.m)).join(' and ')} `
          + `${droppedPartial.length > 1 ? 'are' : 'is'} excluded for that reason.`
        : '')));
  }

  trendChart(trend.body, months, (m) => {
    const row = months.find((x) => x.m === m);
    if (!row || row.no_data) return;
    const near = (t.breaks || []).filter((b) => b.from === m || b.to === m);
    trend.body.querySelectorAll('.picked').forEach((n) => n.remove());
    const d = el('div', 'note picked',
      `${MONTH(m)}: ${fmt(row.trips)} bookings on ${esc((row.booking_platforms || row.platforms || []).join(', ') || 'unknown')}` +
      `${row.telematics_journeys ? `, ${fmt(row.telematics_journeys)} telematics journeys behind them` : ''}` +
      `${row.drivers_known ? `, ${row.drivers} drivers` : ', no driver attribution'}` +
      `${row.accounted ? `, AED ${fmt(row.accounted)} in` : ''}` +
      /* Uber's earnings API serves roughly the last six months, so a month
         older than that has bookings, distance and drivers and no money that
         can ever be collected for it. Without saying so the reader sees a
         month of work worth nothing and reasonably concludes the fleet had a
         bad month. */
      `${row.income_missing ? ' — no platform statement covers this month; its money is not recoverable' : ''}` +
      `${near.length ? ` — ${near.length} break(s) touch this month.` : ''}`);
    trend.body.append(d);
  });

  /* ── breaks ── */
  brk.body.innerHTML = '';
  const stored = Array.isArray(breaks) ? breaks : [];
  if (!stored.length && !(t.breaks || []).length) {
    brk.body.append(note('No month-over-month move above 30% in the record. That is unusual for this fleet — check that the collectors have a full history before reading it as stability.'));
  } else if (!stored.length) {
    // The endpoint computes breaks from trips directly; the stored table is
    // filled by the collector, which may not have run since the last backfill.
    brk.body.append(note('Breaks are visible in the trend above, but the collector has not yet written its decomposition for them. It runs on the next collection cycle.'));
    if ((t.breaks || []).some((b) => b.boundary_artifact)) {
      brk.body.append(el('div', 'note err',
        'A break marked "boundary" touches a month the record only partly covers — collection started or '
        + 'stopped inside it, so the month holds fewer days than a full one. That is a fact about when we '
        + 'began collecting, not about the fleet. It is shown rather than hidden, because a break that '
        + 'silently disappears is its own kind of lie, but nothing should be concluded from it.'));
    }
    brk.body.append(tableFrom(t.breaks || [], [
      { label: 'From', key: 'from', render: (r) => MONTH(r.from) },
      { label: 'To', key: 'to', render: (r) => MONTH(r.to) },
      { label: 'Change', key: 'change_pct', num: true, render: (r) => `${r.change_pct > 0 ? '+' : ''}${r.change_pct}%`
        + (r.boundary_artifact ? ' <span class="tag warn">boundary</span>' : '') },
      { label: 'Trips', key: '_t', num: true, render: (r) => `${fmt(r.trips_from)} → ${fmt(r.trips_to)}` },
      { label: 'Drivers', key: '_d', num: true, render: (r) => (r.drivers_from == null ? 'not comparable' : `${r.drivers_from} → ${r.drivers_to}`) },
      { label: 'Vehicles earning', key: '_v', num: true,
        render: (r) => (r.vehicles_from == null ? '—' : `${fmt(r.vehicles_from)} → ${fmt(r.vehicles_to)}`) },
      /* Distance per booking, over measured bookings only. A swing in trips
         with a flat km-per-trip is a volume change; one where the trips also
         got much shorter or longer is a change in the WORK, and the two need
         different responses. */
      { label: 'Km per booking', key: '_k', num: true,
        render: (r) => (r.km_per_trip_from == null || r.km_per_trip_to == null ? '—'
          : `${fmt(r.km_per_trip_from, 1)} → ${fmt(r.km_per_trip_to, 1)}`) },
      { label: 'Source mix changed', key: '_p', render: (r) => (r.platform_shift
        ? pill(`${(r.platform_shift.from || []).join('+')} → ${(r.platform_shift.to || []).join('+')}`, 'warn') : '—') },
    ]));
  } else {
    stored.sort((a, b) => Math.abs(b.change_pct) - Math.abs(a.change_pct))
      .slice(0, 12).forEach((b) => brk.body.append(breakCard(b)));
  }

  /* ── gaps ── */
  gapP.body.innerHTML = '';
  const gaps = t.gaps || [];
  if (!gaps.length) gapP.body.append(note('Every month between the first and last trip on record has data.'));
  else {
    gapP.body.append(tableFrom(gaps, [
      { label: 'From', key: 'from', render: (r) => MONTH(r.from) },
      { label: 'To', key: 'to', render: (r) => MONTH(r.to) },
      { label: 'Months', key: 'months', num: true },
    ], { compact: true }));
    gapP.body.append(note(
      'A gap is a hole in what was collected, not evidence the fleet stopped. Comparisons never step across one — ' +
      'doing so once produced a confident "82% collapse" that had not happened.'));
  }

  /* ── events ── */
  evP.body.innerHTML = '';
  const evs = Array.isArray(events) ? events : [];
  if (!evs.length) evP.body.append(note('No context events stored yet. The collector derives seasonal and religious dates and classifies regional news on each cycle.'));
  else {
    evP.body.append(tableFrom(evs.slice(0, 40), [
      { label: 'Starts', key: 'starts_on', render: (r) => dayStr(r.starts_on) },
      { label: 'Ends', key: 'ends_on', render: (r) => dayStr(r.ends_on) },
      { label: 'Event', key: 'title' },
      { label: 'Category', key: 'category', render: (r) => pill(r.category || '—') },
      { label: 'Expected effect', key: 'expected_effect', render: (r) => pill(
        String(r.expected_effect || 'unknown').replace(/_/g, ' '),
        r.expected_effect === 'demand_up' ? 'ok' : r.expected_effect === 'demand_down' ? 'warn' : null) },
      { label: 'Confidence', key: 'confidence', num: true, render: (r) => (r.confidence != null ? pct(r.confidence * 100) : '—') },
      { label: 'Why it matters', key: 'summary' },
    ]));
    evP.body.append(el('p', 'cap',
      'Seasonal and religious dates are derived; news items are classified by an LLM from regional coverage. ' +
      'Confidence is how strongly the event is expected to move Dubai ride demand, not how certain we are it occurred.'));
  }
}
