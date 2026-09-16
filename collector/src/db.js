// Postgres pool + migration + generic upsert helpers.
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { log } from './log.js';
import { SCHEMA_FILES } from './schema_files.js';

const __dir = dirname(fileURLToPath(import.meta.url));

// Connection string is infra config — read straight from the environment (kept out of config.js to
// avoid an import cycle: config → settings → db). Managed Postgres presents a CA-signed cert the
// container doesn't trust; we enable TLS but skip chain verification. Strip `sslmode` first, else
// pg-connection-string parses it as verify-full and overrides our ssl option.
function poolConfig() {
  const p = process.env;
  let cs = p.DATABASE_URL
    || `postgres://${p.PGUSER || 'fleet'}:${p.PGPASSWORD || 'fleet'}@${p.PGHOST || 'db'}:${p.PGPORT || '5432'}/${p.PGDATABASE || 'fleet'}`;
  const needSsl = p.DATABASE_SSL === 'true' || /sslmode=/i.test(cs);
  if (needSsl) { try { const u = new URL(cs); u.searchParams.delete('sslmode'); cs = u.toString(); } catch { /* keep as-is */ } }
  return {
    connectionString: cs,
    max: 8,
    /* A query that will not finish must not hold a pool slot for ever. With
       eight connections, two stuck queries are a quarter of the API's capacity
       and the symptom is every other page becoming slow — which reads as a
       database problem rather than as one bad statement. Two minutes is far
       longer than the slowest honest query here (the full rollup, at about
       forty seconds) and far shorter than a hang.

       One value governs both processes. The collector's heaviest single
       statement is the full rollup at about forty seconds, so it fits — and if
       a backfill ever needs longer, STATEMENT_TIMEOUT_MS raises it for that
       component without touching the API's. */
    statement_timeout: Number(process.env.STATEMENT_TIMEOUT_MS || 120000),
    ssl: needSsl ? { rejectUnauthorized: false } : undefined,
  };
}
export const pool = new pg.Pool(poolConfig());

/* pg-pool emits 'error' when a socket belonging to an IDLE client fails. With
   no listener that is an unhandled 'error' event thrown out of a socket
   callback, which takes the process down — and managed Postgres reaps idle
   backends as a matter of routine, so a failover killed both containers rather
   than reconnecting. The pool discards the broken client itself; all this has
   to do is refuse to be fatal. */
pool.on('error', (err) => log.error('db', 'idle client error', { err: err.message, code: err.code }));

/* NINETY-TWO SECONDS OF LLVM FOR A QUERY THAT RUNS IN TWENTY-FIVE
   MILLISECONDS.
   ─────────────────────────────────────────────────────────────────────────
   THE DEFECT, MEASURED ON PRODUCTION 2026-09-16 BY EXPLAIN (ANALYZE, BUFFERS)
   OF THE EXACT STATEMENT THE ROUTE SENDS. /api/unauthorized/attributed
   answered a window containing ZERO segments in 67 to 113 seconds, and the
   cost was flat against the number of segments — 5 segments 98.6 s, 16 78.2 s,
   123 84.1 s, none at all 67.0 s. Two diagnoses read out of the source were
   wrong (the attribution ladder, which an empty window never runs; then an
   unindexed min() over driver_status_event, which sql/schema_v73.sql fixed and
   which moved the floor not at all). The plan settled it:

     Limit … (actual time=92208.833..92209.316 rows=0 loops=1)
       ->  Nested Loop Left Join … (actual time=24.255..24.738 rows=0 loops=1)
     Planning Time: 150.308 ms
     JIT:
       Functions: 2153
       Options: Inlining true, Optimization true, Expressions true, Deforming true
       Timing: Generation 368.210 ms, Inlining 314.023 ms,
               Optimization 50213.092 ms, Emission 41657.475 ms,
               Total 92552.800 ms
     Execution Time: 92636.076 ms

   The query itself takes 24.7 ms. Postgres spent 92.55 SECONDS compiling it —
   50 s in LLVM optimisation and 42 s emitting machine code for 2,153
   functions — and then ran the result on zero rows.

   WHY IT FIRES HERE AND WHY IT WILL FIRE AGAIN. JIT is gated on the planner's
   ESTIMATED total cost, not on how long anything takes: jit_above_cost
   (100,000) turns it on, jit_optimize_above_cost and jit_inline_above_cost
   (500,000 each) turn on the two expensive halves. That statement estimates at
   10,536,749 — a hundred times the inlining threshold — because it is 143,000
   characters of SQL with roughly thirty CTEs and three nested laterals per
   segment. The estimate is what it is whether or not a single row qualifies,
   so an empty window pays the full compile. And both services are basic-xxs:
   one vCPU, where LLVM's optimiser is the slowest thing in the system.

   OFF FOR THE WHOLE POOL, DELIBERATELY. The API's own slow-query log on that
   same boot shows the tax is not confined to one route — statements at 18.7 s,
   17.4 s, 12.9 s and 11.1 s across the driver, vehicle and roster pages, all
   of them wide expression-heavy scans over the same tables, which is exactly
   the shape that clears jit_above_cost. JIT earns its keep on a long scan
   where compiled expression evaluation repays the compile over millions of
   rows; this fleet's largest table is 175,000 rows on a single vCPU, so the
   compile is rarely repaid and is sometimes, as above, three thousand times
   the cost of the work.

   REVERSIBLE WITHOUT A DEPLOY. PG_JIT=on restores the default, so the trade
   can be re-measured against the same endpoints rather than argued about. Set
   per connection rather than in the connection string's `options`, because a
   failure here must be a warning on one connection and never a pool that
   cannot hand out clients. */
