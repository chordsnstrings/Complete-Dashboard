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

/* THE SAME ROW, FOUND WITHOUT SORTING THE TABLE (2026-09-29).
   ─────────────────────────────────────────────────────────────────────────
   /api/live and /api/kpis used to ask DISTINCT ON (plate) over every fix ever
   taken — 657,000 rows on production, 24.7 s and 57.1 s for the live map —
   and now skip through the index one plate at a time (api/telemetry_sql.js).
   What must not change is WHICH row each plate gets, so the rule the old
   query wrote down is kept here as the reference, and both endpoints are
   compared with it row for row on a fixture with the cases a rewrite gets
   wrong: a plate whose only fixes are in the future, two feeds reporting one
   plate at the same instant (the poll time decides), and a poll time that is
   NULL (which sorts FIRST under DESC, as it did before).
   REVERSION (run 2026-09-29): in LATEST_FIX, drop the second branch (future
   fixes) — "a plate whose only fixes are in the future still appears" fails;
   swap the branch ranks — "every plate gets the row the old query chose"
   fails; in /api/kpis use max over past fixes only — "the KPI counts match"
   fails. */
console.log('\nlive: the same row per plate as the DISTINCT ON it replaced');
/* Every time from ONE instant taken here, so "the same instant" is an exact
   tie and not two now()s a few milliseconds apart. */
const BASE = Date.now();
const at = (min) => (min == null ? null : new Date(BASE - min * 60000).toISOString());
const put = (src, plate, capMin, pollMin, lng) => q(
  `INSERT INTO telemetry_snapshot (source, plate, fleet_id, captured_at, polled_at, lat, lng)
   VALUES ($1, $2, 'ecosine', $3::timestamptz, $4::timestamptz, 25.0, $5)`,
  [src, plate, at(capMin), at(pollMin), lng]);
await put('cabman', 'L300', -30, 1, 55.51);              // only future fixes
await put('cabman', 'L300', -90, 1, 55.52);
await put('cabman', 'L400', 10, 9, 55.61);               // two feeds, same instant:
await put('fms', 'L400', 10, 2, 55.62);                  //   the later poll wins
await put('cabman', 'L500', 20, null, 55.71);            // same instant, NULL poll time:
await put('fms', 'L500', 20, 1, 55.72);                  //   NULL sorts first under DESC
await put('fms', 'L500', 400, 1, 55.73);
const ref = await q(`SELECT DISTINCT ON (plate) plate, source, lng
                       FROM telemetry_snapshot
                      ORDER BY plate, (captured_at <= now()) DESC, captured_at DESC, polled_at DESC`);
const live2 = (await get('/api/live')).body;
const pick = (rs) => JSON.stringify(rs.map((r) => [r.plate, r.source, Number(r.lng)]));
check('every plate gets the row the old query chose', pick(live2) === pick(ref),
  `${pick(live2)}\n     vs ${pick(ref)}`);
check('a NULL poll time wins an exact tie, as it did under DESC before',
  live2.some((r) => r.plate === 'L500' && r.source === 'cabman'), pick(live2));
check('a plate whose only fixes are in the future still appears, with its latest-dated fix',
  live2.some((r) => r.plate === 'L300' && Number(r.lng) === 55.52), pick(live2));

const kref = (await q(`SELECT
    count(*) FILTER (WHERE now() - captured_at < interval '30 minutes')::int live,
    count(*) FILTER (WHERE now() - captured_at >= interval '1 day')::int silent,
    count(*)::int tracked
  FROM (SELECT DISTINCT ON (plate) plate, captured_at FROM telemetry_snapshot
         ORDER BY plate, captured_at DESC) s`))[0];
const k = (await get('/api/kpis?from=2000-01-01&to=2100-01-01')).body;
const kk = k.vehicles_reporting || k;
check('the KPI counts match the DISTINCT ON they replaced',
  kk.tracked_vehicles === kref.tracked && kk.live_vehicles === kref.live && kk.silent_vehicles === kref.silent,
  `${JSON.stringify({ tracked: kk.tracked_vehicles, live: kk.live_vehicles, silent: kk.silent_vehicles })} vs ${JSON.stringify(kref)}`);

server.close();
await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
