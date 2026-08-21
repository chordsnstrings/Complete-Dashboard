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
// A run that wrote rows while nine of its twelve windows failed recorded
// status='ok', which is how a 299-day hole in the trip history stayed hidden.
check('failed windows are named at the end of the run', /trip backfill left holes/.test(uber));
check('the run records every window it attempted, not just a total',
  /return \{ total, chunks \}/.test(uber) && /chunks: trips\.chunks/.test(uber));
check('a window that fails is recorded with the dates that would let it be re-fetched',
  /chunk\.error =/.test(uber) && /from: iso\(s\), to: iso\(e\)/.test(uber));
// A backfill that starts twelve months ago and dies partway never reaches the
// months anyone is looking at.
check('windows are fetched newest first so a truncated run is still useful',
  /windows\.reverse\(\)/.test(uber));
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

/* ── every source file must actually parse ────────────────────────────────
   A backtick inside a SQL comment that sits inside a template literal ends the
   literal early. It has now happened four times: the file passes review, the
   route it defines 500s or the whole page goes blank, and nothing catches it
   until a browser does. `npm run check` only parses src/index.js.

   This parses every file the app ships. It costs about a second. */
{
  const { execFileSync } = await import('node:child_process');
  const { readdirSync, statSync } = await import('node:fs');
  const walk = (dir) => readdirSync(dir).flatMap((f) => {
    const p2 = `${dir}/${f}`;
    if (f === 'node_modules' || f === 'vendor') return [];
    return statSync(p2).isDirectory() ? walk(p2) : (p2.endsWith('.js') ? [p2] : []);
  });
  const files = [...walk('src'), ...walk('api')];
  const broken = files.filter((f) => {
    try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); return false; }
    catch { return true; }
  });
  check(`all ${files.length} shipped source files parse`, broken.length === 0, broken.join(', '));
}

/* ── two historical collections must not overlap ──────────────────────────
   The scheduler runs an incremental every thirty minutes and a backfill can be
   queued at any moment. Both call the Uber report pipeline, which the provider
   caps at three reports in flight per org — and an abandoned report keeps its
   slot. A twelve-window backfill competing with a three-day incremental loses
   windows to it, which is how a hole opens while both runs report ok. */
{
  const run = (await import('node:fs')).readFileSync('src/run.js', 'utf8');
  check('a second collection waits for the first rather than running beside it',
    /let inFlight = null;/.test(run) && /await inFlight\.catch/.test(run));
  check('and it waits rather than being silently dropped',
    !/if \(inFlight\) return;/.test(run) && /waiting — another collection is in flight/.test(run));
  check('the lock is released even when the run throws', /finally \{ release\(\); inFlight = null; \}/.test(run));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
