-- v2: enrichment + actionable-insight layer.
-- Additive only; safe to re-run.

/* ── trip enrichment (discovered fields we were dropping) ─────────────── */
ALTER TABLE trip ADD COLUMN IF NOT EXISTS deadhead_km    DOUBLE PRECISION; -- driver approach distance before pickup
ALTER TABLE trip ADD COLUMN IF NOT EXISTS cost           NUMERIC(12,2);    -- cost side (hotel)
ALTER TABLE trip ADD COLUMN IF NOT EXISTS margin         NUMERIC(12,2);    -- computedPrice - cost
ALTER TABLE trip ADD COLUMN IF NOT EXISTS hours          DOUBLE PRECISION; -- billed hours (hourly jobs)
ALTER TABLE trip ADD COLUMN IF NOT EXISTS zone           TEXT;
ALTER TABLE trip ADD COLUMN IF NOT EXISTS partner_id     TEXT;             -- hotel/property id
ALTER TABLE trip ADD COLUMN IF NOT EXISTS partner_name   TEXT;
ALTER TABLE trip ADD COLUMN IF NOT EXISTS is_scheduled   BOOLEAN;
ALTER TABLE trip ADD COLUMN IF NOT EXISTS is_missing     BOOLEAN;          -- hotel isMissingTrip
ALTER TABLE trip ADD COLUMN IF NOT EXISTS driver_own     BOOLEAN;          -- self-managed ride
ALTER TABLE trip ADD COLUMN IF NOT EXISTS authorized     TEXT;             -- authorization / operatorApproval
ALTER TABLE trip ADD COLUMN IF NOT EXISTS surge_or_promo NUMERIC(12,2);
CREATE INDEX IF NOT EXISTS trip_partner_idx ON trip (partner_id);
CREATE INDEX IF NOT EXISTS trip_zone_idx    ON trip (zone);

/* ── driver compliance & identity (licence expiry = hard operational risk) ── */
CREATE TABLE IF NOT EXISTS driver_compliance (
  platform        TEXT NOT NULL,
  driver_ext_id   TEXT NOT NULL,
  fleet_id        TEXT,
  full_name       TEXT,
  phone           TEXT,
  emirates_id     TEXT,
  licence_no      TEXT,
  licence_expires DATE,
  state           TEXT,                 -- active / suspended / deactivated / offline
  suspension_reason TEXT,
  rating          DOUBLE PRECISION,
  device_brand    TEXT,
  device_model    TEXT,
  raw             JSONB,
  updated_at      TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (platform, driver_ext_id)
);
CREATE INDEX IF NOT EXISTS compliance_expiry_idx ON driver_compliance (licence_expires);

/* ── per-vehicle utilisation from platform analytics (Uber vs:vehicle) ──── */
CREATE TABLE IF NOT EXISTS vehicle_utilisation (
  platform      TEXT NOT NULL,
  vehicle_ext_id TEXT NOT NULL,
  plate         TEXT,
  fleet_id      TEXT,
  period_start  DATE NOT NULL,
  period_end    DATE NOT NULL,
  trips         INT,
  hours_online  DOUBLE PRECISION,
  hours_on_job  DOUBLE PRECISION,
  hours_on_trip DOUBLE PRECISION,
  hours_to_trip DOUBLE PRECISION,
  hours_available DOUBLE PRECISION,
  utilisation   DOUBLE PRECISION,       -- 0..1 (share of online time actually earning)
  earnings      NUMERIC(12,2),
  earnings_per_hour NUMERIC(12,2),
  trips_per_online_hour DOUBLE PRECISION,
  acceptance_rate DOUBLE PRECISION,
  incentive_target TEXT,
  incentive_completed TEXT,
  incentive_status TEXT,
  raw           JSONB,
  PRIMARY KEY (platform, vehicle_ext_id, period_start, period_end)
);

/* ── external context: weather (demand + risk driver) ──────────────────── */
CREATE TABLE IF NOT EXISTS weather_daily (
  day            DATE PRIMARY KEY,
  temp_max       DOUBLE PRECISION,
  temp_min       DOUBLE PRECISION,
  precipitation  DOUBLE PRECISION,
  wind_max       DOUBLE PRECISION,
  is_forecast    BOOLEAN DEFAULT false,
  raw            JSONB,
  updated_at     TIMESTAMPTZ DEFAULT now()
);

/* ── external context: calendar (holidays / Hijri months shift demand) ─── */
CREATE TABLE IF NOT EXISTS calendar_day (
  day          DATE PRIMARY KEY,
  hijri_date   TEXT,
  hijri_month  TEXT,
  is_ramadan   BOOLEAN DEFAULT false,
  is_holiday   BOOLEAN DEFAULT false,
  holiday_name TEXT,
  sunrise      TIMESTAMPTZ,
  sunset       TIMESTAMPTZ
);

/* ── the actionable-insight ledger ─────────────────────────────────────── */
CREATE TABLE IF NOT EXISTS insight (
  id           BIGSERIAL PRIMARY KEY,
  code         TEXT NOT NULL,           -- stable machine key, e.g. 'idle_vehicle'
  severity     TEXT NOT NULL,           -- critical | warning | info | good
  category     TEXT NOT NULL,           -- revenue | cost | safety | compliance | utilisation | demand | data
  entity_type  TEXT,                    -- vehicle | driver | fleet | platform | partner
  entity_id    TEXT,
  title        TEXT NOT NULL,           -- one-line, human
  detail       TEXT,                    -- the evidence, in words
  action       TEXT,                    -- what to DO about it
  impact_aed   NUMERIC(14,2),           -- estimated money at stake (nullable)
  metric       DOUBLE PRECISION,
  fleet_id     TEXT,
  window_start DATE,
  window_end   DATE,
  computed_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE (code, entity_type, entity_id, window_start, window_end)
);
CREATE INDEX IF NOT EXISTS insight_sev_idx ON insight (severity, category, computed_at DESC);
