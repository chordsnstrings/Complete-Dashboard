/* ── the index behind statusHistoryFrom(), and the plan it must produce ─────
   THE DEFECT THIS FILE EXISTS FOR, MEASURED ON PRODUCTION 2026-09-16.
   /api/unauthorized/attributed and /api/driver/unauthorized each call
   `SELECT min(at) FROM driver_status_event` — no WHERE — once per request.
   driver_status_event carried two indexes (sql/schema_v70.sql:88-89):
   (local_day, status) and (driver_ext_id, at DESC). Neither can serve a min()
   over the whole table, because `at` is the SECOND column of the only index
   that mentions it, so the query was a sequential scan.

   What that cost, timed end to end against the deployed API:

     window            segments   response
     days=1                   5      98.6 s
     days=3                  16      78.2 s
     days=30                123      84.1 s
     2020-01-01..02           0      67.0 s
     2019-01-01..02           0     109.1 s

   A window with ZERO segments — where the attribution ladder never runs at
   all, because there is no row to run it over — still cost 67 to 109 seconds.
   Every other query behind the route is bound by $1/$2; this min() is the only
   one that does not look at the window, and it is what the response waited on.

   TWO ASSERTIONS, BECAUSE THE INDEX EXISTING IS NOT THE INDEX BEING USED.
   A CREATE INDEX in a file nobody registered in src/schema_files.js never
   runs, and an index the planner declines is an index that fixed nothing. So
   this checks that the schema the SERVER applies produces it, and that the
   planner then reaches for it on the exact statement the API sends. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
await applySchema(db);

console.log('\nthe schema the server applies carries the index');

const idx = (await db.query(
  `SELECT indexname FROM pg_indexes WHERE tablename = 'driver_status_event'`)).rows
  .map((r) => r.indexname);
check('dse_at_idx exists after every registered migration has run',
  idx.includes('dse_at_idx'), JSON.stringify(idx));
/* The two v70 shipped with, asserted alongside it so that a future file which
   drops and rebuilds this table cannot quietly take them with it. */
check('and the two sql/schema_v70.sql added are still there',
  idx.includes('dse_day_idx') && idx.includes('dse_driver_idx'), JSON.stringify(idx));

console.log('\nand the planner uses it for the statement the API sends');

/* Enough rows that a sequential scan is a real alternative rather than a
   foregone conclusion on an empty table. Every row is distinct on the primary
   key (platform, driver_ext_id, at), as the provider's own entries are. */
const rows = [];
for (let i = 0; i < 4000; i += 1) {
  rows.push(`('uber','d${i % 200}','2026-09-14T00:00:00Z'::timestamptz + interval '${i} seconds','online')`);
}
await db.exec(`INSERT INTO driver_status_event (platform, driver_ext_id, at, status)
               VALUES ${rows.join(',')}`);
await db.exec('ANALYZE driver_status_event');

const plan = (await db.query(
  'EXPLAIN SELECT min(at) AS history_from FROM driver_status_event')).rows
  .map((r) => r['QUERY PLAN']).join('\n');
check('min(at) is answered from an index, not a sequential scan',
  /dse_at_idx/.test(plan) && !/Seq Scan on driver_status_event/.test(plan), plan);

/* And the answer is right, which is the thing a plan test can forget to ask.
   statusNote() prints this instant as "the status feed only reaches back to
   X", so a fast wrong answer would be a false sentence about the record. */
const [h] = (await db.query('SELECT min(at) AS at FROM driver_status_event')).rows;
check('and it is the first instant the table holds',
  new Date(h.at).toISOString() === '2026-09-14T00:00:00.000Z', String(h.at));

console.log(`\n${pass} passed, ${fail} failed`);
await db.close();
process.exit(fail ? 1 : 0);
