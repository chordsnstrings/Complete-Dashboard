/* Uber availability, hour by hour — the build and the live read.
   ───────────────────────────────────────────────────────────────────────
   sql/schema_v106.sql says what driver_online_hour holds and why it is kept.
   Two pieces live here, because the routes and the rollup both need them and a
   second copy of either is a second definition of "online":

     ONLINE_HOURS_SLICES  the stored hours, cut from api/online_span_sql.js's
                          spans — the same spans driver_day.online_min sums.
     LIVE_HOURS_SQL       the hours Uber's timeline has not reached yet, from
                          the live status feed (driver_status_event, every
                          LIVE_STATUS_SECONDS since 2026-09-14). Read at
                          request time and never stored: the timeline fills
                          the same hours within three hours and is the record.

   One meaning of online in both: ONLINE or on a trip. The timeline's spans
   merge ONLINE heartbeats with job spans; the live feed says online | ontrip
   | offline, and online + ontrip is the same set of minutes. */
import { onlineSpansSql } from './online_span_sql.js';

/* Every span cut at the Dubai hour, with its minutes and whether OUR bound
   closed it. `where` bounds the event scan (see onlineSpansSql). Ends in
   `slices (driver_ext_id, h_local, mins, open_ended)`; no leading WITH. */
export const ONLINE_HOURS_SLICES = (where = 'TRUE') => `${onlineSpansSql({ where })},
     slices AS (
       SELECT sp.driver_ext_id, g AS h_local, sp.open_ended,
              extract(epoch FROM (
                least(sp.span_end AT TIME ZONE 'Asia/Dubai', g + interval '1 hour')
                - greatest(sp.span_start AT TIME ZONE 'Asia/Dubai', g))) / 60 AS mins
         FROM spans sp,
              LATERAL generate_series(date_trunc('hour', sp.span_start AT TIME ZONE 'Asia/Dubai'),
                                      sp.span_end AT TIME ZONE 'Asia/Dubai', interval '1 hour') AS g)`;

/* The rows driver_online_hour stores, from the slices. `dayFrom` is a SQL
   expression for the first Dubai day to write (NULL for all of them). The
   fleet is the account's newest timeline event at or before the hour's end,
   one probe of dte_driver_at_idx per row. */
export const ONLINE_HOURS_ROWS = (dayFrom = 'NULL') => `
  SELECT 'uber' AS platform, x.driver_ext_id,
         (SELECT e.fleet_id FROM driver_timeline_event e
           WHERE e.driver_ext_id = x.driver_ext_id
             AND e.at < (x.h_local AT TIME ZONE 'Asia/Dubai') + interval '1 hour'
           ORDER BY e.at DESC LIMIT 1) AS fleet_id,
         x.h_local AT TIME ZONE 'Asia/Dubai' AS hour_start,
         x.h_local::date AS day, extract(hour FROM x.h_local)::smallint AS hour,
         round(least(60, x.mins)::numeric, 2) AS online_min,
         round(least(60, x.open_mins)::numeric, 2) AS open_min
    FROM (SELECT driver_ext_id, h_local,
                 sum(greatest(0, mins)) AS mins,
                 coalesce(sum(greatest(0, mins)) FILTER (WHERE open_ended), 0) AS open_mins
            FROM slices GROUP BY 1, 2) x
   WHERE x.mins >= 0.005
     AND (${dayFrom}::date IS NULL OR x.h_local >= ${dayFrom}::date::timestamp)`;

/* Today's hours the timeline has not reached: per account per Dubai hour,
   from the live status feed, between $1 and $2 (instants), fleet $3 (or
   NULL). The state an account was in at $1 is its last event before it
   (within two days); a span ends at the next event, at $2, at now(), or at
   the live feed's last poll — whichever is first — so a feed that stopped is
   never read as everyone still online. */
export const LIVE_HOURS_SQL = `
  WITH ev AS (
    SELECT e.driver_ext_id, e.fleet_id, e.at, lower(e.status) AS status
      FROM driver_status_event e
     WHERE e.platform = 'uber'
       AND e.at < $2::timestamptz
       AND e.at >= $1::timestamptz - interval '2 days'),
  seen AS (SELECT max(observed_at) AS polled FROM driver_status_now WHERE platform = 'uber'),
  spanned AS (
    SELECT driver_ext_id, fleet_id, status, at,
           lead(at) OVER (PARTITION BY driver_ext_id ORDER BY at) AS next_at
      FROM ev),
  cut AS (
    SELECT s.driver_ext_id, s.fleet_id,
           greatest(s.at, $1::timestamptz) AS a,
           least(coalesce(s.next_at, $2::timestamptz), $2::timestamptz, now(),
                 coalesce((SELECT polled FROM seen), now())) AS b
      FROM spanned s
     WHERE s.status IN ('online', 'ontrip')
       AND ($3::text IS NULL OR s.fleet_id = $3)),
  sliced AS (
    SELECT c.driver_ext_id, c.fleet_id, g AS h_local,
           extract(epoch FROM (least(c.b AT TIME ZONE 'Asia/Dubai', g + interval '1 hour')
                               - greatest(c.a AT TIME ZONE 'Asia/Dubai', g))) / 60 AS mins
      FROM cut c,
           LATERAL generate_series(date_trunc('hour', c.a AT TIME ZONE 'Asia/Dubai'),
                                   c.b AT TIME ZONE 'Asia/Dubai', interval '1 hour') AS g
     WHERE c.b > c.a)
  SELECT driver_ext_id, max(fleet_id) AS fleet_id, extract(hour FROM h_local)::int AS hour,
         round(sum(greatest(0, mins))::numeric, 2)::float8 AS online_min
    FROM sliced
   GROUP BY 1, 3
  HAVING sum(greatest(0, mins)) >= 0.005`;
