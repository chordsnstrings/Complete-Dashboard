// Fleet Dashboard — a multipage app behind a hash router.
// Views live in this file; the per-driver detail pages live in driver.js, and
// everything shared between them (panels, tables, modals, routing, fetching)
// lives in ui.js and data.js so the two cannot drift apart.
import { barChart, areaChart, donut, hbars, heatmap, scatter, stackedBar, fmt, empty, showTip, hideTip } from './charts.js';
import { $, el, esc, panel, loading, tableFrom, drill, kpiRow, pill, note, dayStr, dtStr, money, pct } from './ui.js';
import { state, api, params, q, qAll, href, parseHash, navigate } from './data.js';
import { renderDriver, renderDriverDirectory, DRIVER_TABS } from './driver.js';
import { renderVehicle, renderVehicleDirectory, VEHICLE_TABS } from './vehicle.js';
import { renderCauses } from './causes.js';

const VIEWS = [
  { id: 'overview', label: 'Overview', ic: '◱', grp: 'Analyse', sub: 'Fleet-wide performance across every platform' },
  { id: 'demand', label: 'Demand', ic: '◷', grp: 'Analyse', sub: 'When trips happen — by day, hour and weekday' },
  { id: 'drivers', label: 'Drivers', ic: '◧', grp: 'Analyse', sub: 'Per-driver output, quality and cross-platform activity' },
  { id: 'vehicles', label: 'Vehicles', ic: '▤', grp: 'Analyse', sub: 'Utilisation and revenue per vehicle' },
  { id: 'platforms', label: 'Platforms', ic: '◨', grp: 'Analyse', sub: 'Uber vs Yango vs Bolt — share and mix' },
  { id: 'finance', label: 'Finance', ic: '◈', grp: 'Analyse', sub: 'Revenue, payment mix and the transaction ledger' },
  { id: 'causes', label: 'Why it moved', ic: '◔', grp: 'Analyse', sub: 'Structural breaks split into supply and demand, against what was happening in the world' },
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
  } else if (state.view === 'vehicle') {
    const tab = VEHICLE_TABS.find((t) => t.id === (state.sub || 'overview')) || VEHICLE_TABS[0];
    const spec = detail?.spec || {};
    $('#viewTitle').textContent = detail?.name || state.param || 'Vehicle';
    $('#viewSub').textContent = `${tab.label} — ${[spec.year, spec.make, spec.model].filter(Boolean).join(' ') || 'every source that describes this asset'}`;
    crumb.innerHTML = `<a href="${href('vehicles')}">Vehicles</a><span>/</span><b>${esc(detail?.name || state.param || '')}</b>`;
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
  const ctxP = panel('Volume against the weather and the calendar',
    'Dubai demand is weather- and calendar-driven: heat empties the streets, rain floods them, and Ramadan moves the whole day. This puts the two side by side so a dip has a candidate explanation rather than a shrug.');
  root.append(ctxP.panel);
  const hm = panel('Weekday × hour heatmap', 'Darker = busier. Click a cell for that slot'); root.append(hm.panel);
  [hourly.body, daily.body, ctxP.body, hm.body].forEach(loading);

  const [h, d, grid, ctx] = await Promise.all([
    q('/api/trips/hourly'), q('/api/trips/daily'), q('/api/trips/heatmap'),
    q('/api/context').catch(() => []),
  ]);
  areaChart(hourly.body, h.map((r) => ({ label: String(r.h).padStart(2, '0') + ':00', trips: r.trips })), { x: 'label', y: 'trips' });
  barChart(daily.body, d, { x: 'd', y: 'trips', onClick: (r) => drillTrips(`Trips on ${r.d}`, 'Drivers active that day', { from: r.d, to: r.d }) });

  /* Join the day's trips to that day's weather and calendar. Both sides are
     keyed on the calendar date, so a missing weather row leaves the trip row
     intact rather than dropping the day. */
  ctxP.body.innerHTML = '';
  const day = (v) => String(v).slice(0, 10);
  const byDay = new Map(ctx.map((c) => [day(c.day), c]));
  const rows = d.map((r) => ({ ...r, ...(byDay.get(day(r.d)) || {}) }));
  const withWeather = rows.filter((r) => r.temp_max != null);
  if (!withWeather.length) {
    ctxP.body.append(note('No weather rows for this range yet. The collector pulls Dubai daily observations and forecasts each cycle.'));
  } else {
    // Correlation between temperature and volume, stated plainly with its own
    // caveat — a month of days is not enough to call this causal.
    const n = withWeather.length;
    const mx = withWeather.reduce((a, r) => a + r.temp_max, 0) / n;
    const my = withWeather.reduce((a, r) => a + r.trips, 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    for (const r of withWeather) {
      const dx = r.temp_max - mx, dy = r.trips - my;
      sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
    }
    const rho = sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
    const hot = withWeather.filter((r) => r.temp_max >= 42);
    const mild = withWeather.filter((r) => r.temp_max < 42);
    const avg = (a) => (a.length ? a.reduce((s, r) => s + r.trips, 0) / a.length : null);
    const wet = rows.filter((r) => r.precipitation > 0);
    const hol = rows.filter((r) => r.is_holiday);
    const ram = rows.filter((r) => r.is_ramadan);

    ctxP.body.append(kpiRow([
      { label: 'Hottest day', value: `${Math.max(...withWeather.map((r) => r.temp_max)).toFixed(1)}°C`,
        sub: `${fmt(withWeather.filter((r) => r.temp_max >= 42).length)} days at or above 42°C` },
      { label: 'Trips on 42°C+ days', value: hot.length ? fmt(Math.round(avg(hot))) : '—',
        sub: mild.length ? `vs ${fmt(Math.round(avg(mild)))} on cooler days` : 'no cooler days to compare' },
      { label: 'Temp vs volume', value: rho.toFixed(2),
        sub: Math.abs(rho) < 0.3 ? 'no meaningful relationship in this window'
          : rho < 0 ? 'hotter days run quieter' : 'hotter days run busier',
        tone: Math.abs(rho) < 0.3 ? null : 'warn' },
      { label: 'Days with rain', value: fmt(wet.length),
        sub: wet.length ? `averaging ${fmt(Math.round(avg(wet)))} trips` : 'none in this range' },
      hol.length ? { label: 'Holidays', value: fmt(hol.length),
        sub: `averaging ${fmt(Math.round(avg(hol)))} trips` } : null,
      ram.length ? { label: 'Ramadan days', value: fmt(ram.length),
        sub: `averaging ${fmt(Math.round(avg(ram)))} trips` } : null,
    ]));

    ctxP.body.append(tableFrom([...rows].reverse().slice(0, 45), [
      { label: 'Day', key: 'd', render: (r) => dayStr(r.d) },
      { label: 'Trips', key: 'trips', num: true, render: (r) => fmt(r.trips) },
      { label: 'Km', key: 'km', num: true, render: (r) => fmt(r.km) },
      { label: 'Revenue', key: 'revenue', num: true, render: (r) => (r.revenue ? money(r.revenue) : '—') },
      { label: 'Max temp', key: 'temp_max', num: true, render: (r) => (r.temp_max != null
        ? `<span class="pill ${r.temp_max >= 44 ? 'bad' : r.temp_max >= 41 ? 'warn' : 'ok'}">${r.temp_max.toFixed(1)}°C</span>` : '—') },
      { label: 'Rain', key: 'precipitation', num: true, render: (r) => (r.precipitation ? `${r.precipitation} mm` : '—') },
      { label: 'Wind', key: 'wind_max', num: true, render: (r) => (r.wind_max != null ? `${Math.round(r.wind_max)} km/h` : '—') },
      { label: 'Calendar', key: '_c', render: (r) => [
        r.is_holiday ? pill(r.holiday_name || 'holiday', 'warn') : null,
        r.is_ramadan ? pill('Ramadan', 'warn') : null,
        r.is_forecast ? pill('forecast', null) : null,
      ].filter(Boolean).join(' ') || '—' },
    ]));
    ctxP.body.append(el('p', 'cap',
      'A correlation over a few weeks of days is a hint, not a finding — Dubai\'s temperature barely varies within a month, ' +
      'so the seasonal effect only becomes visible across a longer window. Rows marked forecast have not happened yet.'));
  }

  heatmap(hm.body, grid, { onClick: (c) => drill(`${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][c.dow]} at ${String(c.h).padStart(2,'0')}:00`,
    `${fmt(c.trips)} trips in this slot across the selected range`, async (b) => { b.innerHTML = '<div class="note">Slot-level trip list requires per-trip drill; showing driver ranking for the range.</div>';
      const rows2 = await q('/api/drivers/leaderboard'); b.append(tableFrom(rows2.slice(0, 25), [
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

// Why the numbers moved: breaks decomposed into supply vs demand, coverage
// gaps drawn as gaps, and the outside events that overlap them.
V.causes = async (root) => renderCauses(root);

V.vehicles = async (root) => {
  // The directory is the way into the per-vehicle pages; the panel below it is
  // the only question that is about the fleet rather than about one asset.
  await renderVehicleDirectory(root);
  const spread = panel('Fleet spread', 'How trips distribute across the fleet — a long tail here means assets carrying no load');
  root.append(spread.panel); loading(spread.body);
  const tierP = panel('Which assets serve which tier',
    'Uber Black and Comfort earn several times what UberX does per trip, so tier is an allocation decision. This is which cars are actually taking that work.');
  root.append(tierP.panel); loading(tierP.body);

  const [rows, byTier] = await Promise.all([q('/api/vehicles'), q('/api/product/by-vehicle').catch(() => [])]);
  hbars(spread.body, rows.slice(0, 14).map((r) => ({ label: r.plate, n: r.trips })), { seq: true,
    onClick: (d) => { location.hash = href('vehicle', d.label); } });

  tierP.body.innerHTML = '';
  if (!byTier.length) {
    tierP.body.append(note('No product tier recorded against vehicles in this range. Uber names the tier on each trip, so this fills in with the Uber feed.'));
  } else {
    // Pivot to one row per plate, one column per tier — the shape that answers
    // "is the premium work concentrated, and on which cars".
    const tiers = [...new Set(byTier.map((r) => r.product))]
      .sort((a, b) => byTier.filter((x) => x.product === b).reduce((s, x) => s + x.trips, 0)
                    - byTier.filter((x) => x.product === a).reduce((s, x) => s + x.trips, 0))
      .slice(0, 6);
    const byPlate = new Map();
    for (const r of byTier) {
      const cur = byPlate.get(r.plate) || { plate: r.plate, total: 0 };
      cur[r.product] = r.trips; cur.total += r.trips;
      byPlate.set(r.plate, cur);
    }
    const pivot = [...byPlate.values()].sort((a, b) => b.total - a.total).slice(0, 30);
    tierP.body.append(tableFrom(pivot, [
      { label: 'Plate', key: 'plate', render: (r) => `<a class="lnk" href="${href('vehicle', r.plate)}">${esc(r.plate)}</a>` },
      ...tiers.map((t) => ({ label: t, key: t, num: true,
        render: (r) => (r[t] ? `${fmt(r[t])}<span class="dim"> · ${Math.round((r[t] / r.total) * 100)}%</span>` : '—') })),
      { label: 'Total', key: 'total', num: true, render: (r) => fmt(r.total) },
    ]));
    // Concentration is the actionable part: a premium tier served by two cars
    // is a single point of failure for the fleet's best-earning work.
    const premium = tiers.find((t) => /black|lux|premier|comfort/i.test(t));
    if (premium) {
      const serving = pivot.filter((r) => r[premium]).sort((a, b) => (b[premium] || 0) - (a[premium] || 0));
      const total = serving.reduce((a, r) => a + r[premium], 0);
      const topTwo = serving.slice(0, 2).reduce((a, r) => a + r[premium], 0);
      tierP.body.append(el('p', 'cap',
        `${serving.length} vehicle(s) took ${esc(premium)} work. ` +
        (serving.length && total
          ? `The top two carried ${Math.round((topTwo / total) * 100)}% of it` +
            (serving.length <= 3 ? ' — losing one of those cars takes most of the tier with it.' : '.')
          : '')));
    }
  }
};

// The per-vehicle pages. `state.param` is the plate, `state.sub` is the tab.
V.vehicle = async (root) => renderVehicle(root, state.param, state.sub || 'overview');

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
  const kh = el('div'); root.append(kh); loading(kh);
  const g = el('div', 'grid g2'); root.append(g);
  const rev = panel('Revenue per day', 'Fare revenue from trips'); g.append(rev.panel);
  const pay = panel('Payment mix', 'Cash vs card vs wallet — cash is money the fleet has to collect'); g.append(pay.panel);
  const g2 = el('div', 'grid g2'); root.append(g2);
  const tier = panel('What each service tier earns', 'Uber Black and Comfort carry a different fare per kilometre than UberX — this is where tier allocation shows up as money');
  g2.append(tier.panel);
  const comp = panel('Earnings components', 'How the platform breaks a payout down: fares, tips, promotions, and what it deducts'); g2.append(comp.panel);
  const tips = panel('Tips by driver', 'Service quality expressed in money. Riders tip the experience, not the route.'); root.append(tips.panel);
  const led = panel('Ledger by category', 'Platform fees, bonuses and adjustments'); root.append(led.panel);
  [rev.body, pay.body, tier.body, comp.body, tips.body, led.body].forEach(loading);

  const [k, daily, byPay, byProd, ledger, components, tipRows, bySvc] = await Promise.all([
    q('/api/kpis'), q('/api/trips/daily'), q('/api/mix', { by: 'payment' }), q('/api/mix'),
    q('/api/finance/ledger'),
    q('/api/earnings/components').catch(() => []),
    q('/api/earnings/tips').catch(() => []),
    q('/api/mix', { by: 'service' }).catch(() => []),
  ]);

  const cash = byPay.find((p) => /cash/i.test(p.label));
  const tipTotal = tipRows.reduce((a, r) => a + (+r.tips || 0), 0);
  const fareTotal = tipRows.reduce((a, r) => a + (+r.fare || 0), 0);
  kh.replaceWith(kpiRow([
    { label: 'Revenue', value: money(k.revenue), sub: `${fmt(k.trips)} trips` },
    { label: 'Average fare', value: k.revenue && k.trips ? money(k.revenue / k.trips, 'AED', 2) : '—', sub: 'per trip' },
    { label: 'Revenue per km', value: k.revenue && k.km ? money(k.revenue / k.km, 'AED', 2) : '—', sub: `over ${fmt(k.km)} km` },
    { label: 'Cash to collect', value: cash ? money(cash.revenue) : money(0),
      sub: cash ? `${fmt(cash.n)} cash trips` : 'card only',
      tone: cash && k.revenue && cash.revenue / k.revenue > 0.25 ? 'warn' : null },
    { label: 'Tips', value: tipTotal ? money(tipTotal) : '—',
      sub: fareTotal ? `${((tipTotal / fareTotal) * 100).toFixed(2)}% of net fare` : 'no tip data collected yet',
      tone: fareTotal ? (tipTotal / fareTotal >= 0.03 ? 'good' : 'warn') : null },
  ]));

  areaChart(rev.body, daily, { x: 'd', y: 'revenue', color: '--s3', valueFmt: (v) => money(v) });
  donut(pay.body, byPay);

  /* Tier economics: the count alone hides the point, which is that a tier can
     be a small share of trips and a large share of revenue, or the reverse. */
  tier.body.innerHTML = '';
  const withRev = byProd.filter((r) => r.revenue != null && +r.revenue > 0);
  if (!withRev.length) {
    tier.body.append(note('No fares attached to product tiers in this range. The Uber trip export names the tier but omits the fare, so this fills in from the hotel and telematics feeds, or once Uber payout components cover the window.'));
    if (byProd.length) tier.body.append(tableFrom(byProd.slice(0, 8), [
      { label: 'Tier', key: 'label' }, { label: 'Trips', key: 'n', num: true, render: (r) => fmt(r.n) },
    ], { compact: true }));
  } else {
    const totalTrips = withRev.reduce((a, r) => a + r.n, 0);
    const totalRev = withRev.reduce((a, r) => a + +r.revenue, 0);
    tier.body.append(tableFrom(withRev.slice(0, 10), [
      { label: 'Tier', key: 'label' },
      { label: 'Trips', key: 'n', num: true, render: (r) => fmt(r.n) },
      { label: 'Share of trips', key: '_st', num: true, render: (r) => pct((r.n / totalTrips) * 100, 1) },
      { label: 'Revenue', key: 'revenue', num: true, render: (r) => money(r.revenue) },
      { label: 'Share of revenue', key: '_sr', num: true, render: (r) => pct((+r.revenue / totalRev) * 100, 1) },
      { label: 'Per trip', key: '_pt', num: true, render: (r) => money(+r.revenue / r.n, 'AED', 2) },
    ], { compact: true }));
    // The tier that punches above its trip share is the one worth steering toward.
    const best = [...withRev].sort((a, b) => (+b.revenue / b.n) - (+a.revenue / a.n))[0];
    const worst = [...withRev].sort((a, b) => (+a.revenue / a.n) - (+b.revenue / b.n))[0];
    if (best && worst && best.label !== worst.label) {
      const ratio = (+best.revenue / best.n) / (+worst.revenue / worst.n);
      tier.body.append(el('p', 'cap',
        `${esc(best.label)} earns ${ratio.toFixed(1)}× per trip what ${esc(worst.label)} does ` +
        `(${money(+best.revenue / best.n, 'AED', 2)} vs ${money(+worst.revenue / worst.n, 'AED', 2)}). ` +
        `Trip length differs between tiers, so compare per-kilometre before reallocating vehicles.`));
    }
  }

  /* Uber's own personal-vs-business split. Worth stating even when it is
     one-sided: "no business work at all" is a finding, and an empty panel
     reads as a missing feature rather than an absent revenue line. */
  const named = bySvc.filter((r) => r.label && r.label !== 'unknown');
  if (named.length) {
    const biz = named.filter((r) => /business|corporate|u4b/i.test(r.label));
    const total = named.reduce((a, r) => a + r.n, 0);
    tier.body.append(el('p', 'cap', biz.length
      ? `Uber splits these into ${named.map((r) => `${esc(r.label.replace(/_/g, ' '))} ${fmt(r.n)}`).join(', ')} — ` +
        `business work is ${pct((biz.reduce((a, r) => a + r.n, 0) / total) * 100, 1)} of trips.`
      : `Uber labels every one of these ${fmt(total)} trips “${esc(named[0].label.replace(/_/g, ' '))}”. ` +
        `There is no Uber for Business work in the record — that channel is either not enabled for this org or unused.`));
  }

  /* Components arrive signed: fares and tips add, cash already collected and
     fees subtract. Drawing them all one way would show a deduction as income. */
  comp.body.innerHTML = '';
  if (!components.length) {
    comp.body.append(note('No payout breakdown collected yet. Uber publishes components per payout period; they appear once a period covering this range has been pulled.'));
  } else {
    const agg = new Map();
    for (const c of components) {
      const cur = agg.get(c.category) || { label: c.category.replace(/_/g, ' '), amount: 0, parent: c.parent };
      cur.amount += +c.amount || 0;
      agg.set(c.category, cur);
    }
    const rows = [...agg.values()].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
    const max = Math.max(...rows.map((r) => Math.abs(r.amount))) || 1;
    const host = el('div', 'hbars');
    rows.forEach((c, i) => {
      const neg = c.amount < 0;
      const r = el('div', 'hb');
      r.innerHTML = `<div class="k" title="${esc(c.parent || '')}">${esc(c.label)}</div>
        <div class="track"><div class="fill" style="width:${(Math.abs(c.amount) / max * 100).toFixed(1)}%;
          background:var(${neg ? '--s2' : i === 0 ? '--b600' : '--b400'});animation-delay:${i * 45}ms"></div></div>
        <div class="v num">${neg ? '−' : ''}${money(Math.abs(c.amount))}</div>`;
      host.append(r);
    });
    comp.body.append(host);
    comp.body.append(el('div', 'legend', `
      <span><i style="background:var(--b500)"></i>added to the payout</span>
      <span><i style="background:var(--s2)"></i>deducted (cash already taken, fees)</span>`));
  }

  /* Tips are the one quality signal riders pay for directly. */
  tips.body.innerHTML = '';
  if (!tipRows.length) {
    tips.body.append(note('No tip data yet. Tips never appear in the trip feed — they come from the Uber payout breakdown, which fills in per payout period.'));
  } else {
    const t = tableFrom(tipRows.slice(0, 30), [
      { label: 'Driver', key: 'driver_name', render: (r) => (r.driver_ext_id
        ? `<a class="lnk" href="${href('driver', r.driver_ext_id)}">${esc(r.driver_name || r.driver_ext_id)}</a>`
        : esc(r.driver_name || '—')) },
      { label: 'Tips', key: 'tips', num: true, render: (r) => money(r.tips, 'AED', 2) },
      { label: 'Net fare', key: 'fare', num: true, render: (r) => money(r.fare) },
      { label: 'Tip rate', key: 'tip_pct', num: true, render: (r) => (r.tip_pct != null
        ? `<span class="pill ${+r.tip_pct >= 3 ? 'ok' : +r.tip_pct >= 1 ? 'warn' : 'bad'}">${(+r.tip_pct).toFixed(2)}%</span>` : '—') },
    ]);
    tips.body.append(t);
    tips.body.append(el('p', 'cap',
      'Tip rate is tips as a share of net fare, so it compares a high-volume driver with a low-volume one fairly. ' +
      'It reflects the ride experience more than the route — which is what makes it coachable.'));
  }

  led.body.innerHTML = '';
  if (ledger.length) hbars(led.body, ledger.slice(0, 12).map((r) => ({ label: r.category, n: Math.abs(+r.amount) })),
    { color: '--s2', valueFmt: (v) => money(v) });
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

  /* What the platform itself is asking for. These are Uber's own targets for
     the org — acceptance, cancellation, ratings — and they carry weight the
     fleet's internal rules do not: falling short of them affects allocation. */
  const rec = panel('What Uber is asking the fleet to fix',
    'Targets the platform sets for the org. Falling short affects trip allocation, so these are not advisory.');
  root.append(rec.panel); loading(rec.body);
  const recs = await api('/api/recommendations').catch(() => []);
  rec.body.innerHTML = '';
  if (!recs.length) {
    rec.body.append(note('No platform recommendations collected. Uber publishes these per org; they appear once the fleet-portal collector has run against an account that can see them.'));
  } else {
    rec.body.append(tableFrom(recs, [
      { label: 'Platform', key: 'platform' },
      { label: 'Target', key: 'rec_type', render: (r) => esc(String(r.rec_type || '').replace(/_/g, ' ')) },
      { label: 'Period', key: '_p', render: (r) => (r.period_start
        ? `${dayStr(r.period_start)} → ${dayStr(r.period_end)}` : 'current') },
      { label: 'Fleet is at', key: 'org_value', num: true },
      { label: 'Target', key: 'target_value', num: true },
      { label: 'Meeting it', key: 'flagged', render: (r) => (r.flagged
        ? pill('below target', 'bad') : pill('on target', 'ok')) },
      { label: 'Drivers flagged', key: 'flagged_count', num: true, render: (r) => (r.flagged_count != null ? fmt(r.flagged_count) : '—') },
    ]));
    const behind = recs.filter((r) => r.flagged);
    if (behind.length) rec.body.append(el('p', 'cap',
      `${behind.length} of ${recs.length} targets are not being met. Each names the drivers behind it — ` +
      `open a driver's Quality page to see their own acceptance and cancellation figures.`));
  }
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
