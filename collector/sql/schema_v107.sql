-- ════════════════════════════════════════════════════════════════════════
-- v107 — WHAT THE HOUR-BY-HOUR STORE HAS BEEN BUILT FROM (2026-10-14)
-- ════════════════════════════════════════════════════════════════════════
-- driver_online_hour (v106) holds only what a rollup pass has built, and
-- /api/online/hours judged an hour "recorded" by the TIMELINE's last run. On
-- production straight after v106 deployed, 13 October answered "recorded" for
-- all 24 hours, 0 drivers, "no Uber account was recorded online on this day":
-- the table was still empty. The same false zero would recur every cycle for
-- the hours between a timeline run and the next pass, and for every day a
-- narrow (14-day) pass had not reached before the first nightly full pass.
--
-- One row, rewritten by every pass (src/rollup.js refreshOnlineHours):
--
--   read_at      the instant the pass's statements read driver_timeline_event
--                (the database's now() when it began). An hour is recorded
--                only up to the last uber_timeline run that finished before it.
--   built_from   the first Dubai day the table is built back to. A narrow
--                pass rebuilds from its own first day and leaves older days as
--                an earlier pass built them, so this only ever moves back;
--                a full pass builds all of history and writes 1900-01-01.
--   built_to     the last day with an hour in the table, for the status page.
--
-- Not in rollup_state: that table's rows are passes, read as such by the
-- status listing and by test/rollup.test.mjs, and a pass's row says
-- 'running' — with its old started_at gone — for as long as the pass runs.
CREATE TABLE IF NOT EXISTS driver_online_hour_build (
  id          boolean PRIMARY KEY DEFAULT true CHECK (id),
  read_at     timestamptz NOT NULL,
  built_from  date NOT NULL,
  built_to    date,
  finished_at timestamptz NOT NULL DEFAULT now()
);
