/* Every route, executed.
   ──────────────────────────────────────────────────────────────────────────
   `test/endpoint_coverage.test.mjs` greps api/server.js for `app.get` strings
   and checks the front end calls them. It passes whether or not the SQL behind
   a route can run. Because of that, `/api/vehicles` shipped and returned a 500
   on every single call in production — `platform` was ambiguous across a join
   with vehicle_current_driver, which Postgres rejects at parse analysis, so the
   route had never once succeeded. The Vehicles page showed "Could not load this
   view" and nothing in the suite noticed.

   This test mounts the real handlers against a real Postgres (PGlite) with a
   small but shaped fixture, and calls every one of them. It asserts the only
   thing that matters at this level: no route 500s. A route returning an empty
   array because the fixture has no matching row is fine; a route that cannot
   parse its own query is not. */
import { PGlite } from '@electric-sql/pglite';
import express from 'express';
import { readFileSync } from 'node:fs';
import { driverRoutes } from '../api/driver_routes.js';
import { vehicleRoutes } from '../api/vehicle_routes.js';
import { analyticsRoutes } from '../api/analytics_routes.js';
import { rosterRoutes } from '../api/roster_routes.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const SCHEMAS = ['schema.sql', 'schema_v2.sql', 'schema_v3.sql', 'schema_v4.sql', 'schema_v5.sql',
  'schema_v6.sql', 'schema_v7.sql', 'schema_v8.sql', 'schema_v9.sql', 'schema_v10.sql', 'schema_v11.sql', 'schema_v12.sql', 'schema_v13.sql', 'schema_v14.sql'];
for (const f of SCHEMAS) await db.exec(readFileSync(`sql/${f}`, 'utf8'));

/* ── the one-time retraction must be exactly that ─────────────────────────
   schema_v8 deletes every occupancy_segment with a NULL verdict_reason. Both
   containers replay every schema file on every boot, so unguarded it wiped the
   reconciler's stationary/partial/sensor_suspect output on every deploy — and
   in production it had: the Unauthorized page reported zero of everything. */
await q(`INSERT INTO occupancy_segment (plate, started_at, ended_at, verdict, verdict_reason)
         VALUES ('L100', now(), now(), 'stationary', NULL),
                ('L101', now(), now(), 'authorized', 'matched uber trip abc')`);
for (const f of SCHEMAS) await db.exec(readFileSync(`sql/${f}`, 'utf8'));   // a second boot
const kept = await q('SELECT verdict FROM occupancy_segment ORDER BY plate');
check('a one-time data migration runs once, not on every boot',
  kept.length === 2, `${kept.length} of 2 segments survived a second boot`);

/* ── fixture ──────────────────────────────────────────────────────────── */
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine') ON CONFLICT DO NOTHING`);
const trip = (o) => q(
  `INSERT INTO trip (platform,external_id,fleet_id,plate,driver_ext_id,driver_name,requested_at,ended_at,
                     distance_km,duration_s,status,product,payment_type,price,cost,deadhead_km,partner_id,
                     partner_name,zone,is_scheduled,pickup_addr,dropoff_addr,pickup_lat,pickup_lng,
                     dropoff_lat,dropoff_lng,service_type,vehicle_ext_id,raw)
   VALUES ($1,$2,'ecosine',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
           25.1,55.2,25.2,55.3,$22,$23,$24)`,
  [o.platform, o.id, o.plate, o.drv, o.drv ? 'Driver ' + o.drv : null,
   `2026-08-${String(o.day).padStart(2, '0')}T10:00:00+04:00`,
   `2026-08-${String(o.day).padStart(2, '0')}T10:30:00+04:00`,
   o.km ?? null, 1800, o.status ?? 'completed', o.product ?? null, o.pay ?? null, o.price ?? null,
   o.cost ?? null, o.dead ?? null, o.partner ?? null, o.partnerName ?? null, o.zone ?? null,
   o.sched ?? null, '12 Cluster E - Al Thanyah Fifth - Dubai - UAE', 'T3 - Dubai Airport - Dubai - UAE',
   o.service ?? null, o.veh ?? null, o.raw ? JSON.stringify(o.raw) : null]);

