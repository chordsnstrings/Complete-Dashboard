/* A run that failed everything is not "partial", and a source that writes
   nothing is not "ok".
   ─────────────────────────────────────────────────────────────────────────
   Two shapes, one fault: the collector could not describe its own failure.

   Measured on production 2026-09-02. The two newest Uber catch-up runs read

     uber catchup ecosine  partial  rows=0  chunks 44  failed 44  error=NULL
     uber catchup egari    partial  rows=0  chunks 44  failed 44  error=NULL

   — 74 of those 88 windows saying "redirected to auth.uber.com — the session
   is no longer signed in". The Data-sources page paints 'partial' amber and
   'error' red, so the total death of the supplier session wore the same colour
   as a run that mostly worked, under a caption promising that 'partial' means
   rows WERE written.

   And `external` reported ok with rows_written 37 on all three of its latest
   runs. 37 is exactly past_days 30 + forecast_days 7: the weather. The
   calendar half had written nothing on any of them, including a backfill
   spanning 25 months, and calendar_day stopped dead at 2026-08-31 — every day
   since carrying hijri_month NULL on a product that prints Ramadan beside
   every trip. Its status was the literal string 'ok'. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { pool } from '../src/db.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
await applySchema(db);
pool.query = (t, p) => db.query(t, p);
const { logRun } = await import('../src/db.js');

const chunk = (from, to, rows, error = null) => ({ from, to, rows, error });
const runOf = (id) => q('SELECT * FROM collection_run WHERE id = $1', [id]).then((r) => r[0]);

console.log('\na run has to be able to say it failed');

{
  /* The production shape, scaled down: every window refused, nothing written,
     and no top-level error because the errors live on the chunks. */
  const id = await logRun({ source: 'uber', fleet_id: 'ecosine', mode: 'catchup', rows_written: 0,
    chunks: Array.from({ length: 4 }, (_, i) => chunk(`2026-08-0${i + 1}`, `2026-08-0${i + 1}`, 0,
      'web session: redirected to auth.uber.com — the session is no longer signed in')) });
  const r = await runOf(id);
  check('every window failing is an error, not a partial', r.status === 'error', r.status);
  check('…and it carries one of the window errors, so the red cell has something to print',
    /no longer signed in/.test(r.error || ''), String(r.error).slice(0, 80));
}

{
  // The genuine partial: some landed, some did not.
  const id = await logRun({ source: 'fms', fleet_id: 'egari', mode: 'backfill', rows_written: 3038,
    chunks: [chunk('2026-08-01', '2026-08-31', 3038), chunk('2026-08-01', '2026-08-31', 0, 'HTTP 400')] });
  const r = await runOf(id);
  check('a run that landed some windows and lost others is still partial', r.status === 'partial', r.status);
}

{
  const id = await logRun({ source: 'hotel', fleet_id: null, mode: 'incremental', rows_written: 12,
    chunks: [chunk('2026-08-01', '2026-08-31', 12)] });
  check('and a run that landed everything is still ok', (await runOf(id)).status === 'ok');
}

{
  /* A caller's own error is a better account than any window's, so it wins. */
  const id = await logRun({ source: 'bolt', fleet_id: 'ecosine', mode: 'incremental', rows_written: 0,
    error: 'portal token expired', status: 'error',
    chunks: [chunk('2026-09-01', '2026-09-02', 0, 'HTTP 503')] });
  const r = await runOf(id);
  check('a caller that named its own cause keeps it', r.error === 'portal token expired', String(r.error));
}

console.log('\nand a window has to say which surface it was asking for');

{
  /* FMS collects trips and alerts in one run. Until `kind` survived, the same
     31-day window appeared twice in /api/status — once ok with 3,038 trips,
     once failed — with nothing to tell them apart, so a 73-day ALERT hole read
     as a telematics outage that had plainly not happened. */
  const id = await logRun({ source: 'fms', fleet_id: 'ecosine', mode: 'backfill', rows_written: 3038,
    chunks: [{ from: '2026-08-01', to: '2026-08-31', rows: 3038, kind: 'trips' },
      { from: '2026-08-01', to: '2026-08-31', rows: 0, kind: 'alerts', error: 'HTTP 400' }] });
  const detail = (await runOf(id)).detail;
  const kinds = (detail || []).map((c) => c.kind);
  check('the two windows are told apart by the surface they asked for',
    kinds.includes('trips') && kinds.includes('alerts'), JSON.stringify(kinds));
  check('…and the failing one is the alert feed',
    (detail || []).find((c) => c.error)?.kind === 'alerts', JSON.stringify(detail));
  /* And a source that sets no kind must not grow a null one: every existing
     reader would then have to know about a key that means nothing. */
  const id2 = await logRun({ source: 'yango', fleet_id: null, mode: 'incremental', rows_written: 4,
    chunks: [chunk('2026-09-01', '2026-09-02', 4)] });
  check('a source that names no surface grows no empty key',
    !Object.prototype.hasOwnProperty.call((await runOf(id2)).detail[0], 'kind'),
    JSON.stringify((await runOf(id2)).detail[0]));
}

console.log('\na context source that wrote half of itself says so');

{
  /* external.collect is IO all the way down, so this drives its status
     derivation rather than the network: the assertion is that the three
     outcomes exist at all, which for two days on production they did not. */
  const src = await import('../src/sources/external.js');
  check('external exports a collect the scheduler calls', typeof src.collect === 'function');
  const body = await import('node:fs').then((fs) => fs.readFileSync('src/sources/external.js', 'utf8'));
  check('its status is derived, not the literal ok it was',
    !/status: 'ok'/.test(body) && /w \+ c > 0 \? 'partial' : 'error'/.test(body));
  check('…and the empty-calendar case is one of the things it can report',
    /wrote no day/.test(body));
  const ev = await import('node:fs').then((fs) => fs.readFileSync('src/sources/events.js', 'utf8'));
  check('and events.js, which had the identical construction, no longer does',
    !/status: 'ok'/.test(ev) && /written \+ breaks > 0 \? 'partial' : 'error'/.test(ev));
}

await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
