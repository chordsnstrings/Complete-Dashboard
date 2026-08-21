/* Per-vehicle detail — the asset's own pages.
   ──────────────────────────────────────────────────────────────────────────
     #vehicle/<plate>            overview   what it is, and whether it earns
     #vehicle/<plate>/drivers    drivers    who has held it, day by day
     #vehicle/<plate>/movement   movement   where it goes, and where it sits
     #vehicle/<plate>/safety     safety     harsh driving, attributed to a person
     #vehicle/<plate>/compliance compliance documents with an expiry date
     #vehicle/<plate>/trips      trips      the underlying records

   The question a fleet actually asks of a vehicle is "is this asset earning,
   and is it legal to be on the road" — and no single source answers it. The
   platforms know the trips, the telematics box knows the movement, the fleet
   portal knows the papers. These pages put the three next to each other. */

import { barChart, areaChart, donut, hbars, empty } from './charts.js';
import { el, esc, panel, loading, tableFrom, kpiRow, tabBar, pill, note,
  dayStr, dtStr, timeStr, money, pct, fmt } from './ui.js';
import { qAll, href } from './data.js';
import { makeMap, fitTo, renderJourney } from './map.js';

export const VEHICLE_TABS = [
  { id: 'overview', label: 'Overview', ic: '◱' },
  { id: 'drivers', label: 'Drivers', ic: '◧' },
  { id: 'movement', label: 'Movement', ic: '◍' },
  { id: 'safety', label: 'Safety', ic: '△' },
  { id: 'compliance', label: 'Compliance', ic: '❑' },
  { id: 'trips', label: 'Trips', ic: '▤' },
];

const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const docTone = (d) => (d == null ? null : d < 0 ? 'bad' : d < 30 ? 'warn' : 'ok');

/* ── identity header ─────────────────────────────────────────────────────── */
function identityCard(p) {
  const s = p.spec || {}, t = p.telemetry;
  const soonest = (p.documents || []).find((d) => d.days_left != null);
  const wrap = el('div', 'idcard');
  wrap.innerHTML = `
    <div class="platetag">${esc(p.plate)}</div>
    <div class="idmeta">
      <h2>${esc([s.year, s.make, s.model].filter(Boolean).join(' ') || p.plate)}</h2>
      <div class="idsub">
        ${s.fleet_id ? pill(s.fleet_id, 'plat') : ''}
        ${s.fuel_type ? pill(s.fuel_type, 'plat') : ''}
        ${t ? pill(t.stale ? 'tracker stale' : (t.status || 'tracked'), t.stale ? 'warn' : 'ok') : pill('no tracker', 'warn')}
        ${soonest ? pill(`${esc(soonest.doc_type)} ${soonest.days_left < 0 ? `expired ${Math.abs(soonest.days_left)}d ago` : `${soonest.days_left}d left`}`, docTone(soonest.days_left)) : ''}
      </div>
      <div class="idfacts">
        ${p.current_driver?.driver_name
          ? `<span><b>Driver</b> <a class="lnk" href="${href('driver', p.current_driver.driver_ext_id)}">${esc(p.current_driver.driver_name)}</a></span>`
          : '<span><b>Driver</b> unassigned</span>'}
        ${s.colour ? `<span><b>Colour</b> ${esc(s.colour)}</span>` : ''}
        ${s.vin ? `<span><b>VIN</b> ${esc(s.vin)}</span>` : ''}
        ${t?.odometer ? `<span><b>Odometer</b> ${fmt(t.odometer)} km</span>` : ''}
        ${t?.fuel_level != null ? `<span><b>Charge</b> ${fmt(t.fuel_level)}%</span>` : ''}
        <span><b>Last fix</b> ${dtStr(t?.last_fix)}</span>
        <span><b>Drivers</b> ${p.span?.drivers ?? 0}</span>
      </div>
    </div>`;
  return wrap;
}

