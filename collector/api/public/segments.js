/* Unexplained occupancy, as pages you can send someone.
   ──────────────────────────────────────────────────────────────────────────
   This replaces four click paths that all opened the same modal — a day bar, a
   verdict slice, a vehicle bar and a table row — none of which had an address.
   The accusation "L44305 carried a passenger with no booking behind it" is the
   most serious thing this product says about anyone, and until now the only
   way to share it was a screenshot.

   Two pages:
     #segments[/<kind>/<value>]  the filtered list, with its own facets
     #segment/<plate>/<started>  one interval and everything around it

   The evidence page shows the neighbours, not just the nearest booking. That
   is the difference between "no booking within 15 minutes" and "here is every
   booking this car and this driver had within the hour, judge for yourself". */

import { empty, fmt, areaChart, hbars, donut } from './charts.js';
import { el, esc, panel, loading, tableFrom, kpiRow, note, entity, pill,
         dtStr, timeStr, dayStr, money, custody } from './ui.js';
import { q, api, href, state, unfiltered } from './data.js';

const VERDICT_TONE = { unauthorized: 'bad', authorized: 'ok', sensor_suspect: 'warn',
  partial: 'warn', stationary: null, unverifiable: 'warn', pending: null };

const VERDICT_MEANS = {
  unauthorized: 'The seat sensor reported a passenger, the vehicle covered real distance, and no booking on any collected channel overlaps this window.',
  authorized: 'Matched to a booking on a revenue channel.',
  sensor_suspect: 'Occupancy was implausibly long, or registered with the ignition off — consistent with a stuck seat pad rather than a passenger.',
  partial: 'A telemetry gap falls inside this window, so we cannot claim to have observed the whole interval.',
  stationary: 'Occupied, but the vehicle never really moved. Not a trip.',
  unverifiable: 'A revenue channel was unreadable when this was assessed, so "no booking" could not be established.',
  pending: 'Not yet reconciled.',
};

const vTag = (v) => `<span class="tag ${VERDICT_TONE[v] || 'dim'}">${esc(v || '—')}</span>`;

/* The list. `kind` is one of verdict|plate|day|driver, so every facet chip is
   a real destination rather than an in-page filter that dies on reload. */
