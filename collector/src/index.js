// Entrypoint. Usage:
//   node src/index.js migrate       — create/upgrade schema
//   node src/index.js backfill      — pull the last N months (one-off)
//   node src/index.js incremental   — pull the trailing window (one-off)
//   node src/index.js analyst       — one analyst pass over the last 30 days (costs a model call)
//   node src/index.js probe         — describe every provider surface the collectors call
//   node src/index.js schedule      — long-running: cron incrementals + realtime polling (container default)
import cron from 'node-cron';
import { migrate, pool } from './db.js';
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
          `UPDATE collector_job SET status = 'running', started_at = now()
           WHERE id = (SELECT id FROM collector_job WHERE status = 'queued'
                       ORDER BY requested_at LIMIT 1 FOR UPDATE SKIP LOCKED)
           RETURNING id, mode`);
        const job = rows[0];
        if (!job) return;
        jobRunning = true;
        log.info('scheduler', `on-demand ${job.mode} claimed`, { job: job.id });
        try {
          if (job.mode === 'backfill') await backfill();
          else if (job.mode === 'analyst') await analystPass();
          else if (job.mode === 'probe') await probePass();
          else await incremental();
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

    /* A container that dies mid-job leaves the row in 'running' forever. On
       boot, hand anything stranded back to the queue once — a job that was
       genuinely half-done is idempotent (every write is an upsert), and a job
       stuck at 'running' is indistinguishable from one still working. */
    pool.query(
      `UPDATE collector_job SET status='queued', started_at=NULL
       WHERE status='running' AND started_at < now() - interval '3 hours'`)
      .then(({ rowCount }) => { if (rowCount) log.warn('scheduler', 'requeued stranded jobs', { n: rowCount }); })
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