/* ── tab: overview ───────────────────────────────────────────────────────── */
async function tabOverview(root, plate, prof) {
  const kpiHost = el('div'); root.append(kpiHost); loading(kpiHost);
  const g1 = el('div', 'grid g23'); root.append(g1);
  const vol = panel('Trips and idle days', 'A bar per day. Days with a tracker fix but no trip are the ones that cost money.'); g1.append(vol.panel);
  const who = panel('Who has driven it', 'By trips in this window'); g1.append(who.panel);
  const g2 = el('div', 'grid g3'); root.append(g2);
  const prod = panel('Service tier', 'Which product this asset serves'); g2.append(prod.panel);
  const plat = panel('Platform', 'Where its work comes from'); g2.append(plat.panel);
  const pay = panel('Payment', 'Card vs cash'); g2.append(pay.panel);
  const rev = panel('Revenue by day', 'Booked fare value'); root.append(rev.panel);
  [vol.body, who.body, prod.body, plat.body, pay.body, rev.body].forEach(loading);

  const [k, daily, dd, mix] = await Promise.all([
    qAll('/api/vehicle/kpis', { plate }), qAll('/api/vehicle/daily', { plate }),
    qAll('/api/vehicle/drivers-detail', { plate }), qAll('/api/vehicle/mix', { plate }),
  ]);

  kpiHost.replaceWith(kpiRow([
    { label: 'Trips', value: fmt(k.trips), sub: `${fmt(k.days_worked)} earning days` },
    { label: 'Distance', value: `${fmt(k.km)} km`, sub: `avg ${fmt(k.avg_km, 1)} km per trip` },
    { label: 'Revenue', value: money(k.revenue), sub: k.revenue_per_km ? `${money(k.revenue_per_km, 'AED', 2)} per km` : 'from trip fares' },
    { label: 'Utilisation', value: k.utilisation != null ? pct(k.utilisation * 100, 1) : '—', sub: 'platform-reported, share of online time earning',
      tone: k.utilisation == null ? null : k.utilisation >= 0.5 ? 'good' : k.utilisation >= 0.3 ? 'warn' : 'critical' },
    { label: 'Idle days', value: fmt(k.idle_days), sub: 'reported a position, earned nothing',
      tone: k.idle_days === 0 ? 'good' : k.idle_days <= 3 ? 'warn' : 'critical' },
    { label: 'Drivers', value: fmt(k.drivers), sub: `across ${fmt(k.platforms)} platform(s)` },
    { label: 'Harsh events', value: fmt(k.alerts), sub: k.alerts_per_100km != null ? `${fmt(k.alerts_per_100km, 1)} per 100 km` : 'no matched distance',
      tone: k.alerts_per_100km == null ? null : k.alerts_per_100km <= 5 ? 'good' : k.alerts_per_100km <= 15 ? 'warn' : 'critical' },
    { label: 'Last fix', value: k.hours_since_fix != null ? `${fmt(k.hours_since_fix, 1)}h ago` : '—', sub: `${fmt(k.fixes)} fixes in range`,
      tone: k.hours_since_fix == null ? null : k.hours_since_fix < 1 ? 'good' : k.hours_since_fix < 24 ? 'warn' : 'critical' },
  ]));

  vol.body.innerHTML = '';
  // Colour the bar by whether the day earned: an idle day with a live tracker
  // is a different fact from a day the vehicle was simply absent.
  barChart(vol.body, daily.map((d) => ({
    label: `${dayStr(d.day)}${d.trips ? '' : d.fixes ? ' · idle (tracker live)' : ''}`,
    trips: d.trips,
  })), { x: 'label', y: 'trips', color: '--b400' });
  const idle = daily.filter((d) => !d.trips && d.fixes);
  if (idle.length) vol.body.append(el('p', 'cap',
    `${idle.length} day(s) with a tracker fix and no trip on any platform: ${idle.map((d) => dayStr(d.day)).join(', ')}.`));

  who.body.innerHTML = '';
  if (!dd.totals.length) who.body.append(note('No custody records for this vehicle in this window.'));
  else {
    hbars(who.body, dd.totals.slice(0, 8).map((t) => ({ label: t.driver_name || t.driver_ext_id, n: t.trips })),
      { label: 'label', value: 'n', seq: true,
        onClick: (d) => { const t = dd.totals.find((x) => (x.driver_name || x.driver_ext_id) === d.label);
          if (t) location.hash = href('driver', t.driver_ext_id); } });
    who.body.append(el('p', 'cap', 'Click a driver to open their pages.'));
  }

  donut(prod.body, mix.product.slice(0, 6));
  donut(plat.body, mix.platform.slice(0, 6));
  donut(pay.body, mix.payment.slice(0, 6));

  rev.body.innerHTML = '';
  const withRev = daily.filter((d) => d.revenue != null && +d.revenue > 0);
  if (!withRev.length) rev.body.append(note('No fare values on this vehicle’s trips in this window — the Uber trip export omits fares, so revenue only appears where the hotel or telematics feed supplied one.'));
  else areaChart(rev.body, withRev.map((d) => ({ label: dayStr(d.day), v: +d.revenue })), { x: 'label', y: 'v', valueFmt: (v) => money(v) });
}

