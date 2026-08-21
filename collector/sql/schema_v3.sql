-- v3: world events + causal attribution.
-- The point: when a metric breaks, show what was happening in the world at the time,
-- and quantify the coincidence — without pretending correlation is proof.

CREATE TABLE IF NOT EXISTS world_event (
  id           BIGSERIAL PRIMARY KEY,
  source       TEXT NOT NULL,          -- 'seasonal' | 'calendar' | 'news' | 'manual'
  code         TEXT,                   -- stable key for recurring things (e.g. 'summer', 'ramadan')
  title        TEXT NOT NULL,
  category     TEXT,                   -- geopolitical | weather | seasonal | holiday | regulatory | economic | local
  scope        TEXT,                   -- global | regional | uae | dubai
  starts_on    DATE NOT NULL,
  ends_on      DATE,
  expected_effect TEXT,                -- 'demand_up' | 'demand_down' | 'supply_down' | 'risk_up' | 'unknown'
  confidence   DOUBLE PRECISION,       -- 0..1, how sure we are this matters to a Dubai fleet
  url          TEXT,
  summary      TEXT,
  raw          JSONB,
  created_at   TIMESTAMPTZ DEFAULT now(),
  UNIQUE (source, code, starts_on, title)
);
CREATE INDEX IF NOT EXISTS world_event_span_idx ON world_event (starts_on, ends_on);

-- Detected structural breaks in a metric, with the events that overlap them.
CREATE TABLE IF NOT EXISTS metric_break (
  id            BIGSERIAL PRIMARY KEY,
  metric        TEXT NOT NULL,         -- 'trips' | 'revenue' | 'drivers'
  grain         TEXT NOT NULL,         -- 'month' | 'week'
  fleet_id      TEXT,
  platform      TEXT,
  period_from   DATE NOT NULL,
  period_to     DATE NOT NULL,
  value_from    DOUBLE PRECISION,
  value_to      DOUBLE PRECISION,
  change_pct    DOUBLE PRECISION,
  -- supply vs demand decomposition: did output fall because we had fewer drivers,
  -- or because each driver did less?
  drivers_from  INT,
  drivers_to    INT,
  driver_change_pct DOUBLE PRECISION,
  productivity_change_pct DOUBLE PRECISION,
  attribution   TEXT,                  -- 'supply' | 'demand' | 'mixed' | 'unknown'
  candidate_events JSONB,              -- events overlapping the break window
  detected_at   TIMESTAMPTZ DEFAULT now(),
  UNIQUE (metric, grain, platform, period_from, period_to)
);
