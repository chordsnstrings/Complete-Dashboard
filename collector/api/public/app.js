// Fleet Dashboard — a multipage app behind a hash router.
// Views live in this file; the per-driver detail pages live in driver.js, and
// everything shared between them (panels, tables, modals, routing, fetching)
// lives in ui.js and data.js so the two cannot drift apart.
import { barChart, areaChart, donut, hbars, heatmap, scatter, stackedBar, fmt, empty, showTip, hideTip } from './charts.js';
import { $, el, esc, panel, loading, tableFrom, drill, kpiRow, pill, dayStr, dtStr, money, pct } from './ui.js';
import { state, api, params, q, qAll, href, parseHash, navigate } from './data.js';
import { renderDriver, renderDriverDirectory, DRIVER_TABS } from './driver.js';

const VIEWS = [
  { id: 'overview', label: 'Overview', ic: '◱', grp: 'Analyse', sub: 'Fleet-wide performance across every platform' },
  { id: 'demand', label: 'Demand', ic: '◷', grp: 'Analyse', sub: 'When trips happen — by day, hour and weekday' },
  { id: 'drivers', label: 'Drivers', ic: '◧', grp: 'Analyse', sub: 'Per-driver output, quality and cross-platform activity' },
  { id: 'vehicles', label: 'Vehicles', ic: '▤', grp: 'Analyse', sub: 'Utilisation and revenue per vehicle' },
  { id: 'platforms', label: 'Platforms', ic: '◨', grp: 'Analyse', sub: 'Uber vs Yango vs Bolt — share and mix' },
  { id: 'finance', label: 'Finance', ic: '◈', grp: 'Analyse', sub: 'Revenue, payment mix and the transaction ledger' },
  { id: 'insights', label: 'Action list', ic: '✦', grp: 'Operate', sub: 'What needs doing, ranked by what it costs to ignore' },
  { id: 'compliance', label: 'Compliance', ic: '❑', grp: 'Operate', sub: 'Documents and licences with an expiry date attached' },
  { id: 'unauthorized', label: 'Unauthorized trips', ic: '⚠', grp: 'Operate', sub: 'Seat occupied, vehicle moved — but no booking on any channel' },
  { id: 'safety', label: 'Safety', ic: '△', grp: 'Operate', sub: 'Harsh-driving events from the telematics layer' },
  { id: 'live', label: 'Live fleet', ic: '◉', grp: 'Operate', sub: 'Realtime positions — CABMAN refreshes every 5 minutes' },
  { id: 'map', label: 'Map & replay', ic: '◍', grp: 'Operate', sub: 'Where every vehicle is now, and where it went on any given day' },
  { id: 'sources', label: 'Data sources', ic: '⛁', grp: 'Operate', sub: 'Collector health, coverage and history depth' },
  { id: 'settings', label: 'Settings', ic: '⚙', grp: 'Configure', sub: 'Credentials and collection schedule' },
];

/* ─────────── shell ─────────── */
// A detail page keeps its parent lit in the sidebar — `#driver/…` is a page
// *within* Drivers, not a thirteenth top-level destination.
const PARENT = { driver: 'drivers', vehicle: 'vehicles' };

function renderNav() {
  const nav = $('#nav'); nav.innerHTML = '';
  const lit = PARENT[state.view] || state.view;
  let grp = null;
  VIEWS.forEach((v) => {
    if (v.grp !== grp) { grp = v.grp; nav.append(el('div', 'grp', grp)); }
    const a = el('a', v.id === lit ? 'on' : '', `<span class="ic">${v.ic}</span>${v.label}`);
    a.href = href(v.id);
    nav.append(a);
  });
}
function setHeader(detail) {
  const crumb = $('#crumb');
  if (state.view === 'driver') {
    const tab = DRIVER_TABS.find((t) => t.id === (state.sub || 'overview')) || DRIVER_TABS[0];
    $('#viewTitle').textContent = detail?.name || 'Driver';
    $('#viewSub').textContent = `${tab.label} — every platform this person works on, combined`;
    crumb.innerHTML = `<a href="${href('drivers')}">Drivers</a><span>/</span><b>${esc(detail?.name || state.param || '')}</b>`;
    crumb.style.display = 'flex';
  } else {
    const v = VIEWS.find((x) => x.id === state.view) || VIEWS[0];
    $('#viewTitle').textContent = v.label; $('#viewSub').textContent = v.sub;
    crumb.style.display = 'none';
  }
  const noFilter = ['settings', 'live', 'sources'];
  $('#filters').style.display = noFilter.includes(state.view) ? 'none' : 'flex';
}
// generic trip drill-down for any filter combination
function drillTrips(title, subtitle, extra) {
  drill(title, subtitle, async (body) => {
    const rows = await q('/api/drivers/leaderboard', extra);
    body.innerHTML = '';
    body.append(tableFrom(rows.slice(0, 60), [
      { label: 'Driver', key: 'driver_name' }, { label: 'Plate', key: 'plate' },
      { label: 'Platform', key: 'platform' },
      { label: 'Trips', key: 'trips', num: true }, { label: 'Km', key: 'km', num: true },
      { label: 'Revenue', key: 'revenue', num: true, render: (r) => r.revenue ? 'AED ' + fmt(r.revenue) : '—' },
      { label: 'Completion', key: 'completion_pct', num: true, render: (r) => r.completion_pct != null ? r.completion_pct + '%' : '—' },
    ]));
  });
}

/* ─────────── views ─────────── */
const V = {};

V.overview = async (root) => {
  const kpiHost = el('div', 'kpis'); root.append(kpiHost);
  const g1 = el('div', 'grid g23'); root.append(g1);
  const trend = panel('Trips per day', 'Click a bar to see the drivers behind that day'); g1.append(trend.panel);
  const mix = panel('Platform share', 'Trips by platform — click a slice to drill in'); g1.append(mix.panel);
  const g2 = el('div', 'grid g3'); root.append(g2);
  const prod = panel('Product mix', 'Which service tiers the fleet runs'); g2.append(prod.panel);
  const pay = panel('Payment method', 'How riders pay'); g2.append(pay.panel);
  const out = panel('Trip outcome', 'Completed vs cancelled'); g2.append(out.panel);
  const lead = panel('Top drivers', 'Ranked by completed trips — click for detail'); root.append(lead.panel);
  [kpiHost, trend.body, mix.body, prod.body, pay.body, out.body, lead.body].forEach(loading);

  const [k, daily, byPlat, byProd, byPay, byStatus, drivers] = await Promise.all([
    q('/api/kpis'), q('/api/trips/daily'), q('/api/mix', { by: 'platform' }), q('/api/mix'),
    q('/api/mix', { by: 'payment' }), q('/api/mix', { by: 'status' }), q('/api/drivers/leaderboard'),
  ]);

  kpiHost.innerHTML = [
    ['Trips', fmt(k.trips), `${fmt(k.drivers)} drivers`],
    ['Distance', fmt(k.km) + ' km', `avg ${k.avg_km ?? '—'} km/trip`],
    ['Revenue', k.revenue ? 'AED ' + fmt(k.revenue) : '—', 'from trip fares'],
    ['Completion', k.completion_pct != null ? k.completion_pct + '%' : '—', `${k.cancel_pct ?? 0}% cancelled`],
    ['Vehicles', fmt(k.vehicles), `${fmt(k.live_vehicles || 0)} tracked live`],
    ['Safety alerts', fmt(k.alerts), 'harsh-driving events'],
  ].map(([l, n, d]) => `<div class="kpi"><div class="l">${l}</div><div class="n num">${n}</div><div class="d">${d}</div></div>`).join('');

  barChart(trend.body, daily, { x: 'd', y: 'trips', label: 'trips',
    onClick: (d) => drillTrips(`Trips on ${d.d}`, 'Drivers active that day', { from: d.d, to: d.d }) });
  donut(mix.body, byPlat, { onClick: (d) => drillTrips(`${d.label} trips`, 'Drivers on this platform', { platform: d.label }) });
  hbars(prod.body, byProd.slice(0, 6));
  hbars(pay.body, byPay.slice(0, 6), { color: '--s2' });
  stackedBar(out.body, byStatus.slice(0, 5));
  lead.body.innerHTML = '';
  lead.body.append(tableFrom(drivers.slice(0, 12), [
    { label: '#', key: '_i', render: (r) => String(drivers.indexOf(r) + 1) },
    { label: 'Driver', key: 'driver_name' }, { label: 'Plate', key: 'plate' },
    { label: 'Trips', key: 'trips', num: true },
    { label: 'Km', key: 'km', num: true },
    { label: 'Completion', key: 'completion_pct', num: true, render: (r) => r.completion_pct != null ? r.completion_pct + '%' : '—' },
  ]));
};