/* ── tab: drivers ────────────────────────────────────────────────────────── */
async function tabDrivers(root, plate) {
  const tot = panel('Drivers who have held this vehicle', 'Totals across the window — click through to a driver’s pages'); root.append(tot.panel);
  const tl = panel('Custody day by day', 'Every day, and who was holding it. More than one row on a day is a handover.'); root.append(tl.panel);
  [tot.body, tl.body].forEach(loading);
  const dd = await qAll('/api/vehicle/drivers-detail', { plate });

  tot.body.innerHTML = '';
  if (!dd.totals.length) { tot.body.append(note('No custody records for this vehicle in this window.')); }
  else {
    const t = tableFrom(dd.totals, [
      { label: 'Driver', key: 'driver_name', render: (r) => `<a class="lnk" href="${href('driver', r.driver_ext_id)}">${esc(r.driver_name || r.driver_ext_id)}</a>` },
      { label: 'Days', key: 'days', num: true },
      { label: 'As primary', key: 'primary_days', num: true },
      { label: 'Trips', key: 'trips', num: true },
      { label: 'Km', key: 'km', num: true, render: (r) => fmt(r.km) },
      { label: 'Revenue', key: 'revenue', num: true, render: (r) => (r.revenue ? money(r.revenue) : '—') },
      { label: 'Held', key: '_h', render: (r) => `${dayStr(r.first_day)} → ${dayStr(r.last_day)}` },
    ]);
    tot.body.append(t);
  }

  tl.body.innerHTML = '';
  tl.body.append(tableFrom(dd.days.slice(0, 120), [
    { label: 'Day', key: 'day', render: (r) => dayStr(r.day) },
    { label: 'Driver', key: 'driver_name', render: (r) => `<a class="lnk" href="${href('driver', r.driver_ext_id)}">${esc(r.driver_name || r.driver_ext_id)}</a>` },
    { label: 'Platform', key: 'platform' },
    { label: 'Trips', key: 'trips', num: true },
    { label: 'Km', key: 'km', num: true, render: (r) => fmt(r.km) },
    { label: 'First', key: '_a', render: (r) => timeStr(r.first_trip_at) },
    { label: 'Last', key: '_b', render: (r) => timeStr(r.last_trip_at) },
    { label: 'Primary', key: 'is_primary', render: (r) => (r.is_primary ? '●' : '—') },
  ]));
}

