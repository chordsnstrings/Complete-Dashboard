-- ════════════════════════════════════════════════════════════════════════
-- v106 — UBER: WHO WAS ONLINE, HOUR BY HOUR, KEPT (2026-10-14)
-- ════════════════════════════════════════════════════════════════════════
-- The operator: "we need to show driver online by hour on uber and store it to
-- fetch previous data".
--
-- WHAT EXISTED. Availability lives in driver_timeline_event (sql/schema_v37),
-- Uber's chronicle GetTimelineInfo, collected every 3 hours for the last two
-- days and swept weekly for 30 — and Uber will not answer for anything older
-- than about 31 days. api/online_span_sql.js turns those events into spans,
-- and two things were built from the spans: driver_day.online_min (one number
-- a driver a DAY, src/rollup.js) and /api/supply/balance (a weekday × hour
-- AVERAGE, computed per request and stored nowhere). Neither answers "how
-- many drivers were online at 14:00 last Tuesday", and the second cannot be
-- asked about a date at all.
--
-- WHAT THIS HOLDS. One row per Uber account per Dubai hour it was online in,
-- cut from the SAME spans driver_day.online_min sums — so the 24 hours of a
-- driver's day add up to that day's online_min (to within the rounding of one
-- integer), and a page that shows both cannot disagree with itself. Written by
-- src/rollup.js refreshOnlineHours on every rollup pass (the last 14 days,
-- with three days of events before the bound so a span that opened earlier is
-- still closed by its own events) and in full on the nightly rebuild. Kept: no
-- job deletes from it, so the history outlives Uber's 31-day window — which is
-- the point of storing it.
--
--   online_min  minutes inside this hour the account was online (an ONLINE
--               heartbeat or a job), to two decimals
--   open_min    the part of online_min whose span was closed by OUR bound —
--               the last collection, now, or the day's end — rather than by an
--               event of Uber's: "online as far as we know", not "online until"
--   fleet_id    the fleet of the account's newest timeline event at or before
--               the hour's end (the spans carry no fleet)
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS driver_online_hour (
  platform       TEXT         NOT NULL DEFAULT 'uber',
  driver_ext_id  TEXT         NOT NULL,
  fleet_id       TEXT,
  hour_start     TIMESTAMPTZ  NOT NULL,     -- the instant the Dubai hour began
  day            DATE         NOT NULL,     -- its Dubai calendar day
  hour           SMALLINT     NOT NULL CHECK (hour BETWEEN 0 AND 23),
  online_min     NUMERIC(6,2) NOT NULL CHECK (online_min > 0 AND online_min <= 60.01),
  open_min       NUMERIC(6,2) NOT NULL DEFAULT 0,
  computed_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, driver_ext_id, hour_start)
);

-- The two reads: one day's 24 hours (or a range of days) for the fleet, and
-- one fleet's days.
CREATE INDEX IF NOT EXISTS doh_day_hour_idx ON driver_online_hour (day, hour);
CREATE INDEX IF NOT EXISTS doh_fleet_day_idx ON driver_online_hour (fleet_id, day);

COMMENT ON TABLE driver_online_hour IS
  'Uber availability per account per Dubai hour, cut from the spans driver_day.online_min sums (api/online_span_sql.js). Written by src/rollup.js refreshOnlineHours; never pruned, so it keeps what Uber''s 31-day timeline forgets. open_min is the part closed by our bound (last collection, now, day end) rather than by an Uber event.';
