/* Guards on collector behaviour that only shows up in production.
   These are static checks on the source, not runtime tests: the failures they
   protect against are all "the run reported success and wrote nothing", which a
   unit test with a stubbed HTTP layer would happily reproduce as a pass. */
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const src = (f) => readFileSync(`src/sources/${f}`, 'utf8');

/* ── uber report pipeline ──────────────────────────────────────────────────
   A year backfill returned 0 rows with status "ok". Two causes, both here:
   the download poll gave up after 60s when a monthly report for ~90 vehicles
   needs minutes, and each abandoned report kept its slot against Uber's
   three-in-flight cap, so every later chunk failed instantly. */
const uber = src('uber.js');
check('report poll budget is minutes, not one minute',
  /budgetMs = (\d+)/.test(uber) && +uber.match(/budgetMs = (\d+)/)[1] >= 300000,
  uber.match(/budgetMs = (\d+)/)?.[1]);
check('the poll backs off instead of a fixed interval', /wait = Math\.min\(wait \* /.test(uber));
check('a server-side report failure stops the poll early', /failed server-side/.test(uber));
check('the concurrency cap is waited out, not skipped', /CONCURRENCY_HINT/.test(uber) && /return generateReport\(start, end, attempt \+ 1\)/.test(uber));
// A silent skip is what turned a broken backfill into a successful empty one.
check('an unexpected chunk failure logs as an error, not a warning',
  /log\[expected \? 'info' : 'error'\]/.test(uber));
check('repeated chunk failures are reported at the end of the run', /trip backfill degraded/.test(uber));
check('chunks are paced between reports', /await sleep\(consecutiveFailures \? /.test(uber));
// An expired web cookie answers with `errors` and no data, which read as
// "this fleet has no drivers" and quietly zeroed every performance record.
check('a GraphQL error response is reported, not read as an empty fleet',
  /data\?\.errors\?\.length/.test(uber));

/* ── hotel ─────────────────────────────────────────────────────────────────
   The API returns a bcrypt password hash on every driver record. */
const hotel = src('hotel.js');
check('the hotel driver password hash is never persisted',
  !/password/.test(hotel.replace(/\/\/.*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')));
check('a deadhead leg computed from a bad fix is discarded', /km > 200/.test(hotel));

/* ── every collector logs its run ─────────────────────────────────────────
   A source that throws without a collection_run row disappears from the status
   page rather than showing as broken. */
for (const f of ['uber.js', 'yango.js', 'bolt.js', 'fms.js', 'cabman.js', 'hotel.js']) {
  const t = src(f);
  check(`${f} records a run row on failure`, /status: 'error'/.test(t));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
