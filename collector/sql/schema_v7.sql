-- One definition of "a trip", used by every endpoint.
--
-- Three facts about this data were being rediscovered — and got wrong — in
-- nineteen separate queries. They are settled here once.
--
-- 1. A TELEMATICS ROW IS NOT A BOOKING.
--    The FMS collector derives a journey from GPS whenever a vehicle moves.
--    When a driver completes an Uber ride, BOTH sources record it. Checked
--    against production on one plate for one day: every Uber trip has an FMS
--    twin two to five minutes later with near-identical distance —
--      uber 00:53:53 33.64km  /  fms 00:59:29 32.41km
--      uber 01:46:58 33.88km  /  fms 01:51:11 33.63km
--      uber 04:48:23  1.18km  /  fms 04:50:50  1.17km
--    Summing them counted one physical journey twice, so the fleet's headline
--    trip count and total distance were both roughly double the truth.
--    `is_booking` separates the two populations. Telematics rows remain
--    essential — they are what catches movement with no booking behind it —
--    but they are journeys, not bookings, and must never be added to bookings.
--
-- 2. PLATFORMS DO NOT SHARE A STATUS VOCABULARY.
--    Uber says 'completed'; Bolt says 'finished' and also 'client_did_not_show',
--    'driver_did_not_respond', 'driver_rejected'; Yango sends its own strings;
--    the hotel channel maps 'finished' to 'completed' at ingest. Testing
--    `status = 'completed'` scored every completed Bolt trip as a failure, and
--    `status ILIKE '%cancel%'` missed three of Bolt's four failure modes.
--    FMS hardcodes 'completed' on rows that cannot be cancelled at all, which
--    padded both sides of the ratio. `outcome` normalises this, and is NULL for
--    telematics because "did this journey complete" is not a question about a
--    GPS trace.
--
-- 3. THE FLEET WORKS IN DUBAI, NOT UTC.
--    The Postgres session runs in UTC, so a bare `extract(hour from ...)` put
--    Dubai's 19:00 peak at 15:00 and pushed every trip between midnight and
--    04:00 onto the previous day — which, for a fleet whose airport work starts
--    at 03:00, moved a large share of it to the wrong day. Some queries already
--    said `AT TIME ZONE 'Asia/Dubai'` and some did not, so two pages disagreed
--    about the same trip. The local_* columns make the correct answer the
--    convenient one.

/* trip_norm IS DEFINED IN schema_v18.sql, NOT HERE.
   ──────────────────────────────────────────────────────────────────────────
   It used to be defined here, as `SELECT t.* ... FROM trip t`. Postgres
   expands that star ONCE, at creation, and stores the resulting column list —
   so a column added to `trip` by a later migration was invisible to this view
   and to everything built on it, while the column plainly existed in the
   table. CREATE OR REPLACE VIEW cannot fix it either: it refuses to change an
   existing view's output columns.

   v18 drops and recreates both views so the star re-expands. The three traps
   this file documents — telematics twins, the platform status vocabularies,
   and Dubai time — are unchanged and still the reason the view exists; the
   definition simply lives in one place now. */

-- The window predicate every endpoint uses is a range over requested_at, and
-- the groupings are by Dubai-local day. Support both.
CREATE INDEX IF NOT EXISTS trip_requested_platform_idx ON trip (requested_at, platform);
CREATE INDEX IF NOT EXISTS trip_platform_requested_idx ON trip (platform, requested_at);
CREATE INDEX IF NOT EXISTS trip_plate_requested_idx    ON trip (plate, requested_at) WHERE plate IS NOT NULL;
CREATE INDEX IF NOT EXISTS trip_driver_requested_idx   ON trip (driver_ext_id, requested_at) WHERE driver_ext_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS trip_local_day_idx          ON trip (((requested_at AT TIME ZONE 'Asia/Dubai')::date));

-- telemetry_snapshot is the fastest-growing table (a five-minute poll across
-- ~130 vehicles). Every query against it is by plate over a time range.
CREATE INDEX IF NOT EXISTS telemetry_plate_captured_idx ON telemetry_snapshot (plate, captured_at DESC);
CREATE INDEX IF NOT EXISTS telemetry_captured_idx       ON telemetry_snapshot (captured_at);

CREATE INDEX IF NOT EXISTS alert_plate_occurred_idx ON alert (plate, occurred_at);
CREATE INDEX IF NOT EXISTS alert_occurred_idx       ON alert (occurred_at);

CREATE INDEX IF NOT EXISTS vdd_driver_day_idx ON vehicle_driver_day (driver_ext_id, day);
CREATE INDEX IF NOT EXISTS vdd_plate_day_idx  ON vehicle_driver_day (plate, day);

CREATE INDEX IF NOT EXISTS occupancy_plate_started_idx ON occupancy_segment (plate, started_at);
