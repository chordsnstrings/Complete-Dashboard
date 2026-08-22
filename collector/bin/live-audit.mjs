#!/usr/bin/env node
/* The test suite's invariants, run against the live database.
   ─────────────────────────────────────────────────────────────────────────
   Every check in test/ runs against a fixture, and a fixture is a hypothesis
   about the data. This runs the same questions against production, where the
   answers are whatever the providers actually sent.

   It found five things the fixtures could not:

     - the driver directory and the driver ranking folded names differently, so
       the two pages reported 90 and 89 drivers for the same fleet
     - revenue_per_km divided the revenue of one population by the distance of
       another, on three pages
     - fifteen bookings carry no vehicle, so the vehicle table summed to fifteen
       fewer trips than the fleet and nothing said why
     - the fleet revenue headline counted complimentary rides and the settlement
       page did not, a difference of AED 320
     - and, behind all of it, Uber earnings had never been collected at all

   Read-only: every request is a GET. Safe to run against production at any
   time, and worth running after every deploy.

       node bin/live-audit.mjs
       BASE=http://localhost:8099 node bin/live-audit.mjs
       WIN='from=2026-01-01&to=2026-08-22' node bin/live-audit.mjs
*/
const B = process.env.BASE || 'https://fleet-dashboard-wpeqb.ondigitalocean.app';
const W = process.env.WIN || 'from=2026-07-23&to=2026-08-22';
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++) : (fail++, console.log(`  ✗ ${n}  ${x}`)); };
const N = (v) => (v == null || v === '' ? null : Number(v));
const sum = (rows, k) => (rows || []).reduce((a, r) => a + (Number(r[k]) || 0), 0);
const near = (a, b, tol = 0.06) => a != null && b != null && Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;
const get = async (p) => {
  const r = await fetch(`${B}${p}${p.includes('?') ? '&' : '?'}${W}`);
  const t = await r.text();
  try { return { status: r.status, body: JSON.parse(t) }; } catch { return { status: r.status, body: null, raw: t.slice(0, 120) }; }
};

const k = (await get('/api/kpis')).body;
check('kpis.completion_pct', near(N(k.completion_pct), 100 * k.completed_trips / k.bookable_trips), `${k.completion_pct} vs ${k.completed_trips}/${k.bookable_trips}`);
check('kpis.cancel_pct', near(N(k.cancel_pct), 100 * k.cancelled_trips / k.bookable_trips), `${k.cancel_pct}`);
check('kpis.avg_km', near(N(k.avg_km), N(k.km) / k.trips_with_distance, 0.05), `${k.avg_km} vs ${N(k.km)}/${k.trips_with_distance}`);
check('kpis.avg_fare', near(N(k.avg_fare), N(k.revenue) / k.priced_trips, 0.05), `${k.avg_fare}`);
const settle = (await get('/api/settlement/mix')).body;
const classSum = (settle.classes || []).reduce((a, c) => a + (Number(c.revenue) || 0), 0);
check('kpis revenue and the settlement page describe the same money',
  Math.abs(N(k.revenue) - classSum) <= (settle.classes || []).length / 2 + 1,
  `${k.revenue} vs ${classSum}`);
check('kpis trips and the settlement page describe the same trips',
  k.trips === settle.total_trips, `${k.trips} vs ${settle.total_trips}`);
check('kpis.revenue_per_km', near(N(k.revenue_per_km), N(k.priced_measured_revenue) / N(k.priced_km), 0.02), `${k.revenue_per_km} vs ${N(k.priced_measured_revenue)}/${N(k.priced_km)}`);
check('outcomes fit the denominator', k.completed_trips + k.cancelled_trips <= k.bookable_trips, `${k.completed_trips}+${k.cancelled_trips} vs ${k.bookable_trips}`);

