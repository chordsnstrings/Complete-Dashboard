// Fleet Dashboard — a multipage app behind a hash router.
// Views live in this file; the per-driver detail pages live in driver.js, and
// everything shared between them (panels, tables, modals, routing, fetching)
// lives in ui.js and data.js so the two cannot drift apart.
import { barChart, gapBars, areaChart, donut, hbars, heatmap, scatter, stackedBar, fmt, empty, showTip, hideTip } from './charts.js';
import { $, el, esc, panel, loading, tableFrom, kpiRow, tabBar, pill, note, entity,
  dayStr, dtStr, timeStr, money, pct, custody, custodyAsOf } from './ui.js';
import { dubaiDay, TZ, TZ_LABEL } from './tz.js';
import { state, api, params, q, qAll, href, parseHash, navigate, store, setFilter,
  windowDates } from './data.js';
import { renderDriver, renderDriverDirectory, DRIVER_TABS } from './driver.js';
import { renderVehicle, renderVehicleDirectory, VEHICLE_TABS } from './vehicle.js';
import { renderCauses } from './causes.js';
import { renderCorporate, renderProperty, CORP_TABS, PROPERTY_TABS } from './corporate.js';
import { renderSettlement, SETTLE_TABS } from './settlement.js';
import { renderCoverage } from './coverage.js';
import { renderCorridors } from './corridors.js';
import { renderAnalyst, ANALYST_TABS } from './analyst.js';
import { renderProviders } from './providers.js';
import { renderRoster, ROSTER_TABS } from './roster.js';
import { renderDay } from './day.js';
import { renderSegments, renderSegment, segmentTable } from './segments.js';
import { renderSlot } from './slot.js';
import { renderPlaybook } from './playbook.js';
import { renderForecast } from './forecast.js';
import { renderRetention } from './retention.js';
import { renderCapacity } from './capacity.js';
import { renderRevenue } from './revenue.js';

/* Postgres sends a DATE over JSON as a full ISO timestamp, so `d.d` is
   "2026-08-21T00:00:00.000Z" and not "2026-08-21". Passing that straight back
   as a filter produced a zero-width range — every "click a day" drill opened an
   empty modal titled with a raw timestamp. */
const dayKey = (v) => String(v ?? '').slice(0, 10);

/* Uber publishes these as fractions (0.79 against a 0.85 target), and the table
   rendered the raw number beside a column headed "Target". */
const pctOf = (v) => (v == null || !Number.isFinite(Number(v)) ? '—'
  : Number(v) <= 1 ? `${(Number(v) * 100).toFixed(1)}%` : fmt(v, 1));

/* Whether a published target is being missed. `flagged` is a JSON array of the
   drivers Uber named, so testing it for truthiness marked every row — empty
   array included — as below target. Cancellation is the one metric where LOWER
   is better, so the direction is read from the rule name. */
function missingTarget(r) {
  const org = Number(r.org_value), target = Number(r.target_value);
  if (!Number.isFinite(org) || !Number.isFinite(target)) return null;
  const lowerIsBetter = /cancel/i.test(String(r.rec_type || ''));
  return lowerIsBetter ? org > target : org < target;
}

/* A breakdown that quietly drops the rows a provider never labelled reads as a
   complete picture of a subset. Telematics trips carry no payment type at all,
   so the old donut was 80% "unknown" — and once that bucket was removed the
   chart became honest about the categories but silent about the coverage. This
   draws the labelled rows and states what is missing underneath. */
function paymentDonut(host, detail) {
  host.innerHTML = '';
  const groups = (detail && detail.groups) || [];
  if (!groups.length) { empty(host, 'No trip in this range records how it was paid'); return; }
  /* Grouped by SETTLEMENT ROUTE, not by the processor's name. Charted raw this
     was a nineteen-slice donut whose largest slice was `braintree` — the name
     of a payment integration, sitting beside `zaakpay` and `kcp_pg` as if the
     three were different kinds of business, while `room-charge` and
     `posted-for-salary` (money somebody owes us) were folded away past the
     eighth slice. The classes are the same ones the Settlement page uses, so
     the two pages cannot disagree. */
  const CLASS = {
    cash: 'Cash', 'cash-driver': 'Cash', 'cash-supervisor': 'Cash',
    'pos-driver': 'Card', 'pos-supervisor': 'Card', braintree: 'Card', zaakpay: 'Card',
    kcp_pg: 'Card', card: 'Card', credit_card: 'Card',
    apple_pay: 'Wallet', google_pay: 'Wallet', paypal: 'Wallet', alipay2: 'Wallet',
    digital: 'Wallet', wallet: 'Wallet', cashless: 'Wallet',
    'room-charge': 'On account', 'hotel-charge': 'On account', company: 'On account',
    corporate: 'On account', invoice: 'On account',
    'posted-for-salary': 'Salary deduction', salary: 'Salary deduction',
    'foc-complimentary': 'Complimentary', foc: 'Complimentary', complimentary: 'Complimentary',
    offline: 'Settled off-platform', derivative: 'Adjustment',
  };
  const folded = new Map();
  groups.forEach((g) => {
    const k = CLASS[String(g.label || '').toLowerCase()] || 'Other';
    const cur = folded.get(k) || { label: k, n: 0, revenue: 0, priced: 0, labels: [] };
    cur.n += g.n; cur.revenue += Number(g.revenue) || 0; cur.priced += g.priced_n || 0;
    cur.labels.push(g.label);
    folded.set(k, cur);
  });
  const rows = [...folded.values()].sort((a, b) => b.n - a.n);
  donut(host, rows, { onClick: () => { location.hash = href('settlement'); } });
  const owed = rows.filter((r) => ['On account', 'Salary deduction'].includes(r.label));
  host.append(el('p', 'cap', [
    detail.unlabelled_trips
      ? `${fmt(detail.unlabelled_trips)} of ${fmt(detail.total_trips)} trips record no payment type`
        + `${detail.unlabelled_platforms?.length ? ` (${esc(detail.unlabelled_platforms.join(', '))})` : ''}`
        + ' and are left out rather than counted as cash.'
      : '',
    owed.length
      ? `${fmt(owed.reduce((a, r) => a + r.n, 0))} settled after the ride — see Settlement for what is outstanding.`
      : '',
  ].filter(Boolean).join(' ')));
}

const VIEWS = [
  { id: 'overview', label: 'Overview', ic: '◱', grp: 'Analyse', sub: 'Fleet-wide performance across every platform' },
  { id: 'demand', label: 'Demand', ic: '◷', grp: 'Analyse', sub: 'When trips happen — by day, hour and weekday' },
  { id: 'drivers', label: 'Drivers', ic: '◧', grp: 'Analyse', sub: 'Per-driver output, quality and cross-platform activity' },
  { id: 'roster', label: 'Roster & supply', ic: '☰', grp: 'Analyse', sub: 'Who is on the books across all four platforms, and who is earning nothing' },
  { id: 'retention', label: 'Joiners & leavers', ic: '⇅', grp: 'Analyse', sub: 'Whether a falling driver count is people leaving or nobody arriving — a headcount cannot tell them apart' },
  { id: 'vehicles', label: 'Vehicles', ic: '▤', grp: 'Analyse', sub: 'Utilisation and revenue per vehicle' },
  { id: 'platforms', label: 'Platforms', ic: '◨', grp: 'Analyse', sub: 'Uber vs Yango vs Bolt — share, product tier and the acceptance funnel' },
  { id: 'corridors', label: 'Corridors', ic: '⇄', grp: 'Analyse', sub: 'Where jobs start and end, rolled up from the addresses every channel returns' },
  { id: 'revenue', label: 'Revenue by channel', ic: '◇', grp: 'Analyse', sub: 'What each platform actually tells us about money — and which ones tell us nothing' },
  { id: 'finance', label: 'Finance', ic: '◈', grp: 'Analyse', sub: 'Revenue, payment mix and the transaction ledger' },
  { id: 'settlement', label: 'Settlement', ic: '◫', grp: 'Analyse', sub: 'Who settles the fare and when — cash in hand, and what is outstanding' },
  { id: 'corporate', label: 'Corporate & hotels', ic: '❖', grp: 'Analyse', sub: 'The channel that reports a cost, a property, a guest and the driver’s starting point' },
  { id: 'causes', label: 'Why it moved', ic: '◔', grp: 'Analyse', sub: 'Structural breaks split into supply and demand, against what was happening in the world' },
  { id: 'forecast', label: 'Forecast', ic: '◠', grp: 'Analyse', sub: 'What next month looks like, day by day, and how much of that is a guess' },
  { id: 'playbook', label: 'To-do list', ic: '☑', grp: 'Operate', sub: 'What to do this month to earn more — each item with the arithmetic that sized it' },
  { id: 'capacity', label: 'Rota gaps', ic: '◫', grp: 'Operate', sub: 'Where next month’s forecast work lands, against who currently covers that hour' },
  { id: 'insights', label: 'Action list', ic: '✦', grp: 'Operate', sub: 'What needs doing, ranked by what it costs to ignore' },
  { id: 'analyst', label: 'Analyst', ic: '◑', grp: 'Operate', sub: 'Claims a model proposed and the database judged — with the numbers that decided each one' },
  { id: 'compliance', label: 'Compliance', ic: '❑', grp: 'Operate', sub: 'Documents and licences with an expiry date attached' },
  { id: 'unauthorized', label: 'Unauthorized trips', ic: '⚠', grp: 'Operate', sub: 'Seat occupied, vehicle moved — but no booking on any channel' },
  { id: 'safety', label: 'Safety', ic: '△', grp: 'Operate', sub: 'Harsh-driving events from the telematics layer' },
  { id: 'live', label: 'Live fleet', ic: '◉', grp: 'Operate', sub: 'Realtime positions — CABMAN refreshes every 5 minutes' },
  { id: 'map', label: 'Map & replay', ic: '◍', grp: 'Operate', sub: 'Where every vehicle is now, and where it went on any given day' },
  { id: 'sources', label: 'Data sources', ic: '⛁', grp: 'Operate', sub: 'Collector health, coverage and history depth' },
  { id: 'coverage', label: 'Collection gaps', ic: '▦', grp: 'Operate', sub: 'Which days each source actually collected — a hole here makes every rate across it wrong' },
  { id: 'providers', label: 'What each API offers', ic: '⌗', grp: 'Operate', sub: 'Every field each provider sends, and the ones we currently have nowhere to put' },
  { id: 'settings', label: 'Settings', ic: '⚙', grp: 'Configure', sub: 'Credentials and collection schedule' },
];

/* ─────────── shell ─────────── */
// A detail page keeps its parent lit in the sidebar — `#driver/…` is a page
// *within* Drivers, not a thirteenth top-level destination.
const PARENT = { driver: 'drivers', vehicle: 'vehicles', property: 'corporate', day: 'demand', action: 'insights' };

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
  } else if (state.view === 'action') {
    $('#viewTitle').textContent = detail?.title || 'Finding';
    $('#viewSub').textContent = 'One finding, its evidence, and what to do about it';
    crumb.innerHTML = `<a href="${href('insights')}">Action list</a><span>/</span><b>${esc(state.param || '')}</b>`;
    crumb.style.display = 'flex';
  } else if (state.view === 'day') {
    const label = /^\d{4}-\d{2}-\d{2}$/.test(state.param || '')
      ? new Date(`${state.param}T12:00:00Z`).toLocaleDateString(undefined,
        { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: TZ })
      : 'Day';
    $('#viewTitle').textContent = label;
    $('#viewSub').textContent = 'Every source that saw this day — including whether each one was collecting';
    crumb.innerHTML = `<a href="${href('demand')}">Demand</a><span>/</span><b>${esc(state.param || '')}</b>`;
    crumb.style.display = 'flex';
  } else if (state.view === 'property') {
    const tab = PROPERTY_TABS.find((t) => t.id === (state.sub || 'overview')) || PROPERTY_TABS[0];
    $('#viewTitle').textContent = detail?.name || 'Property';
    $('#viewSub').textContent = `${tab.label} — every booking this property placed, with its cost as well as its price`;
    crumb.innerHTML = `<a href="${href('corporate', 'properties')}">Corporate &amp; hotels</a><span>/</span><b>${esc(detail?.name || state.param || '')}</b>`;
    crumb.style.display = 'flex';
  } else {
    const v = VIEWS.find((x) => x.id === state.view) || VIEWS[0];
    $('#viewTitle').textContent = v.label; $('#viewSub').textContent = v.sub;
    crumb.style.display = 'none';
  }
  /* The forecast fits every whole month since the last regime change, so the
     window selector does not control it — showing the control would imply it
     did. The playbook DOES respect the window: "idle this month" is a
     different list from "idle this year". */
  const noFilter = ['settings', 'live', 'sources', 'day', 'providers', 'action', 'insights',
    'compliance', 'forecast', 'retention', 'capacity'];
  $('#filters').style.display = noFilter.includes(state.view) ? 'none' : 'flex';
}
/* ─────────── views ─────────── */
const V = {};