let n = 0;
for (let i = 0; i < 24; i++) {
  await trip({ platform: 'uber', id: `u${n++}`, plate: `L${100 + (i % 4)}`, drv: `d${i % 3}`, day: 1 + (i % 12),
    km: 12, product: ['UberX', 'Black', 'Comfort', 'Electric'][i % 4],
    pay: ['braintree', 'cash', 'offline', 'apple_pay'][i % 4], service: 'personal_transport',
    veh: `veh-${i % 4}`, status: i === 5 ? 'rider_cancelled' : 'completed' });
  await trip({ platform: 'fms', id: `f${n++}`, plate: `L${100 + (i % 4)}`, drv: null, day: 1 + (i % 12), km: 18 });
  await trip({ platform: 'hotel', id: `h${n++}`, plate: `L${100 + (i % 4)}`, drv: `hd${i % 2}`, day: 1 + (i % 12),
    km: 20, price: 100, cost: 70, dead: 3, partner: 'h1', partnerName: 'Palm Grand', zone: 'inside-dubai',
    sched: i % 2 === 0, product: ['pick_and_drop', 'hourly'][i % 2],
    pay: ['cash-driver', 'room-charge', 'posted-for-salary', 'foc-complimentary'][i % 4],
    raw: { client: `guest${i % 5}`, hotel: 'h1', roomNumber: `${900 + i}`, overRun: i === 3,
      authorization: i % 3 ? { _id: 'a' } : null, stops: [] } });
}
await q(`INSERT INTO vehicle (plate, fleet_id) VALUES ('L100','ecosine'),('L101','ecosine'),('L102','ecosine'),('L103','ecosine') ON CONFLICT DO NOTHING`);
await q(`INSERT INTO vehicle_profile (platform,vehicle_ext_id,plate,fleet_id,make,model,year,colour,vin,compliance_status)
         VALUES ('uber','veh-0','L100','ecosine','Lexus','ES',2024,'black','VIN0','ACTIVE'),
                ('uber','veh-1','L101','ecosine','BYD','Han EV',2025,'white','VIN1','ACTIVE')`);
await q(`INSERT INTO vehicle_document (platform,vehicle_ext_id,doc_type,plate,fleet_id,status,expires_at)
         VALUES ('uber','veh-0','registration','L100','ecosine','ACTIVE', now() + interval '20 days')`);
await q(`INSERT INTO driver_compliance (platform,driver_ext_id,fleet_id,full_name,licence_expires,state)
         VALUES ('hotel','hd0','ecosine','Driver hd0', current_date + 15, 'active')`);
await q(`INSERT INTO driver_performance (platform,fleet_id,driver_ext_id,driver_name,period_start,period_end,trips,rating,acceptance_rate,raw)
         VALUES ('yango','ecosine','d0','Driver d0','2026-08-01','2026-08-31',40,4.8,0.9,$1)`,
  [JSON.stringify({ count_orders_all: 100, count_orders_accepted: 80, count_orders_completed: 70,
    price_cash: 900, price_cashless: 300, price_platform_commission: -220, work_time_seconds: 90000, state: 'active' })]);
await q(`INSERT INTO telemetry_snapshot (plate, fleet_id, source, captured_at, polled_at, lat, lng, speed, status, seat_occupied)
         SELECT 'L100','ecosine','cabman', now() - (g || ' minutes')::interval, now(), 25.1+g*0.001, 55.2+g*0.001, 40, 'Active', true
         FROM generate_series(1,40) g`);
await q(`INSERT INTO alert (platform, external_id, plate, fleet_id, alert_type, occurred_at, lat, lng)
         VALUES ('fms','a1','L100','ecosine','Harsh Brake', now() - interval '2 days', 25.1, 55.2)`);
await q(`INSERT INTO vehicle_driver_day (plate, day, driver_ext_id, driver_name, platform, fleet_id, trips)
         VALUES ('L100','2026-08-05','d0','Driver d0','uber','ecosine',6)`);
