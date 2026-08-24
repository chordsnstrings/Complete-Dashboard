-- The components carry the same run-stamp wound the payouts carried.
--
-- driver_earnings_component rows were stamped with the window of the RUN that
-- fetched them — a three-day incremental, a month-long catchup, a year-long
-- backfill — because the REST payments surface aggregates whatever range it is
-- asked and the ask WAS the run. schema_v24 established the law for
-- driver_performance; the same law applies here: the collector now asks in
-- Monday-anchored calendar weeks, so a stored period longer than a week is one
-- of the old mis-stamped asks. The day resolution in src/rollup.js would
-- otherwise hand such a row every day nothing honest covers — a year-long
-- total spread thin across months of on-trip revenue.
--
-- Shorter-than-week rows stay: a three-day ask is a true observation of three
-- days, and the finest-window-wins resolution already prefers it correctly.
-- The next collection re-fetches the weeks the surface still serves.
DELETE FROM driver_earnings_component
WHERE period_end - period_start > 6;
