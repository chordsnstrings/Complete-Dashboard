-- A queue of one is not a queue.
--
-- On-demand collector runs were a single row in source_state: the API wrote
-- `trigger = 'backfill'`, the collector polled for it, ran it, and deleted it.
-- Ask for two things and the second overwrites the first — silently, and with
-- the API answering `{ok: true, queued: "backfill"}` to a request that was
-- about to be discarded. That is exactly what happened when a backfill and a
-- probe were requested seconds apart: only the probe ran, the backfill was
-- never attempted, and nothing anywhere said so. An hour was spent waiting for
-- a job that had been thrown away before it started.
--
-- A row per request, with a lifecycle. Nothing is lost, a duplicate request is
-- refused rather than silently merged, and what is pending is readable.
CREATE TABLE IF NOT EXISTS collector_job (
  id           BIGSERIAL PRIMARY KEY,
  mode         TEXT NOT NULL,           -- backfill | incremental | analyst | probe
  status       TEXT NOT NULL DEFAULT 'queued',   -- queued | running | done | failed
  requested_by TEXT,
  requested_at TIMESTAMPTZ DEFAULT now(),
  started_at   TIMESTAMPTZ,
  finished_at  TIMESTAMPTZ,
  error        TEXT
);

CREATE INDEX IF NOT EXISTS job_pending_idx ON collector_job (status, requested_at)
  WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS job_recent_idx ON collector_job (requested_at DESC);

COMMENT ON TABLE collector_job IS
  'On-demand collector runs, one row per request. Replaces a single source_state key that silently discarded a request whenever two arrived close together.';

-- Carry over anything still sitting in the old single-slot trigger, so a
-- request made just before this deploy is not the last one to be lost.
DO $$
DECLARE pending TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_once WHERE name = 'v14_trigger_to_queue') THEN
    SELECT value INTO pending FROM source_state
      WHERE source = 'collector' AND fleet_id = '-' AND key = 'trigger';
    IF pending IS NOT NULL AND pending <> '' THEN
      INSERT INTO collector_job (mode, requested_by) VALUES (pending, 'migrated from source_state');
      DELETE FROM source_state WHERE source = 'collector' AND fleet_id = '-' AND key = 'trigger';
    END IF;
    INSERT INTO schema_once (name) VALUES ('v14_trigger_to_queue');
  END IF;
END $$;
