/* EACH CAR'S NEWEST FIX, WITHOUT READING EVERY FIX EVER TAKEN.
   ─────────────────────────────────────────────────────────────────────────
   /api/live and /api/kpis (api/server.js) asked `DISTINCT ON (plate) … FROM telemetry_snapshot
   ORDER BY plate, …` — which sorts the whole table to keep one row a plate.
   The table keeps every fix: about 657,000 on 2026-09-29, FMS alone adding
   ~12,000 a day, for ~150 plates. Measured on production that day, the live
   map took 24.7 s and then 57.1 s, #map 9.7–13.6 s, and the KPI version ran
   60 times in an hour at a median 7.3 s — and all of it grows every day
   without anyone changing a line (docs/AUDIT.md, "Page load times on
   production").

   The same answer, asked the way the index can give it:
     TELEMETRY_PLATES — the distinct plates, found by skipping through the
       (plate, captured_at DESC) index one plate at a time: ~150 index probes
       rather than 657,000 rows. plate is NOT NULL (sql/schema.sql), so no
       group is lost by the `plate > previous` step.
     LATEST_FIX(alias) — per plate, the newest fix dated up to now(), and only
       if there is none, the newest dated after it: exactly the old ORDER BY
       `(captured_at <= now()) DESC, captured_at DESC, polled_at DESC`, since
       captured_at is NOT NULL and the boolean is never null. The rank column
       decides between the two rather than the order UNION ALL happens to
       return them in, which SQL does not promise.
   test/live_fix.test.mjs compares both, row for row, with the DISTINCT ON
   they replace, on a fixture with a future-only plate, a two-feed tie, and a
   NULL poll time. */
export const TELEMETRY_PLATES = `plates(plate) AS (
    (SELECT plate FROM telemetry_snapshot ORDER BY plate LIMIT 1)
    UNION ALL
    SELECT (SELECT t.plate FROM telemetry_snapshot t WHERE t.plate > p.plate ORDER BY t.plate LIMIT 1)
      FROM plates p WHERE p.plate IS NOT NULL)`;
export const LATEST_FIX = (plateExpr) => `(
    SELECT f.* FROM (
      (SELECT 0 AS fix_rank, t.* FROM telemetry_snapshot t
        WHERE t.plate = ${plateExpr} AND t.captured_at <= now()
        ORDER BY t.captured_at DESC, t.polled_at DESC LIMIT 1)
      UNION ALL
      (SELECT 1 AS fix_rank, t.* FROM telemetry_snapshot t
        WHERE t.plate = ${plateExpr} AND t.captured_at > now()
        ORDER BY t.captured_at DESC, t.polled_at DESC LIMIT 1)
    ) f ORDER BY f.fix_rank LIMIT 1)`;

/* THE DAYS A CABMAN CAR WAS SEEN MOVING (FIXLIST V3, 2026-10-14).
   ───────────────────────────────────────────────────────────────────────
   "Moved" on #vehicles, the directory's days_moved and /api/economics/assets
   was read off trip_norm alone — bookings plus FMS journeys. CABMAN files
   positions, never journeys, so a CABMAN car driven every day without a
   booking read "did not move": on production L74169 was driven 26 of 30 days
   and counted still. A Dubai day counts here when any CABMAN fix that day
   carried a speed above walking pace — the same 3 km/h line the driver-day
   page draws (api/day_movement.js). Only CABMAN: an FMS car's movement is
   already a journey row, and counting its fixes too would be the same
   movement twice. `fromP`/`toP` are SQL expressions for the window's first and
   last Dubai day. */
export const CABMAN_MOVING_KMH = 3;
export const CABMAN_MOVE_DAYS = (fromP, toP, fleetP = 'NULL') => `SELECT plate, (captured_at AT TIME ZONE 'Asia/Dubai')::date AS local_day
      FROM telemetry_snapshot
     WHERE source = 'cabman' AND speed > ${CABMAN_MOVING_KMH}
       AND (${fleetP}::text IS NULL OR fleet_id = ${fleetP})
       AND captured_at >= (${fromP}::date::timestamp AT TIME ZONE 'Asia/Dubai')
       AND captured_at <  ((${toP}::date + 1)::timestamp AT TIME ZONE 'Asia/Dubai')
     GROUP BY 1, 2`;

