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
check('the concurrency cap is waited out, not skipped',
  /CONCURRENCY_HINT/.test(uber) && /return generateReport\(start, end, attempt \+ 1/.test(uber));
/* And the retry asks for the SAME report. generateReport takes a reportType
   now — three report types are collected, not one — so a retry that dropped
   the argument would wait out the busy slot and then quietly fetch trips where
   the caller asked for driver quality, and upsert them as quality. */
check('and a retry after a busy slot re-asks for the report it was asked for',
  !/reportType/.test(uber) || /return generateReport\(start, end, attempt \+ 1, reportType\)/.test(uber));
// A silent skip is what turned a broken backfill into a successful empty one.
check('an unexpected chunk failure logs as an error, not a warning',
  /log\[expected \? 'info' : 'error'\]/.test(uber));
// A run that wrote rows while nine of its twelve windows failed recorded
// status='ok', which is how a 299-day hole in the trip history stayed hidden.
check('failed windows are named at the end of the run', /trip backfill left holes/.test(uber));
/* Both sub-sources return their windows. The earnings one returns
   `total + comps` rather than a bare `total` — it writes into two tables now,
   driver_performance for the period and driver_earnings_component for the
   tree, and a run that wrote 8,000 component rows and reported 0 is the same
   silence this check exists to break. */
/* Pinned as a PROPERTY, not as a spelling. The union used to be written out
   as `[...trips.chunks, ...perf.chunks]`, and asserting that literal meant the
   check failed the moment a third sub-source was added — reporting a
   regression for the one change that makes the invariant hold harder. What
   matters is that EVERY sub-source pulled in collect() contributes its windows
   to the run, so the count is derived from the pulls rather than written
   twice. */
check('the run records every window it attempted, not just a total',
  (uber.match(/return \{ total(: total \+ comps)?, chunks \}/g) || []).length >= 2);
/* Read off the accumulator rather than off the call sites.
   ─────────────────────────────────────────────────────────────────────────
   The previous version of this block derived the sub-sources from the literal
   `const x = await pullSomething(from, to, onStep, ck)`, which is the shape
   collect() had while it ran one whole pass per org. Interleaving the fleets
   turned those into phases and the check went red on a change that does not
   touch the invariant at all — the second time this block has been broken by
   its own spelling, and the comment above says why that is the wrong way to
   write it.

   So the list comes from the ONE place that enumerates the sub-sources: the
   per-org accumulator every phase writes into. A sub-source that is collected
   and not accumulated has no name here, which is itself the bug this catches. */
{
  const collect = uber.slice(uber.indexOf('export async function collect'));
  const init = collect.match(/const st = new Map\([\s\S]*?\]\)\);/)?.[0] || '';
  const subs = [...init.matchAll(/(\w+): empty\(\)/g)].map((m) => m[1]);
  const union = collect.match(/const chunks = \[([^\]]*)\]/)?.[1] || '';
  check('collect() names its sub-sources in one place',
    subs.length >= 3, `found ${subs.join(', ') || 'none'}`);
  check('and every sub-source in the pass contributes its windows, not just the first',
    subs.length >= 2 && subs.every((v) => union.includes(`...s.${v}.chunks`)),
    `subs ${subs.join(', ')} — union ${union.trim()}`);
  /* Each one is filled by something that also adds what it wrote to the run
     total: either phase(), which does it for every sub-source it drives, or an
     explicit accumulation beside the assignment. A sub-source filled by
     neither is one that can write eight thousand rows and report none. */
  check('and its rows reach the run total, so a sub-source cannot write silently',
    subs.every((v) => new RegExp(`phase\\(s, '${v}'`).test(collect)
      || new RegExp(`s\\.${v} = r;[\\s\\S]{0,120}s\\.written \\+= r\\.total`).test(collect)),
    'a run that wrote 8,000 rows and reported 0 is the silence this check exists to break');
  check('…and phase() is what makes that true for the ones it drives',
    /s\.written \+= r\.total \|\| 0;/.test(collect),
    'phase() that does not accumulate makes every sub-source it drives silent');
  check('and the run row reports that total rather than a recount',
    (collect.match(/rows_written: s\.written/g) || []).length >= 2,
    'the error row and the ok row must both say what actually landed');
}
/* BOTH sub-sources, not just the trip report. The earner-breakdown query asked
   for a field the response type does not have, so Uber rejected it on every
   window for the life of the collector — and because only the trip windows were
   recorded, the run said ok while the fleet's per-driver Uber earnings, the one
   place Uber money exists at all, stayed empty. */