export async function renderSegments(root, kind, value) {
  root.innerHTML = '';
  loading(root);
  const extra = {};
  if (kind && value) extra[kind] = value;
  const d = await q('/api/segments', extra);
  root.innerHTML = '';

  const vf = d.facets.verdict || [];
  const unauth = vf.find((r) => r.key === 'unauthorized');
  const totalAll = vf.reduce((a, r) => a + r.n, 0);
  root.append(kpiRow([
    { label: 'Segments in window', value: fmt(totalAll), sub: 'every occupancy interval CABMAN saw' },
    { label: 'Unexplained', value: fmt(unauth?.n || 0),
      sub: unauth?.km ? `${fmt(unauth.km)} km carried off-book` : 'no distance recorded',
      tone: unauth?.n ? 'bad' : 'good' },
    { label: 'Matching this filter', value: fmt(d.total),
      sub: kind ? `${kind} = ${value}` : 'no filter applied' },
    { label: 'Assessed blind', value: fmt(d.low_confidence),
      sub: 'a revenue channel was unreadable', tone: d.low_confidence ? 'warn' : null },
  ]));

  if (kind) {
    const clear = el('div', 'note');
    clear.innerHTML = `Filtered to <b>${esc(kind)} = ${esc(value)}</b>. `
      + `<a href="${href('segments')}">Show every segment</a>`;
    root.append(clear);
  }

  const g = el('div', 'grid g3'); root.append(g);

  // ── verdict, as the distribution AND as the filter ──────────────────────
  const vp = panel('Verdict', 'Every occupancy interval gets one — click to filter');
  g.append(vp.panel);
  if (vf.length) {
    donut(vp.body, vf.map((r) => ({ label: r.key, n: r.n })), {
      onClick: (s) => { location.hash = href('segments', 'verdict', s.label); } });
    vp.body.append(el('div', 'chips', vf.map((r) =>
      `<a class="chip${kind === 'verdict' && value === r.key ? ' on' : ''}" href="${href('segments', 'verdict', r.key)}">`
      + `${esc(r.key)} <b>${fmt(r.n)}</b></a>`).join('')));
  } else empty(vp.body, 'Nothing reconciled in this range');

  // ── which cars, and who was holding them ────────────────────────────────
  const pp = panel('Vehicles with unexplained occupancy', 'Ranked by flags, not by fleet size');
  g.append(pp.panel);
  const plates = (d.facets.plate || []).filter((r) => r.unauthorized > 0);
  if (plates.length) {
    hbars(pp.body, plates.slice(0, 12).map((r) => ({ label: r.key, n: r.unauthorized })),
      { color: '--s8', onClick: (s) => { location.hash = href('segments', 'plate', s.label); } });
    /* The facet list is capped at the 40 busiest plates, so this count is over
       what came back. A truncated facet is not a shorter menu — the vehicle
       you are looking for is simply absent from it — so the page says how many
       there are rather than implying the list is all of them. */
    const ft = d.facet_totals || {};
    pp.body.append(el('p', 'cap',
      `${fmt(plates.length)} vehicle(s) shown carry at least one flag. A bar is a link to that vehicle’s segments.`
      + (ft.plate > ft.plate_shown
        ? ` ${fmt(ft.plate)} vehicles appear in this range in total — open a vehicle directly if it is not listed.`
        : '')));
  } else empty(pp.body, 'No vehicle carries an unexplained segment in this range');

  // ── what the reconciler actually said ───────────────────────────────────
  const rp = panel('Recorded reasons', 'The reconciler’s own words, not a sentence written here');
  g.append(rp.panel);
  const reasons = d.facets.reason || [];
  if (reasons.length) {
    rp.body.append(tableFrom(reasons, [
      { label: 'Reason', key: 'key', render: (r) => `<span class="wrap">${esc(r.key)}</span>` },
      { label: 'Verdict', key: 'verdict', render: (r) => vTag(r.verdict) },
      { label: 'Segments', key: 'n', num: true },
    ], { compact: true }));
    const rt = d.facet_totals || {};
    if (rt.reason > rt.reason_shown) rp.body.append(el('p', 'cap',
      `The ${fmt(rt.reason_shown)} commonest of ${fmt(rt.reason)} distinct reasons recorded in this range.`));
    if (d.unreasoned) rp.body.append(el('p', 'cap',
      `${fmt(d.unreasoned)} of the segments matching this filter carry no recorded reason at all — `
      + 'they were judged by a version of the reconciler that did not write one down.'));
  } else empty(rp.body, 'No reasons recorded');

  // ── the day strip, as a filter ──────────────────────────────────────────
  const days = d.facets.day || [];
  if (days.length) {
    const dp = panel('By day', 'Unexplained intervals per day — click a day for that day’s list');
    root.append(dp.panel);
    const strip = el('div', 'cal');
    days.forEach((r) => {
      const c = el('i', r.unauthorized ? 'c bad' : 'c');
      c.style.opacity = r.unauthorized
        ? String(0.35 + 0.65 * Math.min(1, r.unauthorized / Math.max(1, ...days.map((x) => x.unauthorized))))
        : '0.18';
      c.title = `${r.key} — ${r.unauthorized} unexplained of ${r.n} segments`;
      c.style.cursor = 'pointer';
      c.onclick = () => { location.hash = href('segments', 'day', r.key); };
      strip.append(c);
    });
    dp.body.append(strip);
    dp.body.append(el('p', 'cap',
      `${dayStr(days[0].key)} → ${dayStr(days[days.length - 1].key)} · `
      + 'a pale cell is a day with occupancy but nothing unexplained.'));
  }

  // ── the list itself ─────────────────────────────────────────────────────
  const lp = panel(kind ? `Segments — ${kind} ${value}` : 'Every occupancy segment',
    `${fmt(d.rows.length)} shown${d.truncated ? ` of ${fmt(d.total)}` : ''} · click a row for the evidence`);
  root.append(lp.panel);
  if (!d.rows.length) { empty(lp.body, 'Nothing matches this filter'); return; }
  lp.body.append(segmentTable(d.rows));
  if (d.truncated) lp.body.append(el('p', 'cap',
    `Showing the ${fmt(d.rows.length)} most recent of ${fmt(d.total)}. Narrow by vehicle or day to see the rest — `
    + 'this list is capped rather than paged, so the tail is genuinely not on screen.'));
}

