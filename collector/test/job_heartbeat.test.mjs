/* Nothing in the product records WHY the collector died.
   ──────────────────────────────────────────────────────────────────────────
   Measured on production (GET /api/settings/jobs, 2026-09-02): of the 40 job
   rows the endpoint returns, one is 'failed' — job 8, a backfill, attempts 5,
   done 0 of 8, current 'uber', remaining the other seven sources, and

     "step": { "of": 12, "index": 6, "window": "2026-01-26..2026-02-25",
               "rows_so_far": 35829 }

   five attempts in a row. Its error is the boot requeue's own inference:
   "abandoned: restarted three times without completing a single source or
   collection window, so the job itself may be killing the collector".

   That sentence is the whole of what this product can say about a dead run.
   collector_job has no exit code, no signal and no memory reading, so the one
   hypothesis the shape actually suggests — pullTrips holds a whole CSV report
   in memory and then upserts a raw JSONB per row, which is an OOM shape — is
   not something anyone can confirm or refute from the row.

   So: a heartbeat, written into the progress document on each onStep, carrying
   the process's RSS and the instant it was taken; and an abandonment message
   that quotes it. This file asserts both, and asserts the two properties that
   decide whether it is worth anything: that it costs no extra query, and that
   it MERGES rather than replacing (a whole-document write erases the baselines
   the abandon rule compares against — see test/resume.test.mjs). */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { applySchema } from './schema.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
await applySchema(db);

const idx = readFileSync('src/index.js', 'utf8');
const runSrc = readFileSync('src/run.js', 'utf8');

/* The SQL under test is the SQL that ships, lifted out of src/index.js rather
   than retyped here. A copy in the test would keep passing after the statement
   it is about had changed — and PGlite then runs it, so a statement that only
   Postgres would reject fails here rather than at 2am on a stranded job.

   Backtick-delimited, which also catches the trap that cost an hour writing
   this: a backtick inside the SQL (a comment saying `||`, say) closes the
   template literal early. node --check still passes — the two halves parse as
   a string concatenation — and the only symptom is the database refusing the
   statement at runtime. Here it shows up as a parse error on this line. */
const literal = (src, after) => {
  const i = src.indexOf(after);
  if (i < 0) return null;
  const a = src.indexOf('`', i);
  const b = src.indexOf('`', a + 1);
  return (a < 0 || b < 0) ? null : src.slice(a + 1, b);
};

console.log('\nthe heartbeat itself');
let heartbeat = null;
try { ({ heartbeat } = await import('../src/run.js')); } catch (e) { console.log(`  (import failed: ${e.message})`); }
check('the runner exposes a heartbeat builder', typeof heartbeat === 'function');
const mem = (rssMb, heapMb = 40) => ({ rss: rssMb * 1048576, heapUsed: heapMb * 1048576 });
if (typeof heartbeat === 'function') {
  const h = heartbeat(mem(913, 402), new Date('2026-01-26T04:15:00.000Z'));
  check('it carries the process RSS, in megabytes', h.rss_mb === 913, JSON.stringify(h));
  check('and the heap, so a CSV held in memory is distinguishable from RSS growth',
    h.heap_mb === 402, JSON.stringify(h));
  /* String(aDate) is "Mon Jan 26 2026", which sorts wrong and parses
     differently in every reader. */
  check('and an ISO timestamp, not a JS date string',
    h.heartbeat_at === '2026-01-26T04:15:00.000Z', String(h.heartbeat_at));
  const live = heartbeat();
  check('a bare call measures this process rather than needing to be told',
    live.rss_mb > 0 && Date.now() - Date.parse(live.heartbeat_at) < 5000, JSON.stringify(live));
}

