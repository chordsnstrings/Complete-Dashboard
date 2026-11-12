/* schema_v115: the retention tables, and the duplicate index — which one the
   planner uses, proved here rather than asserted in a comment.
   ═════════════════════════════════════════════════════════════════════════
   The audit of 2026-11-12 named two "duplicate" index pairs. The brief allowed
   either to be dropped only with proof of which one the planner uses and that
   regenerating schema_v53.sql cannot recreate a conflict. This file is that
   proof, on PGlite (real Postgres planner, compiled to WASM):

     1. telemetry_snapshot's two (plate, captured_at DESC) indexes are twins;
        the planner uses the newer one on a tie (measured — the first draft
        said the older) and the smaller one when sizes differ; the database's
        own scan counters show which one served the reads; v115 drops the
        other, and the plan keeps its shape.
     2. trip's Dubai-day pair is NOT a twin pair: the planner reads the small
        plain index for a key-only day range, so it stays.
     3. Re-running schema_v53.sql after v115 (what every register change does)
        leaves the telemetry index set alone.

   REVERSION: in schema_v115.sql swap the two names in the size CASE (drop the
   smaller instead of the larger) and section 3's "drops the bigger one"
   fails; delete the two zero-scan WHEN lines and "the never-scanned twin is
   dropped" fails; delete the final SELECT and section 2 fails. */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { SCHEMA_FILES } from '../src/schema_files.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const sql = (f) => readFileSync(new URL(`../sql/${f}`, import.meta.url), 'utf8');

const db = new PGlite();
const V115 = 'schema_v115.sql';
/* Registered in numeric order, straight after v114 — production applies it
   there. It was "registered last" until the 2026-11-12 batch merged v116–v124
   after it; this file applies v115 last regardless, to measure its effect. */
check('v115 is registered, straight after v114', SCHEMA_FILES.indexOf(V115) === SCHEMA_FILES.indexOf('schema_v114.sql') + 1
  && SCHEMA_FILES.indexOf(V115) > 0, SCHEMA_FILES.slice(SCHEMA_FILES.indexOf('schema_v114.sql'), SCHEMA_FILES.indexOf('schema_v114.sql') + 3).join(' '));
for (const f of SCHEMA_FILES) { if (f !== V115) await db.exec(sql(f)); }

const telemIdx = async () => (await db.query(
  `SELECT indexname FROM pg_indexes WHERE tablename = 'telemetry_snapshot'
     AND indexdef ~ '\\(plate, captured_at DESC\\)$' ORDER BY indexname`)).rows.map((r) => r.indexname);
const planOf = async (q) => {
  await db.exec('SET enable_seqscan = off; SET enable_bitmapscan = off;');
  const rows = (await db.query(`EXPLAIN ${q}`)).rows.map((r) => r['QUERY PLAN']).join('\n');
  await db.exec('RESET enable_seqscan; RESET enable_bitmapscan;');
  return rows;
};
const usedIndex = (plan) => (plan.match(/using (\w+) on/i) || [])[1] || null;

console.log('\n1. telemetry_snapshot carries the pair before v115, and they are twins');
const before = await telemIdx();
check('both (plate, captured_at DESC) indexes exist before v115',
  before.includes('telem_plate_time_idx') && before.includes('telemetry_plate_captured_idx'), before.join(' '));
const defs = (await db.query(
  `SELECT regexp_replace(indexdef, '^CREATE INDEX \\S+ ', '') AS d FROM pg_indexes
    WHERE indexname IN ('telem_plate_time_idx', 'telemetry_plate_captured_idx')`)).rows.map((r) => r.d);
check('their definitions are identical once the name is cut out', defs.length === 2 && defs[0] === defs[1], defs.join(' | '));

/* A realistic little poll stream: 6 cars, a fix every 2 minutes for a day. */
await db.exec(`INSERT INTO telemetry_snapshot (source, plate, captured_at, lat, lng, speed)
  SELECT 'fms', 'L' || (1000 + c), timestamptz '2026-10-01 00:00+04' + make_interval(mins => 2 * m), 25.2, 55.3, (m % 7)
    FROM generate_series(1, 6) c, generate_series(0, 719) m;
  ANALYZE telemetry_snapshot;`);
