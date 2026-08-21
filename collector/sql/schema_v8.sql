-- Make an unauthorised-trip verdict falsifiable, and stop it being issued when
-- it cannot be verified.
--
-- The feature was naming drivers for trips they had genuinely run. Three causes,
-- all now fixed upstream, all of which would have been caught on day one if the
-- verdict had carried its evidence:
--
--   1. CABMAN's `gmt` field was stamped +04:00, moving every fix four hours into
--      the past. Against a 15-minute matching tolerance, no segment could ever
--      match its own booking. Eleven of thirteen live accusations were trips the
--      driver had completed on Uber.
--   2. Bolt and Yango had zero trip rows in the database while their collectors
--      reported "ok" (rows_written counted roster entries). A segment could not
--      possibly be matched to a Bolt booking, and was called unauthorised.
--   3. Journeys truncated by the edge of available telemetry, or still running
--      when the reconciler swept, were judged as though complete.
--
-- `nearest_gap_min` is the field that makes cause 1 self-evident: thirteen
-- accusations each showing a nearest booking exactly 240 minutes away is a clock
-- problem, not thirteen dishonest drivers.

ALTER TABLE occupancy_segment ADD COLUMN IF NOT EXISTS nearest_platform  TEXT;
ALTER TABLE occupancy_segment ADD COLUMN IF NOT EXISTS nearest_trip_id   TEXT;
ALTER TABLE occupancy_segment ADD COLUMN IF NOT EXISTS nearest_gap_min   INT;
ALTER TABLE occupancy_segment ADD COLUMN IF NOT EXISTS verdict_reason    TEXT;
ALTER TABLE occupancy_segment ADD COLUMN IF NOT EXISTS channels_checked  TEXT;
ALTER TABLE occupancy_segment ADD COLUMN IF NOT EXISTS boundary_gap_min  INT;

COMMENT ON COLUMN occupancy_segment.verdict IS
  'authorized | unauthorized | unverifiable | pending | partial | sensor_suspect | stationary. Only `unauthorized` is an accusation, and it may only be issued when every booking channel reported in the window, the telemetry clock is sane, and the journey is bounded on both sides by observed fixes.';
COMMENT ON COLUMN occupancy_segment.nearest_gap_min IS
  'Minutes to the nearest booking on this plate, matched or not. A population of unauthorised segments sharing one large value is a clock-skew signature, not misconduct.';

-- Retract every verdict issued under the four-hour skew. These are not merely
-- stale: they are wrong, and they name people. Deleting rather than recomputing
-- in place because the segment boundaries themselves were built from skewed
-- timestamps, so the rows cannot be corrected — they have to be rebuilt from
-- telemetry on the next reconcile pass.
DELETE FROM occupancy_segment WHERE verdict_reason IS NULL;