/* A FIX WITH A REAL POSITION (FIXLIST V11, 2026-10-14). A tracker with no
   satellite lock files 0,0 — "null island", in the Gulf of Guinea — and
   /api/where and /api/map/days passed those through: L68713's last position on
   record was 0,0. Anything within a degree of 0,0 is not this fleet, which
   works around 25°N 55°E. `a` is the table alias, with its dot. */
export const REAL_FIX = (a = '') => `(${a}lat IS NOT NULL AND ${a}lng IS NOT NULL
      AND NOT (abs(${a}lat) < 1 AND abs(${a}lng) < 1))`;

/* HOW LONG A CAR STOOD WHERE IT STOOD (FIXLIST V5, 2026-10-14).
   "Where it parks" multiplied the number of stationary fixes by five minutes.
   A parked CABMAN car reports about hourly and a sleeping FMS unit every few
   days, so a car that stood ~277 hours read 21. Measured instead from the gap
   to the car's NEXT fix: when that fix is still stationary at the same spot
   (3 decimals, ~100 m), the car was there the whole gap and all of it counts
   (capped at a week, past which nothing is claimed); when it is elsewhere or
   moving, the car left at some unknown moment, and at most PARK_STEP_MIN
   counts. The last fix in the window counts nothing — its end is unknown. */
export const PARK_STEP_MIN = 5;
export const PARKED_SPOTS_SQL = (plateP, tsPred) => `WITH f AS (
       SELECT round(lat::numeric, 3) AS lat, round(lng::numeric, 3) AS lng,
              coalesce(speed, 0) < 2 AS still, captured_at,
              lead(captured_at) OVER (ORDER BY captured_at) AS nxt_at,
              lead(round(lat::numeric, 3)) OVER (ORDER BY captured_at) AS nxt_lat,
              lead(round(lng::numeric, 3)) OVER (ORDER BY captured_at) AS nxt_lng,
              lead(coalesce(speed, 0) < 2) OVER (ORDER BY captured_at) AS nxt_still
         FROM telemetry_snapshot
        WHERE plate = ${plateP} AND ${tsPred} AND ${REAL_FIX()}
     )
     SELECT lat, lng, count(*)::int fixes,
            round((sum(CASE
              WHEN nxt_at IS NULL THEN 0
              WHEN nxt_still AND nxt_lat = lat AND nxt_lng = lng
                THEN least(extract(epoch FROM nxt_at - captured_at), 7 * 86400)
              ELSE least(extract(epoch FROM nxt_at - captured_at), ${PARK_STEP_MIN} * 60) END) / 3600)::numeric, 1)::float8 AS hours
       FROM f WHERE still
      GROUP BY 1, 2 HAVING count(*) >= 3
      ORDER BY hours DESC, fixes DESC LIMIT 60`;

/* A CAR'S TRACKER, AND WHAT IT IS DOING (FIXLIST V6, 2026-10-14).
   ───────────────────────────────────────────────────────────────────────
   The vehicle header and the directory took their pill, "last fix" and
   odometer from the newest telemetry_snapshot row of ANY source — and the Uber
   collector writes its drivers' online status there too (ONLINE / ONTRIP /
   OFFLINE, src/sources/uber.js). So a busy car wore Uber's "ONTRIP" and lost
   its odometer, a car parked 47 days with the ignition off wore CABMAN's green
   "ACTIVE", and one status column mixed four vocabularies. A car's tracker is
   CABMAN or FMS; its state is said in one vocabulary, from what the fix
   measured: moving above walking pace, standing, or quiet.

   QUIET is per tracker, not one number for both: an FMS unit reports every
   ~5 min while it is awake, a parked CABMAN car about hourly (COVERAGE), and
   the directory's 11-minute rule called every parked CABMAN car stale. Quiet
   is twice the normal rhythm: 30 min for FMS, 120 for CABMAN. */
export const TRACKER_SOURCES_SQL = `('cabman', 'fms')`;
export const QUIET_MIN = Object.freeze({ fms: 30, cabman: 120 });
export const QUIET_SQL = (a = '') => `(now() - ${a}captured_at > CASE ${a}source WHEN 'cabman'
      THEN interval '${QUIET_MIN.cabman} minutes' ELSE interval '${QUIET_MIN.fms} minutes' END)`;
export const TRACKER_STATE_SQL = (a = '') => `CASE WHEN ${QUIET_SQL(a)} THEN 'quiet'
      WHEN coalesce(${a}speed, 0) > ${CABMAN_MOVING_KMH} THEN 'moving' ELSE 'standing' END`;
