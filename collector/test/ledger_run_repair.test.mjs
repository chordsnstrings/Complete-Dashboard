/* ── the run row that counted the whole table, repaired ────────────────────
   Production /api/status on 2026-09-02 read

     ledger  ecosine  import  ok  39,797 rows  finished 2026-08-24 09:00 UTC

   and 39,797 was `SELECT count(*) FROM driver_statement_day WHERE source =
   'ledger'` — the size of the table, under a hard-coded fleet, whatever the
   workbook held. api/server.js writes the honest shape now, but nothing
   schedules a ledger import, so the row already recorded goes on saying the
   old thing indefinitely. sql/schema_v52.sql repairs it from the one thing the
   table can still prove: ingested_at, which the importer stamps on every row
   it writes and resets on every row it rewrites.

   What is asserted here is the derivation AND its limits — an older import
   whose rows have since been overwritten must not be given a made-up count,
   and running the file twice must not double anything. */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { applySchema } from './schema.mjs';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
await applySchema(db);

const MIGRATION = readFileSync('sql/schema_v52.sql', 'utf8');
const apply = () => db.exec(MIGRATION);

/* Two imports. The older one wrote three days in November; the newer one
   rewrote one of them and added two more, so the older import's rows carry the
   NEWER import's ingested_at — which is exactly why only the latest is
   derivable. */
const OLD_AT = '2026-08-10T09:00:00Z';
const NEW_AT = '2026-08-24T09:00:09.118Z';
const day = async (fleet, name, d, at) => q(
  `INSERT INTO driver_statement_day (platform, fleet_id, driver_name, day, net, source, ingested_at)
   VALUES ('uber',$1,$2,$3::date,100,'ledger',$4::timestamptz)`, [fleet, name, d, at]);

await day('ecosine', 'A One', '2025-11-01', NEW_AT);
await day('ecosine', 'A Two', '2025-11-02', NEW_AT);
await day('ecosine', 'A Three', '2026-02-08', NEW_AT);
await day('egari', 'B One', '2025-12-15', NEW_AT);
// Rows the older import wrote and the newer one never touched.
await day('egari', 'B Two', '2025-10-02', OLD_AT);
// A row from a different source, which this must not count.
await q(`INSERT INTO driver_statement_day (platform, fleet_id, driver_name, day, net, source, ingested_at)
         VALUES ('uber','ecosine','C One','2026-03-01',100,'uber_report',$1::timestamptz)`, [NEW_AT]);

const oldShape = async (at) => q(
  `INSERT INTO collection_run (source, fleet_id, mode, status, rows_written, started_at, finished_at)
   SELECT 'ledger','ecosine','import','ok', count(*), $1::timestamptz, $1::timestamptz
     FROM driver_statement_day WHERE source='ledger'`, [at]);
await oldShape(OLD_AT);
await oldShape(NEW_AT);

const before = await q(`SELECT rows_written, fleet_id FROM collection_run
                        WHERE source='ledger' ORDER BY finished_at DESC`);
check('the shape being repaired is the one production had — a table count under a hard-coded fleet',
  before.length === 2 && before[0].rows_written === 5 && before[0].fleet_id === 'ecosine',
  JSON.stringify(before));

await apply();

const runs = await q(
  `SELECT fleet_id, rows_written, to_char(window_start,'YYYY-MM-DD') s,
          to_char(window_end,'YYYY-MM-DD') e, to_char(finished_at,'YYYY-MM-DD') f
     FROM collection_run WHERE source='ledger' ORDER BY finished_at DESC, fleet_id`);

check('the latest import becomes one run per fleet it actually wrote for',
  runs.filter((r) => r.f === '2026-08-24').map((r) => r.fleet_id).join(',') === 'ecosine,egari',
  JSON.stringify(runs));
check('carrying the rows THAT import wrote, not the size of the table',
  runs[0].rows_written === 3 && runs[1].rows_written === 1,
  runs.map((r) => `${r.fleet_id}:${r.rows_written}`).join(' '));
check('and the days those rows cover, which the old row had no column filled for',
  runs[0].s === '2025-11-01' && runs[0].e === '2026-02-08'
  && runs[1].s === '2025-12-15' && runs[1].e === '2025-12-15',
  runs.map((r) => `${r.s}..${r.e}`).join(' '));
check('a row from another source is not counted into the ledger import',
  runs[0].rows_written + runs[1].rows_written === 4,
  String(runs[0].rows_written + runs[1].rows_written));

const older = runs.find((r) => r.f === '2026-08-10');
check('the older import is left exactly as it was, because its rows have since '
  + 'been overwritten and the attribution is genuinely gone',
  older && older.rows_written === 5 && older.s === null, JSON.stringify(older));
check('...and nothing a reader sees comes from it — /api/status is DISTINCT ON '
  + '(source, mode, fleet_id), so the repaired rows win on both fleets',
  (await q(`SELECT DISTINCT ON (source, mode, fleet_id) rows_written
              FROM collection_run WHERE source='ledger'
             ORDER BY source, mode, fleet_id, finished_at DESC`))
    .map((r) => r.rows_written).sort((a, b) => a - b).join(',') === '1,3',
  JSON.stringify(await q(`SELECT DISTINCT ON (source, mode, fleet_id) fleet_id, rows_written
                            FROM collection_run WHERE source='ledger'
                           ORDER BY source, mode, fleet_id, finished_at DESC`)));

/* Migrations replay. A repair that doubles its own rows on a second pass is a
   worse record than the one it replaced. */
await apply();
await apply();
const twice = await q(`SELECT count(*)::int n FROM collection_run WHERE source='ledger'`);
check('running the migration again changes nothing', twice[0].n === runs.length,
  `${twice[0].n} rows after three passes, ${runs.length} after one`);

/* And the case where nothing can be derived: an import whose every row has
   since been overwritten must keep its old row rather than be replaced by a
   fabricated zero. */
{
  const db2 = new PGlite();
  await applySchema(db2);
  await db2.query(
    `INSERT INTO collection_run (source, fleet_id, mode, status, rows_written, started_at, finished_at)
     VALUES ('ledger','ecosine','import','ok', 39797, $1::timestamptz, $1::timestamptz)`, [NEW_AT]);
  await db2.exec(MIGRATION);
  const left = (await db2.query(`SELECT rows_written, window_start FROM collection_run WHERE source='ledger'`)).rows;
  check('an import with no attributable row keeps its old row rather than gaining a fabricated one',
    left.length === 1 && left[0].rows_written === 39797 && left[0].window_start === null,
    JSON.stringify(left));
  await db2.close();
}

await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
