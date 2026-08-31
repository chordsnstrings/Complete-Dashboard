/* A backfill that survives the worker restarting under it.
   ────────────────────────────────────────────────────────────────────────────
   The collector is an App Platform worker, so it restarts on every deploy, and
   a backfill takes hours — Uber alone is twelve monthly report windows plus a
   year of earnings, each costing minutes at the provider. Being interrupted is
   the normal case here, not the exception.

   src/index.js already requeued a job left running at boot. What it could not
   do was make the next attempt CONTINUE: runWindowInner began at the first
   source and the first window every time, so each attempt redid the same work
   and died at the same elapsed point. Production job 8 restarted five times,
   reached window 7 of 12 on every one of them, and was abandoned with
   "restarted three times without completing a single source or collection
   window, so the job itself may be killing the collector". The abandon rule was
   not wrong — `steps` really was 7 last time and 7 again. A run that redoes six
   windows has not advanced, however much work it did.

   So this file asserts the property that makes the difference: interrupt a run
   repeatedly, and the units it finished stay finished. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { loadCheckpoint, clearCheckpoint, NO_CHECKPOINT } from '../src/checkpoint.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  \u2713 ${n}`)) : (fail++, console.log(`  \u2717 ${n} ${x}`)); };
await applySchema(db);

console.log('\nthe table exists and is keyed on the job');
{
  const cols = await q(`SELECT column_name FROM information_schema.columns
                         WHERE table_name = 'collector_checkpoint' ORDER BY ordinal_position`);
  check('collector_checkpoint has the columns a resume needs',
    ['job_id', 'source', 'window_key', 'rows', 'finished_at']
      .every((c) => cols.some((x) => x.column_name === c)),
    cols.map((c) => c.column_name).join(','));
}

console.log('\na unit finished stays finished across a restart');
{
  const ck = await loadCheckpoint(41, db);
  check('a job with no history has nothing to skip', ck.count() === 0 && !ck.has('uber', 'trips A'));
  await ck.mark('uber', 'trips 2026-01..2026-02', 900);
  await ck.mark('uber', 'trips 2026-02..2026-03', 850);
  check('what it marked, it knows', ck.has('uber', 'trips 2026-01..2026-02') && ck.count() === 2);

  /* The restart: a brand new process, a brand new checkpoint object, the same
     job id. This is the whole mechanism. */
  const after = await loadCheckpoint(41, db);
  check('a new process reading the same job sees the finished units',
    after.has('uber', 'trips 2026-01..2026-02') && after.has('uber', 'trips 2026-02..2026-03'),
    String(after.count()));
  check('and only that job\u2019s \u2014 a different backfill starts clean',
    (await loadCheckpoint(42, db)).count() === 0);
  check('a unit it never did is not skipped', !after.has('uber', 'trips 2026-03..2026-04'));
  check('nor is another source\u2019s window of the same name', !after.has('fms', 'trips 2026-01..2026-02'));
}

console.log('\nthe count only grows, which is what the abandon rule reads');
{
  /* src/index.js abandons a job whose `steps` did not exceed the last
     attempt\u2019s. A resumed run that skips six windows and does two would report
     2 against 7 and read as going backwards — so steps counts what the JOB has
     finished, not what this attempt walked past. */
  const ck = await loadCheckpoint(43, db);
  for (let i = 0; i < 5; i++) await ck.mark('uber', `w${i}`, 10);
  const first = ck.count();
  const second = await loadCheckpoint(43, db);
  await second.mark('uber', 'w5', 10);
  check('a second attempt continues the count rather than restarting it',
    second.count() === first + 1, `${first} then ${second.count()}`);
  check('and re-marking a unit does not inflate it', await (async () => {
    await second.mark('uber', 'w5', 10);
    return second.count() === first + 1;
  })(), String(second.count()));
}

console.log('\nthe whole source is a unit too');
{
  const ck = await loadCheckpoint(44, db);
  await ck.mark('uber');
  const after = await loadCheckpoint(44, db);
  check('a finished source is remembered the same way a window is', after.has('uber'));
  check('\u2026and is distinguishable from a window inside it', !after.has('uber', 'trips X'));
}