V.demand = async (root) => {
  const g = el('div', 'grid g2'); root.append(g);
  const hourly = panel('Hourly demand curve', 'Trip requests by hour of day'); g.append(hourly.panel);
  const daily = panel('Daily volume', 'Click a bar to drill into that day'); g.append(daily.panel);
  const hm = panel('Weekday × hour heatmap', 'Darker = busier. Click a cell for that slot'); root.append(hm.panel);
  [hourly.body, daily.body, hm.body].forEach(loading);
  const [h, d, grid] = await Promise.all([q('/api/trips/hourly'), q('/api/trips/daily'), q('/api/trips/heatmap')]);
  areaChart(hourly.body, h.map((r) => ({ label: String(r.h).padStart(2, '0') + ':00', trips: r.trips })), { x: 'label', y: 'trips' });
  barChart(daily.body, d, { x: 'd', y: 'trips', onClick: (r) => drillTrips(`Trips on ${r.d}`, 'Drivers active that day', { from: r.d, to: r.d }) });
  heatmap(hm.body, grid, { onClick: (c) => drill(`${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][c.dow]} at ${String(c.h).padStart(2,'0')}:00`,
    `${fmt(c.trips)} trips in this slot across the selected range`, async (b) => { b.innerHTML = '<div class="note">Slot-level trip list requires per-trip drill; showing driver ranking for the range.</div>';
      const rows = await q('/api/drivers/leaderboard'); b.append(tableFrom(rows.slice(0, 25), [
        { label: 'Driver', key: 'driver_name' }, { label: 'Trips', key: 'trips', num: true }, { label: 'Km', key: 'km', num: true }])); }) });
};

V.drivers = async (root) => {
  // The directory is the way into the per-driver pages; the panels below it are
  // the questions that only make sense across the whole roster.
  await renderDriverDirectory(root);
  const g = el('div', 'grid g2'); root.append(g);
  const sc = panel('Trips vs distance', 'Each dot is a driver — spot high-trip/low-km and vice versa'); g.append(sc.panel);
  const xp = panel('Cross-platform activity', 'The same person working more than one app'); g.append(xp.panel);
  const perf = panel('Platform performance records', 'Hours, acceptance and earnings as reported by each platform'); root.append(perf.panel);
  [sc.body, xp.body, perf.body].forEach(loading);
  const [rows, cross, pf] = await Promise.all([q('/api/drivers/leaderboard'), q('/api/drivers/cross-platform'), q('/api/drivers/performance')]);

  scatter(sc.body, rows.slice(0, 60).map((r) => ({ ...r, trips: +r.trips, km: +(r.km || 0) })),
    { x: 'trips', y: 'km', label: 'driver_name', xLabel: 'trips', yLabel: 'km',
      onClick: (r) => { location.hash = href('driver', r.driver_ext_id); } });
  xp.body.innerHTML = '';
  const multi = cross.filter((r) => [r.uber_trips, r.yango_trips, r.bolt_trips, r.fms_trips].filter((n) => n > 0).length > 1);
  xp.body.append(multi.length ? tableFrom(multi.slice(0, 15), [
    { label: 'Driver', key: 'driver_name' },
    { label: 'Uber', key: 'uber_trips', num: true }, { label: 'Yango', key: 'yango_trips', num: true },
    { label: 'Bolt', key: 'bolt_trips', num: true }, { label: 'Telematics', key: 'fms_trips', num: true },
    { label: 'Total', key: 'total_trips', num: true },
  ]) : el('div', 'note', 'No driver in this window has trips on more than one platform.'));
  perf.body.innerHTML = '';
  perf.body.append(tableFrom(pf.slice(0, 25), [
    { label: 'Platform', key: 'platform' },
    { label: 'Driver', key: 'driver_name' },
    { label: 'Period', key: 'period_start', render: (r) => dayStr(r.period_start) },
    { label: 'Trips', key: 'trips', num: true },
    { label: 'Hrs online', key: 'hours_online', num: true, render: (x) => x.hours_online ? (+x.hours_online).toFixed(1) : '—' },
    { label: 'Earnings', key: 'earnings', num: true, render: (x) => money(x.earnings) },
  ]));
};

// The per-driver pages themselves. `state.param` is the platform driver id and
// `state.sub` is the tab — both come straight from the URL.
V.driver = async (root) => renderDriver(root, state.param, state.sub || 'overview');

