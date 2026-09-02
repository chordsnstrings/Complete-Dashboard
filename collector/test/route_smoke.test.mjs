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
import { applySchema, SCHEMA_FILES } from './schema.mjs';
import express from 'express';
import { readFileSync, readdirSync } from 'node:fs';
import { mountAll, START, END } from './mount.mjs';
import { refreshPayouts } from '../src/rollup.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

// Read from src/db.js, so a migration the server applies is a migration this
// smoke test applies. A hand-maintained copy drifted once and the failure it
// produced pointed at the test rather than at the code.
const SCHEMAS = await applySchema(db);

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
await refreshPayouts(db); // the payout table is collector-filled; this test plays the collector
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
/* The mounting itself moved to test/mount.mjs, because three test files were
   each building it and had drifted: one mounted eight route modules by name
   while ten shipped, so two of them were called, answered 404, and counted as
   passing. */
const src = readFileSync('api/server.js', 'utf8');
const { app, server, port, mounted, get } = await mountAll(db);
check('every route module in api/ is mounted, not just the ones somebody listed',
  mounted.length >= readdirSync('api').filter((x) => x.endsWith('_routes.js')).length,
  mounted.join(' '));
/* The harness slices server.js between two section comments. Rename either and
   the slice silently shrinks to nothing, which would read as "every route
   passes" rather than as a broken harness. */
check('the section markers the harness slices between still exist in server.js',
  src.includes(START) && src.indexOf(END) > src.indexOf(START));

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
  '/api/corporate/property': 'id=h1',
  '/api/corporate/leakage': 'kind=complimentary',
  '/api/corporate/approach': 'by=driver',
  '/api/tiers/mix': 'by=daypart',
  '/api/geo/corridors': '',
  '/api/day': 'day=2026-08-05',
};
const WINDOW = 'from=2026-08-01&to=2026-08-31';