/* ── tab: movement ───────────────────────────────────────────────────────── */
async function tabMovement(root, plate) {
  const ctl = el('div', 'toolbar');
  ctl.innerHTML = `<label class="cap" for="vDay">Replay a day</label>
    <select id="vDay" class="btn"></select>
    <span class="cap" id="vDayNote"></span>`;
  root.append(ctl);
  const mapP = panel('Where it went', 'Straight lines join consecutive fixes; a long gap breaks the line rather than inventing a route.');
  mapP.panel.classList.add('mapwrap'); root.append(mapP.panel);
  const node = el('div', 'mapnode'); mapP.body.append(node);
  const stat = el('div'); mapP.body.append(stat);
  const g = el('div', 'grid g2'); root.append(g);
  const verd = panel('Movement accounted for', 'Every period the vehicle moved, matched against a booking'); g.append(verd.panel);
  const park = panel('Where it sits', 'Clusters of stationary fixes — depot, rank, or somebody’s street'); g.append(park.panel);
  const seg = panel('Movement periods', 'Newest first'); root.append(seg.panel);
  [verd.body, park.body, seg.body].forEach(loading);

  const mv = await qAll('/api/vehicle/movement', { plate });
  const map = makeMap(node, { zoom: 10 });
  let layer = null;

  const sel = ctl.querySelector('#vDay');
  sel.innerHTML = mv.days.map((d) => `<option value="${String(d.day).slice(0, 10)}">${dayStr(d.day)} · ${d.fixes} fixes</option>`).join('')
    || '<option value="">no replayable days</option>';

  const showParking = () => {
    if (layer) { map.removeLayer(layer); layer = null; }
    layer = L.layerGroup().addTo(map);
    const pts = [];
    mv.parked.forEach((s) => {
      L.circleMarker([s.lat, s.lng], { radius: 5 + Math.min(10, Math.sqrt(s.fixes)), color: css('--s5'),
        weight: 1.5, fill: false, dashArray: '3,3', opacity: .7 }).addTo(layer)
        .bindTooltip(`Stationary across ${s.fixes} fixes`, { direction: 'top' });
      pts.push([s.lat, s.lng]);
    });
    fitTo(map, pts, { maxZoom: 14 });
    stat.innerHTML = '';
    stat.append(el('p', 'cap', mv.parked.length
      ? `${mv.parked.length} places this vehicle stood still. Pick a day above to replay its route instead.`
      : 'No stationary clusters recorded. Pick a day above to replay a route.'));
  };

  const showDay = async (day) => {
    if (!day) return showParking();
    if (layer) { map.removeLayer(layer); layer = null; }
    stat.innerHTML = '<div class="skel">Loading…</div>';
    const j = await qAll('/api/map/journey', { plate, day });
    stat.innerHTML = '';
    if (!j.fixes) { stat.append(note(`No GPS fixes stored for ${plate} on ${day}.`)); return showParking(); }
    layer = renderJourney(map, j);
    stat.append(kpiRow([
      { label: 'Fixes', value: fmt(j.fixes), sub: 'five-minute samples' },
      { label: 'Distance', value: `${fmt(j.distance_km)} km`, sub: 'between consecutive fixes' },
      { label: 'With passenger', value: `${fmt(j.occupied_km)} km`,
        sub: j.distance_km ? `${Math.round((j.occupied_km / j.distance_km) * 100)}% of the day` : null },
      { label: 'Driver', value: j.driver || '—', sub: j.driver_trips != null ? `${j.driver_trips} trips` : 'from the trip record' },
    ]));
  };

  sel.onchange = (e) => showDay(e.target.value);
  if (mv.days.length) await showDay(sel.value); else showParking();

  verd.body.innerHTML = '';
  if (!mv.by_verdict.length) verd.body.append(note('No movement periods derived yet. These come from the occupancy analysis, which needs seat-sensor telemetry alongside the trip feed.'));
  else {
    hbars(verd.body, mv.by_verdict.map((v) => ({ label: v.verdict.replace(/_/g, ' '), n: v.n })), { label: 'label', value: 'n', seq: true });
    const un = mv.by_verdict.find((v) => v.verdict === 'unauthorized');
    if (un) verd.body.append(el('p', 'cap', `${un.n} period(s) covering ${fmt(un.km)} km had the seat occupied and the vehicle moving with no booking on any channel.`));
  }

  park.body.innerHTML = '';
  park.body.append(tableFrom(mv.parked.slice(0, 12), [
    { label: 'Location', key: '_l', render: (r) => `${(+r.lat).toFixed(3)}, ${(+r.lng).toFixed(3)}` },
    { label: 'Fixes', key: 'fixes', num: true },
    { label: 'Approx. hours', key: '_h', num: true, render: (r) => fmt((r.fixes * 5) / 60, 1) },
  ], { compact: true }));
  park.body.append(el('p', 'cap', 'Each fix is a five-minute sample, so the hours column is a floor, not a measure.'));

  seg.body.innerHTML = '';
  seg.body.append(tableFrom(mv.segments.slice(0, 60), [
    { label: 'Started', key: 'started_at', render: (r) => dtStr(r.started_at) },
    { label: 'Ended', key: 'ended_at', render: (r) => timeStr(r.ended_at) },
    { label: 'Minutes', key: 'duration_min', num: true },
    { label: 'Km', key: 'distance_km', num: true, render: (r) => fmt(r.distance_km, 1) },
    { label: 'Top speed', key: 'top_speed', num: true, render: (r) => (r.top_speed ? `${fmt(r.top_speed)} km/h` : '—') },
    { label: 'Verdict', key: 'verdict', render: (r) => pill(r.verdict || 'unknown',
      r.verdict === 'unauthorized' ? 'bad' : r.verdict === 'authorized' ? 'ok' : 'warn') },
    { label: 'Matched', key: 'matched_platform' },
    { label: 'Confidence', key: 'low_confidence', render: (r) => (r.low_confidence ? 'low' : 'normal') },
  ]));
}

