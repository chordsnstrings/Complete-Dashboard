-- ===========================================================================
-- FMS's live seat count, beside CABMAN's seat sensor.
-- ===========================================================================
-- The operator, 2026-09-23: "FMS and CABMAN is two separate providers each
-- should provide seat sensor data … we should collect seat count too."
--
-- FMS (InfoTrack) reports a live `Seatcount` on GetVehicleCurrentDetails
-- (docs/fleet-tracking-api-reference.md). Nothing called that operation. The
-- live poller calls GetVehicleStatus, which has no seat field, and the nightly
-- probe called GetVehicleCurrentDetails without `vehicleno=ALL` and was told
-- "Authentication failed" every night on both fleets. So FMS's only seat data
-- was the per-journey `Seat Count` in trip.seat_count.
--
-- seat_count is FMS's live count as reported at that fix. CABMAN's boolean
-- seat_occupied is left exactly as it is: the two providers report different
-- things (a count against a pressure pad), and nothing that reads
-- seat_occupied (src/reconcile.js reads CABMAN only) changes meaning here.
ALTER TABLE telemetry_snapshot ADD COLUMN IF NOT EXISTS seat_count INT;

COMMENT ON COLUMN telemetry_snapshot.seat_count IS
  'FMS only: the live Seatcount from GetVehicleCurrentDetails at this poll. '
  'NULL when FMS did not report one (or for CABMAN, whose seat sensor is '
  'seat_occupied). 0 is a reading, an empty seat, not an absence.';
