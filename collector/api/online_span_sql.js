/* WHAT "ONLINE" IS, written once, because it was written five times and four
   of them dropped the same event.
   ──────────────────────────────────────────────────────────────────────────
   Uber's driver timeline (sql/schema_v37.sql) carries two streams under one
   discriminator. `kind='status'` holds ONLINE and OFFLINE, and nothing else.
   `kind='job'` holds the progress of one booking — DJ_ASSIGNED,
   DJ_PICKUP_ARRIVED, DJ_PICKUP, DJ_COMPLETED, DJ_CANCELED, DJ_UNASSIGNED —
   keyed by job_ext_id.

   TWO FACTS ABOUT THE STATUS STREAM DECIDE EVERYTHING HERE.

   1. ONLINE IS A HEARTBEAT, NOT A TRANSITION. Uber repeats it: 132 rows for
      one driver in one day, 90,389 fleet-wide over thirty days. So an ONLINE
      is almost never followed by an OFFLINE — it is followed by the next
      ONLINE, a few minutes later.

   2. THE HEARTBEAT STOPS WHILE THE DRIVER IS ON A JOB. The status stream goes
      quiet for the length of the booking and resumes after it.

   A span was therefore built as `ONLINE → the next status event`, through
   `lead(at) OVER (PARTITION BY driver_ext_id ORDER BY at)`. Four of the five
   places that did it then wrote `WHERE next_at IS NOT NULL` — which deletes
   the LAST ONLINE, the one whose successor has not arrived yet. Because of
   (2), the last event before a driver is dispatched is exactly the one that
   dangles, so the deletion lands on the working driver rather than on the
   idle one.

   MEASURED ON PRODUCTION 2026-09-10 (api/probe.js:1089 counts it live):
   60 of 89 drivers sit on a dangling ONLINE, 56 of them dated today, and
   7,518 minutes — 125 driver-hours — of online time was dropped on that one
   day. Driver 369dd9c1-ae0a-4526-8d46-d91a8c217121, Bashir Ahmad Amin:

     08:34:46 ONLINE   08:35:05 ONLINE   08:35:11 DJ_ASSIGNED
     09:11:55 DJ_COMPLETED
     09:59:15 ONLINE   ← last status event, no successor, DROPPED
     09:59:21 DJ_ASSIGNED   10:05:46 DJ_PICKUP

   He drove three Uber trips between 08:35 and 11:03. The day page drew him
   online 08:35→09:59 and then printed "99% of online time", dividing 83
   minutes of job time taken from the WHOLE day into an 84-minute online
   window that stopped at 09:59.

   api/online_routes.js:326 is the fifth place and it already gets this right,
   in its own words: "A dangling ONLINE — next_at null, the most recent
   transition we hold — still starts a span. Its start is a fact even when its
   end is not." This module is that sentence, made executable, so the other
   four cannot drift from it again.

   ── HOW A DANGLING ONLINE IS CLOSED ─────────────────────────────────────
   At the earliest of THREE bounds, and the span carries which one closed it:

     now()                        it cannot have run into the future
     the end of its own Dubai day the day is the grain every reader of these
                                  spans draws at — driver_day rows, a day
                                  band, an hour-of-week heatmap
     the last successful          WE CANNOT CLAIM SOMEBODY WAS ONLINE AFTER
     uber_timeline collection     THE LAST MOMENT WE ACTUALLY ASKED UBER

   The third is the one that makes the other two honest. The timeline runs on
   UBER_TIMELINE_CRON — every three hours as shipped — so at any moment the
   most recent hours of today have not been fetched. Closing a dangling ONLINE
   at now() credits a driver with all of them: it converts "we have not asked
   yet" into "they were working", which is the exact substitution this
   dashboard exists to refuse. 56 of the 60 dangling drivers measured on
   2026-09-10 were dangling on TODAY, so this is the common case and not the
   corner: at a three-hourly cadence it is up to three hours of invented
   availability per driver, and about 84 driver-hours across those 56 at the
   mean gap. The figure now grows as collection catches up, which is the
   self-healing direction and the same one api/online_routes.js's
   `awaiting_feed` runs in.

   PER FLEET, and with no cross-fleet fallback. src/sources/uber_timeline.js
   stamps both the events (:143) and the run row (:290) with the same `o.fleet`,
   so the two cannot drift. A fleet whose timeline has never completed a run
   has no evidence of when it was last asked, so it gets no ceiling and falls
   back to the first two bounds — the coordinator's rule, and the only one
   available: borrowing another fleet's collection clock would be a claim about
   a collection that never happened.

   A run that finished BEFORE the event does not bind either. That combination
   means we hold an event we could not have fetched, which is a contradiction
   in the bookkeeping rather than evidence about the driver, and resolving it
   by deleting the span would throw away the one thing we do know.

   ── WHAT IS LEFT AFTER ALL THREE ───────────────────────────────────────
   A dangling ONLINE on a day the collector has since covered many times over
   is still run to that day's midnight: the ceiling is above the day, so it
   does not bind. That is the 4-of-60 case, and the honest reading of it is
   that we asked repeatedly and Uber never sent anything later. It remains a
   claim, so `closed_by` says 'day' and `open_ended` stays true, and every
   surface that must not overstate can refuse it on that flag alone.

   ── WHY THE JOB STREAM IS UNIONED IN ────────────────────────────────────
   Uber does not assign a job to an offline driver, so the interval from a
   booking's first timeline event to its last is direct evidence of being
   online — and by (2) it covers exactly the stretches where the heartbeat
   goes quiet. A job interval that reaches past the status stream's own reach
   is availability we hold proof of and were throwing away.

   It runs from the job's FIRST event to its LAST, not to a terminal state we
   may not have yet: a booking whose DJ_COMPLETED has not arrived contributes
   the part we can prove and no more, which errs towards understating.

   The two sets are then de-overlapped — gaps and islands — so a heartbeat and
   the job it brackets are one interval and not two. Nothing is counted twice.

   An OFFLINE still closes a span, because it is the one event in the stream
   that says the driver stopped. */

