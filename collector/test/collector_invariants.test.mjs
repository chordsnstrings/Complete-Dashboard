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
  (uber.match(/return \{ total, chunks \}/g) || []).length >= 2
  && /const chunks = \[\.\.\.trips\.chunks, \.\.\.perf\.chunks\]/.test(uber));
/* BOTH sub-sources, not just the trip report. The earner-breakdown query asked
   for a field the response type does not have, so Uber rejected it on every
   window for the life of the collector — and because only the trip windows were
   recorded, the run said ok while the fleet's per-driver Uber earnings, the one
   place Uber money exists at all, stayed empty. */
check('and both of the uber sub-sources contribute their windows to the run',
  /perf\.chunks/.test(uber) && /rows_written: trips\.total \+ perf\.total/.test(uber));
/* It does not page at all now. The response type has no token this query can
   select — asking for nextPageToken made the server reject the whole query, and
   the guess that replaced it (paginationResult.nextPageToken) was never
   SELECTED, so it read undefined and one page of ten drivers became the answer
   for a fleet of eighty-five. Every weekly period in the database held exactly
   ten drivers: the shape a cap leaves, and not one any real week has.

   Drivers are asked for by name instead, ten at a time, from the ids we already
   hold — so the batches are the fleet and there is no page to run out. */
/* Scoped to the GraphQL document, not to the whole file. Written as
   "nextPageToken appears nowhere in uber.js" it started failing the moment the
   driver roster — a REST response that genuinely carries one — was paged: a
   check phrased more broadly than the rule it enforces fails on correct code,
   which is how a suite stops being believed. */
const earnerQuery = uber.slice(uber.indexOf('const EARNER_QUERY'),
  uber.indexOf('async function earnerCall'));
check('the earner breakdown does not ask for a pagination field this response has no room for',
  !/nextPageToken/.test(earnerQuery), earnerQuery.slice(0, 80));
