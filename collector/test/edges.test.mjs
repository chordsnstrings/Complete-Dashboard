/* The states a fleet is actually in, which are rarely the happy one.
   ──────────────────────────────────────────────────────────────────────────
   Every page here was written against a month of busy data. The states that
   break them are the ones nobody types into a fixture: a brand-new database, a
   vehicle that has never moved, a driver whose platform reports no outcome, a
   day with one trip on it, a month with none.

   The failure is almost never a crash. It is a page that renders a confident
   zero where it should say "not measured", or a rate computed over a
   denominator of one, or a null that formats as 0 and gets averaged into
   somebody's total. Those are the shapes this pins. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import express from 'express';
import { driverRoutes } from '../api/driver_routes.js';
import { vehicleRoutes } from '../api/vehicle_routes.js';
import { analyticsRoutes } from '../api/analytics_routes.js';
import { rosterRoutes } from '../api/roster_routes.js';
import { dayRoutes } from '../api/day_routes.js';
import { segmentRoutes, slotRoutes } from '../api/segment_routes.js';
import { forecastRoutes } from '../api/forecast_routes.js';
import { playbookRoutes } from '../api/playbook_routes.js';
import { retentionRoutes } from '../api/retention_routes.js';
import { capacityRoutes } from '../api/capacity_routes.js';
import { rebuildCustody } from '../src/custody.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(500).json({ error: String(e) }));
const endOfDay = (d) => `${d}T23:59:59.999Z`;
const range = (req) => [req.query.from || '2026-08-01', req.query.to || '2026-08-31',
  req.query.platform || null, req.query.fleet || null];
const W = (a = '') => { const p = a ? `${a}.` : '';
  return `${p}local_day BETWEEN $1::date AND $2::date AND ($3::text IS NULL OR ${p}platform=$3) AND ($4::text IS NULL OR ${p}fleet_id=$4)`; };
const DAYWIN = (col) => `(${col} AT TIME ZONE 'Asia/Dubai')::date BETWEEN $1::date AND $2::date`;

async function mount(db) {
  const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
  const app = express();
  const F = W(), FB = `${W()} AND is_booking`;
  driverRoutes(app, { q, wrap, endOfDay });
  vehicleRoutes(app, { q, wrap, endOfDay });
  analyticsRoutes(app, { q, wrap, range, F, FB });
  rosterRoutes(app, { q, wrap, range });
  dayRoutes(app, { q, wrap });
  segmentRoutes(app, { q, wrap, range, DAYWIN });
  slotRoutes(app, { q, wrap, range });
  forecastRoutes(app, { q, wrap, DAYWIN });
  playbookRoutes(app, { q, wrap, range, DAYWIN });
  retentionRoutes(app, { q, wrap });
  capacityRoutes(app, { q, wrap });
  const server = app.listen(0);
  const port = server.address().port;
  /* Tolerant of a non-JSON body: an unmounted path gets Express's 404 HTML,
     and a test that throws on it reports a parse error instead of the route
     that is missing. */
  return { q, server,
    get: async (p) => {
      const r = await fetch(`http://127.0.0.1:${port}${p}`);
      const text = await r.text();
      try { return { status: r.status, body: JSON.parse(text) }; }
      catch { return { status: r.status, body: null, raw: text.slice(0, 80) }; }
    } };
}

/* Every GET route these modules declare, so a new one is covered by existing
   rather than by somebody remembering to add it here. */
