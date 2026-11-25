/* Two insights read per plate through an index, and say the same thing
   (2026-11-25, the audit's fix 3: vehicle_dormant and stale_tracker hit the
   120 s statement timeout on every run, 29 times in one night's log).
   ──────────────────────────────────────────────────────────────────────────
   Each query is held against the one it replaced, row for row, on a fixture
   built to catch a rewrite that is only nearly right:
     · a plate whose newest row is Uber's status row, not a tracker's;
     · a plate only Uber ever reported;
     · a plate whose newest tracker fix has no position (0,0);
     · a NULL poll time (DESC puts it first, in both);
     · a plate filed under two fleets, the newest fix deciding;
     · a car quiet for 31 days and one for 400, and one heard yesterday.

   Synthetic data only. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { DORMANT_SQL, STALE_SQL } from '../src/insights.js';
import { TRACKER_SOURCES_SQL, REAL_FIX } from '../api/telemetry_sql.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const pg = new PGlite();
await applySchema(pg);
const q = (t, p = []) => pg.query(t, p).then((r) => r.rows);
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine'),('egari','Egari') ON CONFLICT DO NOTHING`);
const fix = (source, plate, fleet, agoDays, { lat = 25.1, lng = 55.2, polled = 'same' } = {}) => q(
  `INSERT INTO telemetry_snapshot (source, plate, fleet_id, captured_at, polled_at, lat, lng)
   VALUES ($1, $2, $3, now() - ($4 || ' days')::interval,
           ${polled === null ? 'NULL' : `now() - ($4 || ' days')::interval + interval '1 minute'`}, $5, $6)`,
  [source, plate, fleet, String(agoDays), lat, lng]);

await fix('fms', 'L31', 'ecosine', 31);                      // quiet 31 days
await fix('fms', 'L31', 'ecosine', 40);
await fix('uber', 'L31', 'ecosine', 1);                      // Uber's status row, newer, not a signal
await fix('cabman', 'L400', 'egari', 400);                   // quiet 400 days
await fix('cabman', 'L400', 'ecosine', 500);                 // filed under another fleet, older
await fix('fms', 'LZERO', 'egari', 45, { lat: 0, lng: 0 });  // newest tracker fix lost lock
await fix('fms', 'LZERO', 'egari', 60);                      // last real position, older
await fix('uber', 'LUBER', 'ecosine', 90);                   // only Uber ever reported it
await fix('cabman', 'LNOW', 'ecosine', 1);                   // heard yesterday
await fix('cabman', 'LNULL', 'egari', 3);
await fix('cabman', 'LNULL', 'egari', 50, { polled: null }); // a NULL poll time

/* The queries they replaced, verbatim. */
const OLD_DORMANT = `SELECT plate,
            (array_agg(fleet_id ORDER BY captured_at DESC))[1] AS fleet_id,
            max(captured_at) last_seen,
            max(captured_at) FILTER (WHERE ${REAL_FIX()}) last_position
     FROM telemetry_snapshot
     WHERE plate IS NOT NULL AND source IN ${TRACKER_SOURCES_SQL}
     GROUP BY plate
     HAVING max(captured_at) < now() - interval '30 days'
     ORDER BY 3 DESC`;
const OLD_STALE = `SELECT DISTINCT ON (plate) plate, fleet_id, source, captured_at
     FROM telemetry_snapshot ORDER BY plate, polled_at DESC`;

const norm = (rows) => JSON.stringify(rows.map((r) => Object.fromEntries(Object.entries(r)
  .map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]))));
const oldD = await q(OLD_DORMANT); const newD = await q(DORMANT_SQL);
check('dormant: the same plates, fleets, last signals and last positions, in the same order',
  norm(oldD) === norm(newD) && oldD.length === 3, `\n    old ${norm(oldD)}\n    new ${norm(newD)}`);
check('…the lost-lock fix is a signal but not a position; Uber\'s rows are neither', newD.some((r) => r.plate === 'LZERO' && r.last_position < r.last_seen)
  && !newD.some((r) => r.plate === 'LUBER') && newD.find((r) => r.plate === 'L31'), JSON.stringify(newD));
check('…and the fleet is the newest fix\'s', newD.find((r) => r.plate === 'L400')?.fleet_id === 'egari');
const byPlate = (rows) => JSON.parse(norm([...rows].sort((a, b) => (a.plate < b.plate ? -1 : 1))));
const oldS = await q(OLD_STALE); const newS = await q(STALE_SQL);
check('stale: the newest-polled row per plate, the same as the DISTINCT ON', JSON.stringify(byPlate(oldS)) === JSON.stringify(byPlate(newS)) && oldS.length === 6,
  `\n    old ${JSON.stringify(byPlate(oldS))}\n    new ${JSON.stringify(byPlate(newS))}`);
check('…a NULL poll time still sorts first, as DESC put it', byPlate(newS).find((r) => r.plate === 'LNULL') && byPlate(oldS).find((r) => r.plate === 'LNULL')?.captured_at === byPlate(newS).find((r) => r.plate === 'LNULL')?.captured_at);

/* The index the stale read is served by exists — v27's, not a twin (the
   review of 2026-11-25: v131 first added a duplicate). Exactly one index on
   (plate, polled_at DESC). On a table this small the planner may still choose
   a scan, so the speed is measured on production, not asserted here. */
const idx = await q(`SELECT indexname FROM pg_indexes WHERE tablename = 'telemetry_snapshot'
  AND regexp_replace(indexdef, '^.* USING btree ', '') = '(plate, polled_at DESC)'`);
check('one index serves the stale read, v27\'s, and no twin of it', idx.length === 1 && idx[0].indexname === 'telemetry_plate_polled_idx', JSON.stringify(idx));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