for (const by of ['platform', 'status', '']) {
  const rows = (await get(`/api/mix${by ? `?by=${by}` : ''}`)).body || [];
  check(`mix ${by || 'product'} sums to trips`, sum(rows, 'n') === k.trips, `${sum(rows, 'n')} vs ${k.trips}`);
}
check('daily sums to trips', sum((await get('/api/trips/daily')).body, 'trips') === k.trips, `${sum((await get('/api/trips/daily')).body, 'trips')} vs ${k.trips}`);
check('hourly sums to trips', sum((await get('/api/trips/hourly')).body, 'trips') === k.trips);
check('heatmap sums to trips', sum((await get('/api/trips/heatmap')).body, 'trips') === k.trips);

const vdir = (await get('/api/vehicles/directory')).body || [];
const veh = (await get('/api/vehicles')).body;
check('vehicle directory trips + unassigned = fleet trips',
  sum(vdir, 'trips') + (k.trips_without_vehicle || 0) === k.trips,
  `${sum(vdir, 'trips')} + ${k.trips_without_vehicle} vs ${k.trips}`);
// Different populations on purpose: /api/vehicles counts vehicles with a trip
// in the window, the directory covers every plate we hold anything about.
check('vehicles list total <= directory size', veh.total <= vdir.length, `${veh.total} vs ${vdir.length}`);
const dir = (await get('/api/drivers/directory')).body || [];
const lb = (await get('/api/drivers/leaderboard')).body;
check('directory trips = leaderboard trips', sum(dir, 'trips') === sum(lb.rows, 'trips'), `${sum(dir, 'trips')} vs ${sum(lb.rows, 'trips')}`);
check('directory people = leaderboard people', dir.filter((r) => (r.trips || 0) > 0).length === lb.people, `${dir.filter((r) => (r.trips || 0) > 0).length} vs ${lb.people}`);
check('nobody appears twice on the ranking', new Set(lb.rows.map((r) => r.driver_name)).size === lb.rows.length, `${lb.rows.length} rows`);

// every percentage in every response must be a percentage
const ROUTES = ['/api/kpis', '/api/vehicles/directory', '/api/drivers/directory', '/api/settlement/mix',
  '/api/roster', '/api/compliance/drivers', '/api/compliance/vehicles', '/api/unauthorized/summary',
  '/api/alerts/by-driver', '/api/alerts/by-vehicle', '/api/revenue', '/api/tiers/by-vehicle',
  '/api/corporate/properties', '/api/trend/monthly', '/api/playbook', '/api/capacity', '/api/retention',
  '/api/forecast', '/api/sensor-health', '/api/mix/detail?by=payment', '/api/drivers/cross-platform'];
const badPct = [], nan = [];
for (const r of ROUTES) {
  const { status, body } = await get(r);
  if (status >= 400 || body == null) { console.log(`  !! ${r} → ${status}`); continue; }
  const walk = (o, at = '') => {
    if (o == null || typeof o !== 'object') return;
    if (Array.isArray(o)) return o.forEach((x, i) => walk(x, `${at}[${i}]`));
    for (const [key, v] of Object.entries(o)) {
      // A SHARE is bounded; a CHANGE is not. A month that went from 4,203 to
      // 18,672 bookings really is +344%, and flagging it would train everyone
      // to ignore this check.
      const isShare = /_pct$|^pct|percent/.test(key) && !/change|delta|gap|growth|diff|swing/.test(key);
      if (isShare && v != null && Number.isFinite(Number(v)) && (Number(v) < 0 || Number(v) > 100)) badPct.push(`${r}${at}.${key}=${v}`);
      if (typeof v === 'number' && !Number.isFinite(v)) nan.push(`${r}${at}.${key}`);
      if (typeof v === 'string' && /^(NaN|Infinity|-Infinity)$/.test(v)) nan.push(`${r}${at}.${key}=${v}`);
      walk(v, `${at}.${key}`);
    }
  };
  walk(body);
}
check('no percentage out of range', badPct.length === 0, badPct.slice(0, 6).join(' | '));
check('no NaN or Infinity anywhere', nan.length === 0, nan.slice(0, 6).join(' | '));

