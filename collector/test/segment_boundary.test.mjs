/* The evidence for an accusation, computed and thrown away.
   ─────────────────────────────────────────────────────────────────────────
   sql/schema_v8.sql says what an `unauthorized` verdict costs to issue: it
   "may only be issued when every booking channel reported in the window, the
   telemetry clock is sane, and the journey is BOUNDED ON BOTH SIDES by
   observed fixes". The classifier tests exactly that, on gapBefore/gapAfter.

   The number a reader needs to check it is boundary_gap_min — how far the
   observed record reaches either side of the journey. segmentise() computes
   it (src/reconcile.js:112), the column is declared, api/segment_routes.js
   selects it, and api/public/segments.js renders it as "Nearest telemetry
   boundary" — and the object written to the database omitted it. Three layers
   reading a field nothing wrote: null on all 300 production segments in every
   window, on the one page in this product that accuses a named driver of
   taking a car out unbooked.

   Asserted on the write path rather than on the shape, because the shape was
   never the problem: every layer above was already correct. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
await applySchema(db);

/* upsertMany takes a CLIENT out of the pool for its transaction, so patching
   pool.query alone is not enough — reconcile() writes through that path. */
const dbmod = await import('../src/db.js');
const real = { query: dbmod.pool.query, connect: dbmod.pool.connect };
dbmod.pool.query = (t, p) => db.query(t, p);
dbmod.pool.connect = async () => ({
  query: (t, p) => (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(String(t).trim())
    ? Promise.resolve({ rows: [] }) : db.query(t, p)),
  release: () => {},
});

/* CABMAN telemetry for one plate — the feed reconcile() reads — as a quiet
   hour, then a journey, then a quiet hour.
   Both boundaries are OBSERVED, so this journey can be judged — and the gap to
   each boundary is the thing the page has to be able to show. */
const DAY = '2026-08-14';
/* seat_occupied is what opens a journey — buildSegments keys on the seat
   sensor, not on ignition. */
const fix = (min, occupied) => q(
  `INSERT INTO telemetry_snapshot (source, plate, fleet_id, captured_at, lat, lng,
     ignition, seat_occupied, speed, odometer, polled_at)
   VALUES ('cabman', 'L44305', 'ecosine', $1::timestamptz, 25.1, 55.2, $2, $2, $3, $4, $1::timestamptz)`,
  [`${DAY}T${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}:00Z`,
    occupied, occupied ? 40 : 0, 1000 + min]);

/* A fix at 00:00 and 01:00 with the engine off — the observed floor and the
   observed ceiling — and a moving run between 02:00 and 02:20. */
await fix(0, false);
await fix(60, false);
for (let m = 120; m <= 140; m += 5) await fix(m, true);
await fix(200, false);
await fix(260, false);

const { reconcile } = await import('../src/reconcile.js');
await reconcile({ from: `${DAY}T00:00:00Z`, to: `${DAY}T23:59:59Z` });

console.log('\nthe boundary the verdict rests on reaches the database');

const segs = await q(
  `SELECT plate, verdict, boundary_gap_min, max_gap_min, fixes
     FROM occupancy_segment ORDER BY started_at`);
check('reconcile produced at least one journey', segs.length > 0, String(segs.length));
/* The whole fix. Written as `boundary_gap_min IS NOT NULL` rather than as a
   value, because the value depends on the fixture's spacing and the defect was
   that the column was NEVER written at all. */
check('every journey carries the boundary its verdict was judged against',
  segs.every((s) => s.boundary_gap_min != null),
  JSON.stringify(segs.map((s) => [s.verdict, s.boundary_gap_min])));
/* And it is a measurement, not a placeholder: these journeys sit between
   observed fixes an hour apart, so the gap is real minutes. */
check('…and it is the measured gap, not a zero standing in for one',
  segs.some((s) => Number(s.boundary_gap_min) > 0),
  JSON.stringify(segs.map((s) => s.boundary_gap_min)));
check('…never exceeding the largest gap inside the journey plus its own bounds',
  segs.every((s) => Number(s.max_gap_min) >= Number(s.boundary_gap_min)),
  JSON.stringify(segs.map((s) => [s.max_gap_min, s.boundary_gap_min])));

console.log('\nand the page that accuses somebody can read it');

const { get, server } = await mountAll(db, { serverRoutes: true });
const body = (await get(`/api/segments?from=${DAY}&to=${DAY}`)).body;
const rows = body.rows || [];
check('the endpoint returns the journeys', rows.length > 0, String(rows.length));
check('…each carrying the boundary, which was null on every production row',
  rows.every((r) => r.boundary_gap_min != null),
  JSON.stringify(rows.map((r) => r.boundary_gap_min)));

server.close();
dbmod.pool.query = real.query;
dbmod.pool.connect = real.connect;
await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