V.vehicles = async (root) => {
  const g = el('div', 'grid g23'); root.append(g);
  const top = panel('Trips per vehicle', 'Top vehicles by trip count — click to drill'); g.append(top.panel);
  const util = panel('Fleet spread', 'How trips distribute across the fleet'); g.append(util.panel);
  const tbl = panel('Vehicle table', 'Click a row for that vehicle’s activity'); root.append(tbl.panel);
  [top.body, util.body, tbl.body].forEach(loading);
  const rows = await q('/api/vehicles');
  hbars(top.body, rows.slice(0, 12).map((r) => ({ label: r.plate, n: r.trips })), { seq: true,
    onClick: (d) => drillTrips(`Vehicle ${d.label}`, 'Drivers who operated this vehicle', {}) });
  donut(util.body, rows.slice(0, 6).map((r) => ({ label: r.plate, n: r.trips })));
  tbl.body.innerHTML = '';
  const t = tableFrom(rows.slice(0, 40), [
    { label: 'Plate', key: 'plate' }, { label: 'Trips', key: 'trips', num: true },
    { label: 'Km', key: 'km', num: true },
    { label: 'Revenue', key: 'revenue', num: true, render: (r) => r.revenue ? 'AED ' + fmt(r.revenue) : '—' },
    { label: 'Drivers', key: 'drivers', num: true }, { label: 'Platforms', key: 'platforms', num: true },
    { label: 'Last trip', key: 'last_trip', render: (r) => r.last_trip ? String(r.last_trip).slice(0, 10) : '—' },
  ]);
  t.querySelectorAll('tbody tr').forEach((tr, i) => { tr.style.cursor = 'pointer';
    tr.onclick = () => { const v = rows[i]; drill(`Vehicle ${v.plate}`, `${fmt(v.trips)} trips · ${fmt(v.km)} km`, async (b) => {
      const track = await api(`/api/track?plate=${encodeURIComponent(v.plate)}`);
      b.innerHTML = '';
      b.append(el('div', 'kpis', [['Trips', fmt(v.trips)], ['Km', fmt(v.km)], ['Drivers', fmt(v.drivers)],
        ['GPS points', fmt(track.length)]].map(([l, n]) => `<div class="kpi"><div class="l">${l}</div><div class="n num">${n}</div></div>`).join('')));
      const p = el('div', 'panel'); p.append(el('h3', null, 'Recent GPS breadcrumb'), el('p', 'cap', 'CABMAN 5-minute telemetry'));
      if (track.length) p.append(tableFrom(track.slice(-20).reverse(), [
        { label: 'Time', key: 'captured_at', render: (r) => new Date(r.captured_at).toLocaleString() },
        { label: 'Lat', key: 'lat', num: true }, { label: 'Lng', key: 'lng', num: true },
        { label: 'Speed', key: 'speed', num: true }, { label: 'Status', key: 'status' }]));
      else p.append(el('div', 'note', 'No telemetry captured for this vehicle yet.'));
      b.append(p);
    }); };
  });
  tbl.body.append(t);
};

V.platforms = async (root) => {
  const g = el('div', 'grid g2'); root.append(g);
  const share = panel('Trips by platform', 'Share of total volume'); g.append(share.panel);
  const fleetMix = panel('Trips by fleet', 'Ecosine vs Egari'); g.append(fleetMix.panel);
  const cov = panel('Coverage & history depth', 'What each source has actually delivered'); root.append(cov.panel);
  [share.body, fleetMix.body, cov.body].forEach(loading);
  const [byPlat, byFleet, plats] = await Promise.all([q('/api/mix', { by: 'platform' }), q('/api/mix', { by: 'fleet' }), api('/api/platforms')]);
  donut(share.body, byPlat, { onClick: (d) => drillTrips(`${d.label}`, 'Drivers on this platform', { platform: d.label }) });
  donut(fleetMix.body, byFleet);
  cov.body.innerHTML = '';
  cov.body.append(tableFrom(plats, [
    { label: 'Platform', key: 'platform' }, { label: 'Fleet', key: 'fleet_id' },
    { label: 'Trips', key: 'trips', num: true },
    { label: 'Earliest', key: 'earliest', render: (r) => r.earliest ? String(r.earliest).slice(0, 10) : '—' },
    { label: 'Latest', key: 'latest', render: (r) => r.latest ? String(r.latest).slice(0, 10) : '—' },
  ]));
};

V.finance = async (root) => {
  const kh = el('div', 'kpis'); root.append(kh);
  const g = el('div', 'grid g2'); root.append(g);
  const rev = panel('Revenue per day', 'Fare revenue from trips'); g.append(rev.panel);
  const pay = panel('Payment mix', 'Cash vs card vs wallet'); g.append(pay.panel);
  const led = panel('Ledger by category', 'Platform fees, bonuses and adjustments'); root.append(led.panel);
  [kh, rev.body, pay.body, led.body].forEach(loading);
  const [k, daily, byPay, ledger] = await Promise.all([q('/api/kpis'), q('/api/trips/daily'), q('/api/mix', { by: 'payment' }), q('/api/finance/ledger')]);
  kh.innerHTML = [['Revenue', k.revenue ? 'AED ' + fmt(k.revenue) : '—', 'trip fares'],
    ['Trips', fmt(k.trips), 'billable rides'],
    ['Avg fare', k.revenue && k.trips ? 'AED ' + (k.revenue / k.trips).toFixed(1) : '—', 'per trip'],
    ['Distance', fmt(k.km) + ' km', 'total driven']]
    .map(([l, n, d]) => `<div class="kpi"><div class="l">${l}</div><div class="n num">${n}</div><div class="d">${d}</div></div>`).join('');
  areaChart(rev.body, daily, { x: 'd', y: 'revenue', color: '--s3', valueFmt: (v) => fmt(v) });
  donut(pay.body, byPay);
  led.body.innerHTML = '';
  if (ledger.length) hbars(led.body, ledger.slice(0, 12).map((r) => ({ label: r.category, n: Math.abs(+r.amount) })),
    { color: '--s2', valueFmt: (v) => 'AED ' + fmt(v) });
  else empty(led.body, 'Ledger fills once Yango/Bolt credentials are set');
};

V.safety = async (root) => {
  const g = el('div', 'grid g2'); root.append(g);
  const types = panel('Events by type', 'Harsh braking, acceleration, sharp turns, overspeed'); g.append(types.panel);
  const veh = panel('Worst vehicles', 'Most harsh-driving events — click to drill'); g.append(veh.panel);
  const tbl = panel('Per-vehicle breakdown', 'Event counts by category'); root.append(tbl.panel);
  [types.body, veh.body, tbl.body].forEach(loading);
  const [byType, byVeh] = await Promise.all([q('/api/alerts/summary'), q('/api/alerts/by-vehicle')]);
  if (byType.length) donut(types.body, byType.map((r) => ({ label: r.alert_type, n: r.n })));
  else empty(types.body, 'Safety events arrive with FMS credentials');
  hbars(veh.body, byVeh.slice(0, 10).map((r) => ({ label: r.plate, n: r.alerts })), { color: '--s8' });
  tbl.body.innerHTML = '';
  tbl.body.append(tableFrom(byVeh.slice(0, 30), [
    { label: 'Plate', key: 'plate' }, { label: 'Total', key: 'alerts', num: true },
    { label: 'Harsh brake', key: 'harsh_brake', num: true }, { label: 'Harsh accel', key: 'harsh_accel', num: true },
    { label: 'Sharp turn', key: 'sharp_turn', num: true }, { label: 'Overspeed', key: 'overspeed', num: true },
  ]));
};