/* The instant the Dubai day containing `col` ends, as a timestamptz.
   date_trunc rather than a cast to ::date, deliberately: test/indexes.test.mjs
   reads every Dubai-day cast in api/ as a filter that needs an expression
   index, and rightly so, since an unindexed one scans the table. A cast
   written here would ask that check for an index on a value no WHERE ever
   touches — and, because the check reads the source rather than the query,
   even naming the pattern in a comment is enough to trip it. */
const DAY_END = (col) =>
  `((date_trunc('day', ${col} AT TIME ZONE 'Asia/Dubai') + interval '1 day')`
  + ` AT TIME ZONE 'Asia/Dubai')`;

/* The CTE chain, ending in `spans (driver_ext_id, span_start, span_end,
   open_ended)`. Returned without a leading WITH and without a trailing comma
   so a caller can drop it into a larger WITH list.

   Each span also carries `closed_by`: 'event' when a later status event or a
   job's own last event closed it, and otherwise which of the three bounds
   above was the binding one — 'collection', 'now' or 'day'. A reader can then
   tell "still online as far as we know" from "we stopped asking".

   `where`  bounds driver_timeline_event. It is applied to BOTH streams, so it
            must be written in terms the job rows can also answer — a range on
            `at`, an id set, and nothing about `status`.
   `keep`   is an extra predicate on the spans, applied AFTER lead(). That
            placement is load-bearing and api/supply_routes.js paid for it: a
            span is an ONLINE row and the very next event on that driver's
            timeline, so a predicate applied BEFORE lead() does not select
            spans — it deletes events out of the middle of a timeline and lets
            the survivors close each other. Reproduced there on three events:
            &fleet=egari answered 25 online hours for a driver who was online
            for two, because the OFFLINE that ended the shift carried the
            other fleet_id and was filtered away. */