check('and asks for drivers by name rather than paging past the cap',
  /driverListOrPageOptions: 'Driver_List'/.test(uber) && /driverList: drivers\.slice\(/.test(uber));
check('taking the driver ids from both places they land, not just the roster',
  /FROM driver_platform_state WHERE platform = 'uber'/.test(uber)
  && /UNION SELECT driver_ext_id FROM trip WHERE platform = 'uber'/.test(uber));
check('a rejected mode falls back rather than losing the data it was managing',
  /listMode = false/.test(uber) && /driverListOrPageOptions: 'Page_Options'/.test(uber));
check('and each window records how many of the fleet actually answered',
  /drivers answered/.test(uber));
/* Around eight hundred calls and a quarter of an hour, and it ran with the
   progress row frozen on the last TRIP window throughout — a watcher could not
   tell the phase from a wedged run, which is the exact condition onStep exists
   for. */
check('the earnings phase reports its own progress, not only the trip phase',
  /pullEarnerBreakdowns\(from, to, onStep\)/.test(uber) && /phase: 'earnings'/.test(uber));

/* ── a default page size is not a fleet size ──────────────────────────────
   The driver roster was fetched once with no limit and no cursor, so it took
   the API's default page of 50 against a fleet of 152 — and every "on the books
   but not earning" figure in the product was computed over that third. */
check('the driver roster is paged rather than taking the first page',
  /paginationResult\?\.nextPageToken/.test(uber) && /page_token: pageToken/.test(uber));
check('and a server that ignores the cursor stops the loop instead of spinning',
  /key === lastKey/.test(uber) && /cursor ignored by the server/.test(uber));
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

/* ── uber money ────────────────────────────────────────────────────────────
   The trip export has no fare column, so every dirham of Uber revenue this
   product can ever show comes from two surfaces — and both of them returned
   nothing while reporting success, for the life of the collector.

   The earner-payments REST surface answers 200 with an EMPTY list when asked
   for a page of 200. The probe asks for 50 and has been getting 50 records the
   whole time: same endpoint, same window, same credentials, different page
   size. An empty list is indistinguishable from a quiet week unless something
   compares the two, so the collector now does exactly that before believing
   it. */
const fleet = src('uber_fleet.js');
check('the earner-payments page size is the one that is known to work',
  /const EARNER_PAGE = 50;/.test(fleet) && !/page_size: 200/.test(fleet));
check('and its pages are walked rather than assumed to be one',
  /nextPageToken/.test(fleet) && /EARNER_PAGES_MAX/.test(fleet));
check('zero earners is checked against the probe before it is believed',
  /provider_probe/.test(fleet) && /record_count > 0/.test(fleet));
check('records that come back and do not parse are a failure, not an empty week',
  /and no parsable component/.test(fleet));
check('the earner id is read from the spelling this API actually uses',
  /earnerInfo\.uuid/.test(fleet));
// Four surfaces, and 'ok' used to mean "at least one of them worked".
check('a surface that fails is recorded against the run, not only in the log',
  /failed\.push\(/.test(fleet) && /status: failed\.length === 0 \? 'ok'/.test(fleet));

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
  /* When one does not, say WHERE the backtick is.
     node --check reports "missing ) after argument list" pointing at the top of
     the statement, which on a 40-line SQL template is tens of lines from the
     cause — and working back from it has cost an hour more than once across the
     seven times this has happened. A comment line inside a template that quotes
     an identifier in backticks is the cause every time, so when a file fails to
     parse, the likely lines are named. */
  const hint = broken.flatMap((f) => {
    const text = readFileSync(f, 'utf8');
    const at = [];
    // Every comment in the file, block or line, and every backtick inside one.
    const lines = text.split('\n');
    for (const c of text.matchAll(/\/\*[\s\S]*?\*\/|--[^\n]*/g)) {
      if (!/`/.test(c[0])) continue;
      const line = text.slice(0, c.index).split('\n').length;
      /* Only comments sitting inside SQL. A backtick in this file's own header
         prose is not the bug; one in a comment surrounded by a SELECT is. The
         window is generous because these templates are long. */
      const near = lines.slice(Math.max(0, line - 25), line + 25).join('\n');
      if (!/\b(SELECT|INSERT INTO|UPDATE|WITH)\b/.test(near)) continue;
      at.push(`${f}:${line}`);
    }
    return [...new Set(at)];
  });
  check(`all ${files.length} shipped source files parse`, broken.length === 0,
    `${broken.join(', ')}${hint.length ? `\n      a backtick in a comment ends the template literal — look at ${hint.slice(0, 6).join(', ')}` : ''}`);
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

  /* ── the order the sources run in ─────────────────────────────────────────
     This is not style. An FMS year backfill takes four and a half hours; the
     deployment restarts the container on every push; and a restart requeues the
     running job, which begins the sequence from the top. With FMS first, four
     weeks of backfills re-ran FMS and reached Uber on none of them — while the
     job row said 'running' and every collection_run row said 'ok'. The 299-day
     Uber hole the backfill exists to close survived every attempt to close it.

     So: the longest-running source goes last, where being cut short costs the
     least, and the source with the largest hole goes first. */
  const order = run.match(/const HISTORICAL = \{([^}]*)\}/)?.[1]
    .split(',').map((x) => x.trim()).filter(Boolean) || [];
  check('every historical source is still in the sequence', order.length === 8, order.join(','));
  check('the four-and-a-half-hour source runs last, not first',
    order[order.length - 1] === 'fms', order.join(','));
  check('the source with the largest hole runs first', order[0] === 'uber', order.join(','));

  /* ── and it says which one it is on ──────────────────────────────────────
     A four-hour step that reports only on completion is indistinguishable from
     a hung process. That ambiguity is what hid the bug above for weeks. */
  check('progress is reported before a source runs, not after',
    /await onProgress\?\.\(\{ current: name/.test(run));
  check('progress names what is still to come, so a truncated run is visible',
    /remaining: names\.slice/.test(run));
  check('backfill and incremental both accept the progress callback',
    /export const backfill = \(onProgress\)/.test(run)
    && /export const incremental = \(onProgress\)/.test(run));

  const idx = (await import('node:fs')).readFileSync('src/index.js', 'utf8');
  check('the scheduler persists that progress against the job row',
    /UPDATE collector_job SET progress/.test(idx));
  check('a failed progress write cannot fail the collection it is describing',
    /progress write failed/.test(idx) && /\.catch\(\(e\) => log\.warn\('scheduler', 'progress write failed'/.test(idx));

  /* ── a deploy is not the job's fault ──────────────────────────────────────
     The boot requeue counted every restart alike and abandoned a job at three
     with "it may be crashing the collector". That was untrue of the only job
     it ever fired on: a year backfill that had been advancing every single
     time and was interrupted by ordinary deploys. A job that got FURTHER than
     its last attempt is a working job; only one that restarts having completed
     no source at all is a candidate for being the cause. */
  check('the requeue distinguishes a job that advanced from one that did not',
    /done_at_last_attempt/.test(idx));
  check('an advancing job has its attempt counter reset rather than incremented',
    /attempts = CASE WHEN \$\{ADVANCED\} THEN 1 ELSE coalesce\(attempts, 0\) \+ 1 END/.test(idx));
  check('the abandonment message says what was actually observed',
    /restarted three times without completing a single source/.test(idx));
  check('the log names which source the stranded job was on',
    /was_on/.test(idx));

  /* ── per-source progress is too coarse for a source that takes hours ──────
     Uber walks twelve monthly report windows and FMS walks twelve months of
     130 vehicles; each takes hours. Measured only in completed SOURCES, a run
     that had landed 35,000 rows across eleven windows was indistinguishable
     from one that had done nothing, and the requeue abandoned it as such. */
  check('the long sources report each window, not only their completion',
    /onStep\?\.\(\{ window:/.test((await import('node:fs')).readFileSync('src/sources/uber.js', 'utf8'))
    && /onStep\?\.\(\{ window:/.test((await import('node:fs')).readFileSync('src/sources/fms.js', 'utf8')));
  check('the runner passes a step callback down to every source',
    /mod\.collect\(\{ from, to, mode, onStep \}\)/.test(run));
  check('a completed window counts as progress for the requeue',
    /steps_at_last_attempt/.test(idx));
  check('the two progress measures are defined once, so they cannot disagree',
    /const ADVANCED = /.test(idx) && (idx.match(/\$\{ADVANCED\}/g) || []).length >= 3,
    String((idx.match(/\$\{ADVANCED\}/g) || []).length));
  check('the abandonment message names both kinds of progress',
    /without completing a single source /.test(idx) && /or collection window/.test(idx));

  /* ── FMS had the exact failure shape that hid the Uber hole ───────────────
     Its window loop had no try/catch at all, so a throw on window 3 abandoned
     windows 4 through 12 and surfaced as one error against the whole fleet,
     with no record of which months were never attempted. FMS is currently dark
     for 155 days over a period Uber — now fully collected — shows as busy, so
     the fleet was working and this source has been quietly failing. */
  const fmsSrc = (await import('node:fs')).readFileSync('src/sources/fms.js', 'utf8');
  check('an FMS window that fails does not abandon the windows after it',
    /trip window \$\{dotDate\(s\)\}\.\.\$\{dotDate\(e\)\} FAILED/.test(fmsSrc)
    && /continue;/.test(fmsSrc));
  check('the alert loop is protected the same way',
    /alert window \$\{dotDate\(s\)\}\.\.\$\{dotDate\(e\)\} FAILED/.test(fmsSrc));
  check('FMS records every window it attempted, not just a total',
    /return \{ total, chunks \};/.test(fmsSrc)
    && /chunks: \[\.\.\.trips\.chunks, \.\.\.alerts\.chunks\]/.test(fmsSrc));
  check('an FMS run that left windows unfetched cannot report ok',
    !/status: 'ok', rows_written: trips \+ alerts/.test(fmsSrc));
  check('FMS windows are fetched newest first, so a truncated run is still useful',
    (fmsSrc.match(/dateChunks\(from, to, 31\)\]\.reverse\(\)/g) || []).length === 2,
    String((fmsSrc.match(/\.reverse\(\)/g) || []).length));
}


/* ── an unguarded distance sum is a bug waiting for the tracker to come on ──
   FMS distances are odometer-derived and a single row can read 193,027 km.
   trip_norm carries `has_distance` for exactly this, and it kept not being
   used: /api/trend/monthly reported 12,681,536 km for April 2026, and three
   queries on the vehicle page had the same defect. Both were found only
   because a year of Uber data finally landed and made the absurdity visible
   next to something real.

   This is a lint, not a proof. It flags a sum or average over distance_km with
   no FILTER, in a statement that FMS rows can reach — meaning it is not scoped
   to a driver (FMS rows carry no driver id), not pinned to a booking platform,
   and not already restricted to bookings. An exemption needs a reason. */
{
  const { readFileSync: rf, readdirSync: rd } = await import('node:fs');
  const FILES = [...rd('api').filter((f) => f.endsWith('.js')).map((f) => `api/${f}`),
    ...rd('src').filter((f) => f.endsWith('.js')).map((f) => `src/${f}`)];

  /* Named, with the reason each is safe. A query that stops being safe has to
     be removed from here deliberately rather than drifting. */
  const EXEMPT = {
    'src/insights.js': 'the deadhead rule filters on deadhead_km IS NOT NULL, which only the hotel channel ever sets',
  };

  /* Window predicates live in template variables — `${TW}` is the per-driver
     or per-plate window, `${FB}` the bookings-only one — so a scope check that
     reads the raw statement sees a hole where the scoping is. Resolve them
     from their own definitions in the same file rather than special-casing the
     names, so a renamed or redefined predicate is followed rather than
     silently treated as absent. */
  /* Resolved to a fixed point, because a shared predicate is itself built from
     shared pieces: TW is `${PKEY} = ANY($3) AND …`, and one pass left the
     inner ${PKEY} unresolved. The lint then saw no driver predicate in any
     query using TW and reported six correctly-scoped statements as unguarded —
     a lint that cries wolf gets its output ignored, which costs more than the
     bug it watches for. */
  const resolveVars = (src2, stmt) => {
    let out2 = stmt;
    for (let pass = 0; pass < 6 && /\$\{\w+\}/.test(out2); pass++) {
      let changed = false;
      for (const v of new Set([...out2.matchAll(/\$\{(\w+)\}/g)].map((x) => x[1]))) {
        const def = src2.match(new RegExp(`const ${v}\\s*=\\s*\`([^\`]*)\``))
          || src2.match(new RegExp(`const ${v}\\s*=\\s*(?:\\(\\)\\s*=>\\s*)?\`([^\`]*)\``));
        if (!def) continue;
        const next = out2.split(`\${${v}}`).join(def[1]);
        if (next !== out2) { out2 = next; changed = true; }
      }
      if (!changed) break;
    }
    return out2;
  };

  const offenders = [];
  for (const f of FILES) {
    if (EXEMPT[f]) continue;
    const src2 = rf(f, 'utf8');
    for (const m of src2.matchAll(/`([^`]*SELECT[^`]*)`/gs)) {
      const stmt = resolveVars(src2, m[1]);
      if (!/FROM\s+trip(_norm|_ext)?\b/.test(stmt)) continue;

      /* Scope means the WHERE clause, not a FILTER on some other column.
         The first version of this check tested whether `is_booking` appeared
         anywhere in the statement — and a statement that guards SOME of its
         aggregates and not others contains it either way. Reintroducing the
         exact April-2026 bug into a query whose neighbouring columns still
         said FILTER (WHERE is_booking) passed the lint silently. Strip every
         FILTER clause first, so only a real restriction counts. */
      const whereOnly = stmt.replace(/FILTER\s*\([^()]*(?:\([^()]*\)[^()]*)*\)/gi, '');
      /* A person predicate is scoping, whether it names the raw column or the
         synthesised person key. The key is coalesce(driver_ext_id, name:…),
         which is NULL when a row carries neither — and an FMS telematics row
         carries neither, so a person-scoped query still cannot reach an
         odometer distance. Matching only the raw spelling made the lint report
         every driver query as unguarded the moment the key was introduced. */
      const scoped = /driver_ext_id\s*=\s*ANY|driver_name IS NOT NULL|driver_ext_id IS NOT NULL/.test(whereOnly)
        || /coalesce\(nullif\(btrim\(driver_ext_id\)[^)]*\)[\s\S]{0,120}?\)\s*=\s*ANY/.test(whereOnly)
        || /btrim\(driver_name\), ''\) <> ''/.test(whereOnly)
        || /platform\s*=\s*'(?!fms)[a-z_]+'/.test(whereOnly)
        || /\bis_booking\b/.test(whereOnly)
        || /\bproduct IS NOT NULL\b/.test(whereOnly)
        || /\bdeadhead_km IS NOT NULL\b/.test(whereOnly);
      if (scoped) continue;
      // Line numbers come from the ORIGINAL text; resolution changes offsets.
      for (const g of m[1].matchAll(/(?:sum|avg)\((?:t\.)?distance_km\)(?!\s*FILTER)/g)) {
        const line = src2.slice(0, m.index + 1 + g.index).split('\n').length;
        offenders.push(`${f}:${line}`);
      }
    }
  }
  check('no distance sum is left unguarded in a query an odometer row can reach',
    offenders.length === 0,
    offenders.length ? `\n      ${offenders.join('\n      ')}` : '');

  /* And the guard has to exist to be used. If has_distance ever leaves
     trip_norm, every FILTER above silently becomes a syntax error at runtime
     rather than at deploy — so assert the column is still defined. */
  const v18 = rf('sql/schema_v18.sql', 'utf8');
  check('trip_norm still defines the has_distance guard those filters depend on',
    /AS has_distance/.test(v18));
  check('and it still bounds the plausible range rather than only testing NOT NULL',
    /distance_km\s*<\s*500/.test(v18));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