V.unauthorized = async (root) => {
  const kh = el('div', 'kpis'); root.append(kh);
  const g = el('div', 'grid g23'); root.append(g);
  const trend = panel('Occupancy per day', 'Unauthorized vs booked occupancy segments'); g.append(trend.panel);
  const verdicts = panel('How segments resolve', 'Every seat-occupancy interval, classified'); g.append(verdicts.panel);
  const veh = panel('Vehicles with unexplained trips', 'Ranked by count — click to inspect'); root.append(veh.panel);
  const list = panel('Flagged segments', 'Click a row for the full evidence trail'); root.append(list.panel);
  const health = panel('Seat-sensor health', 'A dead or stuck pad makes the numbers above unreliable'); root.append(health.panel);
  [kh, trend.body, verdicts.body, veh.body, list.body, health.body].forEach(loading);

  const [sum, daily, byVeh, rows, sensors] = await Promise.all([
    q('/api/unauthorized/summary'), q('/api/unauthorized/daily'), q('/api/unauthorized/by-vehicle'),
    q('/api/unauthorized/list', { verdict: 'unauthorized' }), q('/api/sensor-health'),
  ]);
  const t = sum.totals || {};
  kh.innerHTML = [
    ['Unexplained trips', fmt(t.unauthorized || 0), 'no booking on any channel'],
    ['Unexplained km', fmt(t.unauth_km || 0) + ' km', 'distance carried off-book'],
    ['Matched to a booking', fmt(t.authorized || 0), 'legitimate, reconciled'],
    ['Sensor suspect', fmt(t.sensor_suspect || 0), 'excluded — likely hardware'],
    ['Inconclusive', fmt(t.partial || 0), 'telemetry gaps — cannot judge'],
  ].map(([l, n, d]) => `<div class="kpi"><div class="l">${l}</div><div class="n num">${n}</div><div class="d">${d}</div></div>`).join('');

  if (t.low_confidence) {
    const w = el('div', 'panel');
    w.innerHTML = `<div class="note err">⚠ ${fmt(t.low_confidence)} flagged segment(s) were assessed while a revenue channel was unavailable — a booking may exist that we could not read. Fix the source in Settings before acting on these.</div>`;
    root.insertBefore(w, g);
  }

  barChart(trend.body, daily, { x: 'd', y: 'unauthorized', color: '--s8', label: 'unexplained',
    onClick: (d) => drill(`Unexplained occupancy on ${d.d}`, 'Segments flagged that day', async (b) => {
      const rs = await api(`/api/unauthorized/list?from=${d.d}&to=${d.d}&verdict=unauthorized`);
      b.innerHTML = ''; b.append(segTable(rs));
    }) });
  donut(verdicts.body, (sum.byVerdict || []).map((r) => ({ label: r.verdict, n: r.n })),
    { onClick: (d) => drill(`Segments: ${d.label}`, 'All occupancy intervals with this verdict', async (b) => {
        const rs = await q('/api/unauthorized/list', { verdict: d.label }); b.innerHTML = ''; b.append(segTable(rs)); }) });

  veh.body.innerHTML = '';
  // Show who was driving, not just which plate — a flag against a car nobody can
  // name is not something anyone can act on.
  if (byVeh.length) hbars(veh.body, byVeh.slice(0, 12).map((r) => ({
      label: r.drivers ? `${r.plate} · ${r.drivers}` : `${r.plate} · driver unknown`,
      plate: r.plate, n: r.unauthorized })), { color: '--s8',
    onClick: (d) => drill(`Vehicle ${d.plate || d.label}`, 'Unexplained occupancy segments', async (b) => {
      const rs = await q('/api/unauthorized/list', { verdict: 'unauthorized' });
      b.innerHTML = ''; b.append(segTable(rs.filter((r) => r.plate === (d.plate || d.label)))); }) });
  else empty(veh.body, 'No unexplained trips detected in this range');

  list.body.innerHTML = ''; list.body.append(segTable(rows));

  health.body.innerHTML = '';
  const flagged = sensors.map((s2) => ({ ...s2,
    ratio: s2.total_fixes ? (s2.occupied_fixes / s2.total_fixes * 100).toFixed(1) : '0',
    verdict: s2.occupied_fixes === 0 ? 'never triggers' : (s2.sensor_suspect_segments > 0 ? 'suspect' : 'ok') }));
  health.body.append(tableFrom(flagged.slice(0, 20), [
    { label: 'Plate', key: 'plate' },
    { label: 'Occupied fixes', key: 'occupied_fixes', num: true },
    { label: 'Total fixes', key: 'total_fixes', num: true },
    { label: 'Occupied %', key: 'ratio', num: true, render: (r) => r.ratio + '%' },
    { label: 'Sensor', key: 'verdict', render: (r) => `<span class="tag ${r.verdict === 'ok' ? 'ok' : r.verdict === 'suspect' ? 'warn' : 'bad'}">${esc(r.verdict)}</span>` },
  ]));
};

// shared: table of occupancy segments with click-through evidence
function segTable(rows) {
  if (!rows.length) { const d = el('div'); empty(d, 'Nothing flagged here'); return d; }
  const t = tableFrom(rows, [
    { label: 'Plate', key: 'plate' },
    // the driver who held the car that day — an unexplained trip needs a person
    { label: 'Driver', key: 'drivers', render: (r) => r.drivers
      ? esc(r.drivers) : '<span class="dim">unknown</span>' },
    { label: 'Started', key: 'started_at', render: (r) => new Date(r.started_at).toLocaleString() },
    { label: 'Duration', key: 'duration_min', num: true, render: (r) => r.duration_min + ' min' },
    { label: 'Distance', key: 'distance_km', num: true, render: (r) => (r.distance_km ?? 0) + ' km' },
    { label: 'Top speed', key: 'top_speed', num: true, render: (r) => (r.top_speed ?? 0) + ' km/h' },
    { label: 'Verdict', key: 'verdict', render: (r) => `<span class="tag ${r.verdict === 'unauthorized' ? 'bad' : r.verdict === 'authorized' ? 'ok' : 'warn'}">${esc(r.verdict)}</span>` },
    { label: 'Confidence', key: 'low_confidence', render: (r) => r.low_confidence ? '<span class="tag warn">low</span>' : '<span class="tag dim">ok</span>' },
  ]);
  t.querySelectorAll('tbody tr').forEach((tr, i) => { tr.style.cursor = 'pointer';
    tr.onclick = () => { const r = rows[i]; drill(`${r.plate}${r.drivers ? ' · ' + r.drivers : ''} · ${new Date(r.started_at).toLocaleString()}`,
      `${r.verdict} — ${r.duration_min} min, ${r.distance_km} km`, async (b) => {
        b.innerHTML = '';
        b.append(el('div', 'kpis', [['Duration', r.duration_min + ' min'], ['Distance', (r.distance_km ?? 0) + ' km'],
          ['Top speed', (r.top_speed ?? 0) + ' km/h'], ['GPS fixes', fmt(r.fixes)],
          ['Largest gap', (r.max_gap_min ?? 0) + ' min'], ['Ignition on', Math.round((r.ignition_ratio || 0) * 100) + '%']]
          .map(([l, n]) => `<div class="kpi"><div class="l">${l}</div><div class="n num">${n}</div></div>`).join('')));
        const why = el('div', 'panel');
        why.append(el('h3', null, 'Why this verdict'));
        const reasons = {
          unauthorized: 'The seat sensor reported a passenger, the vehicle covered real distance, and no booking on Uber, Yango, Bolt, the hotel platform or FMS overlaps this window (±15 min).',
          authorized: `Matched to a ${r.matched_platform || 'booking'} (${r.matched_trip_id || '—'}).`,
          sensor_suspect: 'Occupancy was implausibly long, or registered with the ignition off — consistent with a stuck seat pad rather than a passenger.',
          partial: 'A telemetry gap falls inside this window, so we cannot claim to have observed the whole interval.',
          stationary: 'Occupied but the vehicle never really moved — not a trip.',
        };
        why.append(el('p', 'note', reasons[r.verdict] || ''));
        if (r.low_confidence) why.append(el('p', 'note err', `Assessed while these sources were unavailable: ${esc(r.unavailable_sources || '')}. A booking may exist that we could not read.`));
        b.append(why);
        const trk = el('div', 'panel'); trk.append(el('h3', null, 'Telemetry during this window'), el('p', 'cap', 'CABMAN 5-minute fixes'));
        const track = await api(`/api/track?plate=${encodeURIComponent(r.plate)}&from=${r.started_at}&to=${r.ended_at}`);
        if (track.length) {
          const sp = el('div'); trk.append(sp);
          areaChart(sp, track.map((x) => ({ t: new Date(x.captured_at).toLocaleTimeString(), speed: +x.speed || 0 })), { x: 't', y: 'speed', color: '--s8' });
          trk.append(tableFrom(track, [
            { label: 'Time', key: 'captured_at', render: (x) => new Date(x.captured_at).toLocaleTimeString() },
            { label: 'Speed', key: 'speed', num: true }, { label: 'Seat', key: 'seat_occupied', render: (x) => x.seat_occupied ? 'occupied' : 'empty' },
            { label: 'Lat', key: 'lat', num: true }, { label: 'Lng', key: 'lng', num: true }]));
        } else trk.append(el('div', 'note', 'No fixes stored for this window.'));
        b.append(trk);
      }); };
  });
  return t;
}

