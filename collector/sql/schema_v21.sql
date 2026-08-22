-- ── precomputed rollups, so a page is not an aggregate over all history ──────
--
-- Four endpoints took between six and fourteen seconds, and they share a shape:
-- they aggregate the ENTIRE trip history with no window at all. /api/trend/
-- monthly groups every trip ever collected by month; /api/forecast does the
-- same and then again by day; /api/retention groups every booking by person and
-- month. There is no window to narrow them and no index that helps, because the
-- answer genuinely depends on every row.
--
-- But the answer is also the same for every viewer, and it only changes when
-- the collector writes. Recomputing it per request is the whole cost. So it is
-- computed once, in the background, after each collection run — src/rollup.js.
--
-- Grain matters more than it looks. A COUNT DISTINCT cannot be summed: rolling
-- days up into a month would count a driver who worked twenty days as twenty
-- drivers, and summing per-platform rows would count one human on Uber and
-- Yango as two — which is the exact bug the person fold exists to prevent. So
-- each grain that a page actually asks for is stored at that grain, with its
-- distinct counts computed there.
--
-- '*' means "every platform" / "every fleet", as a stored row rather than a sum
-- over the others. Deliberately a sentinel and not NULL: a UNIQUE constraint in
-- Postgres is NULLS DISTINCT by default, so (2026-08, NULL, NULL) would not
-- conflict with itself and ON CONFLICT would insert a duplicate every refresh.

CREATE TABLE IF NOT EXISTS rollup_month (
  month        DATE NOT NULL,             -- first day of the month, Dubai
  platform     TEXT NOT NULL DEFAULT '*',
  fleet_id     TEXT NOT NULL DEFAULT '*',
  trips             INT,                  -- every row, bookings and telematics
  bookings          INT,
  telematics        INT,
  drivers           INT,                  -- distinct PEOPLE, folded
  vehicles          INT,                  -- distinct plates on ANY row
  earning_vehicles  INT,                  -- distinct plates on a BOOKING
  attributed_trips  INT,                  -- bookings that name a platform driver id
  revenue           NUMERIC(14,2),
  priced_trips      INT,
  km                NUMERIC(14,1),
  measured_trips    INT,
  completed         INT,
  not_completed     INT,
  outcome_n         INT,
  first_day         DATE,
  last_day          DATE,
  platforms         TEXT[],
  booking_platforms TEXT[],
  computed_at  TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (month, platform, fleet_id)
);

CREATE TABLE IF NOT EXISTS rollup_day (
  day          DATE NOT NULL,
  platform     TEXT NOT NULL DEFAULT '*',
  fleet_id     TEXT NOT NULL DEFAULT '*',
  trips             INT,
  bookings          INT,
  telematics        INT,
  drivers           INT,
  vehicles          INT,
  earning_vehicles  INT,
  attributed_trips  INT,
  revenue           NUMERIC(14,2),
  priced_trips      INT,
  km                NUMERIC(14,1),
  measured_trips    INT,
  completed         INT,
  not_completed     INT,
  outcome_n         INT,
  computed_at  TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (day, platform, fleet_id)
);

-- Retention asks "who was active in which month", which is a per-person grain
-- and cannot come from either table above.
CREATE TABLE IF NOT EXISTS rollup_person_month (
  person_key    TEXT NOT NULL,
  month         DATE NOT NULL,
  name          TEXT,
  driver_ext_id TEXT,
  bookings      INT,
  revenue       NUMERIC(14,2),
  km            NUMERIC(14,1),
  platforms     TEXT[],
  computed_at   TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (person_key, month)
);

CREATE INDEX IF NOT EXISTS rollup_month_idx  ON rollup_month (platform, fleet_id, month);
CREATE INDEX IF NOT EXISTS rollup_day_idx    ON rollup_day (platform, fleet_id, day);
CREATE INDEX IF NOT EXISTS rollup_pm_month_idx ON rollup_person_month (month);

/* When each rollup last ran, and over what. A page reading a precomputed answer
   has to be able to say how old it is — a stale number presented as live is
   worse than a slow one, because nothing about it looks wrong. */
CREATE TABLE IF NOT EXISTS rollup_state (
  name         TEXT PRIMARY KEY,
  started_at   TIMESTAMPTZ,
  finished_at  TIMESTAMPTZ,
  rows_written INT,
  duration_ms  INT,
  covers_from  DATE,
  covers_to    DATE,
  status       TEXT,
  error        TEXT
);