/* ── tab: safety ─────────────────────────────────────────────────────────── */
async function tabSafety(root, plate) {
  const kpiHost = el('div'); root.append(kpiHost); loading(kpiHost);
  const g = el('div', 'grid g2'); root.append(g);
  const types = panel('Event types', 'What the telematics box flagged'); g.append(types.panel);
  const drv = panel('Attributed to a driver', 'By whoever held the vehicle on the day of the event'); g.append(drv.panel);
  const line = panel('Events by day', ''); root.append(line.panel);
  const recent = panel('Recent events', 'Newest first, with location where the device reported one'); root.append(recent.panel);
  [types.body, drv.body, line.body, recent.body].forEach(loading);

  const [sf, k] = await Promise.all([qAll('/api/vehicle/safety', { plate }), qAll('/api/vehicle/kpis', { plate })]);
  const total = sf.by_type.reduce((a, r) => a + r.n, 0);

  kpiHost.replaceWith(kpiRow([
    { label: 'Harsh events', value: fmt(total), sub: `over ${fmt(k.km)} km` },
    { label: 'Per 100 km', value: k.alerts_per_100km != null ? fmt(k.alerts_per_100km, 1) : '—', sub: 'comparable across the fleet',
      tone: k.alerts_per_100km == null ? null : k.alerts_per_100km <= 5 ? 'good' : k.alerts_per_100km <= 15 ? 'warn' : 'critical' },
    { label: 'Worst type', value: sf.by_type[0]?.alert_type || '—', sub: sf.by_type[0] ? `${fmt(sf.by_type[0].n)} events` : null },
    { label: 'Most events', value: sf.by_driver[0]?.driver_name || '—', sub: sf.by_driver[0] ? `${fmt(sf.by_driver[0].n)} events` : null },
  ]));

  types.body.innerHTML = '';
  if (!sf.by_type.length) types.body.append(note('No harsh-driving events for this vehicle in this window.'));
  else hbars(types.body, sf.by_type.map((r) => ({ label: r.alert_type, n: r.n })), { label: 'label', value: 'n', seq: true });

  drv.body.innerHTML = '';
  if (!sf.by_driver.length) drv.body.append(note('Nothing to attribute yet.'));
  else {
    drv.body.append(tableFrom(sf.by_driver, [
      { label: 'Driver', key: 'driver_name' },
      { label: 'Events', key: 'n', num: true },
      { label: 'Km that day', key: 'km', num: true, render: (r) => (r.km ? fmt(r.km) : '—') },
      { label: 'Per 100 km', key: '_r', num: true, render: (r) => (r.km > 0 ? fmt((r.n / r.km) * 100, 1) : '—') },
    ], { compact: true }));
    drv.body.append(el('p', 'cap', '“unattributed” means the event landed on a day with no custody record — a trip gap, not an unknown driver.'));
  }

  line.body.innerHTML = '';
  if (!sf.daily.length) empty(line.body, 'No events in this range');
  else barChart(line.body, sf.daily.map((d) => ({ label: dayStr(d.day), alerts: d.alerts })), { x: 'label', y: 'alerts', color: '--s2' });

  recent.body.innerHTML = '';
  recent.body.append(tableFrom(sf.recent.slice(0, 60), [
    { label: 'When', key: 'occurred_at', render: (r) => dtStr(r.occurred_at) },
    { label: 'Event', key: 'alert_type' },
    { label: 'Location', key: 'location' },
    { label: 'Position', key: '_p', render: (r) => (r.lat ? `${(+r.lat).toFixed(4)}, ${(+r.lng).toFixed(4)}` : '—') },
    { label: 'Clip', key: 'video_url', render: (r) => (r.video_url ? `<a class="lnk" href="${esc(r.video_url)}" target="_blank" rel="noopener">view</a>` : '—') },
  ]));
}

