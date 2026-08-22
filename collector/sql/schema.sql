-- Ecosine / Egari fleet analytics — normalized collector store (PostgreSQL)
-- Everything is joined on the physical vehicle via its normalized license plate.
-- Source-specific fields that don't fit the common model are kept in `raw` JSONB.

CREATE TABLE IF NOT EXISTS fleet (
  id    TEXT PRIMARY KEY,              -- 'ecosine' | 'egari'
  name  TEXT NOT NULL
);
INSERT INTO fleet (id, name) VALUES
  ('ecosine','Ecosine Transports LLC'),
  ('egari','Egari Luxury') ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Dimensions: vehicles & drivers (canonical, cross-platform)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vehicle (
  plate       TEXT PRIMARY KEY,        -- normalized: uppercase, no spaces (L18379)
  fleet_id    TEXT REFERENCES fleet(id),
  make        TEXT,
  model       TEXT,
  year        INT,
  color       TEXT,
  vin         TEXT,
  fuel_type   TEXT,
  updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS driver (
  id          BIGSERIAL PRIMARY KEY,
  fleet_id    TEXT REFERENCES fleet(id),
  full_name   TEXT,
  phone       TEXT,
  email       TEXT,
  updated_at  TIMESTAMPTZ DEFAULT now()
);
-- map a canonical driver to their per-platform identity
CREATE TABLE IF NOT EXISTS driver_platform_id (
  platform     TEXT NOT NULL,          -- 'uber' | 'yango' | 'bolt' | 'fms'
  external_id  TEXT NOT NULL,          -- uuid / contractor id / driver id
  driver_id    BIGINT REFERENCES driver(id),
  display_name TEXT,
  PRIMARY KEY (platform, external_id)
);

-- ---------------------------------------------------------------------------
-- Fact: trips (unified Uber / Yango / FMS / Bolt-portal)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trip (
  platform      TEXT NOT NULL,
  external_id   TEXT NOT NULL,         -- Uber Trip UUID / Yango order id / FMS synthetic (plate|start)
  fleet_id      TEXT REFERENCES fleet(id),
  plate         TEXT,                  -- normalized, FK-ish to vehicle.plate
  driver_ext_id TEXT,
  driver_name   TEXT,
  requested_at  TIMESTAMPTZ,
  ended_at      TIMESTAMPTZ,
  pickup_addr   TEXT,
  pickup_lat    DOUBLE PRECISION,
  pickup_lng    DOUBLE PRECISION,
  dropoff_addr  TEXT,
  dropoff_lat   DOUBLE PRECISION,
  dropoff_lng   DOUBLE PRECISION,
  distance_km   DOUBLE PRECISION,
  duration_s    INT,
  status        TEXT,                  -- completed | rider_cancelled | driver_cancelled | ...
  product       TEXT,                  -- Electric | UberX | Comfort | comfort | ...
  payment_type  TEXT,
  seat_count    INT,
  price         NUMERIC(12,2),
  currency      TEXT DEFAULT 'AED',
  raw           JSONB,
  ingested_at   TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (platform, external_id)
);
CREATE INDEX IF NOT EXISTS trip_requested_idx ON trip (requested_at);
CREATE INDEX IF NOT EXISTS trip_plate_idx     ON trip (plate);
CREATE INDEX IF NOT EXISTS trip_fleet_idx     ON trip (fleet_id, requested_at);

-- ---------------------------------------------------------------------------
-- Fact: per-driver performance for a period (day or week)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS driver_performance (
  platform          TEXT NOT NULL,
  fleet_id          TEXT REFERENCES fleet(id),
  driver_ext_id     TEXT NOT NULL,
  driver_name       TEXT,
  plate             TEXT,
  period_start      DATE NOT NULL,
  period_end        DATE NOT NULL,
  trips             INT,
  hours_online      DOUBLE PRECISION,
  hours_on_trip     DOUBLE PRECISION,
  acceptance_rate   DOUBLE PRECISION,
  cancellation_rate DOUBLE PRECISION,
  completion_rate   DOUBLE PRECISION,
  distance_km       DOUBLE PRECISION,
  earnings          NUMERIC(12,2),
  cash_earnings     NUMERIC(12,2),
  rating            DOUBLE PRECISION,
  currency          TEXT DEFAULT 'AED',
  raw               JSONB,
  ingested_at       TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (platform, driver_ext_id, period_start, period_end)
);
CREATE INDEX IF NOT EXISTS perf_period_idx ON driver_performance (period_start, period_end);

-- ---------------------------------------------------------------------------
-- Fact: payments / financial ledger (Uber payments, Yango ledger, Bolt payouts)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ledger_entry (
  platform      TEXT NOT NULL,
  external_id   TEXT NOT NULL,
  fleet_id      TEXT REFERENCES fleet(id),
  driver_ext_id TEXT,
  driver_name   TEXT,
  order_ref     TEXT,
  event_at      TIMESTAMPTZ,
  category      TEXT,
  amount        NUMERIC(14,2),
  currency      TEXT DEFAULT 'AED',
  description   TEXT,
  raw           JSONB,
  ingested_at   TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (platform, external_id)
);
CREATE INDEX IF NOT EXISTS ledger_event_idx ON ledger_entry (event_at);

-- ---------------------------------------------------------------------------
-- Fact: driver-behaviour alerts (FMS)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alert (
  platform     TEXT NOT NULL DEFAULT 'fms',
  external_id  TEXT NOT NULL,          -- alertId or synthetic (plate|type|ts)
  fleet_id     TEXT REFERENCES fleet(id),
  plate        TEXT,
  alert_type   TEXT,                   -- Harsh Brake | Sharp Turn | OverSpeed | ...
  occurred_at  TIMESTAMPTZ,
  lat          DOUBLE PRECISION,
  lng          DOUBLE PRECISION,
  location     TEXT,
  video_url    TEXT,
  raw          JSONB,
  PRIMARY KEY (platform, external_id)
);
CREATE INDEX IF NOT EXISTS alert_occurred_idx ON alert (occurred_at);

-- ---------------------------------------------------------------------------
-- Fact: realtime telemetry snapshots (CABMAN / FMS live) — append-only
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS telemetry_snapshot (
  id           BIGSERIAL PRIMARY KEY,
  source       TEXT NOT NULL,          -- 'cabman' | 'fms'
  fleet_id     TEXT REFERENCES fleet(id),
  plate        TEXT NOT NULL,
  captured_at  TIMESTAMPTZ NOT NULL,
  lat          DOUBLE PRECISION,
  lng          DOUBLE PRECISION,
  speed        DOUBLE PRECISION,
  heading      INT,
  ignition     BOOLEAN,
  engine       TEXT,
  status       TEXT,                   -- Active | Engaged | Moving | Idle | Stopped
  seat_occupied BOOLEAN,
  fuel_level   DOUBLE PRECISION,
  ac_on        BOOLEAN,
  odometer     DOUBLE PRECISION,
  polled_at    TIMESTAMPTZ DEFAULT now(),   -- when the collector last observed this fix (advances every poll)
  raw          JSONB,
  UNIQUE (source, plate, captured_at)
);
-- keep existing installs in sync (CREATE TABLE IF NOT EXISTS won't add new columns)
ALTER TABLE telemetry_snapshot ADD COLUMN IF NOT EXISTS polled_at TIMESTAMPTZ DEFAULT now();
CREATE INDEX IF NOT EXISTS telem_plate_time_idx ON telemetry_snapshot (plate, captured_at DESC);
CREATE INDEX IF NOT EXISTS telem_polled_idx     ON telemetry_snapshot (source, polled_at DESC);

-- ---------------------------------------------------------------------------
-- ETL bookkeeping: run log + incremental watermarks / cursors
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS collection_run (
  id           BIGSERIAL PRIMARY KEY,
  source       TEXT NOT NULL,
  fleet_id     TEXT,
  mode         TEXT,                   -- backfill | catchup | incremental | realtime
  window_start DATE,
  window_end   DATE,
  started_at   TIMESTAMPTZ DEFAULT now(),
  finished_at  TIMESTAMPTZ,
  status       TEXT,                   -- ok | partial | error
  rows_written INT DEFAULT 0,
  error        TEXT
);

CREATE TABLE IF NOT EXISTS source_state (
  source     TEXT NOT NULL,
  fleet_id   TEXT NOT NULL DEFAULT '-',
  key        TEXT NOT NULL,            -- e.g. 'high_watermark' | 'backfilled_through'
  value      TEXT,
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (source, fleet_id, key)
);

-- ---------------------------------------------------------------------------
-- Settings / credential store (edited from the dashboard Settings page).
-- Secret values are stored AES-256-GCM encrypted (see src/settings.js).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_setting (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  is_secret  BOOLEAN DEFAULT false,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Occupancy segments: seat-sensor derived "someone was aboard" intervals, and
-- whether a booking on any revenue channel explains them (see src/reconcile.js).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS occupancy_segment (
  plate            TEXT NOT NULL,
  started_at       TIMESTAMPTZ NOT NULL,
  ended_at         TIMESTAMPTZ,
  fleet_id         TEXT,
  duration_min     INT,
  distance_km      DOUBLE PRECISION,
  top_speed        DOUBLE PRECISION,
  fixes            INT,
  max_gap_min      INT,
  ignition_ratio   DOUBLE PRECISION,
  start_lat        DOUBLE PRECISION, start_lng DOUBLE PRECISION,
  end_lat          DOUBLE PRECISION, end_lng   DOUBLE PRECISION,
  verdict          TEXT,          -- authorized | unauthorized | sensor_suspect | partial | stationary
  matched_platform TEXT,
  matched_trip_id  TEXT,
  low_confidence   BOOLEAN DEFAULT false,
  unavailable_sources TEXT,
  ingested_at      TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (plate, started_at)
);
CREATE INDEX IF NOT EXISTS occ_verdict_idx ON occupancy_segment (verdict, started_at DESC);
CREATE INDEX IF NOT EXISTS occ_started_idx ON occupancy_segment (started_at DESC);
