/* The feeds page's seat lookups are answered by an index made for them.
   ─────────────────────────────────────────────────────────────────────────
   /api/vehicles/feeds asks, per active car, when CABMAN's seat sensor, FMS's
   live seat count and FMS's per-journey seat count last reported. The only
   index those lookups could use was (source, plate, captured_at), which
   cannot tell a row with a seat reading from one without, so for a car whose
   sensor never reports Postgres walked back through the car's whole history
   — 15.9 s and 13.8 s for the page on production, 2026-09-29.
   sql/schema_v94.sql adds three partial indexes whose predicates are the
   lookups' own filters. What this checks is that the planner CAN use each one
   for the statement as FEEDS_SQL writes it — a partial index whose predicate
   the query does not imply is never chosen, whatever its name — and that the
   page answers exactly as before (an index changes no answer).

   REVERSION (run 2026-09-29): drop schema_v94.sql from src/schema_files.js —
   every "…is answered from its own index" check fails. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema, SCHEMA_FILES } from './schema.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
await applySchema(db);
check('schema_v94.sql is registered', SCHEMA_FILES.includes('schema_v94.sql'));

/* One car with a long history and no seat reading at all — the case that
   walked the whole history — and one reading on a second car. */
await db.exec(`
  INSERT INTO telemetry_snapshot (source, plate, fleet_id, captured_at, polled_at)
  SELECT s, 'L900', 'ecosine', now() - (g || ' minutes')::interval, now()
    FROM generate_series(1, 3000) g, unnest(ARRAY['cabman','fms']) s;
  INSERT INTO telemetry_snapshot (source, plate, fleet_id, captured_at, polled_at, seat_occupied, seat_count)
  VALUES ('cabman', 'L901', 'ecosine', now() - interval '5 minutes', now(), true, NULL),
         ('fms',    'L901', 'ecosine', now() - interval '6 minutes', now(), NULL, 1);
  ANALYZE telemetry_snapshot; ANALYZE trip;`);

/* The three lookups, word for word as FEEDS_SQL writes them, with the car
   bound as a parameter where the page correlates it. */
const LOOKUPS = [
  ['CABMAN seat', 'telemetry_cabman_seat_idx',
    `SELECT max(t.captured_at) FROM telemetry_snapshot t
      WHERE t.source = 'cabman' AND t.plate = $1
        AND t.seat_occupied IS NOT NULL AND t.captured_at <= now()`],
  ['FMS live seat', 'telemetry_fms_seat_idx',
    `SELECT max(t.captured_at) FROM telemetry_snapshot t
      WHERE t.source = 'fms' AND t.plate = $1 AND t.seat_count IS NOT NULL
        AND t.captured_at <= now()`],
  ['FMS journey seat', 'trip_fms_seat_end_idx',
    `SELECT max(coalesce(t.ended_at, t.requested_at)) FROM trip t
      WHERE t.platform = 'fms' AND t.plate = $1 AND t.seat_count IS NOT NULL
        AND coalesce(t.ended_at, t.requested_at) <= now()`],
];

console.log('\nthe seat lookups');
/* Sequential scans off, so the question is only WHICH index the planner can
   reach for — on a fixture this small a scan is cheap and would win anyway. */
await db.exec('SET enable_seqscan = off');
const src = (await import('node:fs')).readFileSync(new URL('../api/feed_routes.js', import.meta.url), 'utf8');
const flat = (s) => s.replace(/\s+/g, ' ').replace(/a\.plate/g, '$1').trim();
for (const [label, index, sql] of LOOKUPS) {
  const plan = (await db.query(`EXPLAIN ${sql}`, ['L900'])).rows.map((r) => r['QUERY PLAN']).join('\n');
  check(`${label} is answered from its own index`, plan.includes(index), plan.split('\n').slice(0, 3).join(' | '));
  check(`…and the statement is still the one the page runs`, flat(src).includes(flat(sql).replace(/^SELECT /, '')),
    flat(sql).slice(0, 80));
}
await db.exec('RESET enable_seqscan');

console.log('\nthe answers are the ones a scan gives');
for (const [label, , sql] of LOOKUPS) {
  const viaIndex = (await db.query(sql, ['L901'])).rows[0].max;
  await db.exec('SET enable_indexscan = off; SET enable_bitmapscan = off');
  const viaScan = (await db.query(sql, ['L901'])).rows[0].max;
  await db.exec('RESET enable_indexscan; RESET enable_bitmapscan');
  check(`${label}: same answer with the index as without`, String(viaIndex) === String(viaScan), `${viaIndex} vs ${viaScan}`);
}

await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