V.overview = async (root) => {
  const kpiHost = el('div', 'kpis'); root.append(kpiHost);
  const g1 = el('div', 'grid g23'); root.append(g1);
  const trend = panel('Trips per day',
    'Bookings only. Telematics journeys are drawn behind them in grey — the same physical trips, seen '
    + 'by the trackers. A day nobody collected is hatched, not zero. Click a bar to open that day.');
  g1.append(trend.panel);
  const mix = panel('Platform share',
    'Bookings by channel. Telematics rows are excluded: they are the same journeys, and adding them '
    + 'made this ring total four times the Trips figure above.');
  g1.append(mix.panel);
  const g2 = el('div', 'grid g3'); root.append(g2);
  const prod = panel('Product mix', 'Which service tiers the fleet runs'); g2.append(prod.panel);
  const pay = panel('How fares settle',
    'Grouped by settlement route rather than by the processor\'s name — click for the detail.');
  g2.append(pay.panel);
  const out = panel('Trip outcome', 'Completed vs cancelled'); g2.append(out.panel);
  const lead = panel('Top drivers', 'Ranked by completed trips — click for detail'); root.append(lead.panel);
  [kpiHost, trend.body, mix.body, prod.body, pay.body, out.body, lead.body].forEach(loading);

  const [k, daily, byPlat, byProd, payDetail, byStatus, drivers] = await Promise.all([
    q('/api/kpis'), q('/api/trips/daily'), q('/api/mix', { by: 'platform' }), q('/api/mix'),
    q('/api/mix/detail', { by: 'payment' }), q('/api/mix', { by: 'status' }), q('/api/drivers/leaderboard'),
  ]);

  kpiHost.innerHTML = [
    ['Trips', fmt(k.trips), `${fmt(k.drivers)} drivers · ${fmt(k.telematics_journeys || 0)} telematics journeys`],
    ['Distance', fmt(k.km) + ' km', `avg ${k.avg_km ?? '—'} km/trip`],
    // Revenue over the trips that CARRY a fare. Presenting it as the fleet's
    // revenue while it covers 4% of the trips beside it is the single most
    // misread number on this page.
    ['Revenue', k.revenue ? 'AED ' + fmt(k.revenue) : '—',
      k.priced_trips && k.trips
        ? `over ${fmt(k.priced_trips)} of ${fmt(k.trips)} trips (${Math.round(k.priced_trips / k.trips * 100)}%) that report one`
        : 'no trip in this range reports a fare'],
    ['Completion', k.completion_pct != null ? k.completion_pct + '%' : '—', `${k.cancel_pct ?? 0}% cancelled`],
    ['Vehicles', fmt(k.vehicles), 'with a trip in this range'],
    ['Safety alerts', fmt(k.alerts), 'harsh-driving events'],
  ].map(([l, n, d]) => `<div class="kpi"><div class="l">${l}</div><div class="n num">${n}</div><div class="d">${d}</div></div>`).join('');

  gapBars(trend.body, daily, { x: 'd', y: 'trips', label: 'bookings', secondary: 'telematics_journeys',
    // A day is an address now, not a modal containing a driver list.
    onClick: (d) => { location.hash = href('day', dayKey(d.d)); } });
  donut(mix.body, byPlat, { onClick: (d) => { location.hash = href('platforms'); } });
  hbars(prod.body, byProd.slice(0, 6));
  paymentDonut(pay.body, payDetail);
  stackedBar(out.body, byStatus.slice(0, 5));
  lead.body.innerHTML = '';
  /* One row per person now, not per platform account — a person working two
     apps used to appear twice with half their work on each row, and therefore
     rank below somebody who did less. Tolerant of the old bare-array shape so
     a stale cached bundle does not blank the panel. */
  const lbRows = Array.isArray(drivers) ? drivers : (drivers.rows || []);
  lead.body.append(tableFrom(lbRows.slice(0, 12), [
    { label: '#', key: '_i', render: (r) => String(lbRows.indexOf(r) + 1) },
    { label: 'Driver', key: 'driver_name',
      render: (r) => entity('driver', r.driver_ext_id, r.driver_name) },
    { label: 'Channels', key: 'platforms',
      render: (r) => esc((r.platforms || (r.platform ? [r.platform] : [])).join(', ')) },
    { label: 'Plate', key: 'plate', render: (r) => entity('vehicle', r.plate, r.plate) },
    { label: 'Trips', key: 'trips', num: true },
    { label: 'Km', key: 'km', num: true },
    { label: 'Completion', key: 'completion_pct', num: true, render: (r) => r.completion_pct != null ? r.completion_pct + '%' : '—' },
  ]));
  if (drivers.truncated) {
    lead.body.append(el('p', 'cap',
      `The 12 busiest of ${fmt(drivers.people)} people who drove in this window.`));
  }
};

