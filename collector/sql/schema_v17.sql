-- v17: say which source a running collection is actually on.
--
-- A backfill runs eight sources in sequence and one of them (FMS telematics,
-- 130 vehicles x twelve monthly windows) takes four and a half hours. The job
-- row said 'running' for that whole time and nothing anywhere said which step
-- it was on, so a job making steady progress and a job wedged on a dead socket
-- looked identical. That ambiguity is what hid a real bug for weeks: the
-- backfill was restarting from source one on every deploy and never reaching
-- the source with the hole in it.
ALTER TABLE collector_job ADD COLUMN IF NOT EXISTS progress JSONB;
COMMENT ON COLUMN collector_job.progress IS
  'Which source this run is on right now, how many of the sequence are done, and which are still to come. Written before each source starts, so a long step is visible while it is running rather than only after it ends.';