export function onlineSpansSql({ where = 'TRUE', keep = 'TRUE' } = {}) {
  const CAP2 = `least(now(), ${DAY_END('at')})`;
  const CAP3 = `least(now(), ${DAY_END('at')}, feed_at)`;
  /* feed_at binds only when it is a real bound: a run recorded as finishing
     before the event it would truncate is a contradiction in the bookkeeping,
     not evidence about the driver. */
  const CEILING = 'feed_at IS NOT NULL AND feed_at > at';
  return `feed AS (
     /* When this fleet's timeline last completed. status <> 'error' rather
        than status = 'ok', because a PARTIAL run did reach the provider and
        did collect something — refusing to credit it would push the ceiling
        backwards on exactly the runs that were working hardest. A row with no
        finished_at is a run still going, which has reached nothing yet.

        Named feed_fleet/feed_at rather than fleet_id/finished_at so that a
        caller's own predicate — api/supply_routes.js passes one naming bare
        platform and fleet_id — cannot become ambiguous against this join. */
     SELECT fleet_id AS feed_fleet, max(finished_at) AS feed_at
       FROM collection_run
      WHERE source = 'uber_timeline' AND status <> 'error'
        AND finished_at IS NOT NULL
      GROUP BY 1),
   ev AS (
     /* PARTITIONED BY ACCOUNT, and that is correctness rather than tidiness:
        one ordering across two Uber accounts closes an ONLINE on account A
        with an OFFLINE on account B and yields spans belonging to neither. */
     /* The LEFT JOIN cannot multiply rows — feed is grouped by fleet, so it
        holds at most one row per fleet_id. That is worth stating, because a
        join inside an aggregate that DOES multiply is this codebase's most
        expensive recurring trap. */
     SELECT dte.driver_ext_id, dte.at, dte.status, dte.platform, dte.fleet_id,
            lead(dte.at) OVER (PARTITION BY dte.driver_ext_id ORDER BY dte.at) AS next_at,
            f.feed_at
       FROM driver_timeline_event dte
       LEFT JOIN feed f ON f.feed_fleet = dte.fleet_id
      WHERE dte.kind = 'status' AND dte.status <> '' AND (${where})),
   status_span AS (
     /* coalesce, not a next_at IS NOT NULL filter. See the header: the filter
        this replaces deleted the most recent ONLINE of 60 of 89 drivers. */
     SELECT driver_ext_id, at AS span_start,
            coalesce(next_at,
                     CASE WHEN ${CEILING} THEN ${CAP3} ELSE ${CAP2} END) AS span_end,
            next_at IS NULL AS open_ended,
            /* WHICH bound closed it, so a reader can tell "still online as far
               as we know" from "this is where we stopped asking". */
            CASE WHEN next_at IS NOT NULL THEN 'event'
                 WHEN ${CEILING} AND feed_at < ${CAP2} THEN 'collection'
                 WHEN now() < ${DAY_END('at')} THEN 'now'
                 ELSE 'day' END AS closed_by
       FROM ev
      WHERE status = 'ONLINE' AND (${keep})),
   job_row AS (
     SELECT driver_ext_id, job_ext_id, at, platform, fleet_id
       FROM driver_timeline_event
      WHERE kind = 'job' AND coalesce(job_ext_id, '') <> '' AND (${where})),
   job_span AS (
     /* The opening row's platform and fleet, so the keep predicate attributes
        a job the same way it attributes a span: to the fleet that opened it. */
     SELECT driver_ext_id, min(at) AS span_start, max(at) AS span_end,
            (array_agg(platform ORDER BY at))[1] AS platform,
            (array_agg(fleet_id ORDER BY at))[1] AS fleet_id
       FROM job_row GROUP BY driver_ext_id, job_ext_id),
   piece AS (
     SELECT driver_ext_id, span_start, span_end, open_ended, closed_by
       FROM status_span
      WHERE span_end > span_start
      UNION ALL
     /* A job interval ends on an event we actually hold, so it needs no
        ceiling and is never open-ended. */
     SELECT driver_ext_id, span_start, span_end, false, 'event' FROM job_span
      WHERE span_end > span_start AND (${keep})),
   edge AS (
     /* Gaps and islands. A piece opens a new island only when it starts after
        the furthest any earlier piece on this account ran to — a RUNNING max,
        not the previous row, because a long heartbeat span contains several
        short job intervals and "previous row" would reopen the island on each
        of them. Touching counts as continuous, so the test is <= and not <. */
     SELECT driver_ext_id, span_start, span_end, open_ended, closed_by,
            CASE WHEN span_start <= max(span_end) OVER (
                   PARTITION BY driver_ext_id ORDER BY span_start, span_end
                   ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)
                 THEN 0 ELSE 1 END AS opens
       FROM piece),
   islanded AS (
     SELECT driver_ext_id, span_start, span_end, open_ended, closed_by,
            sum(opens) OVER (PARTITION BY driver_ext_id ORDER BY span_start, span_end
                             ROWS UNBOUNDED PRECEDING) AS grp
       FROM edge),
   spans AS (
     /* bool_or is exact rather than approximate here: every piece is bounded
        above by the three-way least(), so an open-ended piece always supplies
        its island's max end — and closed_by is read off that same piece rather
        than folded, because how an island ENDS is a fact about one of its
        members and not about the set. */
     SELECT driver_ext_id, min(span_start) AS span_start, max(span_end) AS span_end,
            bool_or(open_ended) AS open_ended,
            (array_agg(closed_by ORDER BY span_end DESC, open_ended DESC))[1] AS closed_by
       FROM islanded GROUP BY driver_ext_id, grp)`;
}
