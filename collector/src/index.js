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
import { recordCredentialVisibility } from './settings.js';
import { backfill, incremental, catchUp, cabmanTick, liveStatusTick, analystPass, probePass, uberTimelineTick, uberProfileTick, uberAuditTick } from './run.js';
import { clearCheckpoint } from './checkpoint.js';
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
  /* `timeline` and `timeline-roster`: the scheduled tick asks about drivers who
     drove, which cannot find a driver who was online all evening and never got
     a job. That driver is the point of the panel, so the full sweep is a
     command rather than something nobody can run. */
  if (cmd === 'timeline') return uberTimelineTick();
  if (cmd === 'timeline-roster') return uberTimelineTick({ roster: true, days: 30 });
  /* `profile`: Uber's own rating, lifetime trips, banned flag, compliance
     status and vehicle attachment, one call per driver. A command as well as a
     cron because the first thing anyone wants after wiring a new surface is to
     run it once and look. */
  if (cmd === 'profile') return uberProfileTick();
  if (cmd === 'audit') return uberAuditTick();

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
    /* The driver availability timeline gets a cron of its OWN rather than a
       place in the incremental, because its cost is one request per driver per
       window. Scoped to drivers who worked in the window that is about 74
       requests a run across both fleets; on the thirty-minute incremental that
       would be ten thousand requests a day at a provider that has never been
       asked for more than a few hundred. Three-hourly, and the window is wide
       enough that a missed tick loses nothing. */
    cron.schedule(config.uberTimelineCron, () => uberTimelineTick()
      .catch((e) => log.error('scheduler', 'uber timeline', { err: String(e) })));
    /* Rollups on their own schedule as well as at the end of each run.
       The run-end refresh covers the normal path, but CABMAN writes trips on a
       five-minute tick of its own and a failed incremental leaves the rollups
       behind with no other route back — and a page reading a stale rollup shows
       a number that is wrong in a way nothing about it reveals. Fifteen minutes
       is well inside the thirty-minute collection cycle, so the pages are never
       more than one tick behind what has actually landed. */
    cron.schedule('*/15 * * * *', () => refreshRollups({ days: 14 })
      .catch((e) => log.error('scheduler', 'rollup', { err: String(e) })));
    /* And the whole history once a day. The quarter-hourly refresh only touches
       the last fortnight, which is right for new trips and blind to a backfill
       — a twelve-month re-collection rewrites months the incremental pass never
       looks at. 02:40 Dubai (22:40 UTC), before the analyst reads the same
       aggregates at 03:10. */
    cron.schedule('40 22 * * *', () => refreshRollups()
      .catch((e) => log.error('scheduler', 'rollup full', { err: String(e) })));
    /* And once at boot. A fresh database, or a deploy that lands before the
       first collection, would otherwise serve empty months on every page that
       reads a rollup until the quarter hour came round. */
    refreshRollups().catch((e) => log.error('scheduler', 'rollup at boot', { err: String(e) }));
    /* And record which credentials this process can actually see, so the
       Settings page — served by the API, which has a different environment —
       stops reporting the collector's working Uber session as missing. Names
       and presence only; no value is written. Re-recorded hourly, because an
       env change arrives with a deploy and a settings change arrives at any
       time. */
    recordCredentialVisibility('collector')
      .catch((e) => log.warn('scheduler', 'credential visibility', { err: String(e).slice(0, 120) }));
    cron.schedule('5 * * * *', () => recordCredentialVisibility('collector')
      .catch((e) => log.warn('scheduler', 'credential visibility', { err: String(e).slice(0, 120) })));
    /* Nightly catch-up over thirty days, and the full history weekly.
       The half-hourly incremental looks back three days; nothing else revisited
       anything, so a day that failed to collect or that a provider finalised
       late stayed wrong until a person noticed. Uber settles earnings weekly —
       longer than the window that would catch them — and FMS is silent on 154
       of the last 366 days.

       01:00 Dubai (21:00 UTC) nightly, and Sunday 02:00 Dubai for the year:
       both outside the working day, and clear of the 22:40 probe and the 23:10
       analyst so three heavy passes do not land together. */
    cron.schedule('0 21 * * *', () => catchUp(30)
      .catch((e) => log.error('scheduler', 'catch-up', { err: String(e) })));
    cron.schedule('0 22 * * 0', () => backfill()
      .catch((e) => log.error('scheduler', 'weekly backfill', { err: String(e) })));

    /* The analyst costs a model call per pass, and its input is a month of
       aggregates that does not meaningfully change between two afternoons.
       Once a day, at 03:10 Dubai (23:10 UTC), after the overnight incremental
       has landed the previous day in full. */
    cron.schedule('10 23 * * *', () => analystPass().catch((e) => log.error('scheduler', 'analyst', { err: String(e) })));
    /* Uber's own word on each driver: weekly, Monday 04:20 Dubai (00:20 UTC).
       One call per driver and ~320 of them, placed where nothing else runs —
       after the overnight incremental and the analyst, before the morning.

       Weekly rather than daily because the rating is a trailing average over
       hundreds of trips: it moves by hundredths in a week, so a daily pull
       would write seven identical history rows for every real movement, and
       cost seven times the calls to do it. Monday so a week-over-week change
       lines up with the operating week the rest of the product reports on. */
    cron.schedule('20 0 * * 1', () => uberProfileTick()
      .catch((e) => log.error('scheduler', 'uber profile', { err: String(e) })));
    /* Ask Uber whether the past we hold is the past it has. 05:45 Dubai —
       after the overnight incremental, the analyst and the profile pull, and
       before the morning, because it spends real Uber report slots and the
       collection passes have first claim on them.

       Daily rather than weekly, and only three windows per fleet a night: at
       that rate the whole twelve-month retention window is verified inside a
       week and then continuously re-verified, which is what turns this from a
       one-off reassurance into a standing check. Weekly would take two months
       to say anything about March. */
    cron.schedule('45 1 * * *', () => uberAuditTick()
      .catch((e) => log.error('scheduler', 'uber audit', { err: String(e) })));
    /* A provider changes what it sends without telling anyone, and an expired
       credential looks like a quiet week. Describe every surface daily. */
    /* 22:20, not 22:40: that was the same minute as the nightly full rollup,
       and two heavy passes landing together on a small managed Postgres is the
       contention already measured when the rollups ran against live traffic.
       Found by the check that asserts no two scheduled passes share a start
       time, which is the sort of thing nobody notices by reading a list. */
    cron.schedule('20 22 * * *', () => probePass());
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
           RETURNING id, mode, fleet, attempts`);
        const job = rows[0];
        if (!job) return;
        jobRunning = true;
        log.info('scheduler', `on-demand ${job.mode} claimed`,
          { job: job.id, fleet: job.fleet || 'both fleets' });
        /* Write which source the run is on as it goes. Eight sources run in
           sequence and one of them takes four and a half hours; without this
           the job row says 'running' for the whole afternoon and a wedged
           process is indistinguishable from a working one. */
        /* MERGED into what is there, not written over it.
           ─────────────────────────────────────────────────────────────────
           This was `SET progress = $2`, a whole-document replace — and the
           requeue below writes `done_at_last_attempt` / `steps_at_last_attempt`
           into the same document as the baseline it compares the NEXT attempt
           against. The first progress write of that attempt erased them.

           So the guard that was built to tell an advancing job from a stuck
           one was comparing against a baseline that no longer existed:
           coalesce(absent, -1) is -1, everything beats -1, and a job that
           truly wedges the container every pass could never be abandoned —
           while a job killed BEFORE its first progress write kept the stale
           baselines, compared equal, and was abandoned for it. Both of the
           failed rows on production are the second case. */
        const progress = (p2) => pool.query(
          `UPDATE collector_job
              SET progress = coalesce(progress, '{}'::jsonb) || $2::jsonb
            WHERE id = $1`, [job.id, JSON.stringify(p2)])
          .catch((e) => log.warn('scheduler', 'progress write failed', { err: String(e).slice(0, 80) }));
        try {
          /* A job can name one fleet. The two fleets are separate businesses
             with separate credentials on the same providers, and the reason to
             run one alone is that its credential was just replaced. The
             analyst and probe passes are fleet-agnostic and ignore it. */
          /* The job's id, so a run interrupted by a restart resumes instead of
             beginning again. A backfill is hours long and this worker restarts
             on every deploy, so being interrupted is the normal case. */
          if (job.mode === 'backfill') await backfill(progress, job.fleet || null, job.id);
          else if (job.mode === 'analyst') await analystPass();
          else if (job.mode === 'probe') await probePass();
          /* `timeline` runs the availability pull on demand. It has its own
             three-hourly cron, which means a freshly pasted supplier session
             cannot be checked for three hours — and Uber serves only 31 days
             of this data, so a session that turns out to be broken has already
             cost history that cannot be recovered later. `timeline-roster`
             sweeps the whole roster rather than the drivers who drove. */
          else if (job.mode === 'timeline') await uberTimelineTick();
          /* One call per driver, so it takes the job id and checkpoints per
             driver: a deploy landing mid-sweep resumes where it stopped. */
          else if (job.mode === 'profile') await uberProfileTick({ fleet: job.fleet || null, jobId: job.id });
          /* One Uber report per window and minutes each, so it takes the job
             id and checkpoints per window: a deploy landing mid-audit resumes
             at the window it had reached rather than spending the slots
             again. */
          else if (job.mode === 'audit') await uberAuditTick({ fleet: job.fleet || null, jobId: job.id });
          else if (job.mode === 'timeline-roster') await uberTimelineTick({ roster: true, days: 30 });
          else await incremental(progress, job.fleet || null, job.id);
          await pool.query(
            `UPDATE collector_job SET status='done', finished_at=now() WHERE id=$1`, [job.id]);
          /* The job is over, so its memory of what it finished is no longer
             about anything. Left behind it would be a row per window per
             backfill, for ever. */
          await clearCheckpoint(job.id);
          log.info('scheduler', `on-demand ${job.mode} finished`, { job: job.id });
        } catch (e) {
          // A job that failed must say so rather than sitting in 'running'
          // forever, which reads as "still working" to anyone watching.
          await pool.query(
            `UPDATE collector_job SET status='failed', finished_at=now(), error=$2 WHERE id=$1`,
            [job.id, String(e).slice(0, 500)]);
          /* A FAILED job keeps its checkpoints deliberately: the operator's
             next move is usually to re-queue it, and the point of this table
             is that the re-queue continues rather than starting over. They are
             cleared when it finally finishes. */
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
           -- Reset to zero, not one, and NOT incremented here: the claim above
           -- already counts a restart when it picks the job up again. Counting
           -- it in both places meant one interruption read as two, so a job
           -- restarted twice was accused of having restarted three times --
           -- and the column's own comment says attempts is how many times the
           -- job has been CLAIMED.
           attempts = CASE WHEN ${ADVANCED} THEN 0 ELSE coalesce(attempts, 0) END,
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
