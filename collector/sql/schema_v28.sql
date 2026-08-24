-- A collection can now be asked for one fleet.
--
-- Ecosine and Egari are separate businesses with separate credentials on the
-- same providers — two Uber orgs, two Bolt portals — and they fail separately.
-- When a credential is replaced the operator wants to know whether THAT fleet
-- collects now, and making them wait out a full pass over the fleet that was
-- already working is how a five-minute question becomes an hour.
--
-- Null means both, which is what every existing row means and what the
-- schedules will go on asking for.
ALTER TABLE collector_job ADD COLUMN IF NOT EXISTS fleet TEXT;

-- The de-duplication that stops two identical runs queuing at once has to
-- account for it: a backfill for Egari and a backfill for Ecosine are not the
-- same job, and one must not block the other.
DROP INDEX IF EXISTS job_pending_idx;
CREATE INDEX IF NOT EXISTS job_pending_idx ON collector_job (status, mode, fleet, requested_at)
  WHERE status IN ('queued', 'running');
