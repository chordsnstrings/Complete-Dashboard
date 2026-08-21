-- v5: compliance documents, platform-issued recommendations, and earnings components.
-- These come from surfaces the first pass missed entirely: getSupplierVehicles carries
-- per-document expiry, getRecommendations is Uber telling us which drivers miss target,
-- and the payments tree carries tips, reimbursements and clawbacks separately from fare.

/* ── vehicle documents: registration, insurance, permits ─────────────────── */
CREATE TABLE IF NOT EXISTS vehicle_document (
  platform      TEXT NOT NULL,
  vehicle_ext_id TEXT NOT NULL,
  doc_type      TEXT NOT NULL,
  plate         TEXT,
  fleet_id      TEXT,
  status        TEXT,
  expires_at    TIMESTAMPTZ,
  raw           JSONB,
  updated_at    TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (platform, vehicle_ext_id, doc_type)
);
CREATE INDEX IF NOT EXISTS vehdoc_expiry_idx ON vehicle_document (expires_at);
CREATE INDEX IF NOT EXISTS vehdoc_plate_idx  ON vehicle_document (plate);

/* ── richer vehicle master (make/model/vin/image/owner/assignment) ───────── */
CREATE TABLE IF NOT EXISTS vehicle_profile (
  platform      TEXT NOT NULL,
  vehicle_ext_id TEXT NOT NULL,
  plate         TEXT,
  fleet_id      TEXT,
  make          TEXT,
  model         TEXT,
  year          INT,
  colour        TEXT,
  colour_hex    TEXT,
  vin           TEXT,
  image_url     TEXT,
  owner_ext_id  TEXT,
  assigned_driver_ext_id TEXT,
  compliance_status TEXT,
  raw           JSONB,
  updated_at    TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (platform, vehicle_ext_id)
);
CREATE INDEX IF NOT EXISTS vehprofile_plate_idx ON vehicle_profile (plate);

/* ── what the platform itself says is wrong ──────────────────────────────── */
-- Uber publishes org-vs-target rates and names the drivers below target. That is a
-- second opinion computed on data we cannot see, so it is worth storing verbatim.
CREATE TABLE IF NOT EXISTS platform_recommendation (
  platform      TEXT NOT NULL,
  rec_type      TEXT NOT NULL,
  rec_uuid      TEXT NOT NULL,
  fleet_id      TEXT,
  period_start  DATE,
  period_end    DATE,
  org_value     DOUBLE PRECISION,
  target_value  DOUBLE PRECISION,
  flagged_count INT,
  flagged       JSONB,          -- [{driver_ext_id, value, ...}]
  raw           JSONB,
  updated_at    TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (platform, rec_type, rec_uuid)
);

/* ── earnings components per driver per period (tips are pure margin) ────── */
CREATE TABLE IF NOT EXISTS driver_earnings_component (
  platform      TEXT NOT NULL,
  driver_ext_id TEXT NOT NULL,
  period_start  DATE NOT NULL,
  period_end    DATE NOT NULL,
  category      TEXT NOT NULL,   -- net_fare | tip | taxes_earnings | cash_collected | ...
  parent        TEXT,            -- earnings | payouts | reimbursements
  amount        NUMERIC(14,2),
  currency      TEXT DEFAULT 'AED',
  driver_name   TEXT,
  fleet_id      TEXT,
  PRIMARY KEY (platform, driver_ext_id, period_start, period_end, category)
);
CREATE INDEX IF NOT EXISTS dec_period_idx ON driver_earnings_component (period_start, period_end);