await q(`INSERT INTO occupancy_segment (plate, fleet_id, started_at, ended_at, duration_min, distance_km, verdict, verdict_reason)
         VALUES ('L100','ecosine','2026-08-05T06:00:00Z','2026-08-05T06:30:00Z',30,14,'unauthorized','no booking of any kind on this plate')`);
await q(`INSERT INTO collection_run (source, fleet_id, mode, status, rows_written, finished_at)
         VALUES ('uber','ecosine','incremental','ok',24, now())`);
await q(`INSERT INTO insight (code, severity, title, detail, fleet_id, created_at)
         VALUES ('idle_vehicle','warning','A car earned nothing','detail','ecosine', now())`)
  .catch(() => {});
await q(`INSERT INTO ledger_entry (platform, external_id, fleet_id, occurred_at, category, amount)
         VALUES ('uber','l1','ecosine', now(), 'payout', 500)`).catch(() => {});

/* ── mount every route the way server.js does ─────────────────────────── */
const src = readFileSync('api/server.js', 'utf8');
const body = src.slice(src.indexOf("/* ───────────────────────── overview ───────────────────────── */"),
  src.indexOf('/* ───────────────── per-driver detail pages ───────────────── */'));

const app = express();
app.use(express.json());
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  res.status(500).json({ error: 'internal', detail: String(e).slice(0, 300) });
});
const endOfDay = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d} 23:59:59.999` : d);
const asDate = (v, f) => {
  const s = String(v || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return f;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? f : s;
};
const range = (req) => {
  let from = asDate(req.query.from, '2000-01-01'); let to = asDate(req.query.to, '2100-01-01');
  if (from > to) [from, to] = [to, from];
  return [from, to, req.query.platform || null, req.query.fleet || null];
};
const W = (alias = '') => {
  const c = alias ? `${alias}.` : '';
  return `${c}local_day BETWEEN $1::date AND $2::date`
    + ` AND ($3::text IS NULL OR ${c}platform=$3)`
    + ` AND ($4::text IS NULL OR ${c}fleet_id=$4)`;
};
const F = W();
const FB = `${F} AND is_booking`;
const requireAdmin = (_req, _res, next) => next();
const stub = async () => ({});
// eslint-disable-next-line no-new-func
new Function('app', 'q', 'wrap', 'range', 'F', 'FB', 'W', 'endOfDay', 'requireAdmin',
  'describeSettings', 'setSetting', 'deleteSetting', 'loadSettings', 'insights', 'pool',
  body)(app, q, wrap, range, F, FB, W, endOfDay, requireAdmin,
  stub, stub, stub, stub, { run: stub }, { query: db.query.bind(db) });
driverRoutes(app, { q, wrap, endOfDay });
vehicleRoutes(app, { q, wrap, endOfDay });
analyticsRoutes(app, { q, wrap, range, F, FB });
rosterRoutes(app, { q, wrap, range });

const server = app.listen(0);
const port = server.address().port;

/* Every GET route the server declares, with a parameter set that resolves. A
   route not listed here is called with the window alone. */
const ARGS = {
  '/api/track': 'plate=L100',
  '/api/map/journey': 'plate=L100&day=2026-08-05',
  '/api/vehicle/drivers': 'plate=L100',
  '/api/driver/vehicles': 'driver=d0',
  '/api/mix': 'by=payment',
  '/api/mix/detail': 'by=product',
  '/api/schema/raw-values': 'key=client&platform=hotel',
  '/api/drivers/:id': null,
  '/api/corporate/property': 'id=h1',
  '/api/corporate/leakage': 'kind=complimentary',
  '/api/corporate/approach': 'by=driver',
  '/api/tiers/mix': 'by=daypart',
  '/api/geo/corridors': '',
};
const WINDOW = 'from=2026-08-01&to=2026-08-31';

const declared = [...src.matchAll(/app\.get\('(\/api\/[^']*)'/g)].map((m) => m[1]);
const routes = [...new Set(declared)]
  // Probes call live provider APIs over the network; they are covered by their
  // own allowlist test, not by executing them against a fixture.
  .filter((r) => !r.startsWith('/api/probe/'));

const drvRoutes = [...readFileSync('api/driver_routes.js', 'utf8')
  .matchAll(/app\.get\('(\/api\/[^']*)'/g)].map((m) => m[1]);
const vehRoutes = [...readFileSync('api/vehicle_routes.js', 'utf8')
  .matchAll(/app\.get\('(\/api\/[^']*)'/g)].map((m) => m[1]);
const anaRoutes = [...readFileSync('api/analytics_routes.js', 'utf8')
  .matchAll(/app\.get\('(\/api\/[^']*)'/g)].map((m) => m[1]);
const rosRoutes = [...readFileSync('api/roster_routes.js', 'utf8')
  .matchAll(/app\.get\('(\/api\/[^']*)'/g)].map((m) => m[1]);

const all = [...new Set([...routes, ...drvRoutes, ...vehRoutes, ...anaRoutes, ...rosRoutes])];
// `:param` routes need a real value substituted, not the literal placeholder.
const SUB = { ':id': 'd0', ':plate': 'L100' };
const resolved = all.map((r) => r.replace(/:(\w+)/g, (m) => SUB[m] || 'd0'));

let bad = 0;
for (const path of resolved) {
  const extra = ARGS[path] ?? ARGS[all[resolved.indexOf(path)]] ?? '';
  const url = `http://127.0.0.1:${port}${path}?${WINDOW}${extra ? '&' + extra : ''}`;
  const r = await fetch(url);
  const txt = await r.text();
  if (r.status >= 500) {
    bad++;
    console.log(`  ✗ ${path} → ${r.status} ${txt.slice(0, 160)}`);
  }
}
check(`all ${resolved.length} GET routes execute without a server error`, bad === 0, `${bad} failed`);

