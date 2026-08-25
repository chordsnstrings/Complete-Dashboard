/* ── the live map could show a position older than one it already held ─────
   CABMAN returns the last known position of EVERY vehicle on EVERY cycle, so
   polled_at is fresh for all 130 plates every five minutes whether or not the
   tracker actually reported anything. /api/live picked one row per plate with

     DISTINCT ON (plate) * FROM telemetry_snapshot ORDER BY plate, polled_at DESC

   and every row from the same cycle ties on polled_at. Which one Postgres keeps
   under a tie is arbitrary, so the map could show a stale position while a
   newer fix for the same vehicle sat in the table — and nothing on the page
   would say so, because the row it chose carried its own captured_at and the
   staleness banner agreed with it.

   captured_at is what the tracker says the time was, and it is the only column
   that orders POSITIONS. A fix captured in the future is a tracker whose clock
   runs ahead of ours rather than a newer position, so those must not win
   forever — the same distinction src/reconcile.js draws between skew and age. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
await applySchema(db);

let n = 0;
const fix = (plate, capturedMinAgo, polledMinAgo, lat, lng) => q(
  `INSERT INTO telemetry_snapshot (source, plate, fleet_id, captured_at, polled_at, lat, lng, speed, status)
   VALUES ('cabman', $1, 'ecosine', now() - ($2 || ' minutes')::interval,
           now() - ($3 || ' minutes')::interval, $4, $5, 0, 'ok')`,
  [plate, String(capturedMinAgo), String(polledMinAgo), lat, lng]);

/* One plate, three rows from the SAME poll cycle — which is exactly what
   CABMAN produces. The newest fix is 4 minutes old; a 90-minute-old one shares
   its polled_at and, under the old ordering, could win the tie. */
await fix('L100', 90, 2, 25.10, 55.20);
await fix('L100', 40, 2, 25.11, 55.21);
await fix('L100', 4, 2, 25.19, 55.29);

/* A second plate whose tracker clock runs an hour AHEAD of ours. The "newest"
   captured_at there is in the future and describes nothing. */
await fix('L200', -60, 3, 25.30, 55.40);      // captured 60 min in the future
await fix('L200', 7, 3, 25.31, 55.41);        // the real newest fix

const { server, get } = await mountAll(db, { serverRoutes: true });
const res = await get('/api/live');
check('the endpoint answers', res.status === 200, JSON.stringify(res.body).slice(0, 120));
const rows = Array.isArray(res.body) ? res.body : (res.body.rows || []);
const byPlate = Object.fromEntries(rows.map((r) => [r.plate, r]));

console.log('\nlive: one row per plate, and it is the newest FIX');

check('one row per plate', rows.length === 2, String(rows.length));
check('the four-minute-old fix wins, not whichever row shared its poll time',
  Number(byPlate.L100?.lng) === 55.29, JSON.stringify(byPlate.L100?.lng));
check('and its reported age is that of the chosen fix',
  byPlate.L100 && byPlate.L100.fix_age_min <= 6, String(byPlate.L100?.fix_age_min));

console.log('\nlive: a clock running ahead is not a newer position');

check('a fix captured in the future does not win',
  Number(byPlate.L200?.lng) === 55.41, JSON.stringify(byPlate.L200?.lng));
check('so the age shown is a real age rather than a negative one',
  byPlate.L200 && byPlate.L200.fix_age_min >= 0, String(byPlate.L200?.fix_age_min));

console.log('\nlive: the ordering is deterministic');

const again = await get('/api/live');
const rows2 = Array.isArray(again.body) ? again.body : (again.body.rows || []);
check('the same query twice returns the same rows — a tie broken arbitrarily '
  + 'is a map that moves on refresh',
  JSON.stringify(rows2.map((r) => [r.plate, r.lat, r.lng]))
  === JSON.stringify(rows.map((r) => [r.plate, r.lat, r.lng])));

console.log('\nlive: staleness is a property of the fix, not of our poll');

check('poll age and fix age are reported separately, so "our collector is down" '
  + 'and "this tracker stopped reporting" stay two different states',
  rows.every((r) => 'fix_age_min' in r && 'poll_age_min' in r));
check('and the fresh poll on a stale fix does not hide it',
  byPlate.L100.poll_age_min <= 3 && byPlate.L100.fix_age_min >= 0);

const src = (await import('node:fs')).readFileSync('api/server.js', 'utf8');
check('the ordering column is captured_at, not polled_at',
  /DISTINCT ON \(plate\)[\s\S]{0,200}ORDER BY plate, \(captured_at <= now\(\)\) DESC, captured_at DESC/.test(src));

server.close();
await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
