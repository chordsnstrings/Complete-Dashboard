/* The same fact must have the same value wherever it appears.
   ──────────────────────────────────────────────────────────────────────────
   A dashboard whose pages disagree is worse than one page: it makes every
   number negotiable. This has happened here repeatedly and never as an obvious
   bug — always as two queries that each looked right in isolation:

     the playbook counted 93 vehicles, the directory 131, because one scoped
     the fleet to plates appearing in the window's own rows and the other to
     every plate ever seen;

     a driver's completion rate differed between their own page and the
     leaderboard, because one tested status = 'completed' and the other
     trip_norm.outcome;

     two panels disagreed about the same plate's trip count because one used a
     UTC day boundary and the other a Dubai one.

   Every check here fetches the same fact from two or more endpoints against
   ONE database and requires them to agree. Where they legitimately differ, the
   difference has to be a documented definition, not an accident — and the
   check states which. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import express from 'express';
import { readFileSync } from 'node:fs';
import { mountAll } from './mount.mjs';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

await applySchema(db);

/* ── one fixture, deliberately full of the shapes that break things ─────── */
const D = (n) => new Date(Date.UTC(2026, 7, n)).toISOString().slice(0, 10);
let tn = 0;
const trip = (o) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
     requested_at, ended_at, distance_km, duration_s, status, product, payment_type, price,
     pickup_addr, dropoff_addr)
   VALUES ($1,$2,'ecosine',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
           'Dubai Marina - Dubai - UAE','DXB T3 - Dubai - UAE')`,
  [o.platform, `c${tn++}`, o.plate ?? null, o.drv ?? null, o.name ?? null, o.at, o.end ?? null,
   o.km ?? 12, o.dur ?? 900, o.status ?? 'completed', o.product ?? null, o.pay ?? null, o.price ?? null]);

// Two drivers, three plates, across the whole of August.
for (let d = 1; d <= 20; d++) {
  await trip({ platform: 'uber', plate: 'L100', drv: 'u1', name: 'Ann Ahmed',
    at: `${D(d)}T09:00:00+04:00`, km: 12, status: 'completed' });
  await trip({ platform: 'uber', plate: 'L200', drv: 'u2', name: 'Bob Bakr',
    at: `${D(d)}T19:00:00+04:00`, km: 18, status: 'completed' });
}
// Bolt says 'finished', which a naive completion test scores as a failure.
await trip({ platform: 'bolt', plate: 'L100', drv: 'b1', name: 'Ann Ahmed',
  at: `${D(5)}T21:00:00+04:00`, status: 'finished', price: 60, pay: 'cash' });
await trip({ platform: 'bolt', plate: 'L100', drv: 'b1', name: 'Ann Ahmed',
  at: `${D(6)}T21:00:00+04:00`, status: 'client_did_not_show', price: null, pay: 'cash' });
// A telematics twin of a journey a platform already reported.
await trip({ platform: 'fms', plate: 'L100', at: `${D(7)}T09:05:00+04:00`, km: 193027 });
// A 01:00 Dubai booking — 21:00 UTC the previous day.
await trip({ platform: 'uber', plate: 'L300', drv: 'u3', name: 'Cara Chen',
  at: `${D(15)}T01:00:00+04:00`, km: 30 });
// A plate that exists only in telemetry and documents — never booked.
await q(`INSERT INTO telemetry_snapshot (plate, fleet_id, source, captured_at, polled_at, lat, lng, speed)
         VALUES ('L900','ecosine','cabman', now() - interval '1 hour', now(), 25.1, 55.2, 0)`);
await q(`INSERT INTO vehicle_document (platform, vehicle_ext_id, doc_type, plate, fleet_id, status, expires_at)
         VALUES ('uber','v9','registration','L900','ecosine','ACTIVE', now()::date + 5)`);
await q(`INSERT INTO vehicle_profile (platform, vehicle_ext_id, plate, fleet_id, make, model, year)
         VALUES ('uber','v1','L100','ecosine','Tesla','Model Y',2024),
                ('uber','v2','L200','ecosine','BYD','Han EV',2025)`);
for (const [plate, drv, name] of [['L100', 'u1', 'Ann Ahmed'], ['L200', 'u2', 'Bob Bakr']]) {
  for (let d = 1; d <= 20; d++) {
    await q(`INSERT INTO vehicle_driver_day (plate, day, driver_ext_id, driver_name, platform, fleet_id, trips, km, revenue, is_primary)
             VALUES ($1,$2::date,$3,$4,'uber','ecosine',1,12,0,true)`, [plate, D(d), drv, name]);
  }
}

/* ── mount every route module against that one database ─────────────────── */
const app = express();
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(500).json({ error: String(e) }));
const endOfDay = (d) => `${d}T23:59:59.999Z`;
const range = (req) => [req.query.from || '2026-08-01', req.query.to || '2026-08-31',
  req.query.platform || null, req.query.fleet || null];
const W = (alias = '') => {
  const p = alias ? `${alias}.` : '';
  return `${p}local_day BETWEEN $1::date AND $2::date AND ($3::text IS NULL OR ${p}platform=$3) AND ($4::text IS NULL OR ${p}fleet_id=$4)`;
};
const F = W();
const FB = `${F} AND is_booking`;
const DAYWIN = (col) => `(${col} AT TIME ZONE 'Asia/Dubai')::date BETWEEN $1::date AND $2::date`;

/* Two routes live inline in server.js rather than in a module. They are
   extracted ONE AT A TIME and evaluated, so these checks run against the same
   SQL production runs rather than a restatement of it — a consistency test
   that reimplements the query it is checking proves only that I can write the
   same bug twice.

   Extracted individually rather than as a slab: a broad slice pulls in the
   file's own const declarations and collides with the ones passed in. */
/* The whole application, mounted the way production does — server.js's routes
   and every module in api/. This file used to extract two routes from
   server.js by hand and mount eleven modules by name, which meant a check
   written against /api/vehicles found no such route and died parsing Express's
   404 HTML as JSON. test/mount.mjs is the one mounting, shared. */
const { server, get: rawGet } = await mountAll(db);
const WIN = 'from=2026-08-01&to=2026-08-31';
/* Throws on a non-JSON body rather than letting JSON.parse report a stray "<"
   from Express's 404 page — the error should name the route that is missing. */
const get = async (p) => {
  const r = await rawGet(p);
  if (r.body == null) throw new Error(`${p} → ${r.status} ${r.raw || '(no body)'}`);
  return r.body;
};

/* ── 1. how many vehicles does this fleet have? ─────────────────────────── */
{
  const dir = await get(`/api/vehicles/directory?${WIN}`);
  const pb = await get(`/api/playbook?${WIN}`);
  check('the vehicle directory and the playbook count the same fleet',
    pb.fleet.vehicles_seen === dir.length, `playbook ${pb.fleet.vehicles_seen} vs directory ${dir.length}`);
  /* L900 has never booked — only a telemetry fix and a document. It is exactly
     the vehicle an idle-capacity action exists to find, and a fleet count that
     cannot see it understates the thing it is measuring. */
  check('a vehicle that has never booked is still part of the fleet',
    dir.some((v) => v.plate === 'L900'), JSON.stringify(dir.map((v) => v.plate)));
  check('and the playbook can see it too',
    pb.actions.find((a) => a.id === 'redeploy_idle_vehicles')?.detail
      ?.some((v) => v.plate === 'L900') ?? pb.fleet.vehicles_seen >= dir.length,
    JSON.stringify(pb.actions.find((a) => a.id === 'redeploy_idle_vehicles')?.detail));
}

/* ── 2. how many bookings on this plate? ────────────────────────────────── */
{
  const kpi = await get(`/api/vehicle/kpis?plate=L100&${WIN}`);
  const daily = await get(`/api/vehicle/daily?plate=L100&${WIN}`);
  const dailySum = daily.reduce((a, r) => a + (r.trips || 0), 0);
  check('a vehicle’s headline booking count matches the sum of its days',
    kpi.trips === dailySum, `${kpi.trips} vs ${dailySum}`);
  const dir = await get(`/api/vehicles/directory?${WIN}`);
  const row = dir.find((v) => v.plate === 'L100');
  check('and matches the directory row for the same plate',
    row.trips === kpi.trips, `${row.trips} vs ${kpi.trips}`);
  /* The FMS row on L100 is a telematics twin carrying 193,027 km. If any of
     these three counted it, they would disagree — and if all three counted it
     they would agree on a wrong number, which is why the km check is here. */
  check('none of them counts the telematics twin as a booking',
    kpi.trips === 22, `${kpi.trips} bookings — 20 uber + 2 bolt`);
  check('and none of them lets its odometer reading into the distance',
    Number(kpi.km) < 1000, String(kpi.km));
}

/* ── 3. how many bookings did this person take? ─────────────────────────── */
{
  const prof = await get(`/api/driver/profile?id=u1&${WIN}`);
  const kpi = await get(`/api/driver/kpis?id=u1&${WIN}`);
  const daily = await get(`/api/driver/daily?id=u1&${WIN}`);
  const dailySum = daily.reduce((a, r) => a + (r.trips || 0), 0);
  check('a driver’s headline count matches the sum of their days',
    kpi.trips === dailySum, `${kpi.trips} vs ${dailySum}`);
  /* Ann holds a uber id and a bolt id. Both pages fold by name, so both must
     see all 22 — a page that sees only the uber account reports a different
     person from the one whose name is at the top of it. */
  check('both accounts of the same person are folded on every page',
    prof.ids.length === 2 && kpi.trips === 22, `${prof.ids.length} ids, ${kpi.trips} trips`);

  const lb = await get(`/api/drivers/leaderboard?${WIN}`);
  const annRows = (lb.rows || []).filter((r) => /Ann/.test(r.driver_name || ''));
  const lbTotal = annRows.reduce((a, r) => a + r.trips, 0);
  check('the leaderboard’s rows for that person sum to the same total',
    lbTotal === kpi.trips, `${lbTotal} vs ${kpi.trips}`);
  /* And there is exactly ONE of them. Grouped per platform account, Ann was two
     rows carrying half her work each — so she ranked below a single-platform
     driver who did less, which is the one thing a ranking must not do. */
  check('and a person working two platforms is one row on the ranking, not two',
    annRows.length === 1, `${annRows.length} rows: ${JSON.stringify(annRows.map((r) => [r.driver_ext_id, r.trips]))}`);
  check('which names every channel they worked',
    (annRows[0]?.platforms || []).length === 2, JSON.stringify(annRows[0]?.platforms));
  check('and the response says how many people there are, not just how many it returned',
    typeof lb.people === 'number' && lb.people >= (lb.rows || []).length,
    `${lb.people} people, ${lb.shown} shown`);
  /* Bolt's 'finished' is a completion and 'client_did_not_show' is not. A page
     testing the raw string scores the first as a failure, so completion must
     agree between the driver page and the leaderboard. */
  const lbCompletion = annRows.reduce((a, r) => a + (Number(r.completion_pct) || 0) * r.trips, 0) / lbTotal;
  check('completion agrees between the driver page and the leaderboard',
    Math.abs(Number(kpi.completion_pct) - lbCompletion) < 1.5,
    `${kpi.completion_pct} vs ${lbCompletion.toFixed(1)}`);
  check('and Bolt’s "finished" counts as completed on both',
    Number(kpi.completion_pct) > 90, String(kpi.completion_pct));
}

/* ── 4. how much work happened on this day? ─────────────────────────────── */
{
  const day = await get('/api/day?day=2026-08-05');
  const daily = await get(`/api/trips/daily?${WIN}`);
  const row = daily.find((r) => String(r.d).slice(0, 10) === '2026-08-05');
  check('the day page and the daily series agree about that day',
    day.headline.bookings === row.trips, `${day.headline.bookings} vs ${row.trips}`);

  /* The 01:00 Dubai booking on the 15th is 21:00 UTC on the 14th. Every page
     that groups by day must put it on the 15th, or two pages disagree about
     which day it happened. */
  const d15 = await get('/api/day?day=2026-08-15');
  const r15 = daily.find((r) => String(r.d).slice(0, 10) === '2026-08-15');
  const r14 = daily.find((r) => String(r.d).slice(0, 10) === '2026-08-14');
  /* Every other day of the fixture carries two bookings. The 15th carries a
     third at 01:00 Dubai, which is 21:00 UTC on the 14th — so a UTC grouping
     puts it on the 14th and gives 3 and 2 the wrong way round. */
  check('a 01:00 Dubai booking lands on the Dubai day, on both pages',
    d15.headline.bookings === 3 && r15.trips === 3,
    `day page ${d15.headline.bookings}, series ${r15.trips}`);
  check('and the previous day keeps only its own two',
    (r14?.trips || 0) === 2, `${r14?.trips} on the 14th`);
  check('the two pages agree about both days',
    d15.headline.bookings === r15.trips
    && (await get('/api/day?day=2026-08-14')).headline.bookings === r14.trips);
}

/* ── 5. how many drivers are earning? ───────────────────────────────────── */
{
  const ret = await get('/api/retention');
  const pb = await get(`/api/playbook?${WIN}`);
  const roster = await get(`/api/roster?${WIN}`);
  const working = (roster.people || []).filter((p) => p.category === 'working').length;
  /* These three legitimately count different populations and the difference is
     a definition, not an accident — so the check is that each is internally
     consistent and none exceeds the number of people who actually booked. */
  const [{ n: booked }] = await q(
    `SELECT count(DISTINCT lower(regexp_replace(btrim(driver_name), '\\s+', ' ', 'g')))::int n
     FROM trip_norm WHERE is_booking AND coalesce(btrim(driver_name),'') <> ''
       AND local_day BETWEEN '2026-08-01' AND '2026-08-31'`);
  check('nobody reports more earning drivers than actually booked',
    working <= booked, `roster ${working} vs ${booked} who booked`);
  /* One month of fixture is not two complete months, so retention correctly
     refuses. A refusal is the right answer and is checked as one — an endpoint
     that invented a cohort curve from a single month would be worse than one
     that says it cannot. */
  if (!ret.ok) {
    check('retention refuses on a single month rather than inventing a cohort',
      /two complete months|cohort/.test(ret.reason || ''), ret.reason);
  } else {
    const lastFlow = (ret.flow || [])[ret.flow.length - 1];
    check('the retention flow never exceeds the people who booked',
      !lastFlow || lastFlow.active <= booked, `${lastFlow?.active} vs ${booked}`);
  }
}

/* ── 6. capped lists must not be summed into totals ─────────────────────── */
{
  const cash = await get(`/api/settlement/cash-exposure?${WIN}`);
  check('the cash total counts the table, not the returned page',
    cash.total_cash_trips >= cash.drivers.reduce((a, d) => a + d.cash_trips, 0),
    `${cash.total_cash_trips} vs ${cash.drivers.reduce((a, d) => a + d.cash_trips, 0)}`);
  check('and the driver count is its own number',
    typeof cash.driver_count === 'number', String(cash.driver_count));
}

/* ── 7. a rate must never exceed 100%, however small the denominator ────── */
{
  const paths = [
    `/api/vehicle/kpis?plate=L100&${WIN}`, `/api/driver/kpis?id=u1&${WIN}`,
    `/api/drivers/leaderboard?${WIN}`, `/api/day?day=2026-08-05`,
  ];
  const bad = [];
  for (const p of paths) {
    const body = await get(p);
    const walk = (o, path2 = '') => {
      if (o == null) return;
      if (Array.isArray(o)) return o.forEach((x, i) => walk(x, `${path2}[${i}]`));
      if (typeof o === 'object') {
        for (const [k, v] of Object.entries(o)) {
          if (/_pct$|^pct_|percentage/.test(k) && v != null && Number.isFinite(Number(v))
              && (Number(v) < 0 || Number(v) > 100)) bad.push(`${p} ${path2}.${k}=${v}`);
          walk(v, `${path2}.${k}`);
        }
      }
    };
    walk(body);
  }
  check('no percentage anywhere is negative or above 100', bad.length === 0, bad.join(' | '));
}

/* ── 8. one rule for who counts as one person ──────────────────────────── */
/* api/server.js declares CANON as a module-level const, so it cannot be
   imported — the whole file boots against a live pool. custody_sql.js exports
   the same fold as personFold for the queries that live elsewhere. Two copies
   of an identity rule is two answers about how many drivers a vehicle had, and
   the vehicle page reported seven for a car five humans drove. Extracted and
   evaluated rather than compared as source text, because whitespace and escape
   differences are not differences in the SQL that reaches Postgres. */
{
  const { readFileSync } = await import('node:fs');
  const src = readFileSync('api/server.js', 'utf8');
  const m = src.match(/const CANON = \(col\) => `[\s\S]*?`;/);
  check('api/server.js still declares CANON where this test can find it', !!m);
  if (m) {
    // eslint-disable-next-line no-new-func
    const CANON = new Function(`return ${m[0].replace(/^const CANON = /, '').replace(/;$/, '')}`)();
    const { personFold, personKey, peopleCount } = await import('../api/custody_sql.js');
    check('the shared person fold is byte for byte the one server.js uses',
      CANON('x') === personFold('x'), `${CANON('x')}\n      ${personFold('x')}`);
    check('the person key prefers the name and falls back to the id',
      personKey('i', 'n').includes('coalesce') && personKey('i', 'n').endsWith('i)'),
      personKey('i', 'n'));
    check('counting people counts distinct person keys, not distinct records',
      peopleCount('i', 'n').startsWith('count(DISTINCT coalesce('), peopleCount('i', 'n'));
  }
}

/* ── 9. a vehicle's driver count is people, not platform records ────────── */
/* Uber issues a UUID, Yango another, Bolt a third — for the same human. Every
   vehicle-side count of DISTINCT driver_ext_id therefore counted records. */
{
  await q(`INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
             requested_at, status, distance_km, price)
           VALUES ('uber','mp1','ecosine','L100','u-multi','Multi Platform Person',
                   '2026-08-07T09:00:00+04:00','completed',10,40),
                  ('yango','mp2','ecosine','L100','y-multi','Multi Platform Person',
                   '2026-08-07T15:00:00+04:00','completed',10,40)`);
  const { rebuildCustody } = await import('../src/custody.js');
  await rebuildCustody({ from: '2026-08-01', to: '2026-08-31', db });
  const det = await get(`/api/vehicle/drivers-detail?plate=L100&${WIN}`);
  const rows = (det.totals || []).filter((r) => /Multi Platform/.test(r.driver_name || ''));
  check('one human with two platform ids is one row on the vehicle page',
    rows.length === 1, JSON.stringify(rows.map((r) => [r.driver_ext_id, r.trips])));
  check('and that row carries both their trips, not one platform worth',
    rows[0]?.trips === 2, String(rows[0]?.trips));
  check('and stays openable, by every id they hold',
    Array.isArray(rows[0]?.driver_ids) && rows[0].driver_ids.length === 2,
    JSON.stringify(rows[0]?.driver_ids));
  const veh = await get(`/api/vehicles?${WIN}`);
  const l100 = (veh.rows || veh || []).find((r) => r.plate === 'L100');
  check('and the fleet table counts them once as well',
    l100 && l100.drivers === new Set((det.totals || []).map((r) => r.driver_name)).size,
    `${l100?.drivers} vs ${new Set((det.totals || []).map((r) => r.driver_name)).size}`);
}

server.close(); await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
