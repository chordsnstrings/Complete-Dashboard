-- A run that wrote rows is not the same as a run that worked.
--
-- The Uber collector chunks a backfill into twelve monthly windows. When nine
-- of them fail — a report that times out, a session that expired, a range past
-- retention — the tenth still writes rows, and `collection_run` records
-- `status='ok', rows_written=1129`. That is what the Data sources page showed
-- for months while the trip history had a 299-day hole in it. The run-level
-- status hid the chunk-level failure, so the only way to find the hole was to
-- count rows per day and notice.
--
-- A run now records how many windows it attempted, how many failed, and which
-- ones — so "ok" means every window landed, and anything else says so.
ALTER TABLE collection_run ADD COLUMN IF NOT EXISTS chunks_total  INT;
ALTER TABLE collection_run ADD COLUMN IF NOT EXISTS chunks_failed INT;
ALTER TABLE collection_run ADD COLUMN IF NOT EXISTS detail        JSONB;

COMMENT ON COLUMN collection_run.status IS
  'ok = every window this run attempted landed. partial = at least one window failed while others succeeded, which still leaves a hole. error = the run did not complete. A source with rows_written > 0 and status=partial is the shape that hid a 299-day gap.';
COMMENT ON COLUMN collection_run.detail IS
  'Per-window outcome: [{from, to, rows, error}]. The dates of the windows that failed are what make a gap fixable rather than merely visible.';

CREATE INDEX IF NOT EXISTS run_source_finished_idx ON collection_run (source, finished_at DESC);
