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

CREATE OR REPLACE VIEW trip_norm AS
SELECT
  t.*,

  -- Is this a booking on a ride-hailing or corporate channel, or a journey
  -- inferred from a GPS trace?
  (t.platform <> 'fms') AS is_booking,

  -- Normalised outcome. NULL where the question does not apply.
  CASE
    WHEN t.platform = 'fms' THEN NULL
    WHEN t.status IS NULL THEN NULL
    WHEN lower(btrim(t.status)) IN ('completed', 'finished', 'complete', 'closed', 'delivered')
      THEN 'completed'
    WHEN t.status ILIKE '%cancel%'
      OR lower(btrim(t.status)) IN ('client_did_not_show', 'driver_did_not_respond',
                                    'driver_rejected', 'rejected', 'expired', 'failed', 'no_show')
      THEN 'not_completed'
    ELSE 'other'
  END AS outcome,

  -- Dubai-local calendar keys. Every grouping and every window bound should
  -- use these rather than re-deriving them.
  (t.requested_at AT TIME ZONE 'Asia/Dubai')::date            AS local_day,
  extract(hour  FROM t.requested_at AT TIME ZONE 'Asia/Dubai')::int AS local_hour,
  extract(dow   FROM t.requested_at AT TIME ZONE 'Asia/Dubai')::int AS local_dow,
  date_trunc('month', (t.requested_at AT TIME ZONE 'Asia/Dubai'))::date AS local_month,

  -- Does this row carry money, and is its distance usable as a trip distance?
  -- The Uber trip export has no fare column at all, so `price` is NULL on every
  -- Uber row; a revenue figure describes only the hotel, Yango and Bolt rows.
  (t.price IS NOT NULL) AS has_fare,
  -- FMS distances are odometer-derived and occasionally implausible. A trip
  -- distance is only comparable within a sane range.
  (t.distance_km IS NOT NULL AND t.distance_km > 0 AND t.distance_km < 500) AS has_distance
FROM trip t;

COMMENT ON VIEW trip_norm IS
  'trip, with the platform differences resolved: is_booking separates bookings from telematics journeys, outcome normalises status across platforms, local_* are Dubai-local calendar keys, has_fare/has_distance mark which rows a money or distance ratio may be computed over.';

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
