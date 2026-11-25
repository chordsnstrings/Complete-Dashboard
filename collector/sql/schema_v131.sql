-- schema_v131 — the three fixes the audit of 2026-11-25 asked for, their storage
-- ---------------------------------------------------------------------------
-- 1. telem_plate_polled_idx. The stale-tracker insight picks each plate's
--    newest-POLLED row (src/insights.js staleTelemetry). It was a DISTINCT ON
--    over the whole table sorted by (plate, polled_at DESC) — an order no index
--    had — and hit the 120 s statement timeout on every run. With this index it
--    is one probe per plate.
CREATE INDEX IF NOT EXISTS telem_plate_polled_idx ON telemetry_snapshot (plate, polled_at DESC);

-- 2. cash_fare_day.fare_only. /api/ledger/exposure now reads settled days of
--    cash fares from cash_fare_day (sql/schema_v119.sql) instead of scanning
--    trip twice through the trip_cash view (103 s on production). Its
--    `collected` term also counts the trips valued only by their fare
--    (cash_basis 'fare_only'), which the day table did not carry. NULL on rows
--    built before this file; the route uses the table only once a full pass
--    has filled it (history_rollup_build 'cash_fare_day:fare_only').
ALTER TABLE cash_fare_day ADD COLUMN IF NOT EXISTS fare_only INT;

-- 3. coverage_day. /api/coverage counted trip, driver_timeline_event,
--    telemetry_snapshot and alert in full, grouped by day, on every call
--    (18 s average, 94 s at worst, 147 times in 18 hours). Kept per dataset,
--    fleet and Dubai day by src/coverage_rollup.js; the route sums it.
--    dataset: trip:<platform> | timeline:<platform> | telemetry:<source> | alerts
--    with_a / with_b: trip pickup / drop-off coordinates; timeline coordinates.
--    min_ts / max_ts: first and last timestamp the day holds (for telemetry,
--    min captured_at and max polled_at); min_b: telemetry's first polled_at.
--    day 0001-01-01 holds the rows whose timestamp is NULL.
CREATE TABLE IF NOT EXISTS coverage_day (
  dataset      text        NOT NULL,
  fleet_id     text        NOT NULL DEFAULT '',
  day          date        NOT NULL,
  rows         int         NOT NULL,
  with_a       int,
  with_b       int,
  min_ts       timestamptz,
  max_ts       timestamptz,
  min_b        timestamptz,
  computed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dataset, fleet_id, day)
);