console.log('\nit is forgotten when the job is');
{
  const ck = await loadCheckpoint(45, db);
  await ck.mark('uber', 'w1', 1);
  await clearCheckpoint(45, db);
  check('a finished job leaves no rows behind', (await loadCheckpoint(45, db)).count() === 0);
  check('and clearing one job does not touch another',
    (await loadCheckpoint(44, db)).count() === 1);
}

console.log('\na run with no job behind it is unaffected');
{
  const none = await loadCheckpoint(null, db);
  check('no job means nothing to skip', none === NO_CHECKPOINT && !none.has('uber', 'x'));
  check('and marking is a no-op rather than a crash',
    await (async () => { await none.mark('uber', 'x', 1); return true; })());
}

console.log('\na checkpoint that cannot be read costs time, never correctness');
{
  const broken = { query: async () => { throw new Error('relation does not exist'); } };
  const ck = await loadCheckpoint(46, broken);
  check('an unreadable checkpoint skips nothing rather than throwing', !ck.has('uber', 'w1'));
  check('and marking still does not throw',
    await (async () => { await ck.mark('uber', 'w1', 1); return true; })());
}

/* ── the wiring ────────────────────────────────────────────────────────────
   The mechanism above is exercised for real. What these assert is that the
   runner and the source that stalls are actually PLUGGED INTO it — which is a
   separate question, and the one that decides whether any of it runs in
   production. Source-shape checks, deliberately: runWindowInner is not
   exported and HISTORICAL is a module-level map of the eight real collectors,
   so reaching the loop from a test would mean either stubbing eight provider
   modules or reshaping the runner to be testable. Neither is worth more than
   naming the four lines that matter and failing if they go. */