const { readFileSync, readdirSync } = await import('node:fs');
const ROUTES = [...new Set(readdirSync('api')
  .filter((f) => f.endsWith('_routes.js'))
  .flatMap((f) => [...readFileSync(`api/${f}`, 'utf8')
    .matchAll(/app\.get\('(\/api\/[^']*)'/g)].map((m) => m[1])))];
const ARGS = {
  '/api/driver/profile': 'id=nobody', '/api/driver/kpis': 'id=nobody',
  '/api/driver/daily': 'id=nobody', '/api/driver/heatmap': 'id=nobody',
  '/api/driver/standing': 'id=nobody', '/api/driver/territory': 'id=nobody',
  '/api/driver/mix': 'id=nobody', '/api/driver/earnings': 'id=nobody',
  '/api/driver/quality': 'id=nobody', '/api/driver/trips': 'id=nobody',
  '/api/driver/custody': 'id=nobody', '/api/driver/vehicles': 'id=nobody',
  '/api/vehicle/profile': 'plate=NOPLATE', '/api/vehicle/kpis': 'plate=NOPLATE',
  '/api/vehicle/daily': 'plate=NOPLATE', '/api/vehicle/drivers-detail': 'plate=NOPLATE',
  '/api/vehicle/movement': 'plate=NOPLATE', '/api/vehicle/safety': 'plate=NOPLATE', '/api/vehicle/trips': 'plate=NOPLATE',
  '/api/vehicle/mix': 'plate=NOPLATE',
  '/api/vehicle/drivers': 'plate=NOPLATE',
  '/api/day': 'day=2026-08-05', '/api/slot': 'dow=2&hour=19',
  '/api/segment': 'plate=NOPLATE&at=2026-08-05T10:00:00Z',
};
const WIN = 'from=2026-08-01&to=2026-08-31';

/* ── 1. an empty database ───────────────────────────────────────────────── */
/* The state every deployment is in for its first hour, and the one most likely
   to be reached by a filter combination nobody anticipated. Nothing may 500,
   and nothing may report a confident zero for a quantity it has not measured. */
{
  const db = new PGlite();
  await applySchema(db);
  const { get, server } = await mount(db);
  const broke = [];
  for (const r of ROUTES) {
    const extra = ARGS[r] ? `&${ARGS[r]}` : '';
    const { status, body } = await get(`${r}?${WIN}${extra}`);
    if (status >= 500) broke.push(`${r} → ${status} ${JSON.stringify(body).slice(0, 90)}`);
  }
  check('no route 500s against a database with nothing in it',
    broke.length === 0, `\n      ${broke.join('\n      ')}`);

  /* A rate over nothing is not zero. "0% completion" on an empty fleet is a
     statement about drivers that no row supports. */
  const nulls = [];
  for (const r of ROUTES) {
    const extra = ARGS[r] ? `&${ARGS[r]}` : '';
    const { body } = await get(`${r}?${WIN}${extra}`);
    const walk = (o, path = '') => {
      if (o == null || typeof o !== 'object') return;
      if (Array.isArray(o)) return o.forEach((x, i) => walk(x, `${path}[${i}]`));
      for (const [k, v] of Object.entries(o)) {
        if (/_pct$|^avg_|_per_|rate$/.test(k) && v === 0) nulls.push(`${r}${path}.${k}`);
        walk(v, `${path}.${k}`);
      }
    };
    walk(body);
  }
  check('no average or rate reports a confident zero over an empty fleet',
    nulls.length === 0, `\n      ${nulls.join('\n      ')}`);
  server.close(); await db.close();
}

/* ── 2. one row ─────────────────────────────────────────────────────────── */
/* A denominator of one. Medians, percentiles, standard deviations and
   month-over-month comparisons all have a degenerate case here, and the honest
   answer to most of them is "not enough to say". */
{
  const db = new PGlite();
  await applySchema(db);
  const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
  await q(`INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
             requested_at, distance_km, status, price, payment_type, pickup_addr, dropoff_addr)
           VALUES ('uber','one','ecosine','L1','d1','Solo Driver','2026-08-05T10:00:00+04:00',
                   12,'completed',50,'cash','A - Dubai - UAE','B - Dubai - UAE')`);
  const { get, server } = await mount(db);
  const broke = [];
  for (const r of ROUTES) {
    const extra = ARGS[r] ? `&${ARGS[r]}` : '';
    const { status, body } = await get(`${r}?${WIN}${extra}`);
    if (status >= 500) broke.push(`${r} → ${JSON.stringify(body).slice(0, 90)}`);
  }
  check('no route 500s on a fleet with exactly one trip in it',
    broke.length === 0, `\n      ${broke.join('\n      ')}`);

  const kpi = (await get(`/api/driver/kpis?id=d1&${WIN}`)).body;
  check('one trip gives one trip, not a rounded nothing', kpi.trips === 1, String(kpi.trips));
  check('and a completion rate of 100, because that trip completed',
    Number(kpi.completion_pct) === 100, String(kpi.completion_pct));

  /* A standing built from one peer has no distribution. A percentile over a
     population of one is 100 or 0 and means neither. */
  const st = (await get(`/api/driver/standing?id=d1&${WIN}`)).body;
  check('a percentile ranking over a population of one is refused, not reported',
    st.metrics.length === 0 || st.n_peers <= 1,
    `${st.n_peers} peers, ${st.metrics.length} metrics`);

  const fc = (await get('/api/forecast')).body;
  check('a forecast from one month refuses rather than drawing a line',
    fc.ok === false && /complete month/.test(fc.reason || ''), JSON.stringify(fc.reason));
  server.close(); await db.close();
}

/* ── 3. rows that carry no money and no distance ────────────────────────── */
/* The live Uber shape: 165,000 bookings, not one of them priced. Every money
   figure has to be null rather than zero, because zero is a claim that the
   fleet earned nothing and null is the truth that we cannot see it. */
{
  const db = new PGlite();
  await applySchema(db);
  const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
  for (let i = 0; i < 30; i++) {
    await q(`INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
               requested_at, status)
             VALUES ('uber',$1,'ecosine','L1','d1','Unpriced Driver',$2,'completed')`,
      [`np${i}`, `2026-08-${String((i % 20) + 1).padStart(2, '0')}T10:00:00+04:00`]);
  }
  const { get, server } = await mount(db);
  const kpi = (await get(`/api/driver/kpis?id=d1&${WIN}`)).body;
  check('a fleet whose bookings carry no fare reports null revenue, not zero',
    kpi.revenue == null, String(kpi.revenue));
  check('and null average distance, because none was reported',
    kpi.avg_km == null, String(kpi.avg_km));
  check('but it still counts the bookings', kpi.trips === 30, String(kpi.trips));

  const veh = (await get(`/api/vehicle/kpis?plate=L1&${WIN}`)).body;
  check('the vehicle page says the same', veh.revenue == null && veh.trips === 30,
    `${veh.revenue} / ${veh.trips}`);
  check('and says how many bookings the distance was measured over',
    veh.measured_trips === 0, String(veh.measured_trips));

  const mix = (await get(`/api/settlement/mix?${WIN}`)).body;
  const unlabelled = mix.classes.find((c) => c.settlement_class == null);
  check('a booking with no payment type is not silently classed as cash',
    !mix.classes.some((c) => c.settlement_class === 'cash'),
    JSON.stringify(mix.classes.map((c) => c.settlement_class)));
  server.close(); await db.close();
}

/* ── 4. a name with no id, and an id with no name ───────────────────────── */
{
  const db = new PGlite();
  await applySchema(db);
  const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
  await q(`INSERT INTO trip (platform, external_id, fleet_id, plate, driver_name, requested_at, status, distance_km)
           VALUES ('hotel','nn1','ecosine','L1','Named But Idless','2026-08-05T10:00:00+04:00','completed',9)`);
  await q(`INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, requested_at, status, distance_km)
           VALUES ('uber','ni1','ecosine','L1','id-only','2026-08-06T10:00:00+04:00','completed',9)`);
  // The real rebuild, not a reimplementation of it — custody is what every
  // vehicle-side attribution hangs off, so it has to be the shipped one.
  await rebuildCustody({ from: '2026-08-01', to: '2026-08-31', db });
  const { get, server } = await mount(db);
  const lb = (await get(`/api/vehicle/drivers-detail?plate=L1&${WIN}`)).body;
  check('a driver with a name and no id still appears, rather than vanishing',
    JSON.stringify(lb).includes('Named But Idless'), JSON.stringify(lb).slice(0, 160));
  const dir = (await get(`/api/drivers/directory?${WIN}`)).body;
  check('and appears in the directory too',
    JSON.stringify(dir).includes('Named But Idless'), String(dir.length));
  server.close(); await db.close();
}

/* ── 5. a window that contains nothing, on a database that does ─────────── */
/* The commonest real state: the fleet has years of history and the operator
   has picked last Tuesday. Everything must render empty, and nothing may
   report a rate over the empty window as though it described the fleet. */
{
  const db = new PGlite();
  await applySchema(db);
  const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
  for (let i = 0; i < 40; i++) {
    await q(`INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
               requested_at, status, distance_km, price)
             VALUES ('uber',$1,'ecosine','L1','d1','Historic Driver',$2,'completed',11,44)`,
      [`h${i}`, `2025-03-${String((i % 28) + 1).padStart(2, '0')}T10:00:00+04:00`]);
  }
  const { get, server } = await mount(db);
  const EMPTY = 'from=2026-08-01&to=2026-08-31';
  const broke = [];
  for (const r of ROUTES) {
    const extra = ARGS[r] ? `&${ARGS[r]}` : '';
    const { status, body } = await get(`${r}?${EMPTY}${extra}`);
    if (status >= 500) broke.push(`${r} → ${JSON.stringify(body).slice(0, 90)}`);
  }
  check('an empty window over a populated database breaks nothing',
    broke.length === 0, `\n      ${broke.join('\n      ')}`);

  const kpi = (await get(`/api/driver/kpis?id=d1&${EMPTY}`)).body;
  check('a driver with no trips in the window reports zero trips',
    kpi.trips === 0, String(kpi.trips));
  check('and a null completion rate, not a zero one',
    kpi.completion_pct == null, String(kpi.completion_pct));
  server.close(); await db.close();
}

console.log(`\n  ${ROUTES.length} routes exercised in five degenerate states`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