// every driver/vehicle a list names opens
const ids = [...new Set(dir.slice(0, 25).map((r) => r.ids?.[0] || r.driver_ext_id).filter(Boolean))];
const dead = [];
for (const id of ids) {
  const { status } = await get(`/api/driver/kpis?id=${encodeURIComponent(id)}`);
  if (status !== 200) dead.push(`${id} → ${status}`);
}
check('every driver in the directory opens', dead.length === 0, dead.slice(0, 5).join(', '));
const deadV = [];
for (const v of vdir.slice(0, 25)) {
  const { status } = await get(`/api/vehicle/kpis?plate=${encodeURIComponent(v.plate)}`);
  if (status !== 200) deadV.push(`${v.plate} → ${status}`);
}
check('every vehicle in the directory opens', deadV.length === 0, deadV.slice(0, 5).join(', '));
check('an unknown driver 404s', (await get('/api/driver/kpis?id=no-such-person')).status === 404);
check('an unknown vehicle 404s', (await get('/api/vehicle/kpis?plate=NOSUCHPLATE')).status === 404);

// hollow pages: the list says busy, the page says nothing
const hollow = [];
for (const r of dir.filter((x) => (x.trips || 0) > 20).slice(0, 20)) {
  const id = r.ids?.[0] || r.driver_ext_id;
  const kk = (await get(`/api/driver/kpis?id=${encodeURIComponent(id)}`)).body;
  if (!kk || (kk.trips || 0) === 0) hollow.push(`${r.driver_name}: dir ${r.trips}, page ${kk?.trips}`);
}
check('no driver page is empty for somebody the directory says drove', hollow.length === 0, hollow.slice(0, 5).join(' | '));

/* ── every route the app declares, live ─────────────────────────────────── */
const ARGS = {
  '/api/mix': 'by=payment', '/api/mix/detail': 'by=product', '/api/tiers/mix': 'by=daypart',
  '/api/corporate/leakage': 'kind=complimentary', '/api/corporate/approach': 'by=driver',
  '/api/schema/raw-values': 'key=client&platform=hotel',
  '/api/day': `day=${new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10)}`,
  '/api/slot': 'dow=2&hour=19',
};
const one = (arr) => (Array.isArray(arr) ? arr[0] : null);
const someDriver = one(dir)?.ids?.[0] || one(dir)?.driver_ext_id;
const somePlate = one(vdir)?.plate;
const someProp = one((await get('/api/corporate/properties')).body || [])?.partner_id;
const seg = one(((await get('/api/segments')).body || {}).rows || []);
const DETAIL = {
  driver: `id=${encodeURIComponent(someDriver || '')}`,
  vehicle: `plate=${encodeURIComponent(somePlate || '')}`,
};
const routes = (await (await fetch(`${B}/api/endpoints`)).text().catch(() => '')) || '';
const KNOWN = ['/api/kpis','/api/trips/daily','/api/trips/hourly','/api/trips/heatmap','/api/mix','/api/mix/detail',
  '/api/drivers/leaderboard','/api/drivers/cross-platform','/api/drivers/performance','/api/drivers/directory',
  '/api/vehicles','/api/vehicles/directory','/api/live','/api/track','/api/map/days','/api/map/journey',
  '/api/alerts/summary','/api/alerts/by-vehicle','/api/alerts/by-driver','/api/finance/ledger','/api/finance/daily',
  '/api/unauthorized/summary','/api/unauthorized/list','/api/unauthorized/by-vehicle','/api/unauthorized/daily',
  '/api/sensor-health','/api/platforms','/api/status','/api/coverage','/api/settings','/api/insights',
  '/api/insights/summary','/api/compliance/vehicles','/api/compliance/drivers','/api/recommendations',
  '/api/earnings/components','/api/earnings/tips','/api/tiers/by-vehicle','/api/tiers/mix','/api/product/by-vehicle',
  '/api/breaks','/api/events','/api/trend/monthly','/api/geo/corridors','/api/settlement/mix',
  '/api/settlement/cash-exposure','/api/corporate/properties','/api/corporate/leakage','/api/corporate/approach',
  '/api/roster','/api/roster/states','/api/schema/raw-fields','/api/schema/raw-values','/api/day','/api/slot',
  '/api/segments','/api/forecast','/api/playbook','/api/retention','/api/capacity','/api/revenue',
  '/api/probe/results','/api/analyst/findings','/api/analyst/rules','/api/settings/jobs'];