/* ── tab: compliance ─────────────────────────────────────────────────────── */
async function tabCompliance(root, plate, prof) {
  const p = panel('Documents', 'Everything with an expiry date attached to this vehicle'); root.append(p.panel);
  const docs = prof.documents || [];
  p.body.innerHTML = '';
  if (!docs.length) {
    p.body.append(note('No documents collected for this vehicle. Uber publishes these per vehicle; they appear once the fleet-portal collector has run against an account that can see them.'));
  } else {
    p.body.append(tableFrom(docs, [
      { label: 'Document', key: 'doc_type' },
      { label: 'Platform', key: 'platform' },
      { label: 'Status', key: 'status', render: (r) => pill(r.status || '—', r.status === 'ACTIVE' ? 'ok' : 'warn') },
      { label: 'Expires', key: 'expires_at', render: (r) => dayStr(r.expires_at) },
      { label: 'Days left', key: 'days_left', num: true, render: (r) => (r.days_left == null ? '—'
        : pill(r.days_left < 0 ? `expired ${Math.abs(r.days_left)}d ago` : `${r.days_left}d`, docTone(r.days_left))) },
    ]));
    const soon = docs.filter((d) => d.days_left != null && d.days_left < 30);
    if (soon.length) p.body.append(el('p', 'cap',
      `${soon.length} document(s) expire within 30 days. Renewal in the UAE is not same-day — leaving it to the final week risks losing the vehicle from service.`));
  }

  const s = prof.spec || {};
  const spec = panel('Specification', 'As the fleet register and the platform profile describe it'); root.append(spec.panel);
  spec.body.innerHTML = '';
  const rows = [['Plate', prof.plate], ['Make', s.make], ['Model', s.model], ['Year', s.year],
    ['Colour', s.colour], ['VIN', s.vin], ['Fuel', s.fuel_type], ['Fleet', s.fleet_id],
    ['Platform record', s.platform ? `${s.platform} · ${s.vehicle_ext_id}` : null],
    ['Platform compliance', s.compliance_status]].filter(([, v]) => v != null && v !== '');
  spec.body.append(el('div', 'kv', rows.map(([k, v]) =>
    `<div class="kv-k">${esc(k)}</div><div class="kv-v">${esc(v)}</div>`).join('')));
  if (s.image_url) {
    const img = el('img'); img.src = s.image_url; img.alt = `${prof.plate}`;
    img.style.cssText = 'max-width:320px;border-radius:var(--r-sm);margin-top:14px';
    spec.body.append(img);
  }
}

