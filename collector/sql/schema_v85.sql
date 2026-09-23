-- ===========================================================================
-- occupancy_segment: WHICH SEAT-SENSOR PROVIDER a segment came from — in the key.
-- ===========================================================================
-- The operator's rulings, 2026-09-23:
--   1. "FMS and CABMAN is two separate providers … add FMS as well": both are
--      used for unauthorized-trip detection.
--   2. FMS's Seat Count counts PASSENGERS; 1 or more means passengers aboard.
--   3. FMS is used twice over: its live seat count (telemetry_snapshot.
--      seat_count, schema_v84, every poll since 2026-09-23) and its per-journey
--      Seat Count (trip.seat_count on platform 'fms', about two years deep).
--   4. Two cars carry both trackers. Keep BOTH providers' segments for them,
--      each carrying its own source and its own timestamps. Nothing is merged
--      across sources and nothing is dropped.
--
-- WHY THE KEY HAS TO CHANGE, NOT ONLY GAIN A COLUMN. The table was keyed
-- (plate, started_at) with no source, and src/reconcile.js writeWindow()
-- deletes every row on a plate in the window it re-derived, then sweeps out
-- any row a longer one on the same plate contains. Written per provider over
-- that key, the second provider's pass would have deleted the first's rows on
-- the same plate, and an FMS journey starting at the same second as a CABMAN
-- segment would have overwritten it through ON CONFLICT. So `source` is part
-- of the primary key, and the reconciler's delete and sweep are scoped to
-- (source, plate) — one provider can never remove another's segment.
--
-- THE VALUES. 'cabman' (CABMAN DT's seat pad, a 5-minute poll), 'fms_live'
-- (FMS's live Seatcount, read on every 2-minute poll), 'fms_trip' (FMS's
-- per-journey Seat Count from GetTripPassenger). Every row that exists today
-- was written by the CABMAN-only reconciler, so the default fills them with
-- 'cabman' — which is also why the default stays: fixtures and old rows that
-- name no source are CABMAN's. The reconciler always writes the source
-- explicitly.
--
-- `passengers` is the count the provider reported, where it reports one: the
-- FMS journey's own Seat Count on an 'fms_trip' row. CABMAN's reading is
-- stored as occupied/empty (telemetry_snapshot.seat_occupied) and FMS live
-- segments are built from occupied/empty in memory, so both leave it NULL —
-- absent, not zero.
--
-- WORKS ON BOTH ENGINES. ADD COLUMN … NOT NULL DEFAULT with a constant is a
-- catalogue change on Postgres 11+ (no table rewrite) and is supported by
-- PGlite. The primary-key swap is guarded on the catalogue rather than on
-- schema_once, so it is a no-op on any database whose key already carries
-- `source` — a replay, a fresh test database, or production after the first
-- boot — and it is the same statement on both engines. No JSONB is bound
-- anywhere here or by the reconciler's write, so the node-postgres array-to-
-- JSONB trap (docs/COVERAGE.md) cannot arise from this table.
ALTER TABLE occupancy_segment ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'cabman';
ALTER TABLE occupancy_segment ADD COLUMN IF NOT EXISTS passengers INT;

ALTER TABLE occupancy_segment DROP CONSTRAINT IF EXISTS occupancy_segment_source_ck;
ALTER TABLE occupancy_segment ADD CONSTRAINT occupancy_segment_source_ck
  CHECK (source IN ('cabman', 'fms_live', 'fms_trip'));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
     WHERE i.indrelid = 'occupancy_segment'::regclass
       AND i.indisprimary
       AND a.attname = 'source') THEN
    ALTER TABLE occupancy_segment DROP CONSTRAINT IF EXISTS occupancy_segment_pkey;
    ALTER TABLE occupancy_segment
      ADD CONSTRAINT occupancy_segment_pkey PRIMARY KEY (source, plate, started_at);
  END IF;
END $$;

COMMENT ON COLUMN occupancy_segment.source IS
  'Which seat-sensor provider this segment came from: cabman (CABMAN DT seat pad), '
  'fms_live (FMS live Seatcount, occupied when >= 1), fms_trip (one FMS journey whose '
  'Seat Count is >= 1). Part of the key: two providers on one plate keep their own rows, '
  'and the reconciler deletes and sweeps per (source, plate) only.';
COMMENT ON COLUMN occupancy_segment.passengers IS
  'The passenger count the provider reported for this segment: the FMS journey''s Seat Count '
  'on fms_trip rows. NULL on cabman and fms_live rows, whose readings are occupied/empty.';