/* A table of segments where every cell that names something is a link to it.
   Exported because the vehicle and day pages want the same table. */
export function segmentTable(rows) {
  if (!rows.length) { const d = el('div'); empty(d, 'Nothing flagged here'); return d; }
  const t = tableFrom(rows, [
    { label: 'Plate', key: 'plate', render: (r) => entity('vehicle', r.plate, r.plate) },
    /* Both destinations, because they answer different questions and the row
       previously offered only one. The name opens the PERSON — which is what
       somebody reading an accusation wants — and the funnel opens this
       driver's other flagged segments. A handover day names two people and
       both are openable, which is why the endpoint returns name-and-id pairs
       rather than a comma-joined string it could only print. */
    { label: 'Driver that day', key: 'drivers',
      render: (r) => custody(r, { title: 'This driver’s other flagged segments',
        hrefFor: (d) => href('segments', 'driver', d.name) }) },
    { label: 'Started', key: 'started_at', render: (r) => `<a href="${href('segment', r.plate, r.started_at)}">${esc(dtStr(r.started_at))}</a>` },
    { label: 'Duration', key: 'duration_min', num: true, render: (r) => (r.duration_min ?? '—') + ' min' },
    { label: 'Distance', key: 'distance_km', num: true, render: (r) => (r.distance_km ?? 0) + ' km' },
    { label: 'Top speed', key: 'top_speed', num: true, render: (r) => (r.top_speed ?? 0) + ' km/h' },
    { label: 'Verdict', key: 'verdict', render: (r) => vTag(r.verdict) },
    { label: 'Confidence', key: 'low_confidence', render: (r) => (r.low_confidence
      ? '<span class="tag warn">blind</span>' : '<span class="tag dim">ok</span>') },
  ]);
  // The row is a link too, but only where the click did not land on one of the
  // cell links above — otherwise the plate link and the row link fight.
  t.querySelectorAll('tbody tr').forEach((tr, i) => {
    tr.style.cursor = 'pointer';
    tr.onclick = (e) => {
      if (e.target.closest('a')) return;
      const r = rows[i]; location.hash = href('segment', r.plate, r.started_at);
    };
  });
  return t;
}

