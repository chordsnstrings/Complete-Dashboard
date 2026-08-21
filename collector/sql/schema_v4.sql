-- v4: who was driving which vehicle, on which day.
-- Derived from trips (99.9% of Uber rows carry plate + driver + timestamp), so any
-- vehicle-level fact can name a person instead of just a plate. Handovers are real:
-- ~12% of vehicle-days have more than one driver, so we keep every driver for the day
-- and mark the one with the most trips as primary.

CREATE TABLE IF NOT EXISTS vehicle_driver_day (
  plate         TEXT NOT NULL,
  day           DATE NOT NULL,
  driver_ext_id TEXT NOT NULL,
  platform      TEXT NOT NULL,
  driver_name   TEXT,
  fleet_id      TEXT,
  trips         INT DEFAULT 0,
  km            DOUBLE PRECISION,
  revenue       NUMERIC(12,2),
  first_trip_at TIMESTAMPTZ,
  last_trip_at  TIMESTAMPTZ,
  is_primary    BOOLEAN DEFAULT false,   -- most trips for that plate that day
  PRIMARY KEY (plate, day, driver_ext_id, platform)
);
CREATE INDEX IF NOT EXISTS vdd_plate_day_idx ON vehicle_driver_day (plate, day DESC);
CREATE INDEX IF NOT EXISTS vdd_driver_idx    ON vehicle_driver_day (driver_ext_id, day DESC);
CREATE INDEX IF NOT EXISTS vdd_primary_idx   ON vehicle_driver_day (plate, day DESC) WHERE is_primary;

-- Current custody: the most recent primary driver per plate. Lets every vehicle view
-- answer "who has this car right now" without a correlated subquery at read time.
CREATE OR REPLACE VIEW vehicle_current_driver AS
SELECT DISTINCT ON (plate)
  plate, day AS as_of, driver_ext_id, driver_name, platform, fleet_id, trips
FROM vehicle_driver_day
WHERE is_primary
ORDER BY plate, day DESC;
