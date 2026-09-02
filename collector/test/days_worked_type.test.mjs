/* days_worked is a count of DAYS, not of weekday-and-month labels.
   ─────────────────────────────────────────────────────────────────────────
   api/economics_routes.js aggregates the days a person drove in SQL —
   `array_agg(DISTINCT local_day)` over trip, a date[] — and folds those arrays
   together in JS, because one human holds several platform accounts and the
   query groups on the account. The fold used `String(d).slice(0, 10)` as the
   Set key.

   node-postgres (and PGlite, as this file demonstrates) parses a DATE into a
   JS Date, so those ten characters are "Tue Oct 01": the head of a Date
   toString, with the YEAR cut off. The same mistake shipped to production in
   src/sources/ledger.js and printed "covering days up to Fri Aug 21" on the
   Data-sources page.

   Here it did not print anything — only `.size` was read — so it was wrong in
   type while right in number, and it stayed right only while no two days in
   the window shared a (weekday, month, day). The fleet holds 702 days today
   (2024-10-01..2026-09-02) and those are all distinct. 2019-10-01 and
   2024-10-01 are not: both are a Tuesday, both "Tue Oct 01". api/window.js
   accepts `days` up to 3660, and from/to are unclamped, so that window is
   reachable now and arrives on its own once the fleet holds six years.

   One driver, two days, one row: days_worked must be 2. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
await applySchema(db);

/* The two colliding days, on one plate, under one name and one account. */
const DAYS = ['2019-10-01', '2024-10-01'];
for (const [i, d] of DAYS.entries()) {
  await db.query(
    `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
       requested_at, ended_at, distance_km, status, price, pickup_addr, dropoff_addr)
     VALUES ('uber',$1,'ecosine','L45240','u-collide','Collide Driver',
             $2::timestamptz, $3::timestamptz, 12, 'completed', 40,
             'A - Deira - Dubai - UAE','B - Al Barsha - Dubai - UAE')`,
    [`collide-${i}`, `${d}T09:00:00+04:00`, `${d}T09:20:00+04:00`]);
}

/* What the database actually hands JavaScript, stated rather than assumed —
   this is the whole premise of the test and it is one query away. */
const agg = await db.query(
  `SELECT array_agg(DISTINCT (requested_at AT TIME ZONE 'Asia/Dubai')::date) days FROM trip`);
const raw = agg.rows[0].days;
check('a date[] arrives as JS Dates, not as strings',
  Array.isArray(raw) && raw.every((d) => d instanceof Date),
  JSON.stringify(raw));
check('…so the old key drops the year and both days collapse to one',
  new Set(raw.map((d) => String(d).slice(0, 10))).size === 1,
  JSON.stringify(raw.map((d) => String(d).slice(0, 10))));

const { get } = await mountAll(db);
const r = await get('/api/economics/drivers?from=2019-10-01&to=2024-10-02');
check('the route answers', r.status === 200, `${r.status} ${JSON.stringify(r.body || r.raw).slice(0, 200)}`);
const row = (r.body?.rows || []).find((x) => x.driver_name === 'Collide Driver');
check('and carries the driver', !!row, JSON.stringify(r.body?.rows || []).slice(0, 200));
check('who worked two days, not one', row?.days_worked === 2, `days_worked=${row?.days_worked}`);
check('and the fleet total counts them both', r.body?.totals?.worked_days === 2,
  `worked_days=${r.body?.totals?.worked_days}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
