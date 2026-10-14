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
