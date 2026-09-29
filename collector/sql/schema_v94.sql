-- v94 — the newest seat reading per car, found in the index (2026-09-29).
--
-- /api/vehicles/feeds (api/feed_routes.js FEEDS_SQL) asks, for every car Uber
-- lists as active, when each seat sensor last reported:
--   CABMAN:     max(captured_at) … WHERE source = 'cabman' AND plate = $car
--                                      AND seat_occupied IS NOT NULL
--   FMS live:   max(captured_at) … WHERE source = 'fms' AND plate = $car
--                                      AND seat_count IS NOT NULL
--   FMS trips:  max(coalesce(ended_at, requested_at)) FROM trip
--                                WHERE platform = 'fms' AND plate = $car
--                                  AND seat_count IS NOT NULL
-- The only index those could use is (source, plate, captured_at), which has
-- no idea which rows carry a seat reading. For a car whose sensor never
-- reports, Postgres walks back through that car's whole history looking for
-- one — thousands of rows, six times per car, for ~130 cars, on a table of
-- ~657,000 rows that grows by ~12,000 a day. Measured on production
-- 2026-09-29: the page took 15.9 s and 13.8 s on two passes
-- (docs/AUDIT.md, "Page load times on production").
--
-- Partial indexes on exactly the rows those lookups are about make each one a
-- single probe. They hold only the rows with a seat reading, so they are small,
-- and an index changes no answer: the query text is untouched.
-- Additive and idempotent (IF NOT EXISTS). Building them takes a SHARE lock on
-- each table for the few seconds the build lasts, which holds back the
-- collector's inserts, never a reader.
-- test/feeds_seat_index.test.mjs.
CREATE INDEX IF NOT EXISTS telemetry_cabman_seat_idx
  ON telemetry_snapshot (plate, captured_at DESC)
  WHERE source = 'cabman' AND seat_occupied IS NOT NULL;

CREATE INDEX IF NOT EXISTS telemetry_fms_seat_idx
  ON telemetry_snapshot (plate, captured_at DESC)
  WHERE source = 'fms' AND seat_count IS NOT NULL;

CREATE INDEX IF NOT EXISTS trip_fms_seat_end_idx
  ON trip (plate, (coalesce(ended_at, requested_at)) DESC)
  WHERE platform = 'fms' AND seat_count IS NOT NULL;