V.live = async (root) => {
  const kh = el('div', 'kpis'); root.append(kh);
  const p = panel('Live vehicles', 'CABMAN refreshes every 5 minutes · click a row for the GPS breadcrumb'); root.append(p.panel);
  [kh, p.body].forEach(loading);
  const rows = await api('/api/live');
  const fresh = rows.filter((r) => !r.stale).length;
  const moving = rows.filter((r) => +r.speed > 3).length;
  const engaged = rows.filter((r) => /engag/i.test(r.status || '') || r.seat_occupied).length;
  kh.innerHTML = [['Vehicles tracked', fmt(rows.length), 'with a GPS fix'],
    ['Fresh (<11 min)', fmt(fresh), 'reporting now'],
    ['Moving', fmt(moving), 'speed > 3 km/h'],
    ['Engaged', fmt(engaged), 'passenger on board']]
    .map(([l, n, d]) => `<div class="kpi"><div class="l">${l}</div><div class="n num">${n}</div><div class="d">${d}</div></div>`).join('');
  p.body.innerHTML = '';
  if (!rows.length) { empty(p.body, 'Positions appear once CABMAN credentials are saved in Settings'); return; }
  const t = tableFrom(rows, [
    { label: 'Plate', key: 'plate' }, { label: 'Fleet', key: 'fleet_id' },
    { label: 'Status', key: 'status', render: (r) => `<span class="tag ${/engag/i.test(r.status || '') ? 'ok' : 'dim'}">${esc(r.status || '—')}</span>` },
    { label: 'Speed', key: 'speed', num: true, render: (r) => r.speed != null ? fmt(r.speed) + ' km/h' : '—' },
    { label: 'Seat', key: 'seat_occupied', render: (r) => r.seat_occupied ? '<span class="tag ok">occupied</span>' : '<span class="tag dim">empty</span>' },
    { label: 'Fix age', key: 'polled_at', render: (r) => `<span class="tag ${r.stale ? 'warn' : 'ok'}">${r.stale ? 'stale' : 'live'}</span>` },
    { label: 'Last fix', key: 'captured_at', render: (r) => new Date(r.captured_at).toLocaleTimeString() },
  ]);
  t.querySelectorAll('tbody tr').forEach((tr, i) => { tr.style.cursor = 'pointer';
    tr.onclick = () => { const v = rows[i]; drill(`Vehicle ${v.plate}`, 'GPS breadcrumb (5-minute resolution)', async (b) => {
      const track = await api(`/api/track?plate=${encodeURIComponent(v.plate)}`);
      b.innerHTML = '';
      if (!track.length) return empty(b, 'No breadcrumb stored yet');
      const sp = panel('Speed over time', `${track.length} fixes`); b.append(sp.panel);
      areaChart(sp.body, track.slice(-60).map((r) => ({ t: new Date(r.captured_at).toLocaleTimeString(), speed: +r.speed || 0 })),
        { x: 't', y: 'speed', color: '--s3' });
      b.append(tableFrom(track.slice(-25).reverse(), [
        { label: 'Time', key: 'captured_at', render: (r) => new Date(r.captured_at).toLocaleString() },
        { label: 'Lat', key: 'lat', num: true }, { label: 'Lng', key: 'lng', num: true },
        { label: 'Speed', key: 'speed', num: true }, { label: 'Status', key: 'status' }]));
    }); };
  });
  p.body.append(t);
};


V.map = async (root) => {
  const { makeMap, renderLive, renderJourney } = await import('/map.js');

  // ── controls ──
  const ctl = el('div', 'panel');
  ctl.innerHTML = `
    <div class="btnrow" style="justify-content:space-between">
      <div class="btnrow">
        <button class="btn primary" id="mLive">Live fleet</button>
        <button class="btn" id="mReplay">Day replay</button>
      </div>
      <div class="btnrow" id="mReplayCtl" style="display:none">
        <select id="mPlate" class="btn"></select>
        <input id="mDay" type="date" class="btn" />
        <button class="btn" id="mGo">Show route</button>
      </div>
    </div>`;
  root.append(ctl);

  const stat = el('div', 'kpis'); root.append(stat);
  const wrap = el('div', 'panel mapwrap');   // mapwrap opts out of the chart svg rule
  wrap.style.padding = '0'; wrap.style.overflow = 'hidden';
  const node = el('div'); node.style.height = '560px'; node.style.width = '100%';
  wrap.append(node); root.append(wrap);
  const legend = el('div', 'legend'); root.append(legend);

  const map = makeMap(node);
  let layer = null;
  const clear = () => { if (layer) { map.removeLayer(layer); layer = null; } };

  const showLive = async () => {
    clear();
    const rows = await api('/api/live');
    const withGps = rows.filter((r) => r.lat != null);
    stat.innerHTML = [
      ['On the map', fmt(withGps.length), 'vehicles with a fix'],
      ['Engaged', fmt(withGps.filter((r) => r.seat_occupied || /engag/i.test(r.status || '')).length), 'passenger aboard'],
      ['Moving', fmt(withGps.filter((r) => +r.speed > 3).length), 'above 3 km/h'],
      ['Stale', fmt(withGps.filter((r) => r.stale).length), 'no fix in 11 min'],
    ].map(([l, n, d]) => `<div class="kpi"><div class="l">${l}</div><div class="n num">${n}</div><div class="d">${d}</div></div>`).join('');
    legend.innerHTML = [['--s3', 'Passenger aboard'], ['--s1', 'Moving, empty'], ['--s5', 'Stopped'], ['--ink-3', 'Stale fix']]
      .map(([c, t]) => `<span><i class="sw" style="background:var(${c})"></i>${t}</span>`).join('');
    layer = renderLive(map, withGps, (r) => {
      $('#mReplay').click();
      const sel = $('#mPlate'); if (sel) sel.value = r.plate;
    });
    if (!withGps.length) empty(stat, 'No GPS fixes stored yet — CABMAN populates this every 5 minutes');
  };

  const showReplay = async () => {
    const plate = $('#mPlate').value, day = $('#mDay').value;
    if (!plate || !day) return;
    clear();
    const j = await api(`/api/map/journey?plate=${encodeURIComponent(plate)}&day=${day}`);
    stat.innerHTML = [
      ['Fixes', fmt(j.fixes), `on ${day}`],
      ['Distance', fmt(j.distance_km) + ' km', 'between fixes'],
      ['With passenger', fmt(j.occupied_km) + ' km', j.distance_km ? Math.round(j.occupied_km / j.distance_km * 100) + '% of distance' : '—'],
      ['Driver', j.driver || '—', j.driver_trips != null ? j.driver_trips + ' trips' : 'from trip records'],
    ].map(([l, n, d]) => `<div class="kpi"><div class="l">${l}</div><div class="n num">${n}</div><div class="d">${esc(d)}</div></div>`).join('');
    legend.innerHTML = [['--s3', 'Passenger aboard'], ['--s1', 'Running empty (dashed)']]
      .map(([c, t]) => `<span><i class="sw" style="background:var(${c})"></i>${t}</span>`).join('')
      + `<span class="dim">Lines join consecutive 5-minute fixes; a gap over 20 minutes breaks the line rather than guessing the route.</span>`;
    if (!j.fixes) { empty(stat, `No GPS fixes stored for ${plate} on ${day}`); return; }
    layer = renderJourney(map, j);
  };

  // populate the replay pickers from days that actually have a trail
  const days = await api('/api/map/days').catch(() => []);
  const plates = [...new Set(days.map((d) => d.plate))].sort();
  $('#mPlate').innerHTML = plates.map((p) => `<option>${esc(p)}</option>`).join('')
    || '<option value="">no trails yet</option>';
  const latest = days[0]?.day ? String(days[0].day).slice(0, 10) : new Date().toISOString().slice(0, 10);
  $('#mDay').value = latest;

  $('#mLive').onclick = () => {
    $('#mLive').classList.add('primary'); $('#mReplay').classList.remove('primary');
    $('#mReplayCtl').style.display = 'none'; showLive();
  };
  $('#mReplay').onclick = () => {
    $('#mReplay').classList.add('primary'); $('#mLive').classList.remove('primary');
    $('#mReplayCtl').style.display = 'flex'; showReplay();
  };
  $('#mGo').onclick = showReplay;
  $('#mPlate').onchange = showReplay;
  $('#mDay').onchange = showReplay;

  await showLive();
};