console.log('\nthe runner is plugged into it');
{
  const { readFileSync } = await import('node:fs');
  const run = readFileSync('src/run.js', 'utf8');
  check('the runner reads the job\u2019s checkpoint', /loadCheckpoint\(jobId\)/.test(run));
  check('a source this job already finished is skipped whole',
    /if \(ckpt\.has\(name\)\)/.test(run));
  check('\u2026and still counts as done, so the number a reader sees is how much is behind the run',
    /if \(ckpt\.has\(name\)\) \{\s*\n\s*done\+\+;/.test(run));
  check('the source is handed a checkpoint of its own', /mod\.collect\(\{[^}]*checkpoint/.test(run));
  check('a source is marked finished only when it did not throw',
    /if \(!threw\) await ckpt\.mark\(name\)/.test(run));
  /* The abandon rule in src/index.js compares `steps` against the last
     attempt\u2019s. If steps counted this attempt\u2019s work, a resumed run would
     report fewer than before and read as going backwards — and be abandoned
     for resuming successfully. */
  check('steps counts what the JOB has finished, not what this attempt walked past',
    /let steps = ckpt\.count\(\)/.test(run) && /steps = ckpt\.count\(\) \+ 1/.test(run));

  const uber = readFileSync('src/sources/uber.js', 'utf8');
  check('the trip windows are skipped when already collected',
    /checkpoint\?\.has\(`trips /.test(uber));
  check('\u2026and marked when they land', /checkpoint\?\.mark\(`trips /.test(uber));
  check('the earnings windows too', /checkpoint\?\.has\(unit\)/.test(uber) && /checkpoint\?\.mark\(unit/.test(uber));
  /* A window recorded as done because it FAILED is a hole the job would then
     skip for ever — the one way this mechanism could make things worse than
     no mechanism at all. */
  check('a failed window is not marked done',
    /if \(!chunk\.error \|\| chunk\.expected\)/.test(uber) && /if \(!err\) await checkpoint\?\.mark\(unit/.test(uber));
  check('a window past the provider\u2019s retention IS done, because asking again can only be refused again',
    /chunk\.expected/.test(uber));
  /* Two fleets walk the same calendar. A bare window name would let Egari be
     skipped because Ecosine had already collected that month. */
  check('the two fleets do not share a window\u2019s checkpoint',
    /checkpoint\.has\(`\$\{o\.fleet\}:/.test(uber));

  const idx = readFileSync('src/index.js', 'utf8');
  check('the scheduler hands the job id to the run', /backfill\(progress, job\.fleet \|\| null, job\.id\)/.test(idx));
  check('and forgets the checkpoints once the job is done', /clearCheckpoint\(job\.id\)/.test(idx));
  /* A failed job keeps them: re-queuing it is the operator\u2019s next move, and
     the point of the table is that the re-queue continues. */
  const failBlock = idx.slice(idx.indexOf("status='failed'"), idx.indexOf("status='failed'") + 700);
  check('a FAILED job keeps its checkpoints, so re-queuing it resumes',
    !/clearCheckpoint/.test(failBlock));
}

/* ── the three things that decide whether any of it fires ─────────────────
   The checkpoint makes a run continue. These make the SCHEDULER let it. */
console.log('\nthe abandon rule can actually see the progress');
{
  const { readFileSync } = await import('node:fs');
  const idx = readFileSync('src/index.js', 'utf8');
  /* The requeue writes done_at_last_attempt / steps_at_last_attempt into the
     progress document as the baseline for the NEXT attempt. The progress
     writer was a whole-document replace, so the first write of that attempt
     erased them — and coalesce(absent, -1) is -1, which everything beats. So
     a job that truly wedged the container could never be abandoned, while one
     killed before its first progress write kept the stale baselines, compared
     equal, and was abandoned for it. Both failed rows on production are the
     second case. */
  check('the progress write merges rather than replacing',
    /SET progress = coalesce\(progress, '\{\}'::jsonb\) \|\| \$2::jsonb/.test(idx),
    'a whole-document write erases the baselines the abandon rule compares against');
  check('and the requeue still writes those baselines',
    /done_at_last_attempt/.test(idx) && /steps_at_last_attempt/.test(idx));
  /* attempts was incremented on claim AND on requeue, so one interruption
     read as two and a job restarted twice was accused of three. */
  check('a restart is counted once, not twice',
    /attempts = coalesce\(attempts, 0\) \+ 1/.test(idx)
    && !/attempts = CASE WHEN \$\{ADVANCED\} THEN 1 ELSE coalesce\(attempts, 0\) \+ 1 END/.test(idx),
    'the claim counts it; the requeue must not count it again');
  check('and a job that advanced starts its count again',
    /attempts = CASE WHEN \$\{ADVANCED\} THEN 0 ELSE coalesce\(attempts, 0\) END/.test(idx));
}

console.log('\ntwo collections waiting do not both wake');
{
  /* The barrier was one promise every waiter awaited, so N waiters woke
     together and ran concurrently — into the provider's three-report cap,
     which is the starvation the barrier exists to prevent. */
  let running = 0, maxConcurrent = 0;
  const order = [];
  const tailTest = (() => {
    let queuedN = 0;
    let t = Promise.resolve();
    return (name, ms) => {
      queuedN++;
      const run = async () => {
        running++; maxConcurrent = Math.max(maxConcurrent, running);
        order.push(name);
        await new Promise((r) => setTimeout(r, ms));
        running--; queuedN--;
      };
      const mine = t.then(run, run);
      t = mine.then(() => {}, () => {});
      return mine;
    };
  })();
  /* The shape of the bug: a long run, then three short ones queued behind it
     while it is still going. */
  const a = tailTest('backfill', 60);
  const b = tailTest('incremental-1', 5);
  const c = tailTest('incremental-2', 5);
  const d2 = tailTest('incremental-3', 5);
  await Promise.all([a, b, c, d2]);
  check('only one collection runs at a time', maxConcurrent === 1, `peak ${maxConcurrent}`);
  check('and they run in the order they were asked for',
    order.join(',') === 'backfill,incremental-1,incremental-2,incremental-3', order.join(','));

  const { readFileSync } = await import('node:fs');
  const run = readFileSync('src/run.js', 'utf8');
  check('the runner chains rather than sharing one gate',
    /const mine = tail\.then\(run, run\)/.test(run) && !/inFlight = new Promise/.test(run));
  check('and a failed run does not poison the queue behind it',
    /tail = mine\.then\(\(\) => \{\}, \(\) => \{\}\)/.test(run));
}

await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
