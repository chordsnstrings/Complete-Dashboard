-- The whole product filters by Dubai calendar day. One table could serve it.
--
-- Every window in this dashboard is a range of Asia/Dubai dates, and the
-- queries say so directly: `(occurred_at AT TIME ZONE 'Asia/Dubai')::date
-- BETWEEN $1 AND $2`. That is a function of the COLUMN, so a plain index on
-- the timestamp cannot answer it — Postgres reads every row and computes the
-- expression to find out which ones match.
--
-- schema_v7 noticed this for `trip` and added trip_local_day_idx. The same
-- predicate is used against alert, telemetry_snapshot, occupancy_segment and
-- ledger_entry — fifteen call sites across the API — and none of them had the
-- matching index, so each of those windowed queries scanned its whole table
-- however narrow the window. On a one-vCPU database sharing its CPU with a
-- backfill that is the difference between a page and a gateway timeout: 52,000
-- alerts and 44,000 telemetry rows read to answer "what happened in the last
-- thirty days".
--
-- These are the indexes that predicate can use, one per table, matching the
-- expression exactly — an index on a DIFFERENT expression for the same column
-- is no index at all.
CREATE INDEX IF NOT EXISTS alert_local_day_idx
  ON alert (((occurred_at AT TIME ZONE 'Asia/Dubai')::date));

CREATE INDEX IF NOT EXISTS telemetry_local_day_idx
  ON telemetry_snapshot (((captured_at AT TIME ZONE 'Asia/Dubai')::date));

CREATE INDEX IF NOT EXISTS occupancy_local_day_idx
  ON occupancy_segment (((started_at AT TIME ZONE 'Asia/Dubai')::date));

CREATE INDEX IF NOT EXISTS ledger_local_day_idx
  ON ledger_entry (((event_at AT TIME ZONE 'Asia/Dubai')::date));

-- And the live-fleet count, which is on every page.
--
-- /api/kpis asks for the newest reading per vehicle:
--
--   SELECT DISTINCT ON (plate) plate, polled_at
--     FROM telemetry_snapshot ORDER BY plate, polled_at DESC
--
-- telemetry_snapshot is indexed on (plate, captured_at DESC) — the time the
-- TRACKER recorded the fix — but this orders by polled_at, the time WE asked.
-- They are different columns and the index cannot serve the sort, so the
-- headline "vehicles live now" figure sorted all 44,000 rows, on every page,
-- on a table that grows by twelve thousand rows per collection cycle.
CREATE INDEX IF NOT EXISTS telemetry_plate_polled_idx
  ON telemetry_snapshot (plate, polled_at DESC);