export const sessionSql = (env = process.env) => (env.PG_JIT === 'on' ? null : 'SET jit = off');

export async function applySessionSettings(client, env = process.env) {
  const sql = sessionSql(env);
  if (!sql) return null;
  await client.query(sql);
  return sql;
}

pool.on('connect', (client) => {
  applySessionSettings(client).catch(
    (err) => log.warn('db', 'session setting refused', { err: err.message }));
});


/* Every deploy replayed all thirty-one files in full, and three of them are
   expensive.
   ─────────────────────────────────────────────────────────────────────────
   The API answers 503 while migrate() runs, and migrate() was taking between
   five and six minutes on every single deploy — so every deploy of this
   product included six minutes of a dashboard that does not load. Not a slow
   query somewhere: the same three statements timing out, failing, being logged
   and swallowed, every boot, for months.

   Two of them are the insight de-duplication in v15 and v31, which were
   written as self-joins — `DELETE FROM insight a USING insight b` — over a
   table holding thirty thousand rows. That is a quadratic comparison, roughly
   nine hundred million row pairs, and it hits the two-minute statement timeout
   without ever finishing. Both are rewritten below as anti-joins against the
   set the read path already selects, which is O(n log n) and completes.

   But the real fix is that a migration that has succeeded should not run
   again. This ledger records the SHA-256 of each file's contents once it
   applies cleanly, and skips it on the next boot. Keyed on the CONTENT and not
   on the name, so editing a migration re-runs it exactly once — which is what
   makes fixing the two DELETEs above deployable at all.

   Everything here is still written to be safely re-runnable (IF NOT EXISTS,
   OR REPLACE, guarded data changes), so the ledger is an optimisation and
   never the thing correctness depends on. A file that fails is NOT recorded
   and is retried on the next boot, exactly as before. */
