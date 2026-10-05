-- v99 — two indexes for the unauthorized-trip attribution, 2026-10-05. Additive.
--
-- Measured on production (EXPLAIN ANALYZE of /api/unauthorized/attributed,
-- period=month, 211 journeys, 31 s):
--
-- 1. trip_person_ext_idx. The candidate's Uber status (statusJoin in
--    api/unauthorized_sql.js) needs the person's account ids: every trip with
--    that person_key, ~2,200 heap rows per candidate, 232 candidates, to find
--    one or two distinct driver_ext_id values. On (person_key, driver_ext_id)
--    the same answer is an index-only read.
--
-- 2. trip_plate_end_idx. A probe for the newest non-Uber trip on the car
--    between the last Uber trip and the journey filtered every trip on the
--    plate — 6,914 rows removed per probe, 107 probes, 3.2 s — because
--    trip_plate_idx is on plate alone and the window is on
--    coalesce(ended_at, requested_at). The expression here is that one,
--    character for character, or the planner will not use it.
CREATE INDEX IF NOT EXISTS trip_person_ext_idx ON trip (person_key, driver_ext_id);
CREATE INDEX IF NOT EXISTS trip_plate_end_idx ON trip (plate, (coalesce(ended_at, requested_at)));
