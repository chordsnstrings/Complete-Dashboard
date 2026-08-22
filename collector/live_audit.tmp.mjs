/* The same invariants the test suite asserts against a fixture, run against the
   live database. A fixture is a hypothesis about the data; this is the data. */
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
check('kpis.revenue_per_km', near(N(k.revenue_per_km), N(k.revenue) / N(k.priced_km), 0.02), `${k.revenue_per_km}`);
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
check('vehicle directory trips = fleet trips', sum(vdir, 'trips') === k.trips, `${sum(vdir, 'trips')} vs ${k.trips}`);
check('vehicles list total = directory size', veh.total === vdir.length, `${veh.total} vs ${vdir.length}`);
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
      if (/_pct$|^pct|percent/.test(key) && v != null && Number.isFinite(Number(v)) && (Number(v) < 0 || Number(v) > 100)) badPct.push(`${r}${at}.${key}=${v}`);
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

console.log(`\n${pass} passed, ${fail} failed  (live: ${B})`);