async function ledger() {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_applied (
    file       TEXT PRIMARY KEY,
    sha        TEXT NOT NULL,
    applied_at TIMESTAMPTZ DEFAULT now(),
    ms         INT
  )`);
  await pool.query(`COMMENT ON TABLE schema_applied IS
    'One row per schema file that has applied cleanly, keyed on the SHA-256 of its contents. A file whose hash matches is skipped at boot; editing one re-runs it once. A file that FAILS is not recorded, so it retries on the next boot.'`);
  const { rows } = await pool.query('SELECT file, sha FROM schema_applied');
  return new Map(rows.map((r) => [r.file, r.sha]));
}

/* ONE MIGRATOR AT A TIME.
   ─────────────────────────────────────────────────────────────────────────
   Two services run this on boot — src/index.js:20 for the collector and
   api/server.js:5533 for the API — and a deploy starts both containers at
   once. That was harmless while every file was additive and idempotent: two
   processes running CREATE TABLE IF NOT EXISTS against each other cost
   nothing.

   sql/schema_v53.sql is not additive. It drops nine views, rebuilds six
   generated columns and puts the views back, and two of those running
   concurrently take locks on the same objects in whatever order they get to
   them. Measured on production 2026-09-07, in the boot after the view fix
   landed:

     ERROR [db] migration schema_v53.sql failed {"err":"deadlock detected"}

   Postgres picked one of the two to kill, the file was not recorded, and the
   next boot did it again.

   A session advisory lock on a fixed key serialises them: the second process
   blocks until the first is finished, then reads the ledger, finds every sha
   already recorded and skips the lot. It waits rather than giving up, because
   a service that skipped migrations to avoid a wait would serve against a
   schema it has not applied — which is the failure this whole file guards.

   The key is arbitrary and must only be stable. It is held on ONE checked-out
   client for the whole run, because an advisory lock is session-scoped and a
   pooled query would release it the moment that query's client went back.

   ── and the lock wait is itself a statement ────────────────────────────────
   The first version of this took the lock on a client straight out of the
   pool, which arms every session with statement_timeout (120s, see
   poolConfig). pg_advisory_lock BLOCKS, and a blocked statement is still a
   statement: Postgres cancelled the WAIT at two minutes. The catch around it
   swallowed that and let the boot carry on WITHOUT the lock — the exact
   fail-open this code exists to prevent. Measured on production 2026-09-07,
   the boot after it shipped:

     api       15:11:02  INFO  [db] migrated schema_v53.sql {"ms":123022}
     collector 15:13:00  ERROR [db] migration schema_v53.sql failed
                               {"ms":120510,"err":"statement timeout"}

   Subtract the durations: the API ran v53 from 15:09:00 to 15:11:02 and the
   collector started its own copy at 15:10:59.94 — 120 seconds after it began
   waiting, and two seconds BEFORE the API committed. Both rewrote the trip
   table at once. The API's won, the collector's rolled back, and the fleet
   paid for the second rewrite in bloat: /api/kpis over the full window went
   from about a second to 48.

   So the migration session raises its own timeout before it reaches for the
   lock, and the migrations then run ON that same client rather than through
   the pool — because the file legitimately takes longer than an API query is
   ever allowed to: v53 took 123 seconds, which is already past the pool's
   limit and only survived because no single statement inside it crossed.

   It is a large finite number rather than 0. Unlimited would mean a migration
   that genuinely hangs takes the boot with it and never says why. */
const MIGRATE_LOCK = 0x5f16534e;
const MIGRATE_TIMEOUT_MS = Number(process.env.MIGRATE_STATEMENT_TIMEOUT_MS || 900000);

export async function migrate() {
  let gate = await pool.connect().catch(() => null);
  if (gate) {
    await gate.query(`SET statement_timeout = ${Number(MIGRATE_TIMEOUT_MS) || 900000}`).catch(() => {});
    try {
      await gate.query('SELECT pg_advisory_lock($1)', [MIGRATE_LOCK]);
    } catch (e) {
      /* With the timeout raised this is a dead connection, not a wait that ran
         long. Migrating unlocked is the lesser evil — a concurrent run loses a
         rewrite and retries next boot, whereas refusing to migrate would leave
         this service answering against a schema it has not applied — but it is
         never silent, because it is how the 48-second regression above got in. */
      log.error('db', 'migration lock unavailable — migrating WITHOUT it', { err: String(e).slice(0, 200) });
      gate.release();
      gate = null;
    }
  }
  try {
    return await runMigrations(gate);
  } finally {
    if (gate) {
      await gate.query('SELECT pg_advisory_unlock($1)', [MIGRATE_LOCK]).catch(() => {});
      gate.release();
    }
  }
}

/* `client` is the locked session when there is one, so a migration runs under
   MIGRATE_TIMEOUT_MS rather than the API's query budget. Falls back to the
   pool when the lock could not be taken. */
async function runMigrations(client) {
  const db = client || pool;
  let applied;
  try {
    applied = await ledger();
  } catch (e) {
    /* No ledger is not a reason not to migrate. An older database, or a role
       without CREATE, falls back to the previous behaviour: replay everything. */
    log.error('db', 'schema ledger unavailable — replaying every file', { err: String(e).slice(0, 200) });
    applied = new Map();
  }

  let ran = 0, skipped = 0;
  for (const f of SCHEMA_FILES) {
    const sql = readFileSync(join(__dir, '..', 'sql', f), 'utf8');
    const sha = createHash('sha256').update(sql).digest('hex');
    if (applied.get(f) === sha) { skipped += 1; continue; }
    const t0 = Date.now();
    try {
      await db.query(sql);
      const ms = Date.now() - t0;
      ran += 1;
      log.info('db', `migrated ${f}`, { ms });
      await db.query(
        `INSERT INTO schema_applied (file, sha, applied_at, ms) VALUES ($1, $2, now(), $3)
         ON CONFLICT (file) DO UPDATE SET sha = EXCLUDED.sha, applied_at = now(), ms = EXCLUDED.ms`,
        [f, sha, ms]).catch(() => { /* no ledger: still migrated, just not recorded */ });
    } catch (e) {
      /* Not recorded, so it is retried next boot. schema.sql is the only file
         whose failure is fatal: everything else is additive. */
      log.error('db', `migration ${f} failed`, { ms: Date.now() - t0, err: String(e).slice(0, 200) });
      if (f === 'schema.sql') throw e;
    }
  }
  log.info('db', 'migrations complete', { ran, skipped, of: SCHEMA_FILES.length });
}

// Upsert one row into `table`, conflict on `conflict` columns, updating the rest.
export async function upsert(table, row, conflict) {
  const cols = Object.keys(row);
  const vals = cols.map((c) => row[c]);
  const ph = cols.map((_, i) => `$${i + 1}`);
  const changing = cols.filter((c) => !conflict.includes(c));
  const updates = changing.map((c) => `${c}=EXCLUDED.${c}`);
  /* The same guard upsertMany() carries, and for the same reason — the whole
     argument, with the production timings that produced it, is at its call
     site below. Both writers, or the rule is one a caller has to know which
     function it picked to rely on. */
  const changed = `(${changing.map((c) => `${table}.${c}`).join(', ')})`
    + ` IS DISTINCT FROM (${changing.map((c) => `EXCLUDED.${c}`).join(', ')})`;
  const doUpdate = updates.length
    ? `DO UPDATE SET ${updates.join(', ')} WHERE ${changed}`
    : 'DO NOTHING';
  const text = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${ph.join(',')})
                ON CONFLICT (${conflict.join(',')}) ${doUpdate}`;
  await pool.query(text, vals);
}

