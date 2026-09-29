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