/* The action list. Everything here is something a person could do today, ordered by
   what it costs to leave alone. Severity is a claim, so each row shows the evidence
   that produced it — a dashboard that asserts without showing its working gets
   ignored the first time it is wrong. */
V.insights = async (root) => {
  const kh = el('div', 'kpis'); root.append(kh); loading(kh);

  const [sum, all] = await Promise.all([
    api('/api/insights/summary').catch(() => null),
    api('/api/insights').catch(() => []),
  ]);

  const bySev = Object.fromEntries((sum?.by_severity || []).map((r) => [r.severity, r.n]));
  const impact = Number(sum?.total?.total_impact || 0);
  kh.innerHTML = [
    ['Open actions', fmt(sum?.total?.n ?? all.length), 'across every source'],
    ['Critical', fmt(bySev.critical || 0), 'act today', bySev.critical ? 'err' : 'ok'],
    ['Warnings', fmt(bySev.warning || 0), 'act this week', bySev.warning ? 'warn' : 'ok'],
    ['Quantified cost', impact ? 'AED ' + fmt(Math.round(impact)) : '—', 'where it can be sized'],
  ].map(([l, n, d, cls]) => `<div class="kpi ${cls || ''}"><div class="l">${l}</div><div class="n num">${n}</div><div class="d">${d}</div></div>`).join('');

  if (!all.length) {
    const p0 = panel('Nothing to action', 'The engine runs after each collection'); root.append(p0.panel);
    empty(p0.body, 'No findings yet — either the fleet is clean, or the collectors have not completed a cycle.');
    return;
  }

  // category filter
  const cats = [...new Set(all.map((r) => r.category))].sort();
  const bar = el('div', 'panel');
  bar.innerHTML = `<div class="btnrow"><button class="btn primary" data-cat="">All (${all.length})</button>` +
    cats.map((c) => `<button class="btn" data-cat="${esc(c)}">${esc(c)} (${all.filter((r) => r.category === c).length})</button>`).join('') +
    `</div>`;
  root.append(bar);

  const listPanel = panel('Ranked actions', 'Most consequential first — click any row for the evidence behind it');
  root.append(listPanel.panel);

  const SEV = { critical: 'err', warning: 'warn', info: 'info', good: 'ok' };
  const draw = (cat) => {
    const rows = cat ? all.filter((r) => r.category === cat) : all;
    listPanel.body.innerHTML = '';
    if (!rows.length) return empty(listPanel.body, 'Nothing in this category');
    const list = el('div', 'hbars');
    rows.forEach((r) => {
      const item = el('div', 'insight-row');
      item.innerHTML = `
        <div class="insight-sev"><span class="tag ${SEV[r.severity] || ''}">${esc(r.severity)}</span></div>
        <div class="insight-main">
          <div class="insight-title">${esc(r.title)}</div>
          <div class="insight-action">${esc(r.action || '')}</div>
        </div>
        <div class="insight-meta">
          <span class="tag">${esc(r.category)}</span>
          ${r.impact_aed ? `<span class="num" style="color:var(--critical);font-weight:600">AED ${fmt(Math.round(r.impact_aed))}</span>` : ''}
        </div>`;
      item.onclick = () => drill(r.title, `${r.category} · ${r.severity}`, (b) => {
        b.innerHTML = '';
        const why = panel('What we found', 'the evidence behind this flag'); b.append(why.panel);
        why.body.innerHTML = `<p style="margin:0 0 12px">${esc(r.detail || '')}</p>`;
        const act = panel('What to do', 'the smallest useful next step'); b.append(act.panel);
        act.body.innerHTML = `<p style="margin:0">${esc(r.action || '')}</p>`;
        const facts = [
          ['Entity', `${r.entity_type || '—'} ${r.entity_id || ''}`],
          ['Fleet', r.fleet_id || 'both'],
          ['Window', r.window_start ? `${String(r.window_start).slice(0, 10)} → ${String(r.window_end || '').slice(0, 10)}` : 'current state'],
          ['Estimated cost', r.impact_aed ? 'AED ' + fmt(Math.round(r.impact_aed)) : 'not quantifiable'],
          ['Rule', r.code],
          ['Computed', r.computed_at ? new Date(r.computed_at).toLocaleString() : '—'],
        ];
        const fp = panel('Details', ''); b.append(fp.panel);
        fp.body.innerHTML = `<div class="kv">${facts.map(([k, v]) =>
          `<div class="kv-k">${esc(k)}</div><div class="kv-v">${esc(v)}</div>`).join('')}</div>`;
      });
      list.append(item);
    });
    listPanel.body.append(list);
  };
  draw('');
  bar.querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      bar.querySelectorAll('button').forEach((x) => x.classList.remove('primary'));
      b.classList.add('primary'); draw(b.dataset.cat);
    };
  });
};

/* Compliance is the one place where the data is unambiguous: a date, and a vehicle
   that is either legal or not. Sorted by urgency, not by plate. */