/* ── tab: trips ──────────────────────────────────────────────────────────── */
async function tabTrips(root, plate) {
  const p = panel('Trip records', 'Every platform, newest first'); root.append(p.panel); loading(p.body);
  const rows = await qAll('/api/vehicle/trips', { plate, limit: 500 });
  p.body.innerHTML = '';
  if (!rows.length) return empty(p.body);
  const bar = el('div', 'toolbar');
  bar.innerHTML = `<input id="vq" type="search" placeholder="Filter by driver, address, product or status…">
    <span class="cap" id="vn">${rows.length} trips</span>`;
  p.body.append(bar);
  const host = el('div'); p.body.append(host);
  const cols = [
    { label: 'Requested', key: 'requested_at', render: (r) => dtStr(r.requested_at) },
    { label: 'Driver', key: 'driver_name', render: (r) => (r.driver_ext_id
      ? `<a class="lnk" href="${href('driver', r.driver_ext_id)}">${esc(r.driver_name || r.driver_ext_id)}</a>`
      : esc(r.driver_name || '—')) },
    { label: 'Platform', key: 'platform' },
    { label: 'From', key: 'pickup_addr' },
    { label: 'To', key: 'dropoff_addr' },
    { label: 'Km', key: 'distance_km', num: true, render: (r) => fmt(r.distance_km, 1) },
    { label: 'Product', key: 'product' },
    { label: 'Status', key: 'status', render: (r) => pill(r.status || '—', /cancel/i.test(r.status || '') ? 'warn' : 'ok') },
    { label: 'Fare', key: 'price', num: true, render: (r) => (r.price ? money(r.price, r.currency) : '—') },
  ];
  const draw = (list) => { host.innerHTML = ''; host.append(tableFrom(list.slice(0, 400), cols)); };
  draw(rows);
  bar.querySelector('#vq').oninput = (e) => {
    const t = e.target.value.trim().toLowerCase();
    const list = t ? rows.filter((r) => JSON.stringify(r).toLowerCase().includes(t)) : rows;
    bar.querySelector('#vn').textContent = `${list.length} trips`;
    draw(list);
  };
}

const TABS = { overview: tabOverview, drivers: tabDrivers, movement: tabMovement,
  safety: tabSafety, compliance: tabCompliance, trips: tabTrips };

/* ── page shell ──────────────────────────────────────────────────────────── */
export async function renderVehicle(root, plate, tab = 'overview') {
  const head = el('div'); root.append(head); loading(head);
  const body = el('div'); root.append(body);

  let prof;
  try { prof = await qAll('/api/vehicle/profile', { plate }); }
  catch {
    head.innerHTML = `<div class="empty"><b>No such vehicle</b>Nothing in the record matches this plate.
      <a class="lnk" href="${href('vehicles')}">Back to all vehicles</a></div>`;
    return;
  }
  head.innerHTML = '';
  head.append(identityCard(prof));
  head.append(tabBar(VEHICLE_TABS, tab, (t) => href('vehicle', plate, t === 'overview' ? null : t)));

  const fn = TABS[tab] || tabOverview;
  await fn(body, plate, prof);
  return { name: prof.plate, spec: prof.spec };
}

