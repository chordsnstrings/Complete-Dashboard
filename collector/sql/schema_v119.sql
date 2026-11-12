-- ════════════════════════════════════════════════════════════════════════
-- v119 — TWO DAY ROLL-UPS FOR THE HERO SPARKLINES, AND WHEN THEY WERE BUILT
-- (2026-11-12)
-- ════════════════════════════════════════════════════════════════════════
-- /api/history (api/history_routes.js) answers, in ONE request, the daily or
-- weekly series behind a page's hero tile, and it reads them only from tables
-- the collector refreshes — never by re-aggregating the raw feeds on a page
-- load. Two of the series the redesign plan asks for had no such table:
--
--   #online-time "Late"  (docs/UI-REDESIGN-PLAN.md, #online-time: "The Late
--        sparkline … needs one /api/online-time request per day (15 per page
--        load), or a history endpoint that does not exist"). The page's Late
--        is a count of PEOPLE whose first ONLINE transition on Uber's
--        timeline came after the viewer's expected start. The start is the
--        viewer's own (localStorage, default 06:00), so a stored count would
--        answer for one start time only. What can be stored is the instant
--        each account first came online each Dubai day — then Late for ANY
--        start is a comparison at read time. driver_online_hour (v106) does
--        not hold it: its spans merge ONLINE heartbeats with job spans
--        (api/online_span_sql.js), so its first minute can be a trip's start,
--        and /api/online-time reads the first ONLINE *status event* only.
--        Two definitions of "came online" on one page would disagree.
--
--   #deposits "Ceiling on cash outstanding" and "Drivers carrying a ceiling"
--        (plan, #deposits, not adopted: "the payload holds no series for
--        it"). Both are running totals of every cash fare on record, summed
--        live from the trip_cash view (v80) by /api/ledger/exposure. Their
--        history is that same sum cut at the end of each past week, and that
--        needs cash fares by day.
--
-- Both are built by src/history_rollup.js inside the ordinary rollup pass
-- (src/rollup.js refreshRollupsInner): the last 14 days every quarter hour and
-- after each collection, everything at boot and nightly at 22:40.
--
--   driver_first_online   one row per Uber account per Dubai day it came
--                         online: min(at) over driver_timeline_event rows with
--                         kind 'status' and status 'ONLINE' on that day —
--                         exactly the `first_at` /api/online-time computes
--                         for one day (api/online_routes.js, STAGE TWO).
--   cash_fare_day         one row per account per channel per Dubai day it
--                         took cash: trip_cash rows (completed, driver holds
--                         cash), how many, how many carry a value, and the
--                         sum of cash_amount — the same column
--                         /api/ledger/exposure sums into owes.cash_taken.
--                         `value` is NULL, never 0, when no trip that day
--                         carries an amount: an unvalued cash trip is not a
--                         dirham-zero trip, and the exposure read treats a
--                         person with only unvalued trips as carrying no
--                         ceiling (sum() over nulls is NULL there too).
--   history_rollup_build  one row per roll-up above: the instant its pass
--                         READ the source (the database's now() as it
--                         began), and the first day it has been built back
--                         to. A narrow pass rebuilds from its own first day,
--                         so built_from only ever moves back; a full pass
--                         writes 1900-01-01. The route judges a day "built"
--                         from these — the same reason v107 exists: an empty
--                         or half-built table must never read as a day when
--                         nobody came online, or a week with no cash.
--
-- Kept, not pruned: a row per account-day is small (production holds about
-- 160 Uber accounts and 62,000 cash trips in two years) and the point is the
-- history. Late-arriving changes older than 14 days — Uber's weekly payments
-- report re-pricing a cash trip months later, which changes cash_amount — are
-- caught by the nightly full pass, so the table can trail the live view by
-- less than a day; docs/COVERAGE.md records it as a trap.
CREATE TABLE IF NOT EXISTS driver_first_online (
  platform         TEXT        NOT NULL DEFAULT 'uber',
  driver_ext_id    TEXT        NOT NULL,
  day              DATE        NOT NULL,          -- Dubai calendar day
  fleet_id         TEXT,                          -- the fleet of that first ONLINE event
  first_online_at  TIMESTAMPTZ NOT NULL,
  computed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, driver_ext_id, day)
);
CREATE INDEX IF NOT EXISTS dfo_day_idx ON driver_first_online (day);

COMMENT ON TABLE driver_first_online IS
  'The first ONLINE status event of each Uber account on each Dubai day (min(at) over driver_timeline_event, kind status, status ONLINE) — the first_at /api/online-time computes per day. Written by src/history_rollup.js refreshFirstOnline; read by /api/history for the #online-time Late series. Not driver_online_hour: those spans merge job spans in.';

CREATE TABLE IF NOT EXISTS cash_fare_day (
  platform       TEXT        NOT NULL,
  driver_ext_id  TEXT        NOT NULL,
  day            DATE        NOT NULL,            -- Dubai calendar day of requested_at
  fleet_id       TEXT,
  trips          INT         NOT NULL,            -- trip_cash rows
  valued         INT         NOT NULL,            -- of which cash_amount is known
  value          NUMERIC,                         -- sum(cash_amount); NULL when none is known
  computed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, driver_ext_id, day)
);
CREATE INDEX IF NOT EXISTS cfd_day_idx ON cash_fare_day (day);
CREATE INDEX IF NOT EXISTS cfd_driver_idx ON cash_fare_day (driver_ext_id);

COMMENT ON TABLE cash_fare_day IS
  'Cash fares by account, channel and Dubai day, from the trip_cash view (v80): count, how many carry a value, and sum(cash_amount) — the column /api/ledger/exposure sums into owes.cash_taken. value is NULL when no trip that day carries an amount. Written by src/history_rollup.js refreshCashFareDay; read by /api/history for the #deposits ceiling series.';

CREATE TABLE IF NOT EXISTS history_rollup_build (
  name         TEXT        PRIMARY KEY,           -- driver_first_online | cash_fare_day
  read_at      TIMESTAMPTZ NOT NULL,              -- the instant the pass read its source
  built_from   DATE        NOT NULL,              -- first day built back to; 1900-01-01 = all
  finished_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE history_rollup_build IS
  'When each of the v119 roll-ups was last built: the instant its pass read the source, and how far back it has been built. /api/history judges a day built from this, so an empty or half-built table is never read as a day with nobody online or a week with no cash.';