// Batched upsert (chunks to keep parameter counts sane).
/* One statement per batch, not one per row.
   ─────────────────────────────────────────────────────────────────────────
   This sent a separate INSERT for every row. A year backfill writes about
   165,000 trips, so it sent 165,000 statements, each a round trip to a managed
   database on another host — and it is why a backfill pinned a one-vCPU
   Postgres for hours and every dashboard page timed out behind it. The work
   was never the writing; it was the asking.

   Three things have to be right for a multi-row upsert, and each of them is a
   real failure this code has to handle:

   1. Rows in one call can carry DIFFERENT columns — the sources build objects
      field by field and omit what a provider did not send. A single statement
      has one column list, so rows are grouped by their column signature and
      each group gets its own statement.

   2. A conflict key must not appear twice in one statement. Postgres refuses
      with "ON CONFLICT DO UPDATE command cannot affect row a second time" —
      the row-at-a-time version simply applied them in order, so duplicates
      inside one batch were legal and the last one won. The same rule is kept
      by de-duplicating on the conflict key before the statement, last write
      winning, which is what a sequential replay would have produced.

   3. Postgres allows 65,535 bind parameters per statement. A batch of 200
      rows of 25 columns is 5,000, but a wide table and a large chunk could
      cross it, so the batch size is derived from the column count.

   Same transaction per batch, same ON CONFLICT semantics, same idempotency on
   re-run. Only the number of round trips changed. */