check('and both of the uber sub-sources contribute their windows to the run',
  /s\.perf\.chunks/.test(uber) && /s\.trips\.chunks/.test(uber));
/* It pages through `pageInfo`, and only through `pageInfo`.
   ─────────────────────────────────────────────────────────────────────────
   Two earlier attempts failed and this rule is the difference between them and
   the one that works. A BARE `nextPageToken` on the connection is a field the
   response type does not have, and asking for it made Uber reject the whole
   query on every window. The guess that replaced it,
   `paginationResult.nextPageToken`, was a REST shape that GraphQL never
   SELECTED, so it read undefined and one page of ten drivers became the answer
   for a fleet of eighty-five — every weekly period in the database held
   exactly ten, the shape a cap leaves and not one any real week has.

   The path the portal itself sends is `pageInfo { nextPageToken }`, and it
   works: checked against the live endpoint with this file's own query text, a
   Dubai day comes back in three pages for Egari and five or six for Ecosine,
   and the seven days sum to exactly the trips and net outstanding the one
   weekly call reports — 842 / AED 30,280.53 and 1,862 / AED 71,006.78.

   So the rule is not "never ask for a token", which would forbid the thing
   that works; it is "ask for it where the type actually has it". */
/* Scoped to the GraphQL document, not to the whole file. Written as
   "nextPageToken appears nowhere in uber.js" it started failing the moment the
   driver roster — a REST response that genuinely carries one — was paged: a
   check phrased more broadly than the rule it enforces fails on correct code,
   which is how a suite stops being believed. */
const earnerQuery = uber.slice(uber.indexOf('const EARNER_QUERY'),
  uber.indexOf('async function earnerCall'));
check('the earner breakdown asks for its token through pageInfo, where the type has it',
  /pageInfo \{ nextPageToken \}/.test(earnerQuery), earnerQuery.slice(0, 90));
check('and never as a bare field on the connection, which the server rejects',
  !/(^|[^.\w])nextPageToken(?![^{]*\})/.test(earnerQuery.replace(/pageInfo \{ nextPageToken \}/g, '')),
  earnerQuery.slice(0, 90));
check('nor as the REST shape that was never selected',
  !/paginationResult/.test(earnerQuery));
