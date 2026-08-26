-- The other clock on telemetry_snapshot, grouped by Dubai day.
-- ─────────────────────────────────────────────────────────────────────────
-- /api/coverage now reports how continuous each dataset is, and for telemetry
-- that question has to be asked of polled_at rather than captured_at: this
-- fleet has trackers that stopped years ago (the collector logs "dormant 15 of
-- 48, oldest_days 862"), and their last surviving fix drags min(captured_at)
-- back to 2024. A span computed from it reported CABMAN as 23 days collected
-- of 863 with 840 missing, which reads as a catastrophic collection failure
-- and is actually fifteen dead units.
--
-- polled_at advances every time the collector observes a vehicle, so a day
-- with a poll on it is a day we collected — which is what the column asks.
--
-- schema_v27 added the captured_at expression index for the same reason; this
-- is its sibling, and test/indexes.test.mjs requires one for every Dubai-day
-- expression the API uses, so that a filter or a grouping cannot quietly
-- become a sequential scan.
CREATE INDEX IF NOT EXISTS telemetry_polled_dubai_day_idx
  ON telemetry_snapshot (((polled_at AT TIME ZONE 'Asia/Dubai')::date));