const LATEST = `SELECT * FROM telemetry_snapshot WHERE plate = 'L1003' ORDER BY captured_at DESC LIMIT 1`;
const planBefore = await planOf(LATEST);
const chosen = usedIndex(planBefore);
/* MEASURED, and it overturned the first draft of v115's comment, which said
   the planner keeps the older twin on a tie. It keeps the newer. */
check('on an exact tie the planner uses the NEWER twin (schema_v7.sql)', chosen === 'telemetry_plate_captured_idx', planBefore);
/* Now run the read for real, so the database's own counters see which twin
   serves it — the evidence v115 reads on production. */
const scans = async (names) => {
  await db.query('SELECT pg_stat_force_next_flush()');
  const r = (await db.query(`SELECT indexrelname AS n, idx_scan::int AS s FROM pg_stat_user_indexes
    WHERE indexrelname = ANY($1::text[])`, [names])).rows;
  return Object.fromEntries(r.map((x) => [x.n, x.s]));
};
for (let i = 0; i < 3; i++) await db.query(LATEST);
const sc = await scans(['telem_plate_time_idx', 'telemetry_plate_captured_idx']);
check('the counters agree: the chosen twin served the scans, the other none',
  sc[chosen] >= 3 && sc[chosen === 'telem_plate_time_idx' ? 'telemetry_plate_captured_idx' : 'telem_plate_time_idx'] === 0,
  JSON.stringify(sc));

console.log('\n2. v115 drops the other one, and the plan keeps its shape');
await db.exec(sql(V115));
const after = await telemIdx();
check('exactly one (plate, captured_at DESC) index remains', after.length === 1, after.join(' '));
check('and it is the one the planner was using', after[0] === chosen, `${after[0]} vs ${chosen}`);
const planAfter = await planOf(LATEST);
check('the latest-fix read still walks that index backwards',
  usedIndex(planAfter) === chosen && /Backward|Index Scan/i.test(planAfter), planAfter);
const again = (await db.query(
  `SELECT retention_drop_duplicate_index('telem_plate_time_idx', 'telemetry_plate_captured_idx') AS r`)).rows[0].r;
check('calling it again is a no-op that says so', /^nothing to do/.test(again), again);

console.log('\n3. with no counter evidence, the size rule: the bigger twin is the one dropped');
await db.exec(`CREATE TABLE twin (id serial PRIMARY KEY, k int, t timestamptz);
  CREATE INDEX twin_a ON twin (k, t DESC);
  CREATE INDEX twin_b ON twin (k, t DESC);
  INSERT INTO twin (k, t) SELECT g % 50, now() - make_interval(secs => g) FROM generate_series(1, 20000) g;
  DELETE FROM twin WHERE id % 4 <> 0;
  REINDEX INDEX twin_b;`);
await db.exec('VACUUM ANALYZE twin');
const sizes = (await db.query(
  `SELECT pg_relation_size('twin_a') AS a, pg_relation_size('twin_b') AS b`)).rows[0];
check('twin_a (older) is bigger than the freshly rebuilt twin_b', Number(sizes.a) > Number(sizes.b), JSON.stringify(sizes));
const twinPlan = await planOf(`SELECT * FROM twin WHERE k = 7 ORDER BY t DESC LIMIT 1`);
check('the planner prefers the SMALLER twin, older or not', usedIndex(twinPlan) === 'twin_b', twinPlan);
const r3 = (await db.query(`SELECT retention_drop_duplicate_index('twin_a', 'twin_b') AS r`)).rows[0].r;
check('the function drops the bigger one and keeps the one in use', r3 === 'dropped twin_a, kept twin_b', r3);

/* A ZERO beside served scans outranks size: on production both twins have
   existed for months, so one that never served a scan is one the planner
   never picked, whatever its size today. Contrived here by building the
   second twin after the scans. */
await db.exec(`CREATE TABLE twin2 (id serial PRIMARY KEY, k int, t timestamptz);
  INSERT INTO twin2 (k, t) SELECT g % 50, now() - make_interval(secs => g) FROM generate_series(1, 20000) g;
  CREATE INDEX twin_d ON twin2 (k, t DESC);
  DELETE FROM twin2 WHERE id % 4 <> 0;`);