V.compliance = async (root) => {
  const kh = el('div', 'kpis'); root.append(kh); loading(kh);
  const [veh, drv] = await Promise.all([
    api('/api/compliance/vehicles').catch(() => []),
    api('/api/compliance/drivers').catch(() => []),
  ]);
  const dl = (r) => Number(r.days_left);
  const vExpired = veh.filter((r) => dl(r) < 0).length;
  const vWeek = veh.filter((r) => dl(r) >= 0 && dl(r) <= 7).length;
  const vMonth = veh.filter((r) => dl(r) > 7 && dl(r) <= 45).length;
  const dExpired = drv.filter((r) => r.licence_expires && dl(r) < 0).length;

  kh.innerHTML = [
    ['Vehicle docs expired', fmt(vExpired), 'cannot legally work', vExpired ? 'err' : 'ok'],
    ['Expiring in 7 days', fmt(vWeek), 'renew now', vWeek ? 'err' : 'ok'],
    ['Expiring in 45 days', fmt(vMonth), 'start the paperwork', vMonth ? 'warn' : 'ok'],
    ['Driver licences expired', fmt(dExpired), 'stand down until renewed', dExpired ? 'err' : 'ok'],
  ].map(([l, n, d, cls]) => `<div class="kpi ${cls}"><div class="l">${l}</div><div class="n num">${n}</div><div class="d">${d}</div></div>`).join('');

  const vp = panel('Vehicle documents', 'registration, insurance and permits with an expiry date');
  root.append(vp.panel);
  if (!veh.length) empty(vp.body, 'No vehicle documents collected yet');
  else vp.body.append(tableFrom(veh.slice(0, 120), [
    { label: 'Due', key: 'days_left', num: true, render: (r) => {
      const d = dl(r);
      const cls = d < 0 ? 'err' : d <= 7 ? 'err' : d <= 45 ? 'warn' : 'ok';
      return `<span class="tag ${cls}">${d < 0 ? Math.abs(d) + 'd ago' : d + 'd'}</span>`; } },
    { label: 'Plate', key: 'plate', render: (r) => `<span class="plate">${esc(r.plate || '—')}</span>` },
    { label: 'Vehicle', key: 'make', render: (r) => esc([r.make, r.model, r.year].filter(Boolean).join(' ') || '—') },
    { label: 'Document', key: 'doc_type' },
    { label: 'Expires', key: 'expires_at', render: (r) => String(r.expires_at || '').slice(0, 10) },
    { label: 'Driver', key: 'driver_name', render: (r) => esc(r.driver_name || '—') },
  ]));

  const dp = panel('Driver licences', 'from the platforms that publish an expiry date');
  root.append(dp.panel);
  if (!drv.length) empty(dp.body, 'No driver licence dates collected yet — Hotel publishes these, Uber does not expose them to this role');
  else dp.body.append(tableFrom(drv.slice(0, 120), [
    { label: 'Due', key: 'days_left', num: true, render: (r) => r.licence_expires
      ? `<span class="tag ${dl(r) < 0 ? 'err' : dl(r) <= 45 ? 'warn' : 'ok'}">${dl(r) < 0 ? Math.abs(dl(r)) + 'd ago' : dl(r) + 'd'}</span>` : '—' },
    { label: 'Driver', key: 'full_name' },
    { label: 'Platform', key: 'platform' },
    { label: 'Licence', key: 'licence_no', render: (r) => `<span class="plate">${esc(r.licence_no || '—')}</span>` },
    { label: 'Expires', key: 'licence_expires', render: (r) => String(r.licence_expires || '—').slice(0, 10) },
    { label: 'State', key: 'state', render: (r) => `<span class="tag ${/suspend|deact/i.test(r.state || '') ? 'warn' : 'ok'}">${esc(r.state || '—')}</span>` },
  ]));
};

V.sources = async (root) => {
  const st = panel('Collector health', 'Last run per source — errors usually mean a credential needs updating'); root.append(st.panel);
  const cv = panel('Data coverage', 'What has actually landed in the database'); root.append(cv.panel);
  [st.body, cv.body].forEach(loading);
  const [status, coverage] = await Promise.all([api('/api/status'), api('/api/coverage')]);
  st.body.innerHTML = '';
  st.body.append(tableFrom(status, [
    { label: 'Source', key: 'source' }, { label: 'Mode', key: 'mode' },
    { label: 'Status', key: 'status', render: (r) => `<span class="tag ${r.status === 'ok' ? 'ok' : 'bad'}">${esc(r.status)}</span>` },
    { label: 'Rows', key: 'rows_written', num: true },
    { label: 'Last run', key: 'finished_at', render: (r) => r.finished_at ? new Date(r.finished_at).toLocaleString() : '—' },
    { label: 'Detail', key: 'error', render: (r) => r.error ? `<span class="note err">${esc(String(r.error).slice(0, 90))}</span>` : '<span class="note ok">healthy</span>' },
  ]));
  cv.body.innerHTML = '';
  const cov = [
    ...(coverage.trips || []).map((r) => ({ what: `trips · ${r.platform}`, n: r.n, from: r.from_ts, to: r.to_ts })),
    ...(coverage.telemetry || []).map((r) => ({ what: `telemetry · ${r.source}`, n: r.n, from: null, to: r.last_poll })),
    ...(coverage.alerts || []).map((r) => ({ what: 'safety alerts', n: r.n, from: null, to: r.latest })),
    ...(coverage.ledger || []).map((r) => ({ what: 'ledger entries', n: r.n, from: null, to: r.latest })),
  ];
  cv.body.append(tableFrom(cov, [
    { label: 'Dataset', key: 'what' }, { label: 'Rows', key: 'n', num: true },
    { label: 'From', key: 'from', render: (r) => r.from ? String(r.from).slice(0, 10) : '—' },
    { label: 'Latest', key: 'to', render: (r) => r.to ? String(r.to).slice(0, 16).replace('T', ' ') : '—' },
  ]));
};

