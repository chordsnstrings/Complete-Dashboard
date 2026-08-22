// Entrypoint. Usage:
//   node src/index.js migrate       — create/upgrade schema
//   node src/index.js backfill      — pull the last N months (one-off)
//   node src/index.js incremental   — pull the trailing window (one-off)
//   node src/index.js analyst       — one analyst pass over the last 30 days (costs a model call)
//   node src/index.js probe         — describe every provider surface the collectors call
//   node src/index.js schedule      — long-running: cron incrementals + realtime polling (container default)
import cron from 'node-cron';
import { migrate, pool } from './db.js';
import { refreshRollups } from './rollup.js';
import { backfill, incremental, cabmanTick, liveStatusTick, analystPass, probePass } from './run.js';
import { config } from './config.js';
import { log } from './log.js';

const cmd = process.argv[2] || 'schedule';

async function main() {
  await migrate();
  if (cmd === 'migrate') return;
  if (cmd === 'backfill') return backfill();
  if (cmd === 'incremental') return incremental();
  if (cmd === 'analyst') return analystPass();
  if (cmd === 'probe') return probePass();

  if (cmd === 'schedule') {
    log.info('scheduler', 'starting', {
      cabmanCron: config.cabmanCron, liveStatusSeconds: config.liveStatusSeconds, incrementalDays: config.incrementalDays,
    });
    // CABMAN realtime GPS — every 5 minutes, saved to the database
    cron.schedule(config.cabmanCron, () => cabmanTick());
    // Uber/FMS live status — lighter interval
    setInterval(() => liveStatusTick(), config.liveStatusSeconds * 1000);
    // historical/aggregate refresh every 30 minutes
    cron.schedule('*/30 * * * *', () => incremental().catch((e) => log.error('scheduler', 'incremental', { err: String(e) })));
    /* Rollups on their own schedule as well as at the end of each run.
       The run-end refresh covers the normal path, but CABMAN writes trips on a
       five-minute tick of its own and a failed incremental leaves the rollups
       behind with no other route back — and a page reading a stale rollup shows
       a number that is wrong in a way nothing about it reveals. Fifteen minutes
       is well inside the thirty-minute collection cycle, so the pages are never
       more than one tick behind what has actually landed. */
    cron.schedule('*/15 * * * *', () => refreshRollups()
      .catch((e) => log.error('scheduler', 'rollup', { err: String(e) })));
    /* And once at boot. A fresh database, or a deploy that lands before the
       first collection, would otherwise serve empty months on every page that
       reads a rollup until the quarter hour came round. */
    refreshRollups().catch((e) => log.error('scheduler', 'rollup at boot', { err: String(e) }));
    /* The analyst costs a model call per pass, and its input is a month of
       aggregates that does not meaningfully change between two afternoons.
       Once a day, at 03:10 Dubai (23:10 UTC), after the overnight incremental
       has landed the previous day in full. */
    cron.schedule('10 23 * * *', () => analystPass().catch((e) => log.error('scheduler', 'analyst', { err: String(e) })));
    /* A provider changes what it sends without telling anyone, and an expired
       credential looks like a quiet week. Describe every surface daily. */
    cron.schedule('40 22 * * *', () => probePass());
    /* Honour on-demand runs queued from the Settings page.
       One job at a time, claimed atomically. The previous version read a
       single source_state key, so two requests arriving close together meant
       the second silently replaced the first — and the API had already told
       the caller the first was queued. */
    let jobRunning = false;
    setInterval(async () => {
      if (jobRunning) return;                 // never run two collections at once
      try {
        // Claim the oldest queued job in one statement, so a second poller (or
        // a restarted container) cannot pick up the same work.
        const { rows } = await pool.query(
          `UPDATE collector_job
           SET status = 'running', started_at = now(), attempts = coalesce(attempts, 0) + 1
           WHERE id = (SELECT id FROM collector_job WHERE status = 'queued'
                       ORDER BY requested_at LIMIT 1 FOR UPDATE SKIP LOCKED)
           RETURNING id, mode, attempts`);
        const job = rows[0];
        if (!job) return;
        jobRunning = true;
        log.info('scheduler', `on-demand ${job.mode} claimed`, { job: job.id });
        /* Write which source the run is on as it goes. Eight sources run in
           sequence and one of them takes four and a half hours; without this
           the job row says 'running' for the whole afternoon and a wedged
           process is indistinguishable from a working one. */
        const progress = (p2) => pool.query(
          `UPDATE collector_job SET progress = $2 WHERE id = $1`, [job.id, JSON.stringify(p2)])
          .catch((e) => log.warn('scheduler', 'progress write failed', { err: String(e).slice(0, 80) }));
        try {
          if (job.mode === 'backfill') await backfill(progress);
          else if (job.mode === 'analyst') await analystPass();
          else if (job.mode === 'probe') await probePass();
          else await incremental(progress);
          await pool.query(
            `UPDATE collector_job SET status='done', finished_at=now() WHERE id=$1`, [job.id]);
          log.info('scheduler', `on-demand ${job.mode} finished`, { job: job.id });
        } catch (e) {
          // A job that failed must say so rather than sitting in 'running'
          // forever, which reads as "still working" to anyone watching.
          await pool.query(
            `UPDATE collector_job SET status='failed', finished_at=now(), error=$2 WHERE id=$1`,
            [job.id, String(e).slice(0, 500)]);
          log.error('scheduler', `on-demand ${job.mode} failed`, { job: job.id, err: String(e) });
        } finally { jobRunning = false; }
      } catch (e) { log.error('scheduler', 'job poll', { err: String(e) }); jobRunning = false; }
    }, 20000);

    /* A container that dies mid-job leaves the row in 'running' forever, and
       this deployment restarts on every push. ANY job marked running at boot is
       stranded by definition: this process has just started, so nothing it owns
       can be in flight. Requeued immediately rather than after a timeout —
       every collector write is an upsert, so repeating a half-done job is safe,
       and the three-hour wait meant a backfill killed by a deploy simply never
       finished. It sat at 'running' while the coverage page it was meant to fix
       stayed unchanged, which is exactly the shape of a job that has silently
       been thrown away.

       The attempt count is what stops it looping forever on a job that kills
       the container every time it runs — but only that. It counted every
       restart alike, so a backfill interrupted three times by ordinary deploys
       was abandoned with 'it may be crashing the collector', which was simply
       untrue: it had been advancing every time.

       A job that got FURTHER than its last attempt is a working job that was
       interrupted, and its counter resets. Only a job that restarts having
       made no progress at all is a job that might be the cause.

       "Further" counts completed sources AND completed windows within a
       source, because Uber and FMS each take hours: measured only in sources,
       a run that had landed 35,000 rows across eleven monthly windows looked
       identical to one that had done nothing, and was abandoned as such. */
    /* "Advanced" once, so the three places that ask cannot disagree. */
    const ADVANCED = `(coalesce((progress ->> 'done')::int, 0)
                         > coalesce((progress ->> 'done_at_last_attempt')::int, -1)
                       OR coalesce((progress ->> 'steps')::int, 0)
                         > coalesce((progress ->> 'steps_at_last_attempt')::int, -1))`;
    pool.query(
      `UPDATE collector_job
       SET status = CASE WHEN coalesce(attempts, 0) >= 3 AND NOT ${ADVANCED}
                         THEN 'failed' ELSE 'queued' END,
           started_at = NULL,
           attempts = CASE WHEN ${ADVANCED} THEN 1 ELSE coalesce(attempts, 0) + 1 END,
           -- Remember how far it had got, so the next restart can tell whether
           -- this one advanced.
           progress = coalesce(progress, '{}'::jsonb)
                      || jsonb_build_object(
                           'done_at_last_attempt', coalesce((progress ->> 'done')::int, 0),
                           'steps_at_last_attempt', coalesce((progress ->> 'steps')::int, 0)),
           error = CASE WHEN coalesce(attempts, 0) >= 3 AND NOT ${ADVANCED}
                        THEN 'abandoned: restarted three times without completing a single source '
                             || 'or collection window, so the job itself may be killing the collector'
                        ELSE error END
       WHERE status = 'running'
       RETURNING id, mode, attempts, progress ->> 'current' AS was_on,
                 coalesce((progress ->> 'steps')::int, 0) AS steps`)
      .then(({ rows }) => {
        if (rows.length) {
          log.warn('scheduler', 'requeued jobs stranded by a restart',
            { jobs: rows.map((r) => `${r.mode}#${r.id} (attempt ${r.attempts}`
              + `${r.was_on ? `, was on ${r.was_on}` : ''})`) });
        }
      })
      .catch((e) => log.error('scheduler', 'requeue', { err: String(e) }));

    // kick one of each at boot so the dashboard has fresh data immediately
    cabmanTick();
    probePass();
    incremental().catch((e) => log.error('scheduler', 'boot-incremental', { err: String(e) }));
    return new Promise(() => {}); // run forever
  }
  log.error('index', `unknown command: ${cmd}`);
  process.exit(1);
}

main().then(async () => {
  if (cmd !== 'schedule') { await pool.end(); process.exit(0); }
}).catch((e) => { log.error('index', 'fatal', { err: String(e) }); process.exit(1); });