check('and asks for drivers by name rather than paging past the cap',
  /driverListOrPageOptions: 'Driver_List'/.test(uber) && /driverList: drivers\.slice\(/.test(uber));
check('taking the driver ids from both places they land, not just the roster',
  /FROM driver_platform_state\s+WHERE platform = 'uber'/.test(uber)
  && /UNION SELECT driver_ext_id FROM trip\s+WHERE platform = 'uber'/.test(uber));
check('a rejected mode falls back rather than losing the data it was managing',
  /listMode = false/.test(uber) && /driverListOrPageOptions: 'Page_Options'/.test(uber));
check('and each window records how many of the fleet actually answered',
  /drivers answered/.test(uber));
/* Around eight hundred calls and a quarter of an hour, and it ran with the
   progress row frozen on the last TRIP window throughout — a watcher could not
   tell the phase from a wedged run, which is the exact condition onStep exists
   for. */
check('the earnings phase reports its own progress, not only the trip phase',
  /pullEarnerBreakdowns\(from, to, onStep\b/.test(uber) && /phase: 'earnings'/.test(uber));

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
  /* A QUEUE, not a single gate. It was one promise every waiter awaited, so
     two waiters woke together and ran concurrently — into the provider's
     three-report cap, which is the starvation the barrier exists to prevent.
     test/resume.test.mjs drives the shape and asserts the peak is one. */
  check('a second collection waits for the first rather than running beside it',
    /let tail = Promise\.resolve\(\);/.test(run) && /const mine = tail\.then\(run, run\)/.test(run));
  check('and it waits rather than being silently dropped',
    !/if \(inFlight\) return;/.test(run) && /waiting — \$\{queued\} collection/.test(run));
  check('the lock is released even when the run throws', /finally \{ queued--; \}/.test(run));
  check('and one failed run does not poison the queue behind it',
    /tail = mine\.then\(\(\) => \{\}, \(\) => \{\}\)/.test(run));

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
    /export const backfill = \(onProgress\b/.test(run)
    && /export const incremental = \(onProgress\b/.test(run));

  const idx = (await import('node:fs')).readFileSync('src/index.js', 'utf8');
  /* MERGED, not replaced. The requeue writes the baselines the abandon rule
     compares the next attempt against into this same document; a whole-document
     write erased them on that attempt's first progress report. */
  check('the scheduler persists that progress against the job row',
    /UPDATE collector_job\s*\n?\s*SET progress = coalesce\(progress, '\{\}'::jsonb\) \|\| \$2::jsonb/.test(idx));
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
  /* Reset to zero and not incremented here: the claim already counts a
     restart when it picks the job up again, and counting it in both places
     meant one interruption read as two. */
  check('an advancing job has its attempt counter reset rather than incremented',
    /attempts = CASE WHEN \$\{ADVANCED\} THEN 0 ELSE coalesce\(attempts, 0\) END/.test(idx));
  check('and a restart is counted once, by the claim',
    /attempts = coalesce\(attempts, 0\) \+ 1/.test(idx));
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
    /mod\.collect\(\{ from, to, mode, onStep\b[^}]*\}\)/.test(run));
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

/* ── bolt: four surfaces, one green tick ───────────────────────────────────
   Bolt has two fleets on the FI roster and two on the portal, and every one of
   them could be rejected while the run recorded status 'ok' with rows_written
   0 — only a thrown exception reached the catch. That is the same shape that
   hid a 299-day hole in the Uber trip history, and it is why Bolt read as a
   healthy source for the life of the project while writing nothing at all. */
const bolt = src('bolt.js');
/* The status is DERIVED now, not asserted, and that is the stronger version of
   the same invariant. bolt hands logRun its per-window chunks and logRun works
   out from them that all-failed is 'error' and some-failed is 'partial' —
   src/db.js:236. Bolt was the only chunking source that never passed them, so a
   harvest that lost fifteen of twenty-one months read exactly like one that
   lost none. The literal expression this used to match is still here for the
   case where there are no windows at all. */
check('a bolt run that wrote nothing and failed everywhere is not "ok"',
  /\.\.\.\(chunks\.length \? \{ chunks \} : \{\}\)/.test(bolt)
  && /fails\.length === 0 \? 'ok' : \(roster \+ trips > 0 \? 'partial' : 'error'\)/.test(bolt));
/* And the chunks may only make it WORSE. Handing logRun the windows and no
   status let a run whose ROSTER half was refused report 'ok', because the
   portal's windows knew nothing about the roster and every one of them
   answered — seen on production minutes after the deploy. */
check('the chunks refine the status, they do not replace it',
  /status,\n\s*\.\.\.\(chunks\.length \? \{ chunks \} : \{\}\)/.test(bolt));
check('and every window it attempted reaches the run row', /chunks\.push\(|allChunks\.push\(/.test(bolt));
check('and the failing surfaces are named in the run, not only in the log',
  /error: fails\.length \? fails\.join/.test(bolt));
check('a partial bolt run does not log at info, where nobody reads it',
  /log\[fails\.length \? 'warn' : 'info'\]/.test(bolt));
/* One surface must not take the other down with it. The roster is a snapshot of
   who exists and the portal is every trip and every fare; they share this
   function and nothing else, and a throw in the first used to skip the second
   entirely. */
/* Comments blanked before matching. These files explain their own defects in
   prose that quotes the very code being searched for, and a lint that reads its
   own explanation is a lint that passes on a file where the code is gone. */
const code = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const boltCode = code(bolt);
check('the roster half cannot take the portal half with it',
  /roster = await pullFiRoster[\s\S]{0,600}?\} catch[\s\S]{0,600}?trips = await pullPortalTrips/.test(boltCode),
  'a throw in the roster used to skip every trip and every fare for both fleets');
check('and one fleet cannot take the other',
  /await oneFleet\([\s\S]{0,120}?\} catch/.test(boltCode),
  'egari is walked first; its failure used to cost ecosine its whole harvest');
// Two fleets came back with two different codes under one message we invented.
check('the FI gateway rejection carries its own message rather than our verdict',
  /FI getDrivers rejected for/.test(bolt) && /data\?\.message/.test(bolt));
check('and a thrown bolt run still reports what had already failed',
  /\[String\(e\), \.\.\.fails\]/.test(bolt));

/* ── reserved words that only bite as a bare alias ─────────────────────────
   `SELECT n day` is not a column named day — Postgres reads it as the start of
   an interval qualifier (INTERVAL '1' DAY) and rejects the whole statement.
   Written `SELECT n AS day` it is fine. The same holds for hour, month, year,
   minute, second and week.

   This has now cost two 500s here: `hour` once, and `day` on the vehicle
   earnings route. Both are syntax errors node --check cannot see, that appear
   only when the query actually runs, and that read in review as an ordinary
   alias. So it is checked rather than waited for.

   Scoped to template literals that actually contain SQL, with their comments
   stripped. Anything looser matches the prose in this codebase — "a quarter of
   an hour," is a fine sentence and a false positive. */
{
  const UNITS = 'day|hour|month|year|minute|second|week';
  /* Only an alias following an EXPRESSION is dangerous: a closing paren, a
     cast, or a qualified column. `SELECT day, x FROM t` is a plain column
     reference, so the token before is checked against the keywords that can
     legitimately precede one. */
  const LEAD = /^(select|,|\(|by|distinct|as|and|or|where|on|then|else|when|case|from|having|filter|order|group|partition|between|interval|extract|over|coalesce|nullif|min|max|sum|count|avg)$/i;
  const { readdirSync: rd2, statSync: st2 } = await import('node:fs');
  const walk2 = (dir) => rd2(dir).flatMap((f) => {
    const full = `${dir}/${f}`;
    return st2(full).isDirectory() ? walk2(full) : [full];
  });
  const offenders = [];
  for (const f of [...walk2('api'), ...walk2('src')]) {
    if (!f.endsWith('.js')) continue;
    const text = readFileSync(f, 'utf8');
    for (const lit of text.match(/`[^`]*`/g) || []) {
      if (!/\bSELECT\b/i.test(lit)) continue;
      // A SQL comment can say anything, including "that day, not whoever".
      const sql = lit.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
      sql.split('\n').forEach((line) => {
        // SELECT DISTINCT ON (day) day — the paren closes the ON list, and the
        // token after it is an ordinary column reference.
        if (/DISTINCT\s+ON\s*\(/i.test(line)) return;
        const re = new RegExp(`([\\w.$)\\]]+)\\s+(${UNITS})\\s*(,|$)`, 'gi');
        for (const m of line.matchAll(re)) {
          if (LEAD.test(m[1])) continue;
          const at = text.slice(0, text.indexOf(lit)).split('\n').length;
          offenders.push(`${f}:~${at}  ${line.trim().slice(0, 90)}`);
        }
      });
    }
  }
  check('no query aliases a column as a bare interval keyword',
    offenders.length === 0,
    offenders.length ? `\n      ${offenders.join('\n      ')}` : '');
}

/* ── a gap has to heal without somebody noticing it ────────────────────────
   The incremental window is three days and it runs every half hour. Nothing
   else revisited anything: a backfill only ran when a person triggered one, so
   a day that failed to collect, or that a provider finalised late, stayed wrong
   until it was found. Uber settles driver earnings weekly — longer than the
   window that would pick them up — and FMS is silent on 154 of the last 366
   days. A collection gap in this product has never been self-healing. */
{
  const { readFileSync: rf3, readdirSync: rd3 } = await import('node:fs');
  const run = rf3('src/run.js', 'utf8');
  const idx = rf3('src/index.js', 'utf8');
  check('there is a catch-up that re-walks more than the incremental window',
    /export const catchUp = \(days = 30/.test(run));
  check('and it is wider than the incremental it exists to backstop',
    /daysAgo\(days\)/.test(run) && /incrementalDays/.test(run));
  check('the catch-up runs nightly without anyone asking',
    /cron\.schedule\('0 21 \* \* \*', \(\) => catchUp\(30\)/.test(idx));
  /* Thirty days nightly cannot repair the year behind it, which is exactly the
     shape of the hole that has been sitting in this data. */
  check('and the whole history is re-collected weekly, since a month cannot repair a year',
    /cron\.schedule\('0 22 \* \* 0', \(\) => backfill\(\)/.test(idx));
  /* The schedules must not land on top of each other: the probe is at 22:40 and
     the analyst at 23:10, and three heavy passes at once on a small managed
     database is the contention that was already measured on the rollups. */
  {
    const hours = [...idx.matchAll(/cron\.schedule\('(\d+) (\d+) [^']*'/g)]
      .map((m) => `${m[2]}:${m[1].padStart(2, '0')}`);
    check('no two scheduled heavy passes share a start time',
      new Set(hours).size === hours.length, hours.join(' '));
  }
  /* And the reason re-collecting is safe to do on a timer at all: every write
     is an upsert keyed on the provider's own id, so a day already correct is
     rewritten to the same values rather than duplicated. */
  const srcs = rd3('src/sources').filter((f) => f.endsWith('.js'));
  const appending = srcs.filter((f) => {
    const t = rf3(`src/sources/${f}`, 'utf8');
    return /INSERT INTO (trip|driver_performance|telemetry_snapshot|alert)\b/i.test(t)
      && !/ON CONFLICT/i.test(t);
  });
  check('no collector inserts without an upsert key, or a re-run would duplicate',
    appending.length === 0, appending.join(', '));
}

/* ── one bad moment must not cost a year of history ────────────────────────
   The earner collector asks for drivers ten at a time by name, and falls back
   to a single page if the server rejects that mode. listMode was declared
   outside the window loop, so the first failure of any kind disabled the mode
   for every remaining window — and windows run oldest first. One timeout in the
   first week of the record degraded all fifty-three weeks to a page of ten
   drivers, and the run still reported every window successful, because a page
   of ten is not an error.

   Uber earnings are in fact absent for every month before about March 2026,
   with 20,016 bookings in September 2025 and no payout row against any of them,
   while the provider still serves that window when asked. This is the shape
   that produces exactly that. */
{
  const uberSrc = src('uber.js');
  check('the driver-list mode is abandoned only when the server rejects the MODE',
    /const modeRejected = /.test(uberSrc) && /if \(modeRejected\) listMode = false;/.test(uberSrc));
  check('and any other failure keeps the mode for the next window',
    /keeping driver-list mode/.test(uberSrc));
  /* The failure is still recorded either way, or "we retried and it worked" and
     "we retried and it failed every time" would look the same. */
  check('either way the window records the error rather than swallowing it',
    /err = r\.err;/.test(uberSrc));
}

console.log('\nuber: both fleets are collected, or the absence is loud');

/* The operator's own ledger put Egari at ~27% of Uber trips and a third of the
   money; the collector was built against one org and every number the
   dashboard showed for "uber" was silently Ecosine-only. These pin the shape
   of the fix: a second org is a first-class pass with its own run row, never a
   merge into the first one's — and a missing credential drops the ORG, not a
   random half of its data. */
{
  const cfg = readFileSync('src/config.js', 'utf8');
  check('config lists uber orgs per fleet',
    /fleet: 'ecosine'.*UBER_ORG_UUID'/s.test(cfg) && /fleet: 'egari'.*UBER_ORG_UUID_EGARI/s.test(cfg));
  check('an org missing either credential is not collected at all',
    /\.filter\(\(o\) => o\.orgUuid && o\.webCookie\)/.test(cfg),
    'a half-pasted credential would produce a half-collected fleet');

  const uberSrc = src('uber.js');
  /* The org list moved behind uberOrgs(), which also applies the fleet filter —
     the check is that collect still iterates orgs, not that it inlines the
     list it iterates. */
  check('collect runs once per configured org', /for \(const o of uberOrgs\(fleet\)\)/.test(uberSrc));
  check('each fleet logs its own run row', /logRun\(\{ source: SRC, fleet_id: o\.fleet/.test(uberSrc),
    'a dead Egari cookie must read as Egari failing, not as half the numbers missing');
  check('trips and earnings are stamped with the org being collected, not a constant',
    !/fleet_id: config\.uber\.fleet/.test(uberSrc));
  check('the earnings driver list is scoped to the fleet being asked about',
    /fleet_id = \$1 OR fleet_id IS NULL/.test(uberSrc));
  check('the org pointer is cleared even when a fleet fails',
    /finally \{\s*cur = null;/.test(uberSrc),
    'a thrown pass would leave the next probe reading the wrong org');

  const auth = readFileSync('src/auth/uber.js', 'utf8');
  check('the web session is per org, with the legacy cookie as fallback',
    /uberWebHeaders\(org = null\)/.test(auth) && /org\?\.webCookie \|\| config\.uber\.webCookie/.test(auth));

  const st = readFileSync('src/settings.js', 'utf8');
  check('the Egari credentials are real settings the UI can show',
    /UBER_ORG_UUID_EGARI/.test(st) && /UBER_WEB_COOKIE_EGARI/.test(st));
}

console.log('\nthe two fleets are collected separately, and fail separately');

/* Ecosine and Egari are separate Uber businesses with separate credentials.
   The only thing they share is this process, and that is exactly what makes
   the failure mode easy to write by accident: a bare `for (const org of orgs)`
   with an await inside throws out of the whole pass on the first rejection, so
   an expired Egari cookie takes Ecosine's live map down with it — and the log
   names Egari while the operator watches Ecosine go blank.

   Every multi-org entry point therefore isolates each fleet, and a run can be
   narrowed to one of them. */
{
  const uberSrc = src('uber.js');
  const live = uberSrc.slice(uberSrc.indexOf('export async function pullLive'));
  const liveBody = live.slice(0, live.indexOf('\nexport function uberOrgs'));
  check('the live pull guards each fleet on its own',
    /try \{[\s\S]*?await pullLiveOrg\(o\)[\s\S]*?\} catch/.test(liveBody),
    'one fleet rejecting would end the pass before the next one runs');
  check('and says which fleet failed rather than failing silently',
    /live status failed for \$\{o\.fleet\}/.test(liveBody)
    && /live status incomplete/.test(liveBody));
  check('a fleet with no REST credential is skipped, not failed',
    /if \(!o\.org\)/.test(liveBody) && /skipped for/.test(liveBody),
    'a credential nobody has pasted yet is not a broken collector');

  check('collect can be narrowed to one fleet', /uberOrgs\(fleet\)/.test(uberSrc));
  check('and the org list is derived, not written down twice',
    /export function uberOrgs\(fleet = null\)/.test(uberSrc));

  const run = readFileSync('src/run.js', 'utf8');
  check('the fleet reaches the sources through the run',
    /collect\(\{ from, to, mode, onStep, fleet\b[^}]*\}\)/.test(run));
  check('and every entry point can carry it',
    /export const backfill = \(onProgress, fleet = null\b/.test(run)
    && /export const incremental = \(onProgress, fleet = null\b/.test(run)
    && /export const catchUp = \(days = 30, onProgress, fleet = null\b/.test(run));

  const idx = readFileSync('src/index.js', 'utf8');
  check('the worker claims the job\'s fleet and honours it',
    /RETURNING id, mode, fleet, attempts/.test(idx)
    && /backfill\(progress, job\.fleet \|\| null\b/.test(idx));

  const server = readFileSync('api/server.js', 'utf8');
  check('the trigger accepts a fleet from the operator',
    /FLEETS\.includes\(req\.body\?\.fleet\)/.test(server));
  /* Two fleets queued at once are two different jobs. Written as a plain
     `mode = $1` test, asking for Egari while an Ecosine run was in flight
     answered "already queued" and did nothing. */
  check('and a run for one fleet does not block the other',
    /fleet IS NOT DISTINCT FROM \$2/.test(server),
    'the de-duplication would treat the two fleets as the same job');
  const v28 = readFileSync('sql/schema_v28.sql', 'utf8');
  check('the queue records which fleet was asked for',
    /ADD COLUMN IF NOT EXISTS fleet TEXT/.test(v28)
    && /job_pending_idx ON collector_job \(status, mode, fleet/.test(v28));
}

console.log('\na silent vehicle is not a broken clock');

/* The CABMAN feed returns every vehicle it knows of on every five-minute
   cycle, including trackers that went quiet long ago — four of this fleet's
   have produced no fix since April 2024. Their timestamps sat in the median
   lag, dragged it past the threshold, and the collector logged an ERROR every
   five minutes blaming a timezone change that had not happened. The tell was
   the number itself: around forty-five minutes, and no timezone is
   forty-five minutes away from Dubai.

   Static checks, because the alarm only fires against a live provider — but
   the thing that broke was which POPULATION the median is taken over, and
   that is visible in the source. */
{
  const cab = src('cabman.js');
  check('the statistic is taken over the vehicles still reporting',
    /const talking = lags\.filter\(\(m\) => m < DORMANT_MIN\)/.test(cab)
    && /talking\[Math\.min\(talking\.length - 1,/.test(cab),
    'a dormant tracker still drags the median past the threshold');
  /* And the threshold is on the FLOOR now, not the middle. Excluding the
     dormant trackers was necessary and was not sufficient: measured on
     production, median 24 minutes over 34 reporting vehicles, an ERROR every
     five minutes, while the freshest fix in the fleet was 1.2 minutes old.
     These trackers report on movement rather than on a timer, so a car parked
     twenty minutes ago is twenty minutes stale and entirely healthy — and
     half a fleet is parked at any moment. A clock error is the thing that
     moves EVERY vehicle at once, the just-reported one included. */
  check('and the alarm tests the freshest fix, which is what a clock error moves',
    /const floor = at\(0\.1\)/.test(cab) && /if \(floor > 20\)/.test(cab),
    'a high median over a low floor is a fleet with cars parked, not a clock that is wrong');
  check('and dormant vehicles are counted, not counted AS a clock error',
    /vehicles listed but not reporting/.test(cab) && /log\.info\(SRC, 'vehicles listed/.test(cab),
    'silence is worth reporting and is not an error in the collector');
  check('the hint no longer asserts a cause it cannot know',
    !/check whether the provider changed the timezone/.test(cab)
    && /whole-hour offset/.test(cab),
    'an alarm that names the wrong cause is worse than one that names none');

  /* The same confusion in the other direction: liveness measured on when WE
     polled rather than when the TRACKER reported. A dormant vehicle satisfies
     a poll-age test forever, because the provider keeps listing it and we keep
     upserting the same ancient fix with a fresh poll time. */
  const server = readFileSync('api/server.js', 'utf8');
  const kpi = server.slice(server.indexOf("app.get('/api/kpis'"));
  const liveQ = kpi.slice(0, kpi.indexOf('\napp.'));
  check('the live-vehicle count measures the fix, not the poll',
    /now\(\) - captured_at < \$\{FIX_FRESH\}/.test(liveQ)
    && !/now\(\)-polled_at < interval/.test(liveQ),
    'a tracker silent since 2024 counted as live');
  check('and the threshold is shared with the live map rather than restated',
    (server.match(/\$\{FIX_FRESH\}/g) || []).length >= 3
    && /const FIX_FRESH = /.test(server),
    'two endpoints disagreeing about which vehicles are live is its own bug');
}

console.log('\na provider that refuses is not a provider with nothing');

/* The FMS collector recorded six consecutive months of 2025 as asked and
   answered empty. FMS was refusing them with HTTP 400 — and http() resolves
   for any status, so the refusal arrived with no Data key, fell through
   `data?.Data || []`, and became a successful empty window. The Collection
   gaps page then reported five months of missing telematics as the provider
   having none, which is the opposite instruction to whoever reads it.

   Asked again today FMS serves those months: 4,500 trips for Egari in
   December 2025, 4,351 in February 2026 — the very windows our record calls
   empty — while refusing Ecosine's deterministically. The data was there the
   whole time. */
{
  const fms = src('fms.js');
  check('the trip pull checks the status before reading the body',
    /if \(!r\.ok\)/.test(fms) && /chunk\.error = `HTTP \$\{r\.status\}/.test(fms),
    'a 400 still falls through as an empty window');
  check('and a refusal is recorded as an error, not as an empty window',
    /trip window .* refused/.test(fms) && !/\({ data } = await call\('GetTripPassenger'/.test(fms),
    'the chunk must carry the refusal so the page can tell the two apart');

  /* And the silence ends everywhere, because no collector checked. Changing
     http() to throw would alter nine collectors' error semantics at once and
     each needs exercising against its own provider first; what it must not do
     is let a refusal pass without a word. */
  const httpSrc = readFileSync('src/http.js', 'utf8');
  check('http() says something when a provider refuses',
    /if \(!res\.ok\)/.test(httpSrc) && /log\.warn\('http'/.test(httpSrc),
    'an unchecked refusal is how five months of telematics went missing quietly');
  check('and still resolves rather than throwing, so callers that read a 4xx body keep working',
    /return \{ status: res\.status, ok: res\.ok, data, headers: res\.headers,/.test(httpSrc)
    && !/throw new Error\(`HTTP/.test(httpSrc));
  /* finalUrl, because fetch follows redirects silently and by the time a
     caller sees the response the 302 is gone. That is the ONLY evidence an
     expired Uber web session leaves: measured live, dropping `sid` sends the
     request to auth.uber.com and returns 404 "Not Found", which parsed as
     neither JSON nor an error and was recorded as a week in which nobody
     drove. src/auth_state.js reads this field and nothing else can. */
  check('and hands back where the request actually landed',
    /finalUrl: res\.url/.test(httpSrc) && /redirected: res\.redirected/.test(httpSrc),
    'without it a redirect to a login page is indistinguishable from a quiet week');

  /* ── the check must be able to see what it checks ────────────────────────
     The refusal guard above shipped reading `r.ok` off the object FMS's own
     `call()` returns — and `call()` returned only { status, data }. So `r.ok`
     was undefined on every window, `!r.ok` was true on every window, and the
     trip collector skipped all of them while filing each as a refusal. A live
     run recorded it in the only way it could: `error: 'HTTP 200'`.

     Only the alert path, which checked nothing, kept writing rows — so the run
     looked half-healthy rather than broken, which is why the earlier tests,
     the deploy, and a reading of /api/status all passed over it.

     Asserting the guard exists is not enough; assert the field it reads is
     actually returned. This compares the keys `call()` hands back against
     every key its callers read, so any future wrapper that quietly narrows the
     response fails here instead of in production. */
  const ret = fms.match(/async function call\([\s\S]*?return \{([^}]*)\};/);
  const returned = new Set((ret?.[1] || '').split(',').map((k) => k.split(':')[0].trim()).filter(Boolean));
  /* Scoped to the call result, not to every variable in the file that happens
     to be named r — the row mappers bind `r` too, and counting their
     `r.requested_at` as a response field makes this fail for the wrong reason. */
  const read = fms.split(/\n/).reduce((acc, line, i, all) => {
    if (!/const r = await call\(/.test(line)) return acc;
    for (const l of all.slice(i, i + 14)) {
      for (const m of l.matchAll(/\br\.([a-zA-Z_]\w*)/g)) acc.push(m[1]);
    }
    return acc;
  }, []);
  const missing = [...new Set(read)].filter((k) => !returned.has(k));
  check('fms call() returns every field its callers read off it',
    returned.size > 0 && missing.length === 0,
    `returns {${[...returned].join(',')}} but reads ${missing.join(',') || 'nothing extra'}`);
  check('and ok is one of them, so the refusal guard is answerable',
    returned.has('ok'), 'without it !r.ok is true for a 200 and every window is skipped');

  /* The alert half had no status check at all, which is the original hole in
     its other location: GetAlertData refused reads through `data?.Data || []`
     as a quiet month exactly like GetTripPassenger did. */
  check('the alert window checks status too, not just the trip window',
    /alert window .* refused/.test(fms)
    && !/\(\{ data \} = await call\('GetAlertData'/.test(fms),
    'a refused alert window must not read as a month with no harsh braking');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