/* The specific shape that broke /api/vehicles: a join against a table that
   also has platform and fleet_id columns. */
{
  const r = await fetch(`http://127.0.0.1:${port}/api/vehicles?${WINDOW}`);
  const rows = await r.json();
  check('the vehicle list joins current-driver without an ambiguous column',
    r.status === 200 && Array.isArray(rows) && rows.length > 0, `${r.status} ${JSON.stringify(rows).slice(0, 120)}`);
  check('the window predicate can be table-qualified', /const W = \(alias/.test(src));
}

/* A bad parameter is a 400 or an empty result, never a 500 carrying the
   driver's own error message. */
for (const bad2 of ['from=banana&to=2026-08-31', 'from=2026-08-31&to=2026-08-01',
  "platform='; DROP TABLE trip; --", 'from=2026-13-45&to=x']) {
  const r = await fetch(`http://127.0.0.1:${port}/api/kpis?${bad2}`);
  check(`a malformed parameter (${bad2.slice(0, 26)}) does not 500`, r.status < 500, String(r.status));
}
check('the trip table survived the injection attempt',
  (await q('SELECT count(*)::int n FROM trip'))[0].n > 0);

/* ── a run that wrote rows is not a run that worked ───────────────────────
   The Uber collector chunks a backfill into twelve monthly windows. When nine
   failed, the tenth still wrote rows and collection_run recorded
   status='ok', rows_written=1129 — which is what the Data sources page showed
   for months while the trip history had a 299-day hole in it. */
{
  const { logRun } = await import('../src/db.js');
  // logRun talks to the shared pool, so the rule it encodes is asserted from
  // the source and the behaviour is asserted directly below against PGlite.
  const dbSrc = readFileSync('src/db.js', 'utf8');
  check('a run with a failed window cannot report ok',
    /const status = run\.status === 'error' \? 'error'/.test(dbSrc)
    && /failed \? 'partial'/.test(dbSrc), 'logRun must downgrade to partial');
  check('the failed windows are stored, not just counted',
    /detail/.test(dbSrc) && /chunks\.map/.test(dbSrc));
  await q(`INSERT INTO collection_run (source,mode,status,rows_written,chunks_total,chunks_failed,detail,finished_at)
           VALUES ('uber','backfill','partial',1129,12,9,$1,now())`,
    [JSON.stringify([{ from: '2025-10-23', to: '2025-11-22', rows: 0, error: 'timed out' },
      { from: '2026-07-22', to: '2026-08-21', rows: 1129, error: null }])]);
  const st = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
  const uber = st.find((r) => r.source === 'uber');
  check('the status endpoint reports partial rather than ok',
    uber && uber.status === 'partial', JSON.stringify(uber && uber.status));
  check('and names the dates of the windows that did not land',
    uber && uber.failed_windows.length === 1 && uber.failed_windows[0].from === '2025-10-23',
    JSON.stringify(uber && uber.failed_windows));
  check('a successful window is not listed as failed',
    uber && uber.windows.filter((w) => w.ok).length === 1);
  check('the raw detail blob is not echoed alongside the parsed one',
    uber && uber.detail === undefined);
  // A source that does not chunk must be unaffected.
  await q(`INSERT INTO collection_run (source,mode,status,rows_written,finished_at)
           VALUES ('cabman','realtime','ok',48,now())`);
  const st2 = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
  const cab = st2.find((r) => r.source === 'cabman');
  check('a source that does not chunk still reports ok with no windows',
    cab && cab.status === 'ok' && cab.failed_windows.length === 0, JSON.stringify(cab && cab.status));
}

/* ── a queue of one is not a queue ───────────────────────────────────────
   On-demand runs were a single source_state row: ask for two things seconds
   apart and the second overwrote the first, while the API answered
   {ok: true, queued: "backfill"} to a request it was about to discard. An hour
   was spent waiting for a backfill that had been thrown away before it
   started. */
{
  const post = (mode) => fetch(`http://127.0.0.1:${port}/api/settings/trigger`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode }) });
  const a = await (await post('backfill')).json();
  const b = await (await post('probe')).json();
  check('two different requests both survive', a.ok && b.ok && a.job_id !== b.job_id,
    JSON.stringify([a.job_id, b.job_id]));
  const jobs = await (await fetch(`http://127.0.0.1:${port}/api/settings/jobs`)).json();
  check('both are visible in the queue',
    jobs.jobs.filter((j) => j.status === 'queued').length === 2, JSON.stringify(jobs.pending));
  check('the queue names what each one is',
    jobs.jobs.map((j) => j.mode).sort().join() === 'backfill,probe',
    jobs.jobs.map((j) => j.mode).join());

  // A duplicate is refused, not merged: "queued" for a job that will never run
  // is the same lie in a different shape.
  const dup = await post('backfill');
  const dupBody = await dup.json();
  check('a duplicate request is refused rather than silently merged',
    dup.status === 409 && dupBody.ok === false, `${dup.status} ${JSON.stringify(dupBody)}`);
  check('the refusal says what is already pending and since when',
    /already queued/.test(dupBody.detail || '') && dupBody.job_id === a.job_id, dupBody.detail);

  // An unknown mode falls back rather than reaching the collector as an
  // instruction nobody validated.
  const weird = await (await post('rm -rf /')).json();
  check('an unrecognised mode falls back to incremental', weird.queued === 'incremental', weird.queued);
  const src2 = readFileSync('api/server.js', 'utf8');
  check('the mode is an allowlist, not a pass-through',
    /JOB_MODES\.includes\(req\.body\?\.mode\)/.test(src2));
  check('the old single-slot trigger is gone',
    !/key='trigger'/.test(src2) && !/'trigger',\$1/.test(src2));
}

/* A 500 body must not hand an unauthenticated caller the storage engine. */
check('the error handler returns a reference, not the driver message',
  /res\.status\(500\)\.json\(\{ error: 'internal', ref \}\)/.test(src));
check('readiness is separate from liveness and names what is missing',
  /\/api\/ready/.test(src) && /schema incomplete/.test(src));
check('the API refuses to serve on a failed migration', /process\.exit\(1\)/.test(src));
check('an idle-client failure is logged, not fatal',
  /pool\.on\('error'/.test(readFileSync('src/db.js', 'utf8')));

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