/* ── one interval, with the case for and against ──────────────────────────── */
export async function renderSegment(root, plate, at) {
  root.innerHTML = '';
  loading(root);
  let d;
  try {
    d = await api(`/api/segment?plate=${encodeURIComponent(plate)}&at=${encodeURIComponent(at)}`);
  } catch (e) {
    root.innerHTML = '';
    return empty(root, `No segment starts at that instant for ${esc(plate)}. `
      + 'The address encodes an exact timestamp, so a re-reconciliation that shifted a boundary breaks the link.');
  }
  root.innerHTML = '';
  const s = d.segment;

  root.append(kpiRow([
    { label: 'Verdict', value: s.verdict || '—', tone: VERDICT_TONE[s.verdict] || null,
      sub: s.matched_platform ? `matched on ${s.matched_platform}` : 'no booking matched' },
    { label: 'Duration', value: (s.duration_min ?? '—') + ' min', sub: `${timeStr(s.started_at)} → ${timeStr(s.ended_at)}` },
    { label: 'Distance', value: (s.distance_km ?? 0) + ' km',
      sub: d.profile.max_speed != null ? `peak ${Math.round(d.profile.max_speed)} km/h` : 'no speed recorded' },
    { label: 'Observed', value: d.profile.observed === null ? '—' : d.profile.observed ? 'fully' : 'with a gap',
      sub: s.max_gap_min != null ? `largest gap ${s.max_gap_min} min` : 'gap not recorded',
      tone: d.profile.observed === false ? 'warn' : null },
  ]));

  const head = el('div', 'note');
  head.innerHTML = `<b>${esc(plate)}</b> — ${entity('vehicle', plate, 'vehicle page')} · `
    + (s.drivers
      ? `held that day by <b>${esc(s.drivers)}</b>`
      : 'no driver could be attributed to this vehicle on this day')
    + ` · <a href="${href('day', s.local_day)}">everything that happened on ${esc(s.local_day)}</a>`
    + ` · <a href="${href('segments', 'plate', plate)}">this vehicle’s other segments</a>`;
  root.append(head);

  /* ── why ──────────────────────────────────────────────────────────────── */
  const why = panel('Why this verdict', 'What the reconciler recorded, and what it could read at the time');
  root.append(why.panel);
  why.body.append(el('p', 'note', VERDICT_MEANS[s.verdict] || 'This verdict has no written meaning.'));
  const facts = [];
  if (s.verdict_reason) facts.push(['Recorded reason', esc(s.verdict_reason)]);
  else facts.push(['Recorded reason', '<span class="dim">none — judged before reasons were written down</span>']);
  if (s.channels_checked) facts.push(['Channels checked', esc(s.channels_checked)]);
  if (s.nearest_platform || s.nearest_trip_id) {
    facts.push(['Nearest booking', `${esc(s.nearest_platform || '—')} ${esc(s.nearest_trip_id || '')}`
      + (s.nearest_gap_min != null ? ` — ${s.nearest_gap_min} min away` : '')]);
  }
  if (s.boundary_gap_min != null) facts.push(['Nearest telemetry boundary', `${s.boundary_gap_min} min`]);
  if (s.ignition_ratio != null) facts.push(['Ignition on', Math.round(s.ignition_ratio * 100) + '% of fixes']);
  facts.push(['Fixes stored', `${fmt(d.profile.fixes)}${d.profile.moving_pct != null ? ` · moving in ${d.profile.moving_pct}%` : ''}`]);
  why.body.append(tableFrom(facts.map(([k, v]) => ({ k, v })), [
    { label: 'Evidence', key: 'k' }, { label: '', key: 'v', render: (r) => r.v },
  ], { compact: true }));

  if (s.low_confidence) {
    why.body.append(el('p', 'note err',
      `Assessed while these sources were unavailable: ${esc(s.unavailable_sources || 'unrecorded')}. `
      + 'A booking may exist that we could not read, so "no booking anywhere" is a statement about our collection, not about the driver.'));
  }

  /* A clock skew is only visible in the neighbours. If every nearby booking
     sits at the same offset, the fleet is not stealing cars — a timestamp is
     wrong somewhere. */
  const g2 = el('div', 'grid g2'); root.append(g2);
  const nv = panel('Bookings on this vehicle, ±4 hours',
    'Not just the nearest — and deliberately wider than the reconciler’s own match window, because the '
    + 'documented skew is four hours and a window narrower than the bug cannot show the bug');
  g2.append(nv.panel);
  if (d.nearby_vehicle_trips.length) {
    nv.body.append(tableFrom(d.nearby_vehicle_trips, [
      { label: 'Platform', key: 'platform' },
      { label: 'Driver', key: 'driver_name', render: (r) => entity('driver', r.driver_ext_id, r.driver_name) },
      { label: 'Requested', key: 'requested_at', render: (r) => timeStr(r.requested_at) },
      { label: 'Offset', key: 'gap_min', num: true, render: (r) => (r.gap_min > 0 ? '+' : '') + r.gap_min + ' min' },
      { label: 'Outcome', key: 'outcome', render: (r) => (r.outcome
        ? `<span class="tag ${r.outcome === 'completed' ? 'ok' : 'warn'}">${esc(r.outcome)}</span>`
        : `<span class="tag dim">${esc(r.status || '—')}</span>`) },
      { label: 'Fare', key: 'price', num: true, render: (r) => (r.price != null ? money(r.price) : '—') },
    ], { compact: true }));
    const offs = d.nearby_vehicle_trips.map((r) => r.gap_min).filter((n) => n != null);
    const spread = offs.length > 1 ? Math.max(...offs) - Math.min(...offs) : null;
    if (offs.length > 2 && spread != null && spread < 5) {
      nv.body.append(el('p', 'note err',
        `Every nearby booking sits within ${spread} minutes of the same offset. That is the signature of a clock `
        + 'skew between the telemetry feed and the booking channel, not of an unbooked ride.'));
    }
  } else {
    empty(nv.body, 'No booking on any collected channel touched this vehicle within four hours either side');
  }

  const nd = panel('Bookings by the driver who held this car, ±90 min',
    'A person demonstrably driving something else did not drive this');
  g2.append(nd.panel);
  if (d.nearby_driver_trips.length) {
    nd.body.append(tableFrom(d.nearby_driver_trips, [
      { label: 'Platform', key: 'platform' },
      { label: 'Plate', key: 'plate', render: (r) => entity('vehicle', r.plate, r.plate) },
      { label: 'Requested', key: 'requested_at', render: (r) => timeStr(r.requested_at) },
      { label: 'Offset', key: 'gap_min', num: true, render: (r) => (r.gap_min > 0 ? '+' : '') + r.gap_min + ' min' },
      { label: 'Outcome', key: 'outcome', render: (r) => esc(r.outcome || r.status || '—') },
    ], { compact: true }));
    const elsewhere = d.nearby_driver_trips.filter((r) => r.plate && r.plate !== plate);
    if (elsewhere.length) nd.body.append(el('p', 'note err',
      `${fmt(elsewhere.length)} of these bookings were taken in a different vehicle. Either the custody `
      + 'attribution for this day is wrong, or the person named above was not behind this wheel.'));
  } else if (!s.drivers) {
    empty(nd.body, 'No driver is attributed to this vehicle on this day, so there is nobody to check');
  } else {
    empty(nd.body, 'That driver has no booking on any channel within 90 minutes either side');
  }

  /* ── the fixes ────────────────────────────────────────────────────────── */
  const tp = panel('Telemetry through the window',
    `${fmt(d.track.length)} CABMAN fixes at 5-minute resolution, five minutes either side of the boundary`);
  root.append(tp.panel);
  if (d.track.length) {
    areaChart(tp.body, d.track.map((r) => ({ t: timeStr(r.captured_at), speed: +r.speed || 0 })),
      { x: 't', y: 'speed', color: '--s8' });
    tp.body.append(tableFrom(d.track.slice(0, 60), [
      { label: 'Time', key: 'captured_at', render: (r) => timeStr(r.captured_at) },
      { label: 'Speed', key: 'speed', num: true, render: (r) => (r.speed != null ? fmt(r.speed) + ' km/h' : '—') },
      { label: 'Seat', key: 'seat_occupied', render: (r) => (r.seat_occupied == null
        ? '<span class="tag dim">not reported</span>'
        : r.seat_occupied ? '<span class="tag ok">occupied</span>' : '<span class="tag">empty</span>') },
      { label: 'Ignition', key: 'ignition', render: (r) => (r.ignition == null ? '—' : r.ignition ? 'on' : 'off') },
      { label: 'Lat', key: 'lat', num: true }, { label: 'Lng', key: 'lng', num: true },
    ], { compact: true }));
    if (d.track.length > 60) tp.body.append(el('p', 'cap', `First 60 of ${fmt(d.track.length)} fixes.`));
  } else {
    empty(tp.body, 'No fixes are stored for this window — which means the segment itself was built from data we no longer hold');
  }

  /* ── the day around it ────────────────────────────────────────────────── */
  if (d.same_day_segments.length > 1) {
    const sd = panel(`Everything this vehicle did on ${s.local_day}`,
      `${fmt(d.same_day_segments.length)} occupancy intervals — one flag in a normal day reads differently from one in a day of flags`);
    root.append(sd.panel);
    sd.body.append(segmentTable(d.same_day_segments.map((r) => ({ ...r, drivers: s.drivers }))));
  }

  if (d.custody.length) {
    const cp = panel('Custody either side of this day', 'Who the trip record says was in this car');
    root.append(cp.panel);
    cp.body.append(tableFrom(d.custody, [
      { label: 'Day', key: 'day', render: (r) => dayStr(r.day) },
      { label: 'Driver', key: 'driver_name', render: (r) => entity('driver', r.driver_ext_id, r.driver_name) },
      { label: 'Platform', key: 'platform' },
      { label: 'Trips', key: 'trips', num: true },
    ], { compact: true }));
  }

  if (d.channels_that_day.length) {
    const ch = panel('Channels that wrote rows that day',
      'A verdict of “no booking anywhere” means nothing if a channel was not collecting');
    root.append(ch.panel);
    ch.body.append(el('div', 'chips', d.channels_that_day.map((r) =>
      `<span class="chip">${esc(r.platform)} <b>${fmt(r.rows_that_day)}</b></span>`).join('')));
    ch.body.append(el('p', 'cap',
      'Counts are fleet-wide for that calendar day, not for this vehicle — a channel with zero rows fleet-wide '
      + 'was not collecting, and could not have supplied the missing booking.'));
  }
}
