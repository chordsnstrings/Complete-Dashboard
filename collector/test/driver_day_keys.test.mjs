/* A DATE used as a key must carry its year.
   ─────────────────────────────────────────────────────────────────────────
   api/driver_routes.js built two keys out of DATE columns with
   `String(d).slice(0, 10)`. node-postgres — and PGlite, as this file
   demonstrates — parses a DATE into a JS Date, so those ten characters are
   "Tue Oct 01": the head of a Date toString, with the YEAR cut off. The same
   mistake shipped to production in src/sources/ledger.js and printed
   "covering days up to Fri Aug 21" on the Data-sources page.

   Neither key printed anything, so both were wrong in type while right in
   number — and right only while no two days in the window shared a
   (weekday, month, day). api/window.js accepts `days` up to 3660 and win()
   leaves an explicit from/to unclamped, so 2019-10-01 and 2024-10-01 — both a
   Tuesday, both "Tue Oct 01" — fit inside one window a caller can ask for
   today, and the fleet arrives there on its own once it holds six years.

   Two collisions, in two different routes, both with a number attached:

     /api/drivers/directory   the union of days a MULTI-ACCOUNT person worked.
                              Two accounts, two colliding days, one day worked.
     /api/driver/earnings     the (platform, period_start, period_end) join
                              from driver_payout_day onto driver_performance.
                              Two weeks, one performance row survives, and the
                              earnings table prints one week's rating and
                              acceptance rate against the other week too. */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
await applySchema(db);

/* The two colliding Tuesdays, and the two weeks they open. */
const A = { day: '2019-10-01', start: '2019-10-01', end: '2019-10-07' };
const B = { day: '2024-10-01', start: '2024-10-01', end: '2024-10-07' };

/* ── one human, two provider accounts, one colliding day each ─────────── */
const ACCOUNTS = [['uber', 'u-collide', A.day], ['yango', 'y-collide', B.day]];
for (const [platform, ext, day] of ACCOUNTS) {
  await db.query(
    `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
       requested_at, ended_at, distance_km, status, price, pickup_addr, dropoff_addr)
     VALUES ($1, $2, 'ecosine', 'L45240', $3, 'Collide Driver',
             $4::timestamptz, $5::timestamptz, 12, 'completed', 40,
             'A - Deira - Dubai - UAE', 'B - Al Barsha - Dubai - UAE')`,
    [platform, `collide-${ext}`, ext, `${day}T09:00:00+04:00`, `${day}T09:20:00+04:00`]);
}

/* What the database actually hands JavaScript, stated rather than assumed —
   this is the premise of the whole file and it is one query away. */
{
  const r = await db.query(
    `SELECT local_day FROM trip_norm ORDER BY local_day`);
  const raw = r.rows.map((x) => x.local_day);
  check('trip_norm.local_day arrives as JS Dates, not as strings',
    raw.length === 2 && raw.every((d) => d instanceof Date), JSON.stringify(raw));
  check('…so the old key drops the year and the two days collapse to one',
    new Set(raw.map((d) => String(d).slice(0, 10))).size === 1,
    JSON.stringify(raw.map((d) => String(d).slice(0, 10))));
}

/* ── the payout weeks, and the performance rows they must each find ───── */
for (const [w, acc, canc, rating] of [[A, 0.50, 0.20, 4.10], [B, 0.90, 0.05, 4.95]]) {
  await db.query(
    `INSERT INTO driver_payout_day (platform, fleet_id, driver_ext_id, driver_name, day,
       period_start, period_end, period_days, period_earnings, earnings, trips)
     VALUES ('uber', 'ecosine', 'u-collide', 'Collide Driver', $1::date,
             $2::date, $3::date, 7, 700, 100, 2)`, [w.day, w.start, w.end]);
  await db.query(
    `INSERT INTO driver_performance (platform, fleet_id, driver_ext_id, driver_name,
       period_start, period_end, acceptance_rate, cancellation_rate, rating)
     VALUES ('uber', 'ecosine', 'u-collide', 'Collide Driver', $1::date, $2::date, $3, $4, $5)`,
    [w.start, w.end, acc, canc, rating]);
}

const { get } = await mountAll(db);

/* ── the directory: a union of days, not of weekday labels ────────────── */
{
  const r = await get('/api/drivers/directory?from=2019-09-30&to=2024-10-02');
  check('the directory answers', r.status === 200,
    `${r.status} ${JSON.stringify(r.body || r.raw).slice(0, 200)}`);
  const row = (r.body || []).find((x) => (x.ids || []).length > 1);
  check('and folds the two accounts into one person',
    !!row && row.ids.length === 2, JSON.stringify((r.body || []).map((x) => x.ids)));
  check('who worked two days, not one', row?.days === 2, `days=${row?.days}`);
}

/* ── the earnings table: each week keeps its OWN rating ───────────────── */
{
  const r = await get('/api/driver/earnings?id=u-collide&from=2019-09-30&to=2024-10-08');
  check('the earnings route answers', r.status === 200,
    `${r.status} ${JSON.stringify(r.body || r.raw).slice(0, 200)}`);
  const periods = r.body?.periods || [];
  check('and lists both payout weeks', periods.length === 2,
    JSON.stringify(periods.map((p) => [p.period_start, p.period_end])));
  /* period_start comes back as a Date that Express has serialised, so the year
     is read off the front of the ISO string rather than trusted to a slice. */
  const year = (p) => String(p.period_start).slice(0, 4);
  const p19 = periods.find((p) => year(p) === '2019');
  const p24 = periods.find((p) => year(p) === '2024');
  check('the 2019 week carries the 2019 rating', p19?.rating === 4.10, `rating=${p19?.rating}`);
  check('the 2024 week carries the 2024 rating', p24?.rating === 4.95, `rating=${p24?.rating}`);
  check('and their acceptance rates are not the same number twice',
    p19?.acceptance_rate === 0.50 && p24?.acceptance_rate === 0.90,
    `${p19?.acceptance_rate} / ${p24?.acceptance_rate}`);
}

/* ── the form itself, so it cannot come back by a different route ─────── */
{
  /* Comments stripped first, so the notes that QUOTE the broken expression in
     order to explain it do not read as the expression coming back. */
  const code = readFileSync('api/driver_routes.js', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  /* A query parameter IS a string — /api/driver/day validates `?day=` with
     exactly this expression and is right to — so the ban is on the ones that
     do not come from req.query, which is where a pg DATE can reach. */
  const offenders = [...code.matchAll(/String\(([^)]*)\)\s*\.slice\(\s*0\s*,\s*10\s*\)/g)]
    .map((m) => m[0]).filter((m) => !/req\.query/.test(m));
  check('no Date is turned into a day by String().slice() in this module',
    offenders.length === 0,
    `${JSON.stringify(offenders)} — a pg DATE through String() is "Tue Oct 01"; use isoDay() or to_char in the SELECT`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
