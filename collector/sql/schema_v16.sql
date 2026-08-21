-- How many times a job has been picked up.
--
-- The collector restarts on every deploy, and a job in flight dies with it —
-- leaving the row at 'running' forever while the work it was doing was never
-- finished. Any job found running at boot is stranded by definition, so it is
-- requeued immediately; this column is what stops that becoming a loop when the
-- job itself is what kills the container.
ALTER TABLE collector_job ADD COLUMN IF NOT EXISTS attempts INT DEFAULT 0;

COMMENT ON COLUMN collector_job.attempts IS
  'Times this job has been claimed. A job requeued three times after dying mid-run is marked failed rather than retried forever.';