export async function upsertMany(table, rows, conflict, chunk = 200) {
  if (!rows.length) return 0;
  const MAX_PARAMS = 60000;   // under Postgres's 65535, with room for the shape

  // Group by column signature: one statement can only carry one column list.
  const groups = new Map();
  for (const r of rows) {
    const cols = Object.keys(r);
    const key = cols.slice().sort().join('\u0000');
    if (!groups.has(key)) groups.set(key, { cols, rows: [] });
    groups.get(key).rows.push(r);
  }

  let n = 0;
  for (const { cols, rows: groupRows } of groups.values()) {
    const changing = cols.filter((c) => !conflict.includes(c));
    const updates = changing.map((c) => `${c}=EXCLUDED.${c}`);
    /* AN UPDATE THAT CHANGES NOTHING IS NOT FREE, AND THIS ONE WAS RUNNING
       EVERY TWO MINUTES.
       ───────────────────────────────────────────────────────────────────────
       THE DEFECT, MEASURED. Postgres has no in-place update: an UPDATE that
       sets every column to the value already stored still writes a new row
       version and leaves the old one as a dead tuple, which every sequential
       scan of that table has to read past until autovacuum gets to it.

       src/sources/uber.js:1919 upserts EVERY status entry the provider carries
       for EVERY driver on every live tick — LIVE_STATUS_SECONDS, default 120 —
       into driver_status_event, a table whose own COMMENT calls it append-only
       and whose call site calls the write "idempotent by construction". It is
       idempotent in its RESULT. It was not idempotent in its COST: the same
       few thousand rows were rewritten 720 times a day, so the heap grew by a
       tick's worth of dead tuples every two minutes while the live row count
       stood still.

       What that bought, timed against production on 2026-09-16:
       `SELECT min(at) FROM driver_status_event` — one unfiltered min() over a
       table two days old — took 67 to 109 seconds, and it is called once per
       request by /api/unauthorized/attributed and /api/driver/unauthorized.
       A window containing ZERO segments cost 67 seconds on that query alone.
       sql/schema_v73.sql adds the index that makes the read cheap; this stops
       the heap it reads from growing for no reason.

       WHY A GUARD RATHER THAN 'DO NOTHING' FOR THAT ONE TABLE. DO NOTHING
       would also stop the rewrite, and it would silently stop a CORRECTION
       too: a row first written with a null fleet_id, or a provider that
       restates a value, would keep the older answer forever. The guard is
       exactly the write that would have changed something, so every caller
       keeps the last-write-wins semantics it has always had, and only the
       writes that were never going to change a byte are skipped. Nothing
       observable differs — same rows, same values, same conflict key.

       SAFE ON EVERY COLUMN THIS SCHEMA HOLDS. IS DISTINCT FROM needs an
       equality operator; every column type in sql/ is text, int, bigint,
       numeric, double, real, boolean, date, timestamp(tz), jsonb, text[] or
       bytea, all of which have one. (jsonb compares by value with normalised
       key order, which is the comparison wanted here; bare `json`, which has
       no equality operator at all, appears nowhere in this schema — if it ever
       does, this line is where it will fail loudly rather than quietly.)
       Generated columns never appear in `cols`, because no caller writes one.

       A single-column list is not a row constructor — `(a) IS DISTINCT FROM
       (b)` is the ordinary scalar form and means the same thing, so the same
       expression serves one column and twenty. */
    const changed = `(${changing.map((c) => `${table}.${c}`).join(', ')})`
      + ` IS DISTINCT FROM (${changing.map((c) => `EXCLUDED.${c}`).join(', ')})`;
    const doUpdate = updates.length
      ? `DO UPDATE SET ${updates.join(', ')} WHERE ${changed}`
      : 'DO NOTHING';
    const perBatch = Math.max(1, Math.min(chunk, Math.floor(MAX_PARAMS / cols.length)));

    for (let i = 0; i < groupRows.length; i += perBatch) {
      const slice = groupRows.slice(i, i + perBatch);
      /* Last write wins within the batch, exactly as sequential upserts did.
         The key is built from the conflict columns; a row missing one of them
         cannot collide on it, so it is kept as its own entry. */
      const byKey = new Map();
      for (const r of slice) {
        byKey.set(conflict.map((c) => `${r[c]}`).join('\u0000'), r);
      }
      const batch = [...byKey.values()];

      const params = [];
      const tuples = batch.map((r) => {
        const ph = cols.map((c) => { params.push(r[c]); return `$${params.length}`; });
        return `(${ph.join(',')})`;
      });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO ${table} (${cols.join(',')}) VALUES ${tuples.join(',')}`
          + ` ON CONFLICT (${conflict.join(',')}) ${doUpdate}`, params);
        await client.query('COMMIT');
        /* The count reports rows ACCEPTED, including the ones a duplicate
           inside the batch replaced — the caller is reporting how much of the
           provider's answer it stored, not how many statements ran. */
        n += slice.length;
      } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
      finally { client.release(); }
    }
  }
  return n;
}

/* Record a run, and — where the source chunked its window — which chunks
   landed. A run that wrote rows while most of its windows failed reported
   status='ok' for months while the Uber trip history had a 299-day hole in it;
   `chunks` is what makes that impossible to miss. Passing chunks is optional,
   so a source that does not chunk is unaffected.

   `detail` is that list of windows and nothing around it — the shape
   schema_v12 documents and the shape every reader has to expect.

   The db handle is a parameter so a test can drive this writer against a
   throwaway database instead of hand-writing what it believes this stores. It
   believed wrong for as long as the coverage fixture existed: it wrote
   {chunks: [...]}, the endpoint read a 'chunks' key, and the two agreed with
   each other and with nothing that ships. A writer no test can call is a
   writer whose output no test can check. */
export async function logRun(run, db = pool) {
  const chunks = Array.isArray(run.chunks) ? run.chunks : null;
  const failed = chunks ? chunks.filter((c) => c.error).length : null;
  /* A source that succeeded on some windows and failed on others is not 'ok',
     whatever it managed to write. And one that failed on ALL of them is not
     'partial' either — there is no part.
     ─────────────────────────────────────────────────────────────────────────
     Measured on production 2026-09-02: the two newest Uber catch-up runs read
       uber catchup ecosine  partial  rows=0  chunks 44  failed 44
       uber catchup egari    partial  rows=0  chunks 44  failed 44
     with error NULL, because the per-window errors live only in `detail`. The
     Data-sources page paints 'partial' amber and 'error' red, so the total
     death of the supplier session — 74 of those 88 windows said "redirected to
     auth.uber.com — the session is no longer signed in" — wore the same colour
     as a run that mostly worked, under a caption reading '"partial" means the
     run wrote rows AND left windows unfetched'. Both halves of that sentence
     were false for the loudest failure on the fleet. */
  const allFailed = !!failed && failed === (chunks ? chunks.length : 0);
  const status = run.status === 'error' || allFailed ? 'error'
    : (failed ? 'partial' : (run.status || 'ok'));
  /* The red cell is driven by `error`, not by status, so a run whose only
     account of itself is 44 identical window errors has to surface one of
     them. A caller that gave its own error still wins. */
  const error = run.error
    || (allFailed ? String(chunks.find((c) => c.error).error).slice(0, 300) : null);
  const { rows } = await db.query(
    `INSERT INTO collection_run
       (source,fleet_id,mode,window_start,window_end,status,rows_written,finished_at,error,
        chunks_total,chunks_failed,detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8,$9,$10,$11) RETURNING id`,
    [run.source, run.fleet_id, run.mode, run.window_start, run.window_end, status,
     run.rows_written || 0, error,
     chunks ? chunks.length : null, failed,
     /* `kind` survives the projection because a source can collect more than
        one surface in one run and the reader cannot otherwise tell them apart.
        FMS is the case that forced it: the same 31-day window appears twice in
        /api/status — once ok with 3,038 trips, once failed — and until this key
        arrived nothing on screen said the failing one was the ALERT feed, so a
        73-day alert hole read as a telematics outage that had plainly not
        happened. Omitted where the source never sets it. */
     chunks ? JSON.stringify(chunks.map((c) => ({
       from: c.from, to: c.to, rows: c.rows ?? 0,
       ...(c.kind ? { kind: c.kind } : {}),
       /* A window a checkpoint says a previous attempt already finished. It is
          not a window that was asked and answered empty, and stripped of this
          key it arrives at /api/status as rows 0 with no error, which reads as
          exactly that. A resumed FMS backfill carries about a hundred. */
       ...(c.skipped ? { skipped: true } : {}),
       error: c.error ? String(c.error).slice(0, 300) : null,
     }))) : null]);
  return rows[0].id;
}

export async function getState(source, fleet, key) {
  const { rows } = await pool.query('SELECT value FROM source_state WHERE source=$1 AND fleet_id=$2 AND key=$3',
    [source, fleet, key]);
  return rows[0]?.value ?? null;
}
export async function setState(source, fleet, key, value) {
  await pool.query(
    `INSERT INTO source_state (source,fleet_id,key,value,updated_at) VALUES ($1,$2,$3,$4,now())
     ON CONFLICT (source,fleet_id,key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
    [source, fleet, key, value]);
}