V.demand = async (root) => {
  const g = el('div', 'grid g2'); root.append(g);
  const hourly = panel('Hourly demand curve', 'Trip requests by hour of day'); g.append(hourly.panel);
  const daily = panel('Daily volume',
    'Bookings per Dubai-local day, with telematics journeys behind them. A day nobody collected is '
    + 'hatched rather than drawn as zero. Click a bar to open that day.');
  g.append(daily.panel);
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
  gapBars(daily.body, d, { x: 'd', y: 'trips', label: 'bookings', secondary: 'telematics_journeys',
    onClick: (r) => { location.hash = href('day', dayKey(r.d)); } });

  /* Join the day's trips to that day's weather and calendar. Both sides are
     keyed on the calendar date, so a missing weather row leaves the trip row
     intact rather than dropping the day. */
  ctxP.body.innerHTML = '';
  const day = (v) => String(v).slice(0, 10);
  const byDay = new Map(ctx.map((c) => [day(c.day), c]));
  const rows = d.map((r) => ({ ...r, ...(byDay.get(day(r.d)) || {}) }));
  /* Only days that are BOTH weather-covered and fully collected.
     weather_daily holds about the last month, so over a 12-month selection this
     panel described one month while labelling nothing — "Days with rain: 1"
     read as a statement about the year. And a day nobody collected has zero
     trips, which dragged every hot-versus-cool average toward whichever side
     the collection gap happened to fall on. */
  const usable = rows.filter((r) => !r.uncollected && !r.sources_silent);
  const withWeather = usable.filter((r) => r.temp_max != null);
  const weatherDays = rows.filter((r) => r.temp_max != null).length;
  if (!withWeather.length) {
    ctxP.body.append(note('No weather rows for this range yet. The collector pulls Dubai daily observations and forecasts each cycle.'));
  } else {
    ctxP.body.append(note(`${fmt(withWeather.length)} of the ${fmt(rows.length)} days in this window have `
      + `both weather and a complete collection, and everything below is over those days only`
      + (weatherDays < rows.length
        ? ` — weather is stored for about the last month, so a longer selection describes a shorter period than its title.`
        : '.')));
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

  /* A cell used to open a modal that showed the driver ranking for the WHOLE
     range — identically whichever cell you clicked, under a title naming the
     slot. It is now a page about that slot: who covers it, on how many of the
     weekdays it could have covered, from where, and what happens if that person
     is off. */
  heatmap(hm.body, grid, { onClick: (c) => { location.hash = href('slot', String(c.dow), String(c.h)); } });
  hm.body.append(el('p', 'cap',
    'Darker is busier. A cell opens that hour as a rostering question — who holds it, how reliably it fires, '
    + 'and where the work starts.'));
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
  const [, cross, pf, dir] = await Promise.all([q('/api/drivers/leaderboard'),
    q('/api/drivers/cross-platform'), q('/api/drivers/performance'), q('/api/drivers/directory')]);

  /* Plotted from the DIRECTORY, not the leaderboard.
     The caption says "each dot is a driver" and the leaderboard is one row per
     ACCOUNT — grouped by (name, id, platform) — so a person working two apps
     was two dots, each showing a fraction of their work, and the dot you
     clicked opened a page whose totals did not match it. The leaderboard is
     also capped at 100 accounts, which on a fleet this size is a sample of the
     roster presented as the roster. The directory is one row per person and
     covers everyone. */
  const dots = (Array.isArray(dir) ? dir : [])
    .filter((r) => (r.trips || 0) > 0)
    .map((r) => ({ ...r, driver_ext_id: r.ids?.[0] || r.driver_ext_id,
      trips: +r.trips, km: +(r.km || 0) }))
    .sort((a, b) => b.trips - a.trips);
  scatter(sc.body, dots.slice(0, 80),
    { x: 'trips', y: 'km', label: 'driver_name', xLabel: 'trips', yLabel: 'km',
      onClick: (r) => { location.hash = href('driver', r.driver_ext_id); } });
  sc.body.append(el('p', 'cap', dots.length > 80
    ? `The 80 busiest of ${fmt(dots.length)} people who drove in this window. One dot per person: `
      + 'platform accounts are folded, so somebody working two apps is one dot carrying both.'
    : 'One dot per person: platform accounts are folded, so somebody working two apps is one '
      + 'dot carrying both.'));
  xp.body.innerHTML = '';
  /* This read `cross.filter(...)`. The endpoint returns
     `{platforms, drivers, multi_platform, note}` and has since it was rewritten
     to fold accounts by person — so `.filter` was being called on an object and
     threw, which the view's catch-all turned into "Could not load this view"
     across the WHOLE Drivers page, directory included. It went unnoticed
     because the mock API had no fixture for this route and the catch-all
     returned `[]`, on which `.filter` works.

     The columns come from `cross.platforms` rather than a hardcoded list, which
     is the same fix the endpoint itself already carries: the hardcoded list had
     no `hotel`, one of only three platforms with trip data, so a driver working
     Uber and the hotel channel scored one platform and this panel printed the
     flat denial below — on a page whose own directory had just listed them. */
  const people = cross.drivers || (Array.isArray(cross) ? cross : []);
  const plats = cross.platforms || [];
  const col = (pl) => `${pl}_trips`;
  const multi = people.filter((r) => plats.filter((pl) => (r[col(pl)] || 0) > 0).length > 1);
  /* The headline counts come from the endpoint, which computes them over every
     person in the window. `people` is capped at 150 rows, so counting them here
     printed "N of 150" for a fleet of 240 — a sentence that is simply false,
     and false in the direction that makes the fleet look smaller than it is. */
  const popN = cross.people ?? people.length;
  const multiN = cross.multi_platform ?? multi.length;
  if (!multiN) {
    xp.body.append(el('div', 'note', plats.length
      ? `No driver in this window has trips on more than one of: ${plats.join(', ')}.`
      : 'No platform has trips in this window, so there is nothing to compare.'));
  } else {
    xp.body.append(tableFrom(multi.slice(0, 15), [
      { label: 'Driver', key: 'driver_name', render: (r) => entity('driver', r.driver_ext_id, r.driver_name) },
      ...plats.map((pl) => ({ label: pl, key: col(pl), num: true })),
      { label: 'Telematics', key: 'telematics_journeys', num: true,
        render: (r) => (r.telematics_journeys ? fmt(r.telematics_journeys) : '—') },
      { label: 'Bookings', key: 'booking_trips', num: true },
      { label: 'Accounts', key: 'accounts', num: true },
    ]));
    xp.body.append(el('p', 'cap',
      `${fmt(multiN)} of ${fmt(popN)} people in this window work more than one channel`
      + (cross.truncated ? `, from the ${fmt(people.length)} busiest shown here. ` : '. ')
      + 'Columns cover every platform with data, so the booking total is the sum of what is shown; '
      + 'telematics journeys are counted apart because they are the same physical trips seen by the tracker.'));
  }
  perf.body.innerHTML = '';
  /* {rows, periods, totals, shown, truncated} — a bare array before. The cap
     started to bite the moment the Uber collector was fixed: a weekly period
     used to hold ten drivers because that was all the collector could see, and
     now holds a hundred and fifty, so the first 300 rows are two periods rather
     than a year of them. Tolerant of the old shape so a stale bundle still
     draws something. */
  const pfRows = Array.isArray(pf) ? pf : (pf.rows || []);
  const pfTot = (Array.isArray(pf) ? null : pf.totals) || {};
  perf.body.append(tableFrom(pfRows.slice(0, 25), [
    { label: 'Platform', key: 'platform' },
    { label: 'Driver', key: 'driver_name', render: (r) => entity('driver', r.driver_ext_id, r.driver_name) },
    { label: 'Period', key: 'period_start', render: (r) => dayStr(r.period_start) },
    { label: 'Trips', key: 'trips', num: true },
    { label: 'Hrs online', key: 'hours_online', num: true, render: (x) => x.hours_online ? (+x.hours_online).toFixed(1) : '—' },
    { label: 'Earnings', key: 'earnings', num: true, render: (x) => money(x.earnings) },
  ]));
  if (pfTot.total) {
    perf.body.append(el('p', 'cap',
      `Showing 25 of ${fmt(pfTot.total)} records — ${fmt(pfTot.people)} people across `
      + `${fmt(pfTot.periods)} reporting periods on ${(pfTot.platforms || []).join(', ') || 'no platform'}, `
      + `${money(pfTot.earnings)} reported in total.`
      + (pf.truncated ? ' The list is the most recent periods, not all of them.' : '')));
  }
};

// The per-driver pages themselves. `state.param` is the platform driver id and
// `state.sub` is the tab — both come straight from the URL.
V.driver = async (root) => renderDriver(root, state.param, state.sub || 'overview');

// Why the numbers moved: breaks decomposed into supply vs demand, coverage
// gaps drawn as gaps, and the outside events that overlap them.
V.causes = async (root) => renderCauses(root);

/* The commercial pages. Each is a tabbed multipage view whose tab is part of
   the address, so "the eleven bookings we gave away last month" is a link. */
V.corporate = async (root) => renderCorporate(root, CORP_TABS.some((t) => t.id === state.param) ? state.param : 'overview');
V.property = async (root) => {
  let detail = null;
  await renderProperty(root, state.param, PROPERTY_TABS.some((t) => t.id === state.sub) ? state.sub : 'overview',
    (d) => { detail = d; });
  return detail;
};
V.settlement = async (root) => renderSettlement(root, SETTLE_TABS.some((t) => t.id === state.param) ? state.param : 'mix');
V.coverage = async (root) => renderCoverage(root);
V.corridors = async (root) => renderCorridors(root);

/* One finding, as an address. It was a modal, so the evidence trail for a
   specific problem could not be sent to the person who has to fix it — and the
   entity it named was plain text, so a finding about a vehicle dead-ended at
   the vehicle's name. */
V.action = async (root) => {
  const code = state.param, entityId = state.sub === '-' ? null : state.sub;
  root.innerHTML = '';
  loading(root);
  const page = await api('/api/insights').catch(() => ({ insights: [] }));
  const rows = (page.insights || []).filter((r) => r.code === code
    && (entityId == null || String(r.entity_id) === String(entityId)));
  root.innerHTML = '';
  if (!rows.length) {
    root.append(note('That finding is no longer open. Either it was resolved and the engine has stopped '
      + 'raising it, or the collection window it was computed over has moved on.'));
    root.append(el('p', 'cap', `Looking for ${esc(code || '?')}${entityId ? ` on ${esc(entityId)}` : ''}.`));
    return { title: 'Finding' };
  }
  const r = rows[0];
  const ENTITY_VIEW = { vehicle: 'vehicle', driver: 'driver', partner: 'property' };
  const view = ENTITY_VIEW[r.entity_type];
  root.append(kpiRow([
    { label: 'Severity', value: r.severity, tone: { critical: 'critical', warning: 'warn', good: 'good' }[r.severity] },
    { label: 'Category', value: r.category },
    { label: 'About', html: view && r.entity_id ? entity(view, r.entity_id, `${r.entity_type} ${r.entity_id}`)
      : esc(`${r.entity_type || 'fleet'} ${r.entity_id || ''}`) },
    { label: 'Computed', value: r.computed_at ? dtStr(r.computed_at) : '—',
      sub: r.window_start ? `over ${dayStr(r.window_start)} → ${dayStr(r.window_end)}` : 'current state' },
    r.impact_aed
      ? { label: 'Sized at', value: money(r.impact_aed),
          sub: r.code === 'idle_vehicle' ? 'a modelled holding cost, not a measurement' : 'as measured',
          tone: r.code === 'idle_vehicle' ? 'warn' : null }
      : null,
  ]));
  const why = panel('What we found', 'The evidence behind this flag.');
  why.body.innerHTML = `<p style="margin:0">${esc(r.detail || '')}</p>`;
  root.append(why.panel);
  const act = panel('What to do', 'The smallest useful next step.');
  act.body.innerHTML = `<p style="margin:0">${esc(r.action || '')}</p>`;
  root.append(act.panel);
  if (view && r.entity_id) {
    root.append(note(`Open the ${esc(r.entity_type)} to see everything else known about it — this finding `
      + 'is one reading, and the page beside it is the rest of them.'));
  }
  if (rows.length > 1) {
    const more = panel('The same rule elsewhere', `${rows.length - 1} other open finding(s) from this rule.`);
    more.body.append(tableFrom(rows.slice(1), [
      { label: 'About', key: 'entity_id',
        render: (x) => (ENTITY_VIEW[x.entity_type]
          ? entity(ENTITY_VIEW[x.entity_type], x.entity_id, x.entity_id) : esc(x.entity_id || '—')) },
      { label: 'Finding', key: 'title' },
      { label: 'Computed', key: 'computed_at', render: (x) => dtStr(x.computed_at) },
    ]));
    root.append(more.panel);
  }
  return { title: r.title };
};
/* A day is a page. It was a modal titled "Trips on 14 August" that contained a
   driver leaderboard, and could not be linked to. */
/* Occupancy segments. `#segments/<kind>/<value>` where kind is one of
   verdict|plate|day|driver, and `#segment/<plate>/<started_at>` for one
   interval. These replaced four separate modals that opened the same body. */
V.segments = async (root) => {
  const KINDS = ['verdict', 'plate', 'day', 'driver'];
  const kind = KINDS.includes(state.param) ? state.param : null;
  await renderSegments(root, kind, kind ? state.sub : null);
};
V.segment = async (root) => renderSegment(root, state.param, state.sub);

/* The two pages an operations lead opens on the first of the month: what is
   coming, and what to do about it. */
V.playbook = async (root) => renderPlaybook(root);
V.forecast = async (root) => renderForecast(root);
V.retention = async (root) => renderRetention(root);
V.capacity = async (root) => renderCapacity(root);
V.revenue = async (root) => renderRevenue(root);

/* One weekday-hour cell of the demand heatmap: `#slot/<dow>/<hour>`. */
V.slot = async (root) => {
  const dow = Number(state.param), hour = Number(state.sub);
  if (!Number.isInteger(dow) || dow < 0 || dow > 6 || !Number.isInteger(hour) || hour < 0 || hour > 23) {
    return empty(root, 'A slot address is #slot/<weekday 0-6>/<hour 0-23>.');
  }
  await renderSlot(root, dow, hour);
};

V.day = async (root) => {
  let detail = null;
  await renderDay(root, state.param, (d) => { detail = d; });
  return detail;
};
V.providers = async (root) => renderProviders(root);
V.roster = async (root) => renderRoster(root);
V.analyst = async (root) => renderAnalyst(root);

V.vehicles = async (root) => {
  // The directory is the way into the per-vehicle pages; the panel below it is
  // the only question that is about the fleet rather than about one asset.
  await renderVehicleDirectory(root);
  const spread = panel('Fleet spread', 'How trips distribute across the fleet — a long tail here means assets carrying no load');
  root.append(spread.panel); loading(spread.body);
  const tierP = panel('Which assets serve which tier',
    'Uber Black and Comfort earn several times what UberX does per trip, so tier is an allocation decision. This is which cars are actually taking that work.');
  root.append(tierP.panel); loading(tierP.body);

  const [vehPage, byTier] = await Promise.all([q('/api/vehicles'), q('/api/product/by-vehicle').catch(() => [])]);
  // {rows, total, shown, truncated} — it used to be a bare array of the busiest
  // 200, which on a larger fleet reads as the whole of it.
  const rows = vehPage.rows || (Array.isArray(vehPage) ? vehPage : []);
  hbars(spread.body, rows.slice(0, 14).map((r) => ({ label: r.plate, n: r.trips })), { seq: true,
    onClick: (d) => { location.hash = href('vehicle', d.label); } });
  spread.body.append(el('p', 'cap', vehPage.total > 14
    ? `The 14 busiest of ${fmt(vehPage.total)} vehicles with a trip in this range. `
      + 'Every one of them is on the vehicle directory.'
    : 'Every vehicle with a trip in this range.'));

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
      // Custody comes back on every row for the plate; keep the first.
      if (!cur.driver_refs) { cur.driver_refs = r.driver_refs; cur.driver_n = r.driver_n; }
      byPlate.set(r.plate, cur);
    }
    /* The concentration sentence is computed over ALL vehicles; the slice is
       for the table only. Computing it over the visible 30 made both the count
       and the share wrong, and wrong in the direction that makes the fleet look
       more concentrated than it is — which is that sentence's whole point. */
    const allPlates = [...byPlate.values()].sort((a, b) => b.total - a.total);
    const pivot = allPlates.slice(0, 30);
    tierP.body.append(tableFrom(pivot, [
      { label: 'Plate', key: 'plate', render: (r) => entity('vehicle', r.plate, r.plate) },
      { label: 'Driven by', key: 'driver_refs', render: (r) => custody(r)
        + (r.driver_n > (r.driver_refs || []).length
          ? ` <span class="dim">+${fmt(r.driver_n - (r.driver_refs || []).length)}</span>` : '') },
      ...tiers.map((t) => ({ label: t, key: t, num: true,
        render: (r) => (r[t] ? `${fmt(r[t])}<span class="dim"> · ${Math.round((r[t] / r.total) * 100)}%</span>` : '—') })),
      { label: 'Total', key: 'total', num: true, render: (r) => fmt(r.total) },
    ]));
    if (allPlates.length > pivot.length) {
      tierP.body.append(el('p', 'cap',
        `Showing the ${fmt(pivot.length)} busiest of ${fmt(allPlates.length)} vehicles.`));
    }
    // Concentration is the actionable part: a premium tier served by two cars
    // is a single point of failure for the fleet's best-earning work.
    const premium = tiers.find((t) => /black|lux|premier|comfort/i.test(t));
    if (premium) {
      const serving = allPlates.filter((r) => r[premium]).sort((a, b) => (b[premium] || 0) - (a[premium] || 0));
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

/* Platforms — three pages, because "which channel" and "which product on that
   channel" and "how much demand we turned away" are three different questions
   and only the first was being asked. */
const PLATFORM_TABS = [
  { id: 'share', label: 'Share', ic: '◨' },
  { id: 'tiers', label: 'Product tiers', ic: '◆' },
  { id: 'funnel', label: 'Acceptance funnel', ic: '⌁' },
];
V.platforms = async (root) => {
  const tab = PLATFORM_TABS.some((t) => t.id === state.param) ? state.param : 'share';
  root.append(tabBar(PLATFORM_TABS, tab, (id) => href('platforms', id === 'share' ? null : id)));
  const host = el('div'); root.append(host);
  if (tab === 'tiers') return platformTiers(host);
  if (tab === 'funnel') return platformFunnel(host);
  return platformShare(host);
};

async function platformShare(root) {
  const g = el('div', 'grid g2'); root.append(g);
  const share = panel('Trips by platform', 'Share of total volume'); g.append(share.panel);
  const fleetMix = panel('Trips by fleet', 'Ecosine vs Egari'); g.append(fleetMix.panel);
  const cov = panel('Coverage & history depth', 'What each source has actually delivered'); root.append(cov.panel);
  [share.body, fleetMix.body, cov.body].forEach(loading);
  const [byPlat, byFleet, plats] = await Promise.all([q('/api/mix', { by: 'platform' }), q('/api/mix', { by: 'fleet' }), api('/api/platforms')]);
  /* Clicking a slice used to open a modal listing that platform's drivers. It
     now sets the platform filter and goes to the driver directory — the same
     answer, on a page with the search box, the compliance columns and an
     address that carries the filter with it. */
  donut(share.body, byPlat, { onClick: (d) => setFilter({ platform: d.label, view: 'drivers', param: null, sub: null }) });
  share.body.append(el('p', 'cap', 'Click a slice to filter the whole dashboard to that platform and open its drivers.'));
  donut(fleetMix.body, byFleet);
  cov.body.innerHTML = '';
  cov.body.append(tableFrom(plats, [
    { label: 'Platform', key: 'platform' }, { label: 'Fleet', key: 'fleet_id' },
    { label: 'Trips', key: 'trips', num: true },
    { label: 'Earliest', key: 'earliest', render: (r) => r.earliest ? String(r.earliest).slice(0, 10) : '—' },
    { label: 'Latest', key: 'latest', render: (r) => r.latest ? String(r.latest).slice(0, 10) : '—' },
  ]));
  cov.body.append(note('A source that stopped mid-window still shows its full trip count here. '
    + 'Collection gaps shows which days it actually collected.'));
}

/* Uber's consumer tier is this fleet's limousine product mix. The export
   carries no fare, so this page deliberately holds no money: a tier table with
   invented revenue would be worse than no tier table. */
async function platformTiers(root) {
  loading(root);
  const [t, mix] = await Promise.all([q('/api/tiers/by-vehicle'), q('/api/tiers/mix', { by: 'daypart' })]);
  root.innerHTML = '';
  if (!t.vehicles.length) return empty(root, 'No Uber trip with a vehicle in this range');
  const under = t.vehicles.filter((v) => v.premium_gap_pct != null)
    .sort((a, b) => b.premium_gap_pct - a.premium_gap_pct);
  root.append(kpiRow([
    { label: 'Premium share', value: pct(t.fleet_premium_pct, 1), sub: 'Black and Comfort, fleet-wide' },
    { label: 'Vehicles carrying Uber work', value: fmt(t.vehicles.length) },
    { label: 'Below what their own model achieves', value: fmt(under.length),
      sub: 'same make and model, 20+ trips', tone: under.length ? 'warn' : 'good' },
    { label: 'Largest shortfall', value: under.length ? pct(under[0].premium_gap_pct, 1) : '—',
      sub: under.length ? `${under[0].plate} · ${under[0].model_key}` : null },
  ]));
  const g = el('div', 'grid g2'); root.append(g);
  const tp = panel('Tier by time of day', 'Where the premium work actually sits in the day');
  const rollup = new Map();
  mix.forEach((r) => {
    const c = rollup.get(r.tier) || { label: r.tier, n: 0 };
    c.n += r.n; rollup.set(r.tier, c);
  });
  donut(tp.body, [...rollup.values()]);
  tp.body.append(el('p', 'cap', mix.length
    ? `Busiest daypart for premium work: ${(() => {
      const best = {};
      mix.filter((r) => ['Black', 'Comfort'].includes(r.tier)).forEach((r) => { best[r.label] = (best[r.label] || 0) + r.n; });
      const top = Object.entries(best).sort((a, b) => b[1] - a[1])[0];
      return top ? `${top[0]} (${fmt(top[1])} trips)` : '—';
    })()}` : ''));
  g.append(tp.panel);
  const gp = panel('Cars doing less premium work than their twins',
    'Compared against the best premium share achieved by the same make and model, not against the fleet average.');
  if (under.length) {
    hbars(gp.body, under.slice(0, 12).map((v) => ({ label: `${v.plate} · ${v.model_key}`, n: v.premium_gap_pct })),
      { valueFmt: (v) => `${fmt(v, 1)} pts`, onClick: (d) => { location.hash = href('vehicle', String(d.label).split(' · ')[0]); } });
  } else empty(gp.body, 'Every car is carrying as much premium work as its model does elsewhere');
  g.append(gp.panel);

  root.append(tableFrom(t.vehicles, [
    { label: 'Vehicle', key: 'plate', render: (r) => entity('vehicle', r.plate, r.plate) },
    /* Who ran the car over this window. A shortfall against the same model
       elsewhere is a finding about how the car is being dispatched and driven,
       and until this column existed the row named only the asset — so acting
       on it meant opening the vehicle page to work out who to talk to. */
    { label: 'Driven by', key: 'driver_refs', render: (r) => custody(r)
      + (r.driver_n > (r.driver_refs || []).length
        ? ` <span class="dim">+${fmt(r.driver_n - (r.driver_refs || []).length)} more</span>` : '') },
    { label: 'Model', key: 'model_key', render: (r) => esc([r.year, r.make, r.model].filter(Boolean).join(' ') || '—') },
    { label: 'Trips', key: 'trips', num: true },
    { label: 'Black', key: 'black', num: true },
    { label: 'Comfort', key: 'comfort', num: true },
    { label: 'Electric', key: 'electric', num: true },
    { label: 'UberX', key: 'uberx', num: true },
    { label: 'Premium', key: 'premium_pct', num: true, render: (r) => pct(r.premium_pct, 1) },
    { label: 'Same model achieves', key: 'model_best_pct', num: true, render: (r) => pct(r.model_best_pct, 1) },
    { label: 'Shortfall', key: 'premium_gap_pct', num: true,
      render: (r) => (r.premium_gap_pct == null ? '—' : `<b class="warn-t">${pct(r.premium_gap_pct, 1)}</b>`) },
    { label: 'Km', key: 'km', num: true, render: (r) => fmt(r.km) },
    { label: 'Avg km', key: 'avg_km', num: true, render: (r) => fmt(r.avg_km, 1) },
  ]));
  root.append(note('No revenue column here is deliberate. The Uber trip export has no fare field at '
    + 'all, so a per-tier revenue figure would have to be invented — and the mix itself is the lever: '
    + 'the same car, the same hour, a different tier.'));
}

/* Yango and Bolt report what a trip table cannot: how many jobs were offered
   and who turned them down. It is the only place lost demand is visible. */
async function platformFunnel(root) {
  loading(root);
  const rows = await q('/api/funnel/drivers');
  root.innerHTML = '';
  const live = rows.filter((r) => r.offered != null);
  if (!live.length) {
    root.append(note('No channel in this window reported an offer count. Only Yango and Bolt publish '
      + 'one, and they publish it per period rather than per trip — widen the range, or check that '
      + 'those collectors are running.'));
    return;
  }
  const sum = (k) => live.reduce((a, r) => a + (+r[k] || 0), 0);
  const offered = sum('offered'), accepted = sum('accepted'), completed = sum('completed');
  root.append(kpiRow([
    { label: 'Jobs offered', value: fmt(offered) },
    { label: 'Accepted', value: fmt(accepted), sub: offered ? pct((accepted / offered) * 100, 1) : null,
      tone: offered && accepted / offered < 0.7 ? 'warn' : null },
    { label: 'Completed', value: fmt(completed), sub: accepted ? pct((completed / accepted) * 100, 1) + ' of accepted' : null },
    { label: 'Lost before it started', value: fmt(offered - accepted),
      sub: 'offered and not accepted', tone: offered - accepted > 0 ? 'warn' : null },
    { label: 'Platform commission', value: money(sum('commission_cost')),
      sub: 'what the channel kept' },
  ]));
  root.append(tableFrom(live, [
    { label: 'Driver', key: 'driver_name', render: (r) => entity('driver', r.driver_ext_id, r.driver_name) },
    { label: 'Channel', key: 'platform' },
    { label: 'Period', key: 'period_start', render: (r) => `${dayStr(r.period_start)} → ${dayStr(r.period_end)}` },
    { label: 'Offered', key: 'offered', num: true, render: (r) => fmt(r.offered) },
    { label: 'Accepted', key: 'accepted', num: true, render: (r) => fmt(r.accepted) },
    { label: 'Accept %', key: 'accept_pct', num: true, render: (r) => pct(r.accept_pct, 1) },
    { label: 'Completed', key: 'completed', num: true, render: (r) => fmt(r.completed) },
    { label: 'Complete %', key: 'complete_pct', num: true, render: (r) => pct(r.complete_pct, 1) },
    { label: 'They cancelled', key: 'cancelled_driver', num: true, render: (r) => fmt(r.cancelled_driver) },
    { label: 'Rider cancelled', key: 'cancelled_client', num: true, render: (r) => fmt(r.cancelled_client) },
    { label: 'Hours', key: 'hours', num: true, render: (r) => fmt(r.hours, 1) },
    { label: 'Gross', key: 'gross', num: true, render: (r) => money(r.gross) },
    { label: 'Cash share', key: 'cash_pct', num: true, render: (r) => pct(r.cash_pct, 0) },
    { label: 'Commission', key: 'commission_cost', num: true, render: (r) => money(r.commission_cost) },
    { label: 'State', key: 'state', render: (r) => (r.state ? pill(r.state, r.state === 'active' ? 'ok' : 'warn') : '—') },
  ]));
  root.append(note('These counts come from each channel’s own driver report, not from our trip table, '
    + 'and they are per reporting period rather than per day — so they answer "is this driver turning '
    + 'work away", not "what happened on Tuesday".'));
}

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

  const [k, daily, payDetail, byProd, ledger, components, tipRows, bySvc] = await Promise.all([
    q('/api/kpis'), q('/api/trips/daily'), q('/api/mix/detail', { by: 'payment' }), q('/api/mix'),
    q('/api/finance/ledger'),
    q('/api/earnings/components').catch(() => []),
    q('/api/earnings/tips').catch(() => []),
    q('/api/mix', { by: 'service' }).catch(() => []),
  ]);

  /* Cash is three labels on this fleet — `cash` (Uber), `cash-driver` and
     `cash-supervisor` (hotel) — and /api/mix/detail returns them ordered by
     count, so `.find` always landed on the Uber one, whose revenue is null
     because that export has no fare column. The tile rendered "—" while the
     fleet was holding real money. Read from the settlement endpoint instead, so
     this and the Settlement page cannot disagree about what cash is. */
  const settle = await q('/api/settlement/mix').catch(() => ({ classes: [] }));
  const cash = (settle.classes || []).find((c) => c.settlement_class === 'cash');
  const tipTotal = tipRows.reduce((a, r) => a + (+r.tips || 0), 0);
  const fareTotal = tipRows.reduce((a, r) => a + (+r.fare || 0), 0);

  /* Every money figure here covers only the trips that carry a fare. The Uber
     trip export has no fare column at all and telematics trips have none
     either, so on this fleet that is roughly a fifth of the rows. Dividing by
     everything showed an average fare of AED 6.98 against a real figure near
     AED 125. Each tile now names the base it was computed over. */
  const coverage = k.priced_pct != null
    ? `${fmt(k.priced_trips)} of ${fmt(k.trips)} trips carry a fare (${pct(k.priced_pct, 1)})`
    : 'no priced trips in this range';

  const kpis = kpiRow([
    { label: 'Revenue', value: money(k.revenue), sub: coverage,
      tone: k.priced_pct != null && k.priced_pct < 40 ? 'warn' : null },
    { label: 'Average fare', value: money(k.avg_fare, 'AED', 2),
      sub: k.priced_trips ? `over ${fmt(k.priced_trips)} priced trips` : 'no fares in this range' },
    { label: 'Revenue per km', value: money(k.revenue_per_km, 'AED', 2),
      sub: k.priced_km ? `over ${fmt(k.priced_km)} priced km` : 'no priced distance' },
    { label: 'Cash collected by drivers',
      value: cash ? (cash.revenue == null ? 'not reported' : money(cash.revenue)) : money(0),
      sub: cash
        ? `${fmt(cash.trips)} cash bookings; ${fmt(cash.priced_trips)} of them report a fare`
        : 'no cash booking in this range',
      tone: cash && cash.priced_trips < cash.trips ? 'warn' : null },
    { label: 'Tips', value: tipTotal ? money(tipTotal) : '—',
      sub: fareTotal ? `${((tipTotal / fareTotal) * 100).toFixed(2)}% of net fare` : 'no tip data collected yet',
      tone: fareTotal ? (tipTotal / fareTotal >= 0.03 ? 'good' : 'warn') : null },
  ]);
  kh.replaceWith(kpis);

  // Say the coverage out loud once, under the tiles, so nobody reads the
  // revenue line as the fleet's whole income.
  if (k.priced_pct != null && k.priced_pct < 90) {
    kpis.after(note(
      `Money on this page covers ${pct(k.priced_pct, 1)} of trips — the other ${fmt(k.trips - k.priced_trips)} ` +
      `carry no fare at all. Uber's trip export omits fares and telematics trips have none, so revenue here is ` +
      `the hotel and Yango channels only. Trip counts cover everything; money does not.`));
  }

  areaChart(rev.body, daily, { x: 'd', y: 'revenue', color: '--s3', valueFmt: (v) => money(v) });
  paymentDonut(pay.body, payDetail);

  /* Tier economics: the count alone hides the point, which is that a tier can
     be a small share of trips and a large share of revenue, or the reverse. */
  tier.body.innerHTML = '';
  /* Per-trip revenue must divide by the PRICED trips, not by all of them. The
     API already returns `priced_n` and `revenue_per_trip` for exactly this, and
     the page was recomputing `revenue / n` instead — so a tier where 40 of
     4,000 trips carried a fare reported AED 0.30 per trip against a real
     AED 30, and the derived sentence claimed one tier earned 666x another. */
  const perTrip = (r) => (r.revenue_per_trip != null ? +r.revenue_per_trip
    : r.priced_n ? +r.revenue / r.priced_n : null);
  const withRev = byProd.filter((r) => perTrip(r) != null);
  if (!withRev.length) {
    tier.body.append(note('No fares attached to any product tier in this range. Uber\'s trip export names the tier but carries no fare column at all, so no Uber tier can appear here — this table fills from the hotel, Yango and Bolt channels.'));
    if (byProd.length) tier.body.append(tableFrom(byProd.slice(0, 10), [
      { label: 'Tier', key: 'label' }, { label: 'Trips', key: 'n', num: true, render: (r) => fmt(r.n) },
    ], { compact: true }));
  } else {
    const totalTrips = withRev.reduce((a, r) => a + r.n, 0);
    const totalRev = withRev.reduce((a, r) => a + (+r.revenue || 0), 0);
    tier.body.append(tableFrom(withRev.slice(0, 10), [
      { label: 'Tier', key: 'label' },
      { label: 'Trips', key: 'n', num: true, render: (r) => fmt(r.n) },
      { label: 'Priced', key: 'priced_n', num: true, render: (r) => `${fmt(r.priced_n)} of ${fmt(r.n)}` },
      { label: 'Revenue', key: 'revenue', num: true, render: (r) => money(r.revenue) },
      { label: 'Share of revenue', key: '_sr', num: true, render: (r) => pct(((+r.revenue || 0) / totalRev) * 100, 1) },
      { label: 'Per priced trip', key: '_pt', num: true, render: (r) => money(perTrip(r), 'AED', 2) },
    ], { compact: true }));
    /* Compare only within one platform. An Uber tier and a hotel booking type
       are not alternatives an operator can choose between, so a ratio across
       them is not a finding — it is a category error with a number attached. */
    const byPlatform = new Map();
    for (const r of withRev) {
      const list = byPlatform.get(r.platform) || [];
      list.push(r); byPlatform.set(r.platform, list);
    }
    const comparable = [...byPlatform.entries()].filter(([, list]) => list.length > 1)
      .sort((a, b) => b[1].length - a[1].length)[0];
    if (comparable) {
      const [platform, list] = comparable;
      const sorted = [...list].sort((a, b) => perTrip(b) - perTrip(a));
      const best = sorted[0], worst = sorted[sorted.length - 1];
      const ratio = perTrip(worst) > 0 ? perTrip(best) / perTrip(worst) : null;
      const strip = (l) => String(l).replace(/^[^:]+:\s*/, '');
      tier.body.append(el('p', 'cap',
        `On ${esc(platform)}, ${esc(strip(best.label))} earns ` +
        (ratio ? `${ratio.toFixed(1)}x per priced trip what ${esc(strip(worst.label))} does ` : 'more per priced trip ') +
        `(${money(perTrip(best), 'AED', 2)} vs ${money(perTrip(worst), 'AED', 2)}). ` +
        `Trip length differs between tiers, so compare per-kilometre before reallocating vehicles. ` +
        `Tiers are only compared within one platform — an Uber tier and a hotel booking type are not alternatives.`));
    } else {
      tier.body.append(el('p', 'cap',
        'Only one priced tier per platform in this range, so there is nothing to compare against.'));
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

/* Safety — three pages, because "which car" and "which person" and "what kind
   of event" are three different questions and the page answered only the first.

   Four things were wrong here and they compounded: the endpoint fetched a
   driver and the view rendered only the plate, so the safety page named nobody;
   the driver it fetched was whoever holds the car TODAY, so a year-old event
   was attributed to the current holder; the four category columns did not add
   up to the Total beside them, with no residual column to explain the gap; and
   a device power fault was charted as harsh driving. */
const SAFETY_TABS = [
  { id: 'people', label: 'By driver', ic: '◧' },
  { id: 'vehicles', label: 'By vehicle', ic: '▤' },
  { id: 'events', label: 'By event type', ic: '△' },
];
V.safety = async (root) => {
  const tab = SAFETY_TABS.some((t) => t.id === state.param) ? state.param : 'people';
  root.append(tabBar(SAFETY_TABS, tab, (id) => href('safety', id === 'people' ? null : id)));
  const host = el('div'); root.append(host);
  loading(host);
  const [byType, vehPage, drvPage] = await Promise.all([
    q('/api/alerts/summary'), q('/api/alerts/by-vehicle'), q('/api/alerts/by-driver')]);
  // Both now return {rows, totals}; the arrays are capped at 100 and the tiles
  // that used to be their lengths read as fleet facts.
  const byVeh = vehPage.rows || vehPage;
  const byDrv = drvPage.rows || drvPage;
  const vTot = vehPage.totals || {};
  const dTot = drvPage.totals || {};
  host.innerHTML = '';

  const total = byType.reduce((a, r) => a + r.n, 0);
  if (!total) {
    host.append(note('No harsh-driving event landed in this window. These come from the FMS '
      + 'telematics layer — check Collection gaps before reading that as good news.'));
    return;
  }
  /* A tracker losing power is a hardware fault, not a driving style. Charted
     together they were one number under a heading about harsh driving. */
  const DEVICE = /power|battery|tamper|disconnect|gps/i;
  const device = byType.filter((r) => DEVICE.test(r.alert_type));
  const driving = byType.filter((r) => !DEVICE.test(r.alert_type));
  const drivingN = driving.reduce((a, r) => a + r.n, 0);
  // Over the whole window, not over the returned rows.
  const unattributed = dTot.unattributed ?? byVeh.reduce((a, r) => a + (r.unattributed || 0), 0);

  host.append(kpiRow([
    { label: 'Driving events', value: fmt(drivingN), sub: 'harsh braking, acceleration, turns, speed' },
    { label: 'Device faults', value: fmt(total - drivingN),
      sub: 'power loss and similar — a tracker problem, not a driver one',
      tone: total - drivingN ? 'warn' : null },
    { label: 'Vehicles involved', value: fmt(vTot.vehicles ?? byVeh.length),
      sub: vehPage.truncated ? `${fmt(byVeh.length)} shown` : 'every one of them listed below' },
    { label: 'Drivers named', value: fmt(dTot.drivers
      ?? byDrv.filter((r) => r.driver_name !== '(unattributed)').length),
      sub: 'people custody could attribute an event to' },
    { label: 'Events nobody held the car for', value: fmt(unattributed),
      sub: unattributed ? 'no custody record for that plate on that day' : 'every event has a driver',
      tone: unattributed ? 'warn' : null },
  ]));

  if (tab === 'events') {
    const g = el('div', 'grid g2'); host.append(g);
    const dp = panel('Driving events', 'Behaviour the fleet can coach.');
    donut(dp.body, driving.map((r) => ({ label: r.alert_type, n: r.n })));
    g.append(dp.panel);
    const fp = panel('Device faults', 'A tracker losing power is a hardware ticket, not a coaching conversation.');
    if (device.length) donut(fp.body, device.map((r) => ({ label: r.alert_type, n: r.n })));
    else empty(fp.body, 'No device fault in this window');
    g.append(fp.panel);
    host.append(note('These were one donut, totalled as a single figure under a heading about harsh '
      + 'driving. They are two different problems with two different owners.'));
    return;
  }

  if (tab === 'vehicles') {
    const vp = panel('Worst vehicles', 'Click a bar to open that vehicle.');
    hbars(vp.body, byVeh.slice(0, 12).map((r) => ({ label: r.plate, n: r.alerts })), {
      color: '--s8', onClick: (d) => { location.hash = href('vehicle', d.label, 'safety'); } });
    host.append(vp.panel);
    host.append(tableFrom(byVeh, [
      { label: 'Vehicle', key: 'plate', render: (r) => entity('vehicle', r.plate, r.plate) },
      { label: 'Total', key: 'alerts', num: true },
      { label: 'Harsh brake', key: 'harsh_brake', num: true },
      { label: 'Harsh accel', key: 'harsh_accel', num: true },
      { label: 'Sharp turn', key: 'sharp_turn', num: true },
      { label: 'Overspeed', key: 'overspeed', num: true },
      // The residual, so the columns and the total reconcile instead of
      // silently disagreeing by however many event types are not in the four.
      { label: 'Other', key: 'other', num: true },
      { label: 'Drivers that window', key: 'drivers', num: true },
      { label: 'Most often', key: 'top_driver',
        render: (r) => (r.top_driver ? entity('driver', r.top_driver_id, r.top_driver)
          : '<span class="ent-off">unattributed</span>') },
    ]));
    host.append(note('Each event is attributed to whoever held the car ON THE DAY it happened, not to '
      + 'whoever holds it now — and vehicle_driver_day carries one row per platform, so custody is '
      + 'collapsed to one driver per plate-day before counting. Joining it directly once showed 584 '
      + 'events twice under two spellings of one name.'));
    return;
  }

  // people
  const named = byDrv.filter((r) => r.driver_name !== '(unattributed)');
  const dp = panel('Who drives hardest', 'Events per 100 km of booked distance, where that distance is known.');
  const rated = named.filter((r) => r.per_100km != null).slice(0, 12);
  if (rated.length) {
    hbars(dp.body, rated.map((r) => ({ label: r.driver_name, n: Number(r.per_100km), id: r.driver_ext_id })), {
      color: '--s8', valueFmt: (v) => `${fmt(v, 2)} / 100km`,
      onClick: (d) => { if (d.id) location.hash = href('driver', d.id, 'quality'); } });
    dp.body.append(el('p', 'cap', 'The rate is over BOOKED kilometres. Dividing by every trip in the '
      + 'table would include each journey twice — once as a booking and once as its telematics twin.'));
  } else {
    empty(dp.body, 'No driver in this window has both events and a known distance');
  }
  host.append(dp.panel);
  host.append(tableFrom(byDrv, [
    { label: 'Driver', key: 'driver_name',
      render: (r) => (r.driver_ext_id ? entity('driver', r.driver_ext_id, r.driver_name)
        : `<span class="ent-off">${esc(r.driver_name)}</span>`) },
    { label: 'Events', key: 'alerts', num: true },
    { label: 'Harsh brake', key: 'harsh_brake', num: true },
    { label: 'Harsh accel', key: 'harsh_accel', num: true },
    { label: 'Sharp turn', key: 'sharp_turn', num: true },
    { label: 'Overspeed', key: 'overspeed', num: true },
    /* Which cars, not just how many. "18 events across 4 vehicles" is not
       something anybody can look into until they know which 4, and a count is
       not a thing you can click. */
    { label: 'Vehicles', key: 'plate_list', render: (r) => {
      const list = r.plate_list || [];
      if (!list.length) return `<span class="dim">${fmt(r.plates)}</span>`;
      return list.map((pl) => entity('vehicle', pl, pl)).join(' ')
        + (r.plates > list.length ? ` <span class="dim">+${fmt(r.plates - list.length)}</span>` : '');
    } },
    { label: 'Booked km', key: 'booked_km', num: true, render: (r) => fmt(r.booked_km) },
    { label: 'Per 100 km', key: 'per_100km', num: true,
      render: (r) => (r.per_100km == null ? '<span class="ent-off">distance unknown</span>'
        : fmt(r.per_100km, 2)) },
  ]));
  if (byDrv.some((r) => r.driver_name === '(unattributed)')) {
    host.append(note('"(unattributed)" is not a person. It is every event on a plate-day with no '
      + 'custody record — shown rather than folded into somebody else\'s total.'));
  }
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
  // {rows, total, shown, truncated} — tolerant of the old bare array.
  const vehRows = byVeh.rows || (Array.isArray(byVeh) ? byVeh : []);
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

  /* Every click here used to open a modal. A flag against a named driver is
     the most serious claim this product makes, and it needs an address you can
     paste into a message — so each of these now navigates to a page. */
  barChart(trend.body, daily, { x: 'd', y: 'unauthorized', color: '--s8', label: 'unexplained',
    onClick: (d) => { location.hash = href('segments', 'day', dayKey(d.d)); } });
  trend.body.append(el('p', 'cap', 'Click a bar for that day’s segments; the day’s full picture — every source, every platform — is on its own page.'));
  donut(verdicts.body, (sum.byVerdict || []).map((r) => ({ label: r.verdict, n: r.n })),
    { onClick: (d) => { location.hash = href('segments', 'verdict', d.label); } });

  veh.body.innerHTML = '';
  // Show who was driving, not just which plate — a flag against a car nobody can
  // name is not something anyone can act on.
  if (vehRows.length) {
    hbars(veh.body, vehRows.slice(0, 12).map((r) => ({
      label: r.drivers ? `${r.plate} · ${r.drivers}` : `${r.plate} · driver unknown`,
      plate: r.plate, n: r.unauthorized })), { color: '--s8',
      onClick: (d) => { location.hash = href('segments', 'plate', d.plate || d.label); } });
    veh.body.append(el('p', 'cap', byVeh.total > 12
      ? `The 12 worst of ${fmt(byVeh.total)} vehicles with an unexplained trip in this range.`
      : 'Every vehicle with an unexplained trip in this range.'));
  } else empty(veh.body, 'No unexplained trips detected in this range');

  /* The evidence table lives in segments.js now. This page and that one were
     two implementations of the same table and had drifted: this one printed a
     hardcoded English sentence keyed on the verdict, with no entry for
     `unverifiable` or `pending`, so eight of fifty-two segments opened a blank
     "Why this verdict". Every row is a link to that segment's own page. */
  list.body.innerHTML = ''; list.body.append(segmentTable(rows));

  health.body.innerHTML = '';
  const flagged = sensors.map((s2) => ({ ...s2,
    ratio: s2.total_fixes ? (s2.occupied_fixes / s2.total_fixes * 100).toFixed(1) : '0',
    verdict: s2.occupied_fixes === 0 ? 'never triggers' : (s2.sensor_suspect_segments > 0 ? 'suspect' : 'ok') }));
  health.body.append(tableFrom(flagged.slice(0, 20), [
    { label: 'Plate', key: 'plate', render: (r) => entity('vehicle', r.plate, r.plate) },
    { label: 'Occupied fixes', key: 'occupied_fixes', num: true },
    { label: 'Total fixes', key: 'total_fixes', num: true },
    { label: 'Occupied %', key: 'ratio', num: true, render: (r) => r.ratio + '%' },
    { label: 'Sensor', key: 'verdict', render: (r) => `<span class="tag ${r.verdict === 'ok' ? 'ok' : r.verdict === 'suspect' ? 'warn' : 'bad'}">${esc(r.verdict)}</span>` },
  ]));
};

V.live = async (root) => {
  const kh = el('div', 'kpis'); root.append(kh);
  const p = panel('Live vehicles', 'CABMAN refreshes every 5 minutes · click a row for that vehicle’s movement page'); root.append(p.panel);
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
    // A plate that is only text is a dead end on the one page an operator has
    // open all day. Every vehicle here has a page.
    { label: 'Plate', key: 'plate', render: (r) => entity('vehicle', r.plate, r.plate) },
    { label: 'Fleet', key: 'fleet_id' },
    { label: 'Status', key: 'status', render: (r) => `<span class="tag ${/engag/i.test(r.status || '') ? 'ok' : 'dim'}">${esc(r.status || '—')}</span>` },
    { label: 'Speed', key: 'speed', num: true, render: (r) => r.speed != null ? fmt(r.speed) + ' km/h' : '—' },
    { label: 'Seat', key: 'seat_occupied', /* Three states, not two. Only the CABMAN feed carries a seat sensor; FMS and
   Uber carry none, so collapsing NULL into "empty" asserted a measurement that
   does not exist for 83 of 130 vehicles. */
      render: (r) => (r.seat_occupied === null || r.seat_occupied === undefined
        ? '<span class="tag dim">not reported</span>'
        : r.seat_occupied ? '<span class="tag ok">occupied</span>' : '<span class="tag">empty</span>') },
    { label: 'Fix age', key: 'polled_at', render: (r) => `<span class="tag ${r.stale ? 'warn' : 'ok'}">${r.stale ? 'stale' : 'live'}</span>` },
    { label: 'Last fix', key: 'captured_at', render: (r) => timeStr(r.captured_at) },
  ]);
  /* The breadcrumb used to be a modal titled after the plate. It is now the
     vehicle's own Movement tab, which has the map, the parked clusters and the
     replayable days the modal never had — and an address you can send. */
  t.querySelectorAll('tbody tr').forEach((tr, i) => { tr.style.cursor = 'pointer';
    tr.onclick = (e) => {
      if (e.target.closest('a')) return;
      location.hash = href('vehicle', rows[i].plate, 'movement');
    };
  });
  p.body.append(t);
  p.body.append(el('p', 'cap',
    'Click a row for that vehicle’s movement page — the map, the replayable days and every stationary cluster.'));
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
  // Assigned once the day list exists, below; the live-map click handler is
  // defined before that and calls it through this binding.
  let refillDays = null;
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
    /* Set the plate BEFORE asking for the replay. `.click()` synchronously ran
       the replay handler, whose first statement reads the select — so it
       fetched whichever vehicle was previously chosen and drew that one's day
       under the plate you clicked. */
    layer = renderLive(map, withGps, (r) => {
      const sel = $('#mPlate');
      if (sel) {
        if (![...sel.options].some((o) => o.value === r.plate)) sel.append(new Option(r.plate, r.plate));
        sel.value = r.plate;
      }
      /* Refill the day list for the newly-chosen plate BEFORE replaying, or the
         replay reads a date that belongs to the previous vehicle — the same
         race the comment above already describes for the plate itself. */
      refillDays?.();
      showReplay(r.plate);
    });
    if (!withGps.length) empty(stat, 'No GPS fixes stored yet — CABMAN populates this every 5 minutes');
  };

  /* `plate` is passed explicitly rather than re-read from the DOM, so a caller
     that has just set it cannot race the read. */
  const showReplay = async (plateArg) => {
    const plate = plateArg || $('#mPlate').value, day = $('#mDayList')?.value;
    if (!day) { clear(); return empty(stat, `No stored trail for ${esc(plate || 'this vehicle')} — the replay list is built from days that have fixes.`); }
    if (!plate || !day) return;
    clear();
    const j = await api(`/api/map/journey?plate=${encodeURIComponent(plate)}&day=${day}`);
    stat.innerHTML = [
      ['Fixes', fmt(j.fixes), `on ${day}`],
      ['Distance', fmt(j.distance_km) + ' km', 'between fixes'],
      /* Null, not zero, when this vehicle's feed never reports occupancy. FMS
         carries no seat sensor, so every FMS-tracked plate showed a hard
         "0 km · 0% of distance" — a positive claim that it drove empty all day,
         on days it ran fifteen bookings. */
      j.occupancy_reported
        ? ['With passenger', fmt(j.occupied_km) + ' km',
          j.occupancy_measured_km ? Math.round(j.occupied_km / j.occupancy_measured_km * 100) + '% of measured distance' : '—']
        : ['With passenger', 'not measured', 'this vehicle\'s feed carries no seat sensor'],
      /* The name is a link. This tile named the person who drove the route on
         screen and led nowhere, on the page most likely to raise a question
         about them. */
      ['Driver', j.driver ? entity('driver', j.driver_id, j.driver) : '—',
        j.driver_trips != null ? j.driver_trips + ' trips that day' : 'from the trip record'],
    ].map(([l, n, d]) => `<div class="kpi"><div class="l">${l}</div><div class="n num">${n}</div><div class="d">${esc(d)}</div></div>`).join('');
    legend.innerHTML = (j.occupancy_reported
      ? [['--s3', 'Passenger aboard'], ['--s1', 'Running empty (dashed)']]
      : [['--ink-3', 'Occupancy not reported by this feed']])
      .map(([c, t]) => `<span><i class="sw" style="background:var(${c})"></i>${t}</span>`).join('')
      + '<span class="dim">Lines join consecutive 5-minute fixes; a gap over 20 minutes breaks the line '
      + 'rather than guessing the route.</span>';
    if (!j.fixes) { empty(stat, `No GPS fixes stored for ${plate} on ${day}`); return; }
    layer = renderJourney(map, j);
  };

  /* Populate the replay pickers from days that actually have a trail.
     A free date input let you pick any day at all, most of which have no fixes,
     so the commonest outcome of using this control was an empty map and no
     explanation. The day list is now per-plate and names who held the car that
     day — which is only correct because /api/map/days stopped joining
     vehicle_current_driver, a view whose whole definition is "whoever has it
     NOW", and started joining custody on the day itself. */
  const days = await api('/api/map/days').catch(() => []);
  const byPlate = new Map();
  days.forEach((d) => {
    const k = d.plate; if (!byPlate.has(k)) byPlate.set(k, []);
    byPlate.get(k).push({ ...d, day: String(d.day).slice(0, 10) });
  });
  const plates = [...byPlate.keys()].sort();
  $('#mPlate').innerHTML = plates.map((p) => `<option>${esc(p)}</option>`).join('')
    || '<option value="">no trails yet</option>';

  const dayList = el('select', 'btn'); dayList.id = 'mDayList';
  const dayNote = el('span', 'cap'); dayNote.id = 'mDayNote';
  $('#mDay').replaceWith(dayList);
  dayList.after(dayNote);
  const fillDays = () => {
    const rows = byPlate.get($('#mPlate').value) || [];
    dayList.innerHTML = rows.map((r) => {
      const who = r.driver_name ? ` · ${r.driver_name}` : '';
      return `<option value="${esc(r.day)}">${esc(dayStr(r.day))} · ${r.fixes} fixes${esc(who)}</option>`;
    }).join('') || '<option value="">no stored days for this vehicle</option>';
    const cur = rows[0]?.current_driver_name;
    dayNote.textContent = rows.length
      ? `${rows.length} replayable day(s)` + (cur ? ` · held today by ${cur}` : '')
      : 'This vehicle has no stored trail.';
  };
  refillDays = fillDays;
  fillDays();
  $('#mPlate').addEventListener('change', fillDays);

  $('#mLive').onclick = () => {
    $('#mLive').classList.add('primary'); $('#mReplay').classList.remove('primary');
    $('#mReplayCtl').style.display = 'none'; showLive();
  };
  $('#mReplay').onclick = () => {
    $('#mReplay').classList.add('primary'); $('#mLive').classList.remove('primary');
    $('#mReplayCtl').style.display = 'flex'; showReplay();
  };
  $('#mGo').onclick = () => showReplay();
  $('#mPlate').addEventListener('change', () => showReplay());
  dayList.onchange = () => showReplay();

  await showLive();
};


/* The action list. Everything here is something a person could do today, ordered by
   what it costs to leave alone. Severity is a claim, so each row shows the evidence
   that produced it — a dashboard that asserts without showing its working gets
   ignored the first time it is wrong. */
V.insights = async (root) => {
  const kh = el('div', 'kpis'); root.append(kh); loading(kh);

  const [sum, page] = await Promise.all([
    api('/api/insights/summary').catch(() => null),
    api('/api/insights').catch(() => ({ insights: [] })),
  ]);
  const all = page.insights || [];

  const bySev = Object.fromEntries((sum?.by_severity || []).map((r) => [r.severity, r.n]));
  /* A modelled figure and a measured one do not belong in one total. The old
     "Quantified cost" tile summed impact_aed across the whole table, and the
     only rule that sets it sets a constant — fourteen days at an assumed AED
     120 — so the headline was (number of runs) x (idle vehicles) x 1,680. It
     read AED 1,424,592. */
  const measured = Number(sum?.total?.measured_impact || 0);
  const modelled = sum?.modelled || {};
  kh.innerHTML = [
    ['Open actions', fmt(sum?.total?.n ?? all.length),
      sum?.duplicates_suppressed ? `${fmt(sum.duplicates_suppressed)} duplicate rows suppressed` : 'across every source'],
    ['Critical', fmt(bySev.critical || 0), 'act today', bySev.critical ? 'err' : 'ok'],
    ['Warnings', fmt(bySev.warning || 0), 'act this week', bySev.warning ? 'warn' : 'ok'],
    ['Measured cost', measured ? 'AED ' + fmt(Math.round(measured)) : '—',
      'only findings that carry a real figure'],
    ['Idle capital, modelled', modelled.aed ? 'AED ' + fmt(Math.round(modelled.aed)) : '—',
      modelled.assumption || 'an assumption, not a measurement', 'warn'],
  ].map(([l, n, d, cls]) => `<div class="kpi ${cls || ''}"><div class="l">${l}</div><div class="n num">${n}</div><div class="d">${esc(d)}</div></div>`).join('');

  if (!all.length) {
    const p0 = panel('Nothing to action', 'The engine runs after each collection'); root.append(p0.panel);
    empty(p0.body, 'No findings yet — either the fleet is clean, or the collectors have not completed a cycle.');
    return;
  }

  /* Category chips from the SUMMARY, not from the page. Built from the visible
     rows they offered exactly two buttons — "All (200)" and one category —
     because 200 duplicates of a single rule had consumed every slot, and the
     operator had no way to know the other categories existed. */
  const catCounts = Object.fromEntries((sum?.by_category || []).map((r) => [r.category, r.n]));
  const cats = Object.keys(catCounts).length
    ? Object.keys(catCounts).sort()
    : [...new Set(all.map((r) => r.category))].sort();
  const bar = el('div', 'panel');
  bar.innerHTML = `<div class="btnrow"><button class="btn primary" data-cat="">All (${fmt(sum?.total?.n ?? all.length)})</button>`
    + cats.map((c) => `<button class="btn" data-cat="${esc(c)}">${esc(c)} (${fmt(catCounts[c] ?? all.filter((r) => r.category === c).length)})</button>`).join('')
    + '</div>';
  root.append(bar);
  if (page.truncated) {
    root.append(note(`Showing the first ${fmt(page.limit)} of ${fmt(sum?.total?.n ?? '?')} findings, `
      + 'most severe first. Use a category above to narrow it rather than scrolling.'));
  }

  const listPanel = panel('Ranked actions', 'Most consequential first — click any row for the evidence behind it');
  root.append(listPanel.panel);

  const SEV = { critical: 'err', warning: 'warn', info: 'info', good: 'ok' };
  // A finding names an entity; the entity has a page. Every row leads there.
  const ENTITY_VIEW = { vehicle: 'vehicle', driver: 'driver', partner: 'property' };

  const draw = async (cat) => {
    loading(listPanel.body);
    /* Refetched per category rather than filtered client-side: the page holds
       at most 200 rows, so filtering them locally showed a category's first few
       findings and called it the category. */
    let rows = all;
    if (cat) {
      try { rows = (await api(`/api/insights?category=${encodeURIComponent(cat)}`)).insights || []; }
      catch { rows = all.filter((r) => r.category === cat); }
    }
    listPanel.body.innerHTML = '';
    if (!rows.length) return empty(listPanel.body, 'Nothing in this category');
    const list = el('div', 'hbars');
    rows.forEach((r) => {
      const view = ENTITY_VIEW[r.entity_type];
      const item = el('a', 'insight-row');
      // An address, so the evidence for one finding can be sent to somebody.
      item.href = href('action', r.code, r.entity_id || '-');
      item.innerHTML = `
        <div class="insight-sev"><span class="tag ${SEV[r.severity] || ''}">${esc(r.severity)}</span></div>
        <div class="insight-main">
          <div class="insight-title">${esc(r.title)}</div>
          <div class="insight-action">${esc(r.action || '')}</div>
        </div>
        <div class="insight-meta">
          ${view && r.entity_id ? `<span class="tag">${esc(r.entity_type)} ${esc(r.entity_id).slice(0, 14)}</span>` : `<span class="tag">${esc(r.category)}</span>`}
          ${r.impact_aed ? `<span class="num" style="color:var(--critical);font-weight:600">AED ${fmt(Math.round(r.impact_aed))}</span>` : ''}
        </div>`;
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
  /* The endpoint returns {rows, shown, history} now — it used to return a bare
     array of the most recent thirty rows across all platforms, and the sentence
     below counted over that cap. Tolerant of both shapes so a stale cached
     bundle does not blank the panel. */
  const recRes = await api('/api/recommendations').catch(() => ({ rows: [] }));
  const recs = Array.isArray(recRes) ? recRes : (recRes.rows || []);
  rec.body.innerHTML = '';
  if (!recs.length) {
    rec.body.append(note('No platform recommendations collected. Uber publishes these per org; they appear once the fleet-portal collector has run against an account that can see them.'));
  } else {
    rec.body.append(tableFrom(recs, [
      { label: 'Platform', key: 'platform' },
      { label: 'Target', key: 'rec_type', render: (r) => esc(String(r.rec_type || '').replace(/_/g, ' ')) },
      { label: 'Period', key: '_p', render: (r) => (r.period_start
        ? `${dayStr(r.period_start)} → ${dayStr(r.period_end)}` : 'current') },
      { label: 'Fleet is at', key: 'org_value', num: true, render: (r) => pctOf(r.org_value) },
      { label: 'Target', key: 'target_value', num: true, render: (r) => pctOf(r.target_value) },
      /* `flagged` is a JSON ARRAY of the drivers Uber named. `r.flagged ? …`
         is therefore true for every row, including an empty array — so every
         target was marked "below target", including the ones being met. The
         comparison has to be between the two numbers. */
      { label: 'Meeting it', key: 'm', render: (r) => {
        const behind = missingTarget(r);
        return behind == null ? pill('no target published', '')
          : behind ? pill('below target', 'bad') : pill('on target', 'ok');
      } },
      { label: 'Drivers named', key: 'flagged_count', num: true,
        render: (r) => (r.flagged_count != null ? fmt(r.flagged_count) : '—') },
    ]));
    const behind = recs.filter((r) => missingTarget(r) === true);
    // One row per platform and target type — the live one — so this count is
    // over the whole population rather than over a page of it.
    rec.body.append(el('p', 'cap', behind.length
      ? `${behind.length} of ${recs.length} current targets are not being met. Each names the drivers behind it — `
        + `open a driver's Quality page to see their own acceptance and cancellation figures.`
      : `All ${recs.length} current targets are being met.`));
  }
};

/* Compliance is the one place where the data is unambiguous: a date, and a vehicle
   that is either legal or not. Sorted by urgency, not by plate. */
V.compliance = async (root) => {
  const kh = el('div', 'kpis'); root.append(kh); loading(kh);
  const [vehPage, drvPage] = await Promise.all([
    api('/api/compliance/vehicles').catch(() => ({ rows: [], totals: {} })),
    api('/api/compliance/drivers').catch(() => ({ drivers: [], totals: {} })),
  ]);
  const veh = vehPage.rows || [];
  const drv = drvPage.drivers || [];
  const dl = (r) => Number(r.days_left);
  /* Counted in the database, not by filtering the list on screen. Both lists
     are capped — 300 documents, 300 licences — and every tile on this page was
     a .filter().length over whichever rows arrived, under captions like
     "cannot legally work" and "stand down until renewed". They agree today
     because expired rows sort first; they stop agreeing the day the fleet
     crosses the cap, silently. */
  const vt = vehPage.totals || {};
  const vExpired = vt.expired ?? veh.filter((r) => dl(r) < 0).length;
  const vWeek = vt.within_7 ?? veh.filter((r) => dl(r) >= 0 && dl(r) <= 7).length;
  const vMonth = vt.within_45 ?? veh.filter((r) => dl(r) > 7 && dl(r) <= 45).length;
  /* A licence date shared by most of the roster is what this source writes when
     the field was never filled in. Counted as expiries it read "77 drivers must
     stand down" — while the insight engine, which runs the same check, was
     already refusing to accuse any of them. The two halves of the product
     disagreed about whether 77 people could legally drive. */
  const placeholder = drvPage.placeholder_date;
  const dt = drvPage.totals || {};
  const dExpired = dt.expired ?? drv.filter((r) => r.licence_expires
    && String(r.licence_expires).slice(0, 10) !== placeholder && dl(r) < 0).length;
  const dPlaceholder = drvPage.placeholder_rows || 0;
  const dNoDate = dt.no_date_at_all || 0;

  kh.innerHTML = [
    ['Vehicle docs expired', fmt(vExpired), 'cannot legally work', vExpired ? 'err' : 'ok'],
    ['Expiring in 7 days', fmt(vWeek), 'renew now', vWeek ? 'err' : 'ok'],
    ['Expiring in 45 days', fmt(vMonth), 'start the paperwork', vMonth ? 'warn' : 'ok'],
    ['Driver licences expired', fmt(dExpired),
      placeholder ? 'excluding the placeholder date' : 'stand down until renewed', dExpired ? 'err' : 'ok'],
    ...(dPlaceholder ? [['Licence dates that are a default', fmt(dPlaceholder),
      'a data problem, not an expiry', 'warn']] : []),
    /* The people we hold no expiry date for at all. They were invisible: not
       expired, not expiring, not a placeholder — simply absent from every tile
       on a page whose subject is whether the roster can legally drive. */
    ...(dNoDate ? [['No licence date on file', fmt(dNoDate),
      'we cannot say whether these are valid', 'warn']] : []),
  ].map(([l, n, d, cls]) => `<div class="kpi ${cls}"><div class="l">${l}</div><div class="n num">${n}</div><div class="d">${esc(d)}</div></div>`).join('');

  if (drvPage.caveat) root.append(note(drvPage.caveat));

  // The data holds registration only; naming three document types implied a
  // completeness this page does not have.
  // From the whole table, not from the rows on screen — the same reason the
  // tiles above stopped counting the array they had just been handed.
  const docTypes = (vehPage.doc_types || []).map((d) => d.doc_type).filter(Boolean);
  const vp = panel('Vehicle documents', docTypes.length
    ? `${docTypes.join(', ')} — the document types this source actually publishes`
    : 'documents with an expiry date');
  root.append(vp.panel);
  if (!veh.length) empty(vp.body, 'No vehicle documents collected yet');
  else vp.body.append(tableFrom(veh.slice(0, 120), [
    { label: 'Due', key: 'days_left', num: true, render: (r) => {
      const d = dl(r);
      const cls = d < 0 ? 'err' : d <= 7 ? 'err' : d <= 45 ? 'warn' : 'ok';
      return `<span class="tag ${cls}">${d < 0 ? Math.abs(d) + 'd ago' : d + 'd'}</span>`; } },
    { label: 'Plate', key: 'plate', render: (r) => entity('vehicle', r.plate, r.plate) },
    // A description, not an identity — the plate beside it is the link.
    { label: 'Make & model', key: 'make', render: (r) => esc([r.make, r.model, r.year].filter(Boolean).join(' ') || '—') },
    { label: 'Document', key: 'doc_type' },
    { label: 'Expires', key: 'expires_at', render: (r) => String(r.expires_at || '').slice(0, 10) },
    /* Who holds the car now — a document expiring next week is that person's
       problem, so the name is a link to them rather than a name to go and look
       up somewhere else. */
    { label: 'Held by', key: 'driver_name', render: (r) => (r.driver_name
      ? entity('driver', r.driver_ext_id, r.driver_name)
        + (r.driver_as_of ? ` <span class="dim">as of ${esc(String(r.driver_as_of).slice(0, 10))}</span>` : '')
      : '<span class="dim">nobody currently attributed</span>') },
  ]));
  if (veh.length) vp.body.append(el('p', 'cap',
    `Showing ${fmt(Math.min(120, veh.length))} of ${fmt(vt.total ?? veh.length)} documents with an expiry date`
    + `${vt.vehicles ? ` across ${fmt(vt.vehicles)} vehicles` : ''}, soonest first. `
    + 'The counts above are over all of them, not over this list.'));

  const dp = panel('Driver licences', placeholder
    ? `From the platforms that publish an expiry date. Rows carrying ${placeholder} are the source's `
      + 'default and are marked as such rather than counted as expired.'
    : 'from the platforms that publish an expiry date');
  root.append(dp.panel);
  if (!drv.length) empty(dp.body, 'No driver licence dates collected yet — Hotel publishes these, Uber does not expose them to this role');
  else dp.body.append(tableFrom(drv.slice(0, 120), [
    { label: 'Due', key: 'days_left', num: true, render: (r) => r.licence_expires
      ? `<span class="tag ${dl(r) < 0 ? 'err' : dl(r) <= 45 ? 'warn' : 'ok'}">${dl(r) < 0 ? Math.abs(dl(r)) + 'd ago' : dl(r) + 'd'}</span>` : '—' },
    { label: 'Driver', key: 'full_name',
      render: (r) => entity('driver', r.driver_ext_id, r.full_name) },
    { label: 'Platform', key: 'platform' },
    { label: 'Licence', key: 'licence_no', render: (r) => `<span class="plate">${esc(r.licence_no || '—')}</span>` },
    { label: 'Expires', key: 'licence_expires', render: (r) => {
      const d = String(r.licence_expires || '').slice(0, 10);
      if (!d) return '—';
      return d === placeholder ? `${esc(d)} ${pill('a default, not a date', 'warn')}` : esc(d);
    } },
    { label: 'State', key: 'state', render: (r) => `<span class="tag ${/suspend|deact/i.test(r.state || '') ? 'warn' : 'ok'}">${esc(r.state || '—')}</span>` },
  ]));
  if (drv.length) dp.body.append(el('p', 'cap',
    `Showing ${fmt(Math.min(120, drv.length))} of ${fmt(dt.total ?? drv.length)} driver records, `
    + `${fmt(dt.with_date ?? 0)} of which carry an expiry date at all. `
    + 'The counts above are over all of them, not over this list.'));
};

V.sources = async (root) => {
  const st = panel('Collector health',
    'Last run per source. "partial" means the run wrote rows AND left windows unfetched — which is how '
    + 'a 299-day hole in the Uber trip history survived for months behind a run that said ok.');
  root.append(st.panel);
  const cv = panel('Data coverage',
    'What has actually landed — and, for each dated source, how many days of the window it covered. '
    + 'A row count between two dates says nothing about the days in between.');
  root.append(cv.panel);
  [st.body, cv.body].forEach(loading);
  // This page hides the global range filter, so the coverage question is asked
  // over the full observed history rather than over an invisible window.
  // The Dubai day, not the UTC one — see api/public/tz.js.
  const [from, to] = ['2000-01-01', dubaiDay()];
  const [status, coverage] = await Promise.all([api('/api/status'), api('/api/coverage')]);
  st.body.innerHTML = '';
  const TAG = { ok: 'ok', partial: 'warn', error: 'bad' };
  st.body.append(tableFrom(status, [
    { label: 'Source', key: 'source' }, { label: 'Mode', key: 'mode' },
    { label: 'Status', key: 'status', render: (r) => `<span class="tag ${TAG[r.status] || 'bad'}">${esc(r.status || '—')}</span>` },
    { label: 'Rows', key: 'rows_written', num: true },
    { label: 'Windows', key: 'chunks_total', num: true, render: (r) => (r.chunks_total == null ? '—'
      : `${fmt(r.chunks_total - (r.chunks_failed || 0))} of ${fmt(r.chunks_total)}`) },
    { label: 'Last run', key: 'finished_at', render: (r) => (r.finished_at ? dtStr(r.finished_at) : '—') },
    { label: 'Detail', key: 'error', render: (r) => (r.error
      ? `<span class="note err">${esc(String(r.error).slice(0, 90))}</span>`
      : r.chunks_failed
        ? `<span class="note warn">${fmt(r.chunks_failed)} window(s) did not land — see below</span>`
        : '<span class="note ok">healthy</span>') },
  ]));
  /* The dates of the windows that failed. Without them a gap is visible but not
     fixable — you can see the hole and not know what to re-fetch. */
  const holes = status.flatMap((r) => (r.failed_windows || [])
    .map((w) => ({ source: r.source, mode: r.mode, ...w })));
  if (holes.length) {
    const hp = panel('Windows that did not land',
      'Each of these is a range with no data behind it. Every rate computed across one is wrong.');
    hp.body.append(tableFrom(holes, [
      { label: 'Source', key: 'source' }, { label: 'Mode', key: 'mode' },
      { label: 'From', key: 'from' }, { label: 'To', key: 'to' },
      { label: 'What came back', key: 'error', render: (h) => esc(String(h.error).slice(0, 140)) },
    ]));
    hp.body.append(note('Re-run a backfill from Settings to attempt these again. If the same window keeps '
      + 'failing, the reason in this table is the thing to fix — usually a credential, or a range past '
      + 'the provider’s retention.'));
    root.append(hp.panel);
  }
  cv.body.innerHTML = '';
  /* "Rows / From / Latest" reads as an unbroken span. Every hole between those
     two dates — the exact failure mode the rest of this codebase is written
     around — was invisible: a source that collected 56 days of a year was
     presented as having covered it. The calendar endpoint that answers this
     correctly already existed and was not called from here. */
  const cal = await api(`/api/coverage/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
    .catch(() => ({ sources: [] }));
  const byCal = Object.fromEntries((cal.sources || []).map((s2) => [s2.source, s2]));
  const cov = [
    ...(coverage.trips || []).map((r) => ({ what: `trips · ${r.platform}`, src: r.platform,
      n: r.n, from: r.from_ts, to: r.to_ts })),
    ...(coverage.telemetry || []).map((r) => ({ what: `telemetry · ${r.source}`, src: null,
      n: r.n, from: null, to: r.last_poll })),
    ...(coverage.alerts || []).map((r) => ({ what: 'safety alerts', src: null, n: r.n, from: null, to: r.latest })),
    ...(coverage.ledger || []).map((r) => ({ what: 'ledger entries', src: null, n: r.n, from: null, to: r.latest })),
  ].map((r) => ({ ...r, cal: r.src ? byCal[r.src] : null }));
  cv.body.append(tableFrom(cov, [
    { label: 'Dataset', key: 'what' },
    { label: 'Rows', key: 'n', num: true, render: (r) => fmt(r.n) },
    { label: 'From', key: 'from', render: (r) => (r.from ? String(r.from).slice(0, 10) : '—') },
    { label: 'Latest', key: 'to', render: (r) => (r.to ? String(r.to).slice(0, 16).replace('T', ' ') : '—') },
    { label: 'Days collected', key: '_d', render: (r) => (r.cal
      ? `${fmt(r.cal.days_with_data)} of ${fmt(r.cal.days_with_data + r.cal.missing_days)}`
      : '<span class="ent-off">not a dated source</span>') },
    { label: 'Missing', key: '_m', render: (r) => (!r.cal ? '—'
      : r.cal.missing_days
        ? `<a class="lnk" href="${href('coverage')}">${fmt(r.cal.missing_days)} days</a>`
        : pill('none', 'ok')) },
    { label: 'Largest gap', key: '_g', render: (r) => {
      const g = r.cal && r.cal.gaps && r.cal.gaps[0];
      return g ? `${dayStr(g.from)} → ${dayStr(g.to)} <small class="dim">${g.days}d</small>`
        : (r.cal ? '<span class="ent-off">none</span>' : '—');
    } },
  ]));
  const holed = cov.filter((r) => r.cal && r.cal.missing_days);
  if (holed.length) {
    cv.body.append(note(`${holed.map((r) => `${r.src} is missing ${r.cal.missing_days} days`).join(', ')}. `
      + 'A row count between two dates says nothing about what is in between — Collection gaps draws it.'));
  }

  /* What each provider actually sends, versus what we keep. Every collector
     stores the original record in `raw`; this reads it back, so "does Uber
     segregate business trips?" is answerable from the dashboard instead of by
     hand-querying the database. It is the difference between knowing what a
     source gives us and guessing from the columns we happened to map. */
  const rawP = panel('What each source actually sends',
    'Fields present in the provider\'s original record, how often they are filled, and whether we already keep them as a column. A field with few distinct values is a dimension worth charting; a wide one is an identifier or free text.');
  root.append(rawP.panel);
  const rawBar = el('div', 'toolbar');
  rawBar.innerHTML = `<select id="rawSrc" class="btn">
      <option value="uber">Uber trips</option><option value="fms">FMS trips</option>
      <option value="hotel">Hotel trips</option><option value="yango">Yango trips</option>
      <option value="bolt">Bolt trips</option><option value="">All platforms</option>
    </select>
    <span class="cap">over the selected date range</span>`;
  rawP.body.append(rawBar);
  const rawHost = el('div'); rawP.body.append(rawHost);
  const drawRaw = async (platform) => {
    loading(rawHost);
    try {
      const d = await q('/api/schema/raw-fields', platform ? { platform } : {});
      rawHost.innerHTML = '';
      if (!d.fields?.length) { rawHost.append(note('No stored records for this source in the selected range.')); return; }
      rawHost.append(tableFrom(d.fields, [
        { label: 'Field', key: 'key' },
        { label: 'Filled', key: 'fill_pct', num: true, render: (r) => pct(r.fill_pct) },
        { label: 'Distinct values', key: 'distinct_values', num: true, render: (r) => fmt(r.distinct_values) },
        { label: 'Kept as a column', key: '_m', render: (r) => (r.already_a_column
          ? pill('yes', 'ok') : pill('raw only', 'warn')) },
        { label: 'Examples', key: '_e', render: (r) => esc((r.examples || []).slice(0, 3).join(' · ')) },
      ]));
      rawHost.append(el('p', 'cap',
        `${fmt(d.rows_with_raw)} stored records, ${fmt(d.sampled)} sampled. ` +
        `Fields marked "raw only" arrive from the provider and are not promoted to a column — ` +
        `if one is useful, that is the list to pick from.`));
    } catch (e) { rawHost.innerHTML = ''; rawHost.append(note(`Could not read the field inventory: ${e.message}`)); }
  };
  await drawRaw('uber');
  rawBar.querySelector('#rawSrc').onchange = (e) => drawRaw(e.target.value);
};

V.settings = async (root) => {
  const auth = panel('Admin access', 'Changes require the admin token configured on the server'); root.append(auth.panel);
  const tokRow = el('div', 'btnrow');
  tokRow.innerHTML = `<input id="admTok" type="password" placeholder="admin token" style="flex:1;min-width:220px;background:var(--paper);border:1px solid var(--rule-strong);border-radius:3px;padding:8px 10px;font-family:'IBM Plex Mono';font-size:.8rem" value="${esc(state.admin)}">
    <button class="btn sec" id="saveTok">Remember</button><span class="note" id="tokNote"></span>`;
  auth.body.append(tokRow);
  tokRow.querySelector('#saveTok').onclick = () => {
    state.admin = tokRow.querySelector('#admTok').value.trim();
    store.set('adminToken', state.admin);
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
    <button class="btn sec" id="runProbe">Describe every provider API</button>
    <button class="btn sec" id="runAnalyst">Run the analyst</button>
    <span class="note" id="setNote"></span>`;
  credP.body.append(actions);
  const note = actions.querySelector('#setNote');
  const post = async (path, body) => {
    if (!state.admin) { note.className = 'note err'; note.textContent = 'enter the admin token first'; return null; }
    try {
      const r = await fetch(path, { method: path.endsWith('trigger') ? 'POST' : 'PUT',
        headers: { 'content-type': 'application/json', 'x-admin-token': state.admin }, body: JSON.stringify(body) });
      const j = await r.json();
      // A refused duplicate is not an error to hide — it is the answer.
      if (r.status === 409) { note.className = 'note warn'; note.textContent = j.detail || 'already queued'; return null; }
      if (!r.ok) throw new Error(j.error || j.detail || r.status);
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
  const RUN = {
    runInc: ['incremental', 'incremental queued — the collector claims it within ~20s'],
    runBack: ['backfill', 'backfill queued — this pulls up to 12 months and takes a while'],
    runProbe: ['probe', 'probe queued — it describes every provider surface and stores the shape'],
    runAnalyst: ['analyst', 'analyst queued — it costs one model call and judges its own claims'],
  };
  Object.entries(RUN).forEach(([id, [mode, msg]]) => {
    actions.querySelector('#' + id).onclick = async () => {
      const j = await post('/api/settings/trigger', { mode });
      if (j) { note.textContent = `${msg} (job ${j.job_id})`; jobs(); }
    };
  });

  /* What has actually been asked for, and what happened to it.
     On-demand runs used to be a single row that the next request overwrote —
     silently, while the API answered "queued" to a job it was about to discard.
     A queue nobody can see is a queue nobody can trust. */
  const jp = panel('Requested runs', 'Every on-demand run, and what became of it.');
  root.append(jp.panel);
  const jobs = async () => {
    loading(jp.body);
    try {
      const d = await api('/api/settings/jobs');
      jp.body.innerHTML = '';
      if (!d.jobs.length) { empty(jp.body, 'Nothing has been requested by hand'); return; }
      const TONE = { queued: 'info', running: 'warn', done: 'ok', failed: 'err' };
      jp.body.append(tableFrom(d.jobs, [
        { label: 'Job', key: 'id', num: true },
        { label: 'What', key: 'mode' },
        { label: 'State', key: 'status', render: (r) => pill(r.status, TONE[r.status]) },
        { label: 'Requested', key: 'requested_at', render: (r) => dtStr(r.requested_at) },
        { label: 'Started', key: 'started_at', render: (r) => (r.started_at ? dtStr(r.started_at) : '—') },
        { label: 'Took', key: 'seconds', num: true,
          render: (r) => (r.seconds != null
            ? (r.seconds > 90 ? `${Math.round(r.seconds / 60)} min` : `${r.seconds}s`)
            : r.running_seconds != null
              ? `<span class="dim">${Math.round(r.running_seconds / 60)} min so far</span>` : '—') },
        /* Which of the eight sources the run is actually on. A backfill's FMS
           step takes four and a half hours; without this the row said 'running'
           all afternoon and a working job looked exactly like a wedged one. */
        { label: 'On', key: 'progress', render: (r) => {
          const p2 = r.progress;
          if (!p2?.current) return p2?.total ? `<span class="dim">all ${p2.total} done</span>` : '';
          // The window within the source, where the source reports one. Uber
          // and FMS each take hours, and "uber (1 of 8)" held still for all of
          // it while eleven monthly reports landed behind it.
          const st = p2.step;
          return `${esc(p2.current)} <span class="dim">(${p2.done + 1} of ${p2.total})</span>`
            + (st?.window
              ? `<br><span class="dim">${esc(st.window)} — window ${st.index + 1} of ${st.of}`
                + `${st.rows_so_far ? `, ${fmt(st.rows_so_far)} rows so far` : ''}</span>`
              : '');
        } },
        { label: 'Restarts', key: 'attempts', num: true,
          render: (r) => (r.attempts > 1
            ? `<span class="pill ${r.attempts >= 3 ? 'bad' : 'warn'}">${r.attempts}</span>` : '') },
        { label: 'Detail', key: 'error', render: (r) => (r.error
          ? `<span class="note err">${esc(String(r.error).slice(0, 110))}</span>` : '') },
      ]));
      // `note` is a DOM element in this scope — the settings status line — so
      // the shared helper of the same name is unreachable here. Build the
      // element directly rather than shadowing something on purpose.
      const live = d.jobs.find((j) => j.status === 'running');
      if (live) {
        const rem = live.progress?.remaining || [];
        jp.body.append(el('div', 'note', esc(
          (live.progress?.current
            ? `Currently collecting ${live.progress.current}`
              + (live.progress.step?.of
                ? ` (window ${live.progress.step.index + 1} of ${live.progress.step.of})` : '')
              + (rem.length ? `, then ${rem.join(', ')}.` : ', the last of the sequence.')
            : 'A run is in progress.')
          + ' Only one runs at a time, so anything queued behind it starts when this finishes.'
          + (live.attempts > 1
            ? ` This job has been restarted ${live.attempts - 1} time(s) by a container restart — each restart`
              + ' begins the sequence again, so a long run may never reach its later sources.'
            : ''))));
      }
    } catch (e) {
      jp.body.innerHTML = '';
      jp.body.append(el('div', 'note err', esc(`Could not load: ${e.message}`)));
    }
  };
  jobs();
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

/* Entrance motion.
   ──────────────────────────────────────────────────────────────────────────
   None of this was firing. The selectors had drifted from the markup: it looked
   for `.hb .bar-cell > i` while charts.js emits `.hb .track > .fill`, and for
   `[data-draw]` / `[data-rise]` / `[data-fade]` attributes that were never set
   on anything. The keyframes existed, the CSS was correct, and no element ever
   matched — so the dashboard had no motion at all and the failure was silent.

   The rule the motion follows: it should carry meaning, not decorate. A bar
   growing from its baseline shows magnitude. A number counting up shows scale.
   A line drawing itself shows direction over time. Anything that does not say
   something is left still. */
function animateView(root) {
  if (REDUCED) return;

  // Stagger the top-level groups so the page assembles rather than appearing.
  root.classList.add('stagger');
  root.querySelectorAll('.kpis, .grid, .hbars, .pbars, .shifts, .dircards, .tscroll tbody')
    .forEach((g) => g.classList.add('stagger'));

  // Headline numbers count up to their value.
  root.querySelectorAll('.kpi .n').forEach(countUp);

  // Horizontal bars grow from their origin, in reading order.
  root.querySelectorAll('.hb .fill').forEach((b, i) => { b.style.animationDelay = `${i * 45}ms`; });
  root.querySelectorAll('.pbar .pb-track > i').forEach((b, i) => { b.style.animationDelay = `${i * 45}ms`; });
  root.querySelectorAll('.shift .sh-track > i').forEach((b, i) => { b.style.animationDelay = `${Math.min(i * 22, 700)}ms`; });

  // Lines draw themselves along their own length.
  root.querySelectorAll('svg path[data-draw]').forEach((path) => {
    try {
      const len = path.getTotalLength();
      if (!len) return;
      path.style.setProperty('--len', Math.ceil(len));
      path.classList.add('draw');
    } catch { /* non-path geometry */ }
  });

  // Bars rise from the axis; areas and slices fade in behind them.
  root.querySelectorAll('svg [data-rise]').forEach((r, i) => {
    r.classList.add('rise');
    r.style.animationDelay = `${Math.min(i * 22, 600)}ms`;
  });
  root.querySelectorAll('svg [data-fade]').forEach((r, i) => {
    r.classList.add('fade');
    r.style.animationDelay = `${Math.min(i * 40, 400)}ms`;
  });

  // Cards that carry a claim settle in rather than snapping.
  root.querySelectorAll('.breakcard, .idcard').forEach((c, i) => {
    c.classList.add('settle');
    c.style.animationDelay = `${Math.min(i * 60, 500)}ms`;
  });
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
      ? `updated ${timeStr(last)}<br>${bad ? `<span style="color:var(--warn)">${bad} source(s) need attention</span>` : 'all sources healthy'}`
      : 'awaiting first collection';
  } catch { $('#freshness').textContent = 'status unavailable'; }
}

/* A filter change rewrites the address rather than re-rendering in place, so
   the URL always describes what is on screen and the back button undoes it.
   `hashchange` does the render. */
$('#fRange').onchange = (e) => setFilter({ days: +e.target.value });
$('#fPlatform').onchange = (e) => setFilter({ platform: e.target.value });
$('#fFleet').onchange = (e) => setFilter({ fleet: e.target.value });
$('#refreshBtn').onclick = (e) => {
  const b = e.currentTarget; b.classList.remove('spin'); void b.offsetWidth; b.classList.add('spin');
  render();
};

/* Which clock, and which days. Every calendar key the API computes is Dubai's
   and every formatter here now renders in Dubai — but a reader in another zone
   has no way to know that from a bare "17:00", and the difference is the whole
   meaning of a peak-hour chart. Shown only when it could be misread, so it is
   silent for the people it does not concern. */
function tzNote() {
  const host = $('#tzNote');
  if (!host) return;
  const [from, to] = windowDates();
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  host.title = `${from} → ${to}, Dubai days`;
  host.textContent = local === TZ ? '' : 'Dubai time';
}
tzNote();
$('#themeBtn').onclick = () => {
  const r = document.documentElement, cur = r.getAttribute('data-theme');
  const dark = cur ? cur === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  r.setAttribute('data-theme', dark ? 'light' : 'dark');
  store.set('theme', dark ? 'light' : 'dark');
};
if (store.get('theme')) document.documentElement.setAttribute('data-theme', store.get('theme'));
/* Routes are `#<view>[/<param>[/<sub>]][?days=&platform=&fleet=]`.
   An unknown view falls back to the overview rather than rendering nothing. */
function applyRoute() {
  const r = parseHash();
  const known = VIEWS.some((v) => v.id === r.view) || !!V[r.view];
  state.view = known ? r.view : 'overview';
  state.param = r.param; state.sub = r.sub;
  // The address is the authority. A link with no filter in it means the
  // defaults, not "whatever the last page happened to be showing" — otherwise
  // clicking a plain link would silently carry a 365-day window into a page
  // whose caption claims 30.
  state.days = r.days ?? 30;
  state.platform = r.platform ?? '';
  state.fleet = r.fleet ?? '';
  const rng = $('#fRange'), plt = $('#fPlatform'), flt = $('#fFleet');
  if (rng) rng.value = String(state.days);
  if (plt) plt.value = state.platform;
  if (flt) flt.value = state.fleet;
}
applyRoute();
window.addEventListener('hashchange', () => { applyRoute(); render(); });
render();
setInterval(() => { if (state.view === 'live') render(); }, 60000);