V.settings = async (root) => {
  const auth = panel('Admin access', 'Changes require the admin token configured on the server'); root.append(auth.panel);
  const tokRow = el('div', 'btnrow');
  tokRow.innerHTML = `<input id="admTok" type="password" placeholder="admin token" style="flex:1;min-width:220px;background:var(--paper);border:1px solid var(--rule-strong);border-radius:3px;padding:8px 10px;font-family:'IBM Plex Mono';font-size:.8rem" value="${esc(state.admin)}">
    <button class="btn sec" id="saveTok">Remember</button><span class="note" id="tokNote"></span>`;
  auth.body.append(tokRow);
  tokRow.querySelector('#saveTok').onclick = () => {
    state.admin = tokRow.querySelector('#admTok').value.trim();
    localStorage.setItem('adminToken', state.admin);
    tokRow.querySelector('#tokNote').className = 'note ok';
    tokRow.querySelector('#tokNote').textContent = 'saved in this browser';
  };

  const credP = panel('Credentials', 'Stored encrypted in the database. Leave blank to keep the current value; the collector picks changes up within 30 seconds.');
  root.append(credP.panel); loading(credP.body);
  const defs = await api('/api/settings');
  credP.body.innerHTML = '';
  const wrap = el('div', 'setgrid'); credP.body.append(wrap);
  let grp = null;
  defs.forEach((d) => {
    if (d.group !== grp) { grp = d.group; wrap.append(el('div', 'setgroup', grp)); }
    const row = el('div', 'setrow');
    row.innerHTML = `<div class="lab">${esc(d.label)}<small>${esc(d.key)}${d.hint ? ' · ' + esc(d.hint) : ''}</small></div>
      <div><input data-k="${esc(d.key)}" type="${d.secret ? 'password' : 'text'}" placeholder="${d.configured ? esc(d.value) : 'not set'}" ${d.secret ? '' : `value="${esc(d.value)}"`}></div>
      <div><span class="tag ${d.configured ? (d.source === 'settings' ? 'ok' : 'dim') : 'warn'}">${d.configured ? d.source : 'unset'}</span></div>`;
    wrap.append(row);
  });
  const actions = el('div', 'btnrow'); actions.style.marginTop = '16px';
  actions.innerHTML = `<button class="btn" id="saveAll">Save credentials</button>
    <button class="btn sec" id="runInc">Run incremental now</button>
    <button class="btn sec" id="runBack">Run 12-month backfill</button>
    <span class="note" id="setNote"></span>`;
  credP.body.append(actions);
  const note = actions.querySelector('#setNote');
  const post = async (path, body) => {
    if (!state.admin) { note.className = 'note err'; note.textContent = 'enter the admin token first'; return null; }
    try {
      const r = await fetch(path, { method: path.endsWith('trigger') ? 'POST' : 'PUT',
        headers: { 'content-type': 'application/json', 'x-admin-token': state.admin }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.status);
      note.className = 'note ok'; return j;
    } catch (e) { note.className = 'note err'; note.textContent = String(e.message); return null; }
  };
  actions.querySelector('#saveAll').onclick = async () => {
    const payload = {};
    wrap.querySelectorAll('input[data-k]').forEach((i) => { if (i.value.trim()) payload[i.dataset.k] = i.value.trim(); });
    if (!Object.keys(payload).length) { note.className = 'note'; note.textContent = 'nothing changed'; return; }
    const j = await post('/api/settings', payload);
    if (j) { note.textContent = `saved ${j.updated.length} setting(s)`; render(); }
  };
  actions.querySelector('#runInc').onclick = async () => { const j = await post('/api/settings/trigger', { mode: 'incremental' }); if (j) note.textContent = 'incremental queued — collector picks it up within ~20s'; };
  actions.querySelector('#runBack').onclick = async () => { const j = await post('/api/settings/trigger', { mode: 'backfill' }); if (j) note.textContent = 'backfill queued — this pulls up to 12 months and takes a while'; };
};


/* ─────────── motion: settle, don't slam ───────────
   Numbers count up, sections stagger in, charts draw themselves. All of it is
   decoration on top of content that is already correct and readable — and all of
   it collapses to nothing under prefers-reduced-motion (handled in CSS). */
const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function countUp(node) {
  const raw = node.textContent.trim();
  const m = raw.match(/^([^\d-]*)(-?[\d,]*\.?\d+)(.*)$/);   // prefix, number, suffix
  if (!m) return;
  const [, pre, numStr, post] = m;
  const target = parseFloat(numStr.replace(/,/g, ''));
  if (!isFinite(target) || Math.abs(target) > 1e12) return;
  const decimals = (numStr.split('.')[1] || '').length;
  const hasComma = numStr.includes(',');
  const fmtN = (v) => {
    const f = v.toFixed(decimals);
    return hasComma ? Number(f).toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) : f;
  };
  const dur = 620, t0 = performance.now();
  const tick = (now) => {
    const p = Math.min(1, (now - t0) / dur);
    const eased = 1 - Math.pow(1 - p, 3);                 // ease-out cubic
    node.textContent = pre + fmtN(target * eased) + post;
    if (p < 1) requestAnimationFrame(tick);
    else node.textContent = raw;                          // land exactly on the real value
  };
  requestAnimationFrame(tick);
}

function animateView(root) {
  if (REDUCED) return;
  // stagger direct children and any grid/kpi groups
  root.classList.add('stagger');
  root.querySelectorAll('.kpis, .grid, .hbars, .tscroll tbody').forEach((g) => g.classList.add('stagger'));
  // count up the hero numbers
  root.querySelectorAll('.kpi .n').forEach(countUp);
  // give each horizontal bar its own small delay
  root.querySelectorAll('.hb .bar-cell > i').forEach((b, i) => { b.style.animationDelay = (i * 45) + 'ms'; });
  // line charts draw themselves in
  root.querySelectorAll('svg path[data-draw]').forEach((path) => {
    try {
      const len = path.getTotalLength();
      path.style.setProperty('--len', Math.ceil(len));
      path.classList.add('draw');
    } catch { /* non-path geometry */ }
  });
  root.querySelectorAll('svg [data-rise]').forEach((r, i) => {
    r.classList.add('rise'); r.style.animationDelay = (i * 22) + 'ms';
  });
  root.querySelectorAll('svg [data-fade]').forEach((r) => r.classList.add('fade'));
}

/* ─────────── render loop ─────────── */
async function render() {
  renderNav(); setHeader();
  const root = $('#view'); root.innerHTML = '';
  root.scrollIntoView?.({ block: 'start' });
  try {
    const detail = await (V[state.view] || V.overview)(root);
    setHeader(detail);                      // detail pages only know their title after fetching
    animateView(root);
  } catch (e) {
    root.innerHTML = `<div class="empty"><b>Could not load this view</b>${esc(e.message)}</div>`;
  }
  freshness();
}
async function freshness() {
  try {
    const s = await api('/api/status');
    const last = s.map((r) => r.finished_at).filter(Boolean).sort().pop();
    const bad = s.filter((r) => r.status !== 'ok').length;
    $('#freshness').innerHTML = last
      ? `updated ${new Date(last).toLocaleTimeString()}<br>${bad ? `<span style="color:var(--warning)">${bad} source(s) need attention</span>` : 'all sources healthy'}`
      : 'awaiting first collection';
  } catch { $('#freshness').textContent = 'status unavailable'; }
}

$('#fRange').onchange = (e) => { state.days = +e.target.value; render(); };
$('#fPlatform').onchange = (e) => { state.platform = e.target.value; render(); };
$('#fFleet').onchange = (e) => { state.fleet = e.target.value; render(); };
$('#refreshBtn').onclick = (e) => {
  const b = e.currentTarget; b.classList.remove('spin'); void b.offsetWidth; b.classList.add('spin');
  render();
};
$('#themeBtn').onclick = () => {
  const r = document.documentElement, cur = r.getAttribute('data-theme');
  const dark = cur ? cur === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  r.setAttribute('data-theme', dark ? 'light' : 'dark');
  localStorage.setItem('theme', dark ? 'light' : 'dark');
};
if (localStorage.getItem('theme')) document.documentElement.setAttribute('data-theme', localStorage.getItem('theme'));
// Routes are `#<view>[/<param>[/<sub>]]`. An unknown view falls back to the
// overview rather than rendering nothing.
function applyRoute() {
  const r = parseHash();
  const known = VIEWS.some((v) => v.id === r.view) || !!V[r.view];
  state.view = known ? r.view : 'overview';
  state.param = r.param; state.sub = r.sub;
}
applyRoute();
window.addEventListener('hashchange', () => { applyRoute(); render(); });
render();
setInterval(() => { if (state.view === 'live') render(); }, 60000);
