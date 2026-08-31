/* What this job has already finished.
   ─────────────────────────────────────────────────────────────────────────
   A backfill takes hours and the worker it runs in restarts whenever the app
   deploys. src/index.js requeues the job — correctly — but the run then began
   again at the first source and the first window, so every attempt redid the
   same work and died at roughly the same elapsed point. Production job 8
   restarted five times, reached window 7 of 12 each time, and was abandoned as
   "restarted three times without completing a single source or collection
   window". The abandon rule was right: it genuinely had not advanced.

   This is the memory that makes the next attempt continue instead. A unit is
   recorded the moment it finishes, and a run skips whatever it finds — so the
   work survives the restart even though the process does not.

   Two things it deliberately is not:

   NOT A CACHE. It never decides that data is fresh enough to skip collecting;
   it only says that THIS job already did this unit. A new backfill gets a new
   id and collects everything again, which is what asking for a backfill means
   — and what makes a re-run a way to repair a window that was collected badly
   rather than a no-op.

   NOT A TRANSACTION LOG. Every collector write is an upsert, so a checkpoint
   lost to a crash between the write and the mark costs one repeated window and
   never correctness. Marking AFTER the write, rather than before, is the only
   ordering with that property. */
import { pool } from './db.js';
import { log } from './log.js';

const SRC = 'checkpoint';

/* A no-op checkpoint, for the runs with no job behind them — the boot
   incremental, a CLI invocation, the tests. An object rather than null, so no
   source ever has to branch on whether one exists. */
export const NO_CHECKPOINT = {
  jobId: null,
  has: () => false,
  mark: async () => {},
  count: () => 0,
};

/** Everything this job has finished, read once at the start of a run. */
export async function loadCheckpoint(jobId, db = pool) {
  if (!jobId) return NO_CHECKPOINT;
  const key = (source, unit = '') => `${source} ${unit}`;
  let done = new Set();
  try {
    const { rows } = await db.query(
      'SELECT source, window_key FROM collector_checkpoint WHERE job_id = $1', [jobId]);
    done = new Set(rows.map((r) => key(r.source, r.window_key)));
    if (done.size) log.info(SRC, 'resuming', { job: jobId, finished: done.size });
  } catch (e) {
    /* A checkpoint that cannot be read is a slow run, not a wrong one: the
       worst case is the work being done again, which is exactly what happened
       before this table existed. */
    log.warn(SRC, 'could not read checkpoints — this run will not resume',
      { job: jobId, err: String(e).slice(0, 160) });
    return { ...NO_CHECKPOINT, jobId };
  }

  return {
    jobId,
    has: (source, unit = '') => done.has(key(source, unit)),
    async mark(source, unit = '', rows = null) {
      if (done.has(key(source, unit))) return;
      done.add(key(source, unit));
      try {
        await db.query(
          `INSERT INTO collector_checkpoint (job_id, source, window_key, rows)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (job_id, source, window_key)
           DO UPDATE SET rows = EXCLUDED.rows, finished_at = now()`,
          [jobId, source, unit, rows]);
      } catch (e) {
        /* Losing the mark costs a repeated window on the next attempt. Losing
           the RUN because the mark failed would cost the whole backfill. */
        log.warn(SRC, 'could not record a checkpoint', { job: jobId, source, unit,
          err: String(e).slice(0, 160) });
      }
    },
    count: () => done.size,
  };
}

/** Forget a job's checkpoints, once it has finished — otherwise the table keeps
    a row per window per backfill for ever. */
export async function clearCheckpoint(jobId, db = pool) {
  if (!jobId) return;
  try { await db.query('DELETE FROM collector_checkpoint WHERE job_id = $1', [jobId]); }
  catch (e) { log.warn(SRC, 'could not clear checkpoints', { job: jobId, err: String(e).slice(0, 120) }); }
}