/* ── the directory that links into the pages above ───────────────────────── */
export async function renderVehicleDirectory(root) {
  const bar = el('div', 'toolbar');
  bar.innerHTML = `<input id="vdq" type="search" placeholder="Search by plate, make, model or driver…">
    <span class="cap" id="vdn"></span>`;
  root.append(bar);
  const kpiHost = el('div'); root.append(kpiHost); loading(kpiHost);
  const tblP = panel('Every vehicle', 'Including assets with no trips in this window — those are the ones worth finding'); root.append(tblP.panel);
  loading(tblP.body);

  const rows = await qAll('/api/vehicles/directory');
  bar.querySelector('#vdn').textContent = `${rows.length} vehicles`;

  const earning = rows.filter((r) => r.trips > 0).length;
  const tracked = rows.filter((r) => r.last_fix).length;
  const staleN = rows.filter((r) => r.stale).length;
  const expiring = rows.filter((r) => r.doc_days_left != null && r.doc_days_left < 30).length;
  kpiHost.replaceWith(kpiRow([
    { label: 'Vehicles', value: fmt(rows.length), sub: 'with any record at all' },
    { label: 'Earning', value: fmt(earning), sub: `${fmt(rows.length - earning)} with no trip in this window`,
      tone: earning === rows.length ? 'good' : rows.length - earning > rows.length / 4 ? 'critical' : 'warn' },
    { label: 'Tracked', value: fmt(tracked), sub: `${fmt(staleN)} with a stale fix`,
      tone: staleN === 0 ? 'good' : 'warn' },
    { label: 'Documents due', value: fmt(expiring), sub: 'expiring within 30 days',
      tone: expiring === 0 ? 'good' : 'critical' },
  ]));

  const cols = [
    { label: 'Plate', key: 'plate', render: (r) => `<a class="lnk" href="${href('vehicle', r.plate)}">${esc(r.plate)}</a>` },
    { label: 'Vehicle', key: '_v', render: (r) => esc([r.year, r.make, r.model].filter(Boolean).join(' ') || '—') },
    { label: 'Current driver', key: 'current_driver', render: (r) => esc(r.current_driver || '—') },
    { label: 'Trips', key: 'trips', num: true, render: (r) => fmt(r.trips) },
    { label: 'Days', key: 'days', num: true },
    { label: 'Km', key: 'km', num: true, render: (r) => fmt(r.km) },
    { label: 'Revenue', key: 'revenue', num: true, render: (r) => (r.revenue ? money(r.revenue) : '—') },
    { label: 'Alerts', key: 'alerts', num: true },
    { label: 'Tracker', key: '_t', render: (r) => (!r.last_fix ? pill('none', 'warn')
      : pill(r.stale ? 'stale' : (r.status || 'live'), r.stale ? 'warn' : 'ok')) },
    { label: 'Documents', key: '_d', render: (r) => (r.doc_days_left == null ? '—'
      : pill(r.doc_days_left < 0 ? 'expired' : `${r.doc_days_left}d`, docTone(r.doc_days_left))) },
    { label: 'Last trip', key: 'last_trip', render: (r) => dayStr(r.last_trip) },
  ];
  const draw = (list) => {
    tblP.body.innerHTML = '';
    const t = tableFrom(list, cols);
    t.querySelectorAll('tbody tr').forEach((tr, i) => {
      tr.style.cursor = 'pointer';
      tr.onclick = (ev) => { if (ev.target.tagName !== 'A') location.hash = href('vehicle', list[i].plate); };
    });
    tblP.body.append(t);
  };
  draw(rows);
  bar.querySelector('#vdq').oninput = (e) => {
    const t = e.target.value.trim().toLowerCase();
    const list = t ? rows.filter((r) => `${r.plate} ${r.make} ${r.model} ${r.current_driver}`.toLowerCase().includes(t)) : rows;
    bar.querySelector('#vdn').textContent = `${list.length} vehicles`;
    draw(list);
  };
  return rows;
}