const broke = [];
for (const r of KNOWN) {
  const extra = ARGS[r] ? `&${ARGS[r]}` : (r === '/api/track' || r === '/api/map/journey' ? `&plate=${somePlate}&day=${new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10)}` : '');
  const { status } = await get(`${r}${extra ? `?${extra.slice(1)}` : ''}`);
  if (status >= 500) broke.push(`${r} → ${status}`);
}
for (const r of ['/api/driver/profile','/api/driver/kpis','/api/driver/daily','/api/driver/trips','/api/driver/custody',
  '/api/driver/vehicles','/api/driver/quality','/api/driver/earnings','/api/driver/standing','/api/driver/territory',
  '/api/driver/mix','/api/driver/heatmap']) {
  const { status } = await get(`${r}?${DETAIL.driver}`);
  if (status >= 500 || status === 404) broke.push(`${r} → ${status}`);
}
for (const r of ['/api/vehicle/profile','/api/vehicle/kpis','/api/vehicle/daily','/api/vehicle/drivers-detail',
  '/api/vehicle/movement','/api/vehicle/safety','/api/vehicle/mix','/api/vehicle/trips','/api/vehicle/drivers']) {
  const { status } = await get(`${r}?${DETAIL.vehicle}`);
  if (status >= 500 || status === 404) broke.push(`${r} → ${status}`);
}
if (someProp) { const { status } = await get(`/api/corporate/property?id=${encodeURIComponent(someProp)}`); if (status >= 400) broke.push(`/api/corporate/property → ${status}`); }
if (seg) { const { status } = await get(`/api/segment?plate=${encodeURIComponent(seg.plate)}&at=${encodeURIComponent(seg.started_at)}`); if (status >= 400) broke.push(`/api/segment → ${status}`); }
check('no route errors or 404s against live data', broke.length === 0, broke.slice(0, 10).join(' | '));

/* ── the pages that reason, reasoned about themselves ───────────────────── */
{
  const fc = (await get('/api/forecast')).body;
  if (fc?.months?.length) {
    const bad = fc.months.filter((m) => m.lo != null && m.hi != null && !(N(m.lo) <= N(m.point) && N(m.point) <= N(m.hi)));
    check('every forecast interval brackets its own point estimate', bad.length === 0,
      JSON.stringify(bad.slice(0, 2)));
  }
  const pb = (await get('/api/playbook')).body;
  if (pb?.actions?.length) {
    const noBasis = pb.actions.filter((a) => !a.basis || a.size == null);
    check('every playbook action carries a size and the arithmetic that produced it',
      noBasis.length === 0, noBasis.map((a) => a.id).join(', '));
    const negative = pb.actions.filter((a) => Number(a.size) < 0);
    check('no action is sized negatively', negative.length === 0, negative.map((a) => `${a.id}=${a.size}`).join(', '));
  }
  const rt = (await get('/api/retention')).body;
  if (rt?.flow?.length) {
    const bad = rt.flow.filter((m) => m.joined < 0 || m.left < 0);
    check('no month gained or lost a negative number of drivers', bad.length === 0, JSON.stringify(bad.slice(0, 2)));
  }
  const rev = (await get('/api/revenue')).body;
  if (rev?.platforms) {
    const over = rev.platforms.filter((r) => r.priced_bookings > r.bookings);
    check('no channel reports more priced bookings than bookings', over.length === 0,
      over.map((r) => `${r.platform} ${r.priced_bookings}/${r.bookings}`).join(', '));
    check('the accounted total is the sum of the per-channel figures',
      Math.abs((rev.totals.accounted || 0) - rev.platforms.reduce((a, r) => a + (r.best || 0), 0)) < 1,
      `${rev.totals.accounted}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed  (live: ${B})`);