console.log('\nevery progress report the run makes carries one');
{
  /* One funnel, not three call sites. The interesting one is onStep: it fires
     per window, which is the grain at which job 8 died. */
  check('the run reports through a single funnel that attaches the heartbeat',
    /const beat = onProgress;\s*\n\s*onProgress = \(p\) => beat\?\.\(\{ \.\.\.p, \.\.\.heartbeat\(\) \}\);/.test(runSrc));
  /* The undecorated callback is reachable under exactly one name, and that
     name is used exactly once. A report that called it directly would be a
     window with no heartbeat, which is the window a death would land on. */
  const raw = runSrc.match(/beat\?\.\(/g) || [];
  check('and no report bypasses it', raw.length === 1, `${raw.length} calls to the undecorated callback`);
  check('onStep reports through it too, so the per-window beat is the frequent one',
    /const onStep = \(st\) => \{[\s\S]{0,260}return onProgress\?\.\(\{/.test(runSrc));
}

console.log('\nthe scheduler writes it without spending a query on it');
const progressSql = literal(idx, 'const progress = (p2) => pool.query(');
check('the progress writer was found', !!progressSql);
{
  const writer = idx.slice(idx.indexOf('const progress = (p2) => pool.query('),
    idx.indexOf('const progress = (p2) => pool.query(') + 900);
  check('the heartbeat rides the write that was already happening',
    (writer.match(/pool\.query\(/g) || []).length === 1,
    'a query per window is not a heartbeat, it is a second collector');
  check('and it still merges into the document rather than replacing it',
    /SET progress = coalesce\(progress, '\{\}'::jsonb\) \|\| \$2::jsonb/.test(progressSql || ''));
}

console.log('\nwhat the row says after two beats');
{
  await db.query(`INSERT INTO collector_job (id, mode, status, requested_by, attempts, started_at)
                  VALUES (8, 'backfill', 'running', 'test', 3, now())`);
  /* The baselines the boot requeue wrote for this attempt. They must survive
     every heartbeat, or the abandon rule is comparing against nothing. */
  await db.query(`UPDATE collector_job SET progress =
                    '{"done_at_last_attempt": 0, "steps_at_last_attempt": 7}'::jsonb WHERE id = 8`);

  const beat = (rssMb, at) => db.query(progressSql, [8, JSON.stringify({
    current: 'uber', done: 0, total: 8,
    remaining: ['uberFleet', 'yango', 'bolt', 'hotel', 'external', 'events', 'fms'],
    step: { of: 12, index: 6, window: '2026-01-26..2026-02-25', rows_so_far: 35829 }, steps: 7,
    ...(heartbeat ? heartbeat(mem(rssMb), new Date(at)) : {}),
  })]);
  /* The shape that matters: RSS climbs through the report, then the reading
     falls back after a GC — so the LAST beat is not the largest the process
     got, and the largest is the number an OOM is about. */
  await beat(913, '2026-01-26T04:15:00.000Z');
  await beat(402, '2026-01-26T04:31:00.000Z');
  const [row] = (await db.query('SELECT progress FROM collector_job WHERE id = 8')).rows;
  const p = row.progress;
  check('the row now says how big the process was at the last beat', p.rss_mb === 402, JSON.stringify(p));
  check('and how big it ever got, which is the number an OOM is about',
    p.rss_peak_mb === 913, JSON.stringify(p));
  check('and when the last beat was', p.heartbeat_at === '2026-01-26T04:31:00.000Z', String(p.heartbeat_at));
  check('the window it was on is still there', p.step?.window === '2026-01-26..2026-02-25');
  check('and the abandon rule’s baselines survived the beats',
    p.done_at_last_attempt === 0 && p.steps_at_last_attempt === 7, JSON.stringify(p));
}

console.log('\nso the next abandonment can say what job 8 could not');
{
  const advanced = literal(idx, 'const ADVANCED =');
  const requeue = literal(idx, '\n    pool.query(');
  check('the requeue statement was found', !!requeue && !!advanced);
  const sql = (requeue || '').split('${ADVANCED}').join(advanced || 'false');
  const { rows } = await db.query(sql);
  const [r] = (await db.query(`SELECT status, error, progress FROM collector_job WHERE id = 8`)).rows;
  check('a job that restarted three times without advancing is still abandoned',
    r.status === 'failed', `${r.status} (requeue returned ${rows.length} row(s))`);
  /* The container log is where anyone looks first after a restart, so the
     statement returns the same reading it stored rather than leaving the log
     to say only which source the job was on. */
  check('and the requeue hands the log the same reading it stored',
    rows[0]?.died_on === '2026-01-26..2026-02-25' && String(rows[0]?.died_rss) === '913',
    JSON.stringify(rows[0]));
  check('the abandonment names the window it died on',
    /2026-01-26\.\.2026-02-25/.test(r.error || ''), r.error);
  check('and how large the process had got',
    /913/.test(r.error || ''), r.error);
  check('while still saying what it can only infer',
    /may be killing the collector/.test(r.error || ''), r.error);
  /* The next attempt's first heartbeat overwrites rss_mb and heartbeat_at, so
     where THIS attempt stopped is snapshotted beside the baselines — same
     statement, no extra write. */
  check('and the row remembers where this attempt stopped, for the attempt after it',
    r.progress?.died_on === '2026-01-26..2026-02-25'
    && r.progress?.died_at === '2026-01-26T04:31:00.000Z', JSON.stringify(r.progress));
}

console.log('\na job with no heartbeat at all is requeued, not broken by the message');
{
  /* Every job row already in production predates this, and a job killed before
     its first onStep has no beat either. The message must degrade to what it
     used to say rather than to NULL — SQL || NULL is NULL, which would erase
     the only sentence the row had. */
  await db.query(`INSERT INTO collector_job (id, mode, status, requested_by, attempts, progress)
                  VALUES (9, 'backfill', 'running', 'test', 4,
                          '{"done": 0, "steps": 0, "done_at_last_attempt": 0, "steps_at_last_attempt": 0}'::jsonb)`);
  const advanced = literal(idx, 'const ADVANCED =');
  const sql = (literal(idx, '\n    pool.query(') || '').split('${ADVANCED}').join(advanced || 'false');
  await db.query(sql);
  const [r] = (await db.query(`SELECT status, error FROM collector_job WHERE id = 9`)).rows;
  check('it is still abandoned', r.status === 'failed', r.status);
  check('and still says why, without a heartbeat to quote',
    /may be killing the collector/.test(r.error || ''), String(r.error));
}

await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
