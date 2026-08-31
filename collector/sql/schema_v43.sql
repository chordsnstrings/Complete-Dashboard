-- ---------------------------------------------------------------------------
-- collector_checkpoint — what a job has already finished, so a restart resumes
-- ---------------------------------------------------------------------------
-- A backfill on this deployment can never finish, and the reason is structural
-- rather than a bug in any source.
--
-- The collector runs as an App Platform worker. A worker restarts whenever the
-- app is deployed, and a backfill takes hours: Uber alone is twelve monthly
-- report windows, each of which costs minutes at the provider. src/index.js
-- requeues any job left 'running' at boot — correctly, since a process that has
-- just started cannot own anything in flight — but runWindowInner then starts
-- at the first source and the first window every time. The work already done is
-- redone, and the run dies at roughly the same elapsed point it died before.
--
-- Production shows exactly that. Job 8 restarted five times, reached window 7
-- of 12 on each attempt, and was abandoned with "restarted three times without
-- completing a single source or collection window". The abandon rule was right:
-- `steps` really was 7 on the attempt before, and 7 again. A job that redoes the
-- same six windows has genuinely not advanced, however much work it did.
--
-- Reordering the sources so the most-broken one runs first (see the note at the
-- top of src/run.js) made the first hours count for something. It did not make
-- the run finish, because nothing was remembered between attempts.
--
-- So finished units are recorded here as they complete, and a run skips what it
-- finds. Keyed on the JOB, deliberately:
--
--   a requeued job keeps its id, so it resumes;
--   a newly requested backfill is a new id, so it collects afresh — which is
--   what somebody asking for a backfill means, and what makes a re-run a way to
--   repair a window that was collected wrongly rather than a no-op.
--
-- Every collector write is already an upsert, so a checkpoint that is lost or
-- written twice costs time and never correctness.

CREATE TABLE IF NOT EXISTS collector_checkpoint (
  job_id      BIGINT NOT NULL,
  -- The source's key in run.js's HISTORICAL map: 'uber', 'fms', …
  source      TEXT NOT NULL,
  -- The unit finished. A window's own name ('2026-01-26..2026-02-25') for a
  -- source that walks windows, and '' for the source as a whole — so "uber is
  -- done" and "this window of uber is done" are the same kind of fact and are
  -- asked the same way.
  window_key  TEXT NOT NULL DEFAULT '',
  rows        INT,
  finished_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (job_id, source, window_key)
);

-- Read once per run, per source, as "what may I skip".
CREATE INDEX IF NOT EXISTS collector_checkpoint_job_idx
  ON collector_checkpoint (job_id, source);