await db.exec('VACUUM ANALYZE twin2');
await db.exec('SET enable_seqscan = off; SET enable_bitmapscan = off;');
for (let i = 0; i < 3; i++) await db.query('SELECT * FROM twin2 WHERE k = 9 ORDER BY t DESC LIMIT 1');
await db.exec('RESET enable_seqscan; RESET enable_bitmapscan;');
await db.exec('CREATE INDEX twin_e ON twin2 (k, t DESC)');
await db.exec('VACUUM ANALYZE twin2');
const de = (await db.query(`SELECT pg_relation_size('twin_d') AS d, pg_relation_size('twin_e') AS e`)).rows[0];
const sde = await scans(['twin_d', 'twin_e']);
check('setup: twin_d is the bigger one and the only one with scans',
  Number(de.d) > Number(de.e) && sde.twin_d >= 3 && sde.twin_e === 0, JSON.stringify({ ...de, ...sde }));
const r5 = (await db.query(`SELECT retention_drop_duplicate_index('twin_d', 'twin_e') AS r`)).rows[0].r;
check('the never-scanned twin is dropped even though it is the smaller', r5 === 'dropped twin_e, kept twin_d', r5);

await db.exec(`CREATE INDEX twin_c ON twin (k, t);`);
const r4 = (await db.query(`SELECT retention_drop_duplicate_index('twin_b', 'twin_c') AS r`)).rows[0].r;
check('a different column order is not a twin and nothing is dropped', /^kept both/.test(r4), r4);

console.log('\n4. the trip Dubai-day pair is not a duplicate, and stays');
const tripIdx = (await db.query(
  `SELECT indexname FROM pg_indexes WHERE tablename = 'trip'
     AND indexdef LIKE '%(((requested_at AT TIME ZONE ''Asia/Dubai''::text))::date)%'
   ORDER BY indexname`)).rows.map((r) => r.indexname);
check('trip_local_day_idx (v7) and trip_econ_day_idx (v30/v53) are both still there',
  tripIdx.includes('trip_local_day_idx') && tripIdx.includes('trip_econ_day_idx'), tripIdx.join(' '));
await db.exec(`INSERT INTO trip (platform, external_id, fleet_id, plate, driver_name, requested_at, price, distance_km, status)
  SELECT 'uber', 'u' || g, 'ecosine', 'L' || (g % 40), 'Driver number ' || (g % 90),
         timestamptz '2026-09-01 00:00+04' + make_interval(mins => 7 * g), 30 + g % 20, 12.5, 'completed'
    FROM generate_series(1, 6000) g;`);
await db.exec('VACUUM ANALYZE trip');
const tsz = (await db.query(
  `SELECT pg_relation_size('trip_local_day_idx') AS plain, pg_relation_size('trip_econ_day_idx') AS covering`)).rows[0];
check('the covering index is several times the size of the plain one',
  Number(tsz.covering) > 2 * Number(tsz.plain), JSON.stringify(tsz));
const dayPlan = await planOf(`SELECT count(*) FROM trip
  WHERE ((requested_at AT TIME ZONE 'Asia/Dubai')::date) BETWEEN '2026-09-03' AND '2026-09-09'`);
check('a key-only Dubai-day range reads the small plain index', usedIndex(dayPlan) === 'trip_local_day_idx', dayPlan);

console.log('\n5. regenerating schema_v53.sql cannot bring the dropped twin back');
const v53 = sql('schema_v53.sql');
const gen = readFileSync(new URL('../bin/gen-schema-v53.mjs', import.meta.url), 'utf8');
check('neither v53 nor its generator names a telemetry index',
  !/telemetry_snapshot|telem_plate_time_idx|telemetry_plate_captured_idx/.test(v53)
  && !/telemetry_snapshot|telem_plate_time_idx|telemetry_plate_captured_idx/.test(gen));
await db.exec(v53);
check('re-running v53 after v115 leaves the single telemetry twin alone', (await telemIdx()).join() === after.join(),
  (await telemIdx()).join(' '));

console.log('\n6. the record tables');
const cols = async (t) => (await db.query(
  `SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [t])).rows.map((r) => r.column_name);
const rt = await cols('retention_run_table');
check('retention_run_table carries considered, would_delete and deleted per table',
  ['considered', 'would_delete', 'deleted', 'tbl', 'policy', 'cutoff'].every((c) => rt.includes(c)), rt.join(','));
const rs = await cols('retention_state');
check('retention_state carries the boundary pages read', ['tbl', 'action', 'done_before', 'bucket_min'].every((c) => rs.includes(c)),
  rs.join(','));
await db.exec(sql(V115));
check('v115 replays cleanly over itself (an edited ledger re-runs a file once)', true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
