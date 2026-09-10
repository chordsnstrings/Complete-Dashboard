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
   At the earlier of now() and the end of the Dubai day the ONLINE opened in,
   and it is marked `open_ended` so a caller can tell a closed span from one
   that is still running.

   now() alone is not enough, and the difference is not academic: 4 of those
   60 drivers dangle on a day that is not today, and closed at now() each of
   them would claim every hour since — days of invented availability, in the
   direction that inflates supply. The end of its own Dubai day bounds the
   claim to the day the event is evidence about, which is also the grain every
   reader of these spans draws at (driver_day rows, a day band, an hour-of-week
   heatmap).

   It is still a claim rather than a measurement, and the residual error runs
   the wrong way for one shape: a driver whose feed goes quiet mid-afternoon
   and does not come back is credited to midnight. That is why open_ended is
   carried out rather than swallowed — a surface that must not overstate can
   refuse it, and /api/driver/day says on the page that the day is still
   being collected.

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
  return `ev AS (
     /* PARTITIONED BY ACCOUNT, and that is correctness rather than tidiness:
        one ordering across two Uber accounts closes an ONLINE on account A
        with an OFFLINE on account B and yields spans belonging to neither. */
     SELECT driver_ext_id, at, status, platform, fleet_id,
            lead(at) OVER (PARTITION BY driver_ext_id ORDER BY at) AS next_at
       FROM driver_timeline_event
      WHERE kind = 'status' AND status <> '' AND (${where})),
   status_span AS (
     /* coalesce, not a next_at IS NOT NULL filter. See the header: the one it
           replaces deleted the most recent ONLINE of 60 of 89 drivers. */
     SELECT driver_ext_id, at AS span_start,
            coalesce(next_at, least(now(), ${DAY_END('at')})) AS span_end,
            next_at IS NULL AS open_ended
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
     SELECT driver_ext_id, span_start, span_end, open_ended FROM status_span
      WHERE span_end > span_start
      UNION ALL
     SELECT driver_ext_id, span_start, span_end, false FROM job_span
      WHERE span_end > span_start AND (${keep})),
   edge AS (
     /* Gaps and islands. A piece opens a new island only when it starts after
        the furthest any earlier piece on this account ran to — a RUNNING max,
        not the previous row, because a long heartbeat span contains several
        short job intervals and "previous row" would reopen the island on each
        of them. Touching counts as continuous, so the test is <= and not <. */
     SELECT driver_ext_id, span_start, span_end, open_ended,
            CASE WHEN span_start <= max(span_end) OVER (
                   PARTITION BY driver_ext_id ORDER BY span_start, span_end
                   ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)
                 THEN 0 ELSE 1 END AS opens
       FROM piece),
   islanded AS (
     SELECT driver_ext_id, span_start, span_end, open_ended,
            sum(opens) OVER (PARTITION BY driver_ext_id ORDER BY span_start, span_end
                             ROWS UNBOUNDED PRECEDING) AS grp
       FROM edge),
   spans AS (
     /* bool_or is exact rather than approximate here: every piece is bounded
        above by least(now(), end of its own Dubai day), so an open-ended piece
        always supplies its island's max end. */
     SELECT driver_ext_id, min(span_start) AS span_start, max(span_end) AS span_end,
            bool_or(open_ended) AS open_ended
       FROM islanded GROUP BY driver_ext_id, grp)`;
}
