-- v39 — when the car actually came free.
--
-- A vehicle with two drivers in a day is already visible: vehicle_driver_day
-- keeps every custodian and marks the busiest one primary. What nothing could
-- answer is the cost of the change-over — the hours a car stands still between
-- one driver finishing and the next one starting. On a fleet where an asset is
-- the scarce thing, that gap is unearned rent, and it is invisible in every
-- per-day number because both drivers "worked that day".
--
-- Measuring it needs an end time, and custody carried only starts. The fold
-- that produces one lives in schema_v19.sql, beside the rest of the custody
-- definition — this file persists it and backfills what already exists.

-- Persisted alongside the rest of custody so the handover view does not depend
-- on trip staying loaded for the whole horizon. NULL on rows written before
-- this migration; every reader coalesces to last_trip_at, which is the value
-- those rows would have produced anyway.
ALTER TABLE vehicle_driver_day ADD COLUMN IF NOT EXISTS last_end_at TIMESTAMPTZ;

-- The handover query walks a plate's stints in start order across a window.
CREATE INDEX IF NOT EXISTS vdd_plate_first_idx
  ON vehicle_driver_day (plate, first_trip_at)
  WHERE first_trip_at IS NOT NULL;

-- The column starts empty, and the collector only rebuilds custody over the
-- window it just collected — so without this every row older than that window
-- would fall back to the request time for as long as the fleet keeps running,
-- and the handover view would read one trip too long on almost all of it.
--
-- Guarded on the column being wholly empty rather than on individual NULLs: a
-- stint whose trips carry no drop-off time is legitimately NULL forever, and a
-- per-row guard would re-run this whole-history aggregate on every deploy.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vehicle_driver_day WHERE last_end_at IS NOT NULL) THEN
    UPDATE vehicle_driver_day v
       SET last_end_at = c.last_end_at
      FROM custody_live c
     WHERE c.plate = v.plate AND c.day = v.day
       AND c.driver_ext_id = v.driver_ext_id AND c.platform = v.platform
       AND c.last_end_at IS NOT NULL;
  END IF;
END $$;
