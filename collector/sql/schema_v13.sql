-- Who is on the roster, per platform, and whether they are actually earning.
--
-- Four providers report a driver's standing and the dashboard joined none of
-- them: Uber returns an `onboardingStatus` with values including
-- ONBOARDING_STATUS_WAITLIST, Bolt returns `state` (active / suspended /
-- deactivated) with a suspension reason and a driver score, Yango returns a
-- state on its driver summary, and the corporate channel returns a
-- currentStatus on every booking. Each lived in a different table, or in a raw
-- payload, or — in Uber's case — was discarded at the door, because the live
-- poller kept only drivers who already had a vehicle attached, which is exactly
-- the filter that removes everyone still waiting to start.
--
-- The question an operator has is not answerable from any one of them:
--   recruited but never activated?     -> a waitlist state with no trips ever
--   on the roster and earning nothing? -> an active state with no trips this month
--   suspended while holding a car?     -> a suspended state with a vehicle attached
--
-- One row per person per platform. `state` is normalised; `state_raw` keeps the
-- provider's own word, because "deactivated" and "suspended" are not the same
-- thing to the person they describe and the distinction must survive.
CREATE TABLE IF NOT EXISTS driver_platform_state (
  platform       TEXT NOT NULL,
  driver_ext_id  TEXT NOT NULL,
  fleet_id       TEXT,
  full_name      TEXT,
  state          TEXT,        -- active | waitlist | onboarding | suspended | deactivated | inactive | unknown
  state_raw      TEXT,        -- the provider's own word for it
  state_reason   TEXT,
  vehicle_ext_id TEXT,
  plate          TEXT,
  score          DOUBLE PRECISION,
  can_earn       BOOLEAN,     -- does this state permit taking work at all?
  observed_at    TIMESTAMPTZ DEFAULT now(),
  raw            JSONB,
  PRIMARY KEY (platform, driver_ext_id)
);

CREATE INDEX IF NOT EXISTS dps_state_idx ON driver_platform_state (state);
CREATE INDEX IF NOT EXISTS dps_plate_idx ON driver_platform_state (plate) WHERE plate IS NOT NULL;
CREATE INDEX IF NOT EXISTS dps_name_idx  ON driver_platform_state (lower(full_name));

COMMENT ON TABLE driver_platform_state IS
  'One row per driver per platform: the standing each provider reports, normalised, with the provider''s own word kept alongside. This is the only place the supply pipeline — recruited, waiting, active, suspended — is visible at all.';
COMMENT ON COLUMN driver_platform_state.can_earn IS
  'Whether this state permits taking work. A driver who cannot earn and has no trips is not idle; a driver who CAN earn and has no trips is.';