const declared = [...src.matchAll(/app\.get\('(\/api\/[^']*)'/g)].map((m) => m[1]);
const routes = [...new Set(declared)]
  // Probes call live provider APIs over the network; they are covered by their
  // own allowlist test, not by executing them against a fixture.
  .filter((r) => !r.startsWith('/api/probe/'));

/* Every route file in api/, discovered. This named five of them and had
   already fallen behind by two — segment_routes.js was mounted in production
   and executed by nothing here, which is exactly the gap this test exists to
   close. A new route file is now covered by existing. */
const moduleRoutes = readdirSync('api')
  .filter((f) => f.endsWith('_routes.js'))
  .flatMap((f) => [...readFileSync(`api/${f}`, 'utf8')
    .matchAll(/app\.get\('(\/api\/[^']*)'/g)].map((m) => m[1]));

const all = [...new Set([...routes, ...moduleRoutes])]
  .filter((r) => !r.startsWith('/api/probe/'));
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

/* A route that is never mounted answers 404, and a 404 is not a 500 — so the
   check above cannot tell "this route works" from "this route does not exist".
   That is exactly how two shipped modules stayed unexercised. Ask Express what
   it actually registered instead of inferring it from a status code. */
const registered = new Set((app._router?.stack || app.router?.stack || [])
  .filter((l) => l.route?.methods?.get).map((l) => l.route.path));
/* /api/health and /api/ready are declared above the slice of server.js this
   harness evaluates, because they read migration state and the live pool
   rather than answering from SQL. They are covered by the source assertions
   further down ("readiness is separate from liveness and names what is
   missing", "the API refuses to serve on a failed migration"), so they are
   named here rather than quietly passing through a looser filter. */
const OUTSIDE_HARNESS = new Set(['/api/health', '/api/ready']);
const unmounted = all.filter((r) => !registered.has(r) && !OUTSIDE_HARNESS.has(r));
check('every route the source declares is actually registered on the app',
  unmounted.length === 0, unmounted.join(' '));

/* ── the mock API must answer in the same SHAPE as the real one ──────────
   mockapi.mjs is what the browser smoke test runs against, so a fixture whose
   shape differs from production makes that test lie. It did:
   /api/drivers/cross-platform returns `{platforms, drivers, ...}`, the mock had
   no fixture for it and fell through to a catch-all returning `[]`, and the UI
   called `.filter` on it. `[].filter` works; `{}.filter` throws. The Drivers
   page — directory included — rendered "Could not load this view" in
   production while 76/76 views passed in the smoke run.

   Comparing top-level shape catches exactly that class, cheaply: array vs
   object, and for objects, that the keys the real route returns exist in the
   fixture. It deliberately does not compare values. */
{
  const mockSrc = readFileSync('mockapi.mjs', 'utf8');
  const mockRoutes = new Set([...mockSrc.matchAll(/app\.get\('(\/api\/[^']*)'/g)].map((m) => m[1]));
  /* swr.js names the endpoints the client must NOT serve from its cache. A
     reference in order to avoid something is not a use of it, and counting them
     demanded mock fixtures for routes the browser never fetches. */
  const uiSrc = readdirSync('api/public').filter((f) => f.endsWith('.js') && f !== 'swr.js')
    .map((f) => readFileSync(`api/public/${f}`, 'utf8')).join('\n');
  const usedByUi = all.filter((r) => new RegExp(
    r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + `(?=['"\`?&]|\\$\\{|$)`, 'm').test(uiSrc));
  const unfixtured = usedByUi.filter((r) => !mockRoutes.has(r));
  check('every route the UI calls has a mock fixture, so the browser smoke test cannot pass on the wrong shape',
    unfixtured.length === 0,
    unfixtured.length ? `\n      unfixtured: ${unfixtured.join('\n      unfixtured: ')}` : '');

  /* The SHAPE comparison lives in test/mockapi.test.mjs, which has a fixture
     where the per-entity routes resolve — here they 404 for want of an id, and
     a 404 is skipped, so this file could only ever have checked the list
     routes while reporting on all of them. */

}

/* ── a test's argument map may not name a route that does not exist ───────
   Several files carry an ARGS map giving each detail route a parameter set
   that resolves. Two of them named /api/vehicle/compliance and
   /api/vehicle/hours, neither of which has ever existed — harmless in itself,
   but a map with stale keys is a map nobody trusts to be complete, and the
   failure it hides is the opposite one: a route MISSING from the map is called
   with no parameters and quietly 400s inside a loop that only counts 500s. */
{
  const declared = new Set(all);
  const stale = [];
  for (const f of readdirSync('test').filter((x) => x.endsWith('.test.mjs'))) {
    const src = readFileSync(`test/${f}`, 'utf8');
    for (const m of src.matchAll(/const (?:ARGS|LIST_ARGS)\s*=\s*\{([\s\S]*?)\n\};/g)) {
      for (const k of m[1].matchAll(/'(\/api\/[^']*)'\s*:/g)) {
        if (!declared.has(k[1])) stale.push(`test/${f}: ${k[1]}`);
      }
    }
  }
  check('no test gives arguments to a route that does not exist',
    stale.length === 0, stale.join('\n      '));
}

/* ── every schema file must survive being replayed ────────────────────────
   Both containers run migrate() on every boot, which replays every file in
   filename order. Two failures live in that loop and neither shows up on a
   first install:

   1. `SELECT t.*` in a view is expanded ONCE, at creation. trip_norm was
      defined in v7 that way, so a column added to `trip` in v18 was invisible
      to it and to trip_ext — while the column plainly existed in the table.
      CREATE OR REPLACE VIEW cannot fix it: it refuses to change an existing
      view's output columns.

   2. Two files defining the same view is fine on install and fails on the
      SECOND boot, when the older file runs first with the older column list
      and Postgres answers "cannot drop columns from view". A migration that
      errors on every boot trains everyone to ignore migration errors.

   So: replay the whole schema three times and require silence. */
{
  const fresh = new PGlite();
  const errs = [];
  for (let boot = 1; boot <= 3; boot++) {
    for (const f of SCHEMA_FILES) {
      try { await fresh.exec(readFileSync(`sql/${f}`, 'utf8')); }
      catch (e) { errs.push(`boot ${boot} ${f}: ${String(e.message || e).slice(0, 120)}`); }
    }
  }
  check('every schema file replays cleanly on three consecutive boots',
    errs.length === 0, errs.slice(0, 4).join(' | '));

  const fq = (t) => fresh.query(t).then((r) => r.rows);
  const extCols = (await fq(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'trip_ext'`))
    .map((c) => c.column_name);
  const tripCols = (await fq(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'trip'`))
    .map((c) => c.column_name);
  /* The invariant behind trap 1, stated directly: trip_ext is built on
     `SELECT t.*` twice over, so every column of `trip` must reach it. A column
     that does not is one somebody added without rebuilding the views, and it
     will be silently missing from every page rather than erroring. */
  const missing = tripCols.filter((c) => !extCols.includes(c));
  check('every column of trip reaches trip_ext, so a new column is not silently invisible',
    missing.length === 0, missing.join(', '));

  // And no view is defined in more than one schema file.
  const defs = {};
  for (const f of SCHEMA_FILES) {
    // Comments first — these files explain the trap in prose, and "CREATE OR
    // REPLACE VIEW cannot fix it" is not a view definition.
    const body = readFileSync(`sql/${f}`, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*--.*$/gm, '');
    for (const m of body.matchAll(/CREATE (?:OR REPLACE )?VIEW (\w+)/g)) {
      (defs[m[1]] ||= []).push(f);
    }
  }
  const dup = Object.entries(defs).filter(([, fs]) => fs.length > 1);
  check('no view is defined in two schema files, which fails only on the second boot',
    dup.length === 0, dup.map(([v, fs]) => `${v}: ${fs.join(',')}`).join(' | '));
  await fresh.close();
}

/* ── no test may keep its own copy of the schema list ─────────────────────
   Nine test files each carried a hand-picked list, several stopping at v5 or
   v12. Each one therefore ran against a schema production has not had for a
   long time — and the failure mode is the quiet one: a test that happens not
   to touch the newer columns PASSES, pinning behaviour that is not real. It
   only became visible when moving trip_ext's definition to a newer file made
   four of them error outright. */
{
  /* What is banned is a test KEEPING ITS OWN LIST, not a test naming a file.
     ───────────────────────────────────────────────────────────────────────
     The original rule flagged any literal `schema_vN.sql`, which also caught
     the two legitimate uses: an assertion that a specific migration is
     registered ("schema_v30 exists but nothing runs it"), and a test whose
     whole subject is one migration's SQL. Both of those read the real list as
     well, and a test that consults SCHEMA_FILES cannot be running against a
     stale schema — which is the entire failure this rule exists to prevent.

     So the test is: does this file name schema files WITHOUT importing the
     list? That still catches the nine stragglers that started it, each of
     which hand-picked a prefix and stopped at v5 or v12. */
  const NAMED = /['\`](?:sql\/)?schema(?:_v\d+)?\.sql['\`]/g;
  const stragglers = readdirSync('test')
    .filter((f) => f.endsWith('.test.mjs'))
    .filter((f) => {
      const src = readFileSync(`test/${f}`, 'utf8');
      /* A LIST is an array literal holding two or more of them. Reading one
         file to assert about its SQL — "schema_v20 defines person_key this
         way", "schema_v26 rejects a week longer than seven days" — is not a
         list and never goes stale: it names the file it is about. */
      return [...src.matchAll(/\[([^\]]*)\]/g)]
        .some((m) => (m[1].match(NAMED) || []).length >= 2);
    });
  check('no test keeps its own list of schema files instead of importing SCHEMA_FILES',
    stragglers.length === 0, stragglers.join(', '));
}

/* ── two pages must not disagree about how big the fleet is ───────────────
   The playbook sized "put idle vehicles back to work" from plates seen in the
   window's own rows, and reported 93 vehicles where the directory reported
   131. That understates idle capacity by exactly the vehicles that are most
   idle: a car that produced nothing and did not even move has no rows in the
   window, so a query scoped to those rows cannot see it — and it is precisely
   the car the action exists to find.

   Both now build from the same union: every plate that ever appeared in a
   trip, a telemetry fix, or a document. */
{
  const dir = await (await fetch(`http://127.0.0.1:${port}/api/vehicles/directory?${WINDOW}`)).json();
  const pb = await (await fetch(`http://127.0.0.1:${port}/api/playbook?${WINDOW}`)).json();
  check('the playbook and the vehicle directory count the same fleet',
    pb.fleet.vehicles_seen === dir.length, `playbook ${pb.fleet.vehicles_seen} vs directory ${dir.length}`);
  check('and agree on how many of them earned',
    pb.fleet.earning === dir.filter((v) => (v.trips || 0) > 0).length,
    `${pb.fleet.earning} vs ${dir.filter((v) => (v.trips || 0) > 0).length}`);
  check('the three vehicle states account for every vehicle, with none double-counted',
    pb.fleet.earning + pb.fleet.moved_only + pb.fleet.still === pb.fleet.vehicles_seen,
    `${pb.fleet.earning}+${pb.fleet.moved_only}+${pb.fleet.still} vs ${pb.fleet.vehicles_seen}`);

  /* Money and ceilings must never be added. A ceiling is what would happen if
     everything went right; a measured amount already happened. */
  check('measured money and modelled ceilings are reported apart',
    'aed_measured' in pb.totals && 'bookings_ceiling' in pb.totals
    && pb.totals.aed_modelled === null,
    JSON.stringify(pb.totals));
  check('nothing is converted to money until a rate is supplied',
    pb.actions.every((a) => a.aed_modelled === null), 
    JSON.stringify(pb.actions.filter((a) => a.aed_modelled !== null).map((a) => a.id)));
  const withRate = await (await fetch(
    `http://127.0.0.1:${port}/api/playbook?${WINDOW}&aed_per_trip=50`)).json();
  check('supplying a rate is echoed back with the figures it produced',
    withRate.assumption.aed_per_trip === 50, JSON.stringify(withRate.assumption));
  /* The rule, stated as an implication so it holds whether or not this
     fixture happens to contain a modelable action: an action with a bookings
     ceiling above zero gets a modelled figure, and one without gets none. A
     bare "something is modelled" would pass or fail on the fixture's shape
     rather than on the behaviour. */
  const modelable = withRate.actions.filter((a) => /bookings/.test(a.ceiling_unit || '') && a.ceiling > 0);
  check('every action with a bookings ceiling is modelled, and only those are',
    modelable.every((a) => a.aed_modelled > 0)
    && withRate.actions.filter((a) => !modelable.includes(a)).every((a) => a.aed_modelled === null),
    JSON.stringify(withRate.actions.map((a) => [a.id, a.ceiling, a.ceiling_unit, a.aed_modelled])));
  check('a modelled figure is exactly the rate times the ceiling, not a blend',
    withRate.actions.filter((a) => a.aed_modelled).every((a) => a.aed_modelled === Math.round(a.ceiling * 50)),
    JSON.stringify(withRate.actions.filter((a) => a.aed_modelled).map((a) => [a.id, a.ceiling, a.aed_modelled])));
  check('a measured amount is never turned into a modelled one',
    withRate.actions.filter((a) => a.aed_measured).every((a) => a.aed_measured === pb.actions.find((x) => x.id === a.id).aed_measured));
  check('every action carries the arithmetic that sized it',
    pb.actions.every((a) => a.basis && a.basis.length > 40),
    JSON.stringify(pb.actions.filter((a) => !a.basis || a.basis.length <= 40).map((a) => a.id)));
  check('and a link to the evidence behind it',
    pb.actions.every((a) => /^#/.test(a.link || '')),
    JSON.stringify(pb.actions.map((a) => a.link)));
}

/* ── the raw explorer must be able to open every table it offers ──────────
   Both raw-field endpoints filtered on `platform`. telemetry_snapshot calls
   that column `source`, so the tool whose entire purpose is answering "what
   else could we be collecting" returned a 500 for the table carrying the
   seat-sensor feed — and CABMAN does send a SeatSensorStatus field we do not
   store. The one tool that would have surfaced it could not open that table. */
{
  const TABLES = ['trip', 'alert', 'telemetry_snapshot', 'driver_performance', 'vehicle_profile'];
  let broken = [];
  for (const t of TABLES) {
    const a = await fetch(`http://127.0.0.1:${port}/api/schema/raw-fields?table=${t}&${WINDOW}`);
    const b = await fetch(`http://127.0.0.1:${port}/api/schema/raw-values?table=${t}&key=x&${WINDOW}`);
    if (a.status >= 500 || b.status >= 500) broken.push(`${t} (${a.status}/${b.status})`);
  }
  check('every table the raw explorer offers can actually be opened',
    broken.length === 0, broken.join(', '));

  // And the provider filter still filters, rather than being silently dropped.
  const filtered = await (await fetch(
    `http://127.0.0.1:${port}/api/schema/raw-fields?table=trip&platform=uber&${WINDOW}`)).json();
  check('the provider filter is applied where the table has one',
    filtered.platform === 'uber' && typeof filtered.rows_with_raw === 'number',
    JSON.stringify({ p: filtered.platform, n: filtered.rows_with_raw }));
}

/* The specific shape that broke /api/vehicles: a join against a table that
   also has platform and fleet_id columns. */
{
  const r = await fetch(`http://127.0.0.1:${port}/api/vehicles?${WINDOW}`);
  const body = await r.json();
  const rows = body.rows || body;
  check('the vehicle list joins current-driver without an ambiguous column',
    r.status === 200 && Array.isArray(rows) && rows.length > 0, `${r.status} ${JSON.stringify(body).slice(0, 120)}`);
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
  // The rule logRun encodes is asserted from the source, and the shape it
  // produces is asserted below against PGlite. logRun now takes a db handle,
  // so test/analytics_routes.test.mjs drives the writer itself rather than
  // guessing at its output — which is how the coverage fixture came to store a
  // shape the collector has never written.
  const dbSrc = readFileSync('src/db.js', 'utf8');
  check('a run with a failed window cannot report ok',
    /const status = run\.status === 'error' \|\| allFailed \? 'error'/.test(dbSrc)
    && /failed \? 'partial'/.test(dbSrc), 'logRun must downgrade to partial');
  /* And one that failed EVERY window is not a partial either — there is no
     part. Two production runs wore an amber pill on 44-of-44 failures; the
     shape of that is driven in test/run_honesty.test.mjs. */
  check('…and a run with no successful window at all reports error',
    /const allFailed = /.test(dbSrc), 'logRun must escalate an all-failed run');
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

/* A 500 body must not hand an unauthenticated caller the storage engine.
   The boundary moved to api/wrap.js so its late-failure branch could be
   exercised rather than reasoned about, and this check moved with it. What is
   asserted here is the WIRING — that server.js still routes through that
   boundary and has not grown a second one; the body's shape, the reference,
   and what happens when a route fails after its first byte are exercised for
   real in test/late_failure.test.mjs. */
check('the error handler returns a reference, not the driver message',
  /res\.status\(500\)\.json\(\{ error: 'internal', ref \}\)/.test(
    readFileSync('api/wrap.js', 'utf8')));
check('and server.js routes through that one boundary rather than its own',
  /const wrap = makeWrap\(\{ log \}\)/.test(src) && !/const wrap = \(fn\)/.test(src));
check('readiness is separate from liveness and names what is missing',
  /\/api\/ready/.test(src) && /schema incomplete/.test(src));
check('the API refuses to serve on a failed migration', /process\.exit\(1\)/.test(src));
check('an idle-client failure is logged, not fatal',
  /pool\.on\('error'/.test(readFileSync('src/db.js', 'utf8')));

/* And at runtime, not only in the source: an /api path that matches nothing
   answers 404 with JSON. It used to fall through to the SPA catch-all and come
   back 200 with a page of HTML, so a misspelled or not-yet-deployed endpoint
   failed at the client with "Unexpected token <". */
{
  const miss = await get('/api/definitely-not-a-route');
  check('an unrouted /api path answers 404, not the dashboard', miss.status === 404,
    `${miss.status} ${miss.raw || JSON.stringify(miss.body)}`);
  check('and answers in JSON, naming the path it could not find',
    miss.body?.error === 'no such endpoint' && miss.body?.path === '/api/definitely-not-a-route',
    JSON.stringify(miss.body));
  /* The guard must not have eaten a real route on the way. /api/kpis rather
     than /api/health: health and ready are declared outside the START/END
     slice this harness mounts, so they are legitimately absent here and would
     make a passing guard look like a broken one. */
  const real = await get('/api/kpis');
  check('while a real endpoint still answers normally', real.status === 200, String(real.status));
}

/* ── readiness must not queue behind the data ─────────────────────────────
   The pool holds eight connections. Eight concurrent heavy queries take all of
   them and the readiness check then waits its turn: measured at 81 seconds
   during a sweep at a ninety-day window, against 0.27 asked on its own. That is
   a feedback loop rather than a slow endpoint — the platform's health check
   times out, the app restarts, the restart empties the response cache, and the
   next wave of traffic is entirely cold. */
{
  const src2 = readFileSync('api/server.js', 'utf8');
  check('the readiness answer is remembered rather than re-queried per request',
    /let readyMemo = null;/.test(src2) && /readyMemo\.at/.test(src2));
  /* A ready process can answer from memory for a while; a process that is NOT
     ready is the state worth being impatient about. */
  check('a positive answer is held far longer than a negative one',
    /TTL_OK = 30000, TTL_BAD = 2000/.test(src2));
  check('and "the database was unreachable" expires quickly, being the claim most worth retrying',
    /Not remembered as long/.test(src2));

  const db2 = readFileSync('src/db.js', 'utf8');
  check('a query that will not finish cannot hold a pool slot for ever',
    /statement_timeout: Number\(process\.env\.STATEMENT_TIMEOUT_MS \|\| 120000\)/.test(db2));
}

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
