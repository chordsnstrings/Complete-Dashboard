/* What has landed, per dataset, per fleet, per Dubai day — kept (2026-11-25).
   ──────────────────────────────────────────────────────────────────────────
   /api/coverage (the Data sources page, and api/warm.js on every version
   change) counted every row of trip, driver_timeline_event,
   telemetry_snapshot and alert on every call, grouped by day: about ten
   whole-table aggregations, run in parallel. Measured on production on the
   audit of 2026-11-25: the telemetry per-day count alone averaged 18 s and
   reached 94 s, it ran 147 times in 18 hours, and the endpoint as a whole is
   what the database spends most of its slow-query time on.

   Past days do not change. So this keeps the counts per (dataset, fleet,
   Dubai day) and the route sums them:

     trip:<platform>       by requested_at — rows, with a pickup coordinate,
                           with a drop-off coordinate, first and last request
     timeline:<platform>   by at — rows, with a coordinate, first and last
     telemetry:<source>    by polled_at (OUR clock, as the route counts it) —
                           rows, first captured_at, first and last polled_at
     alerts                by occurred_at — rows, first and last

   A row whose timestamp is NULL is counted under the sentinel day
   0001-01-01, so a total still equals count(*); the route leaves that day
   out of every calendar and every "before" count, exactly as the live
   queries' predicates did. fleet_id NULL is stored as '' so a fleet filter
   excludes it, as `fleet_id = $1` did.

   Refreshed inside the ordinary rollup pass (src/rollup.js): the last 14
   days every quarter hour and after each collection, everything at boot and
   nightly. Telemetry is the one dataset whose past days can move — a fix's
   polled_at advances while its vehicle is still listed — and those rows were
   polled in the last day or two, inside the narrow window. The build is
   recorded in history_rollup_build ('coverage_day'); the route reads this
   table only once a full pass has built it, and says when it was read. */
import { pool } from './db.js';

const TZ = 'Asia/Dubai';
export const UNDATED = '0001-01-01';

export async function refreshCoverageDay(db = pool, { since = null } = {}) {
  const [{ t0 }] = (await db.query('SELECT now() AS t0')).rows;
  const day = (col) => `coalesce((${col} AT TIME ZONE '${TZ}')::date, DATE '${UNDATED}')`;
  /* Narrow: the days from `since`; the undated sentinel is rebuilt by full
     passes only (it can only grow by a row with no timestamp, which is rare
     and lands in the nightly pass).
     The bound is written as the Dubai day of the column on purpose: trip,
     telemetry_snapshot (polled_at, v36) and alert carry expression indexes
     on exactly that, so the narrow pass is index-served as written. */
  const bound = (col) => (since ? `AND (${col} AT TIME ZONE '${TZ}')::date >= $1::date` : '');
  const p = since ? [since] : [];
  await db.query(
    `INSERT INTO coverage_day (dataset, fleet_id, day, rows, with_a, with_b, min_ts, max_ts, min_b, computed_at)
     SELECT 'trip:' || platform, coalesce(fleet_id, ''), ${day('requested_at')},
            count(*)::int, count(pickup_lat)::int, count(dropoff_lat)::int,
            min(requested_at), max(requested_at), NULL::timestamptz, now()
       FROM trip WHERE true ${bound('requested_at')}
      GROUP BY 1, 2, 3
     UNION ALL
     SELECT 'timeline:' || platform, coalesce(fleet_id, ''), ${day('at')},
            count(*)::int, count(lat)::int, count(lat)::int, min(at), max(at), NULL::timestamptz, now()
       FROM driver_timeline_event WHERE true ${bound('at')}
      GROUP BY 1, 2, 3
     UNION ALL
     SELECT 'telemetry:' || source, coalesce(fleet_id, ''), ${day('polled_at')},
            count(*)::int, NULL::int, NULL::int, min(captured_at), max(polled_at), min(polled_at), now()
       FROM telemetry_snapshot WHERE true ${bound('polled_at')}
      GROUP BY 1, 2, 3
     UNION ALL
     SELECT 'alerts', coalesce(fleet_id, ''), ${day('occurred_at')},
            count(*)::int, NULL::int, NULL::int, min(occurred_at), max(occurred_at), NULL::timestamptz, now()
       FROM alert WHERE true ${bound('occurred_at')}
      GROUP BY 1, 2, 3
     ON CONFLICT (dataset, fleet_id, day) DO UPDATE SET
       rows = EXCLUDED.rows, with_a = EXCLUDED.with_a, with_b = EXCLUDED.with_b,
       min_ts = EXCLUDED.min_ts, max_ts = EXCLUDED.max_ts, min_b = EXCLUDED.min_b,
       computed_at = EXCLUDED.computed_at`, p);
  /* A (dataset, fleet, day) that no longer has any row — a telemetry fix
     whose polled_at moved on — is removed, inside the window rebuilt. */
  await db.query(
    `DELETE FROM coverage_day WHERE computed_at < $1::timestamptz
       ${since ? `AND day >= $2::date` : ''}`, since ? [t0, since] : [t0]);
  await db.query(
    `INSERT INTO history_rollup_build (name, read_at, built_from, finished_at)
     VALUES ('coverage_day', $1::timestamptz, $2::date, now())
     ON CONFLICT (name) DO UPDATE SET read_at = EXCLUDED.read_at,
       built_from = least(history_rollup_build.built_from, EXCLUDED.built_from),
       finished_at = EXCLUDED.finished_at`, [t0, since || '1900-01-01']);
  const { rows } = await db.query('SELECT count(*)::int n FROM coverage_day');
  return rows[0].n;
}
