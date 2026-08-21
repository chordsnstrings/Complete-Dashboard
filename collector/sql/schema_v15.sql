-- An insight that cannot replace itself is not an insight, it is a log line.
--
-- `insight` was declared UNIQUE (code, entity_type, entity_id, window_start,
-- window_end). Postgres UNIQUE is NULLS DISTINCT by default, and seven of the
-- rules pass window_start and window_end as NULL — idle_vehicle,
-- vehicle_dormant, the licence rules, stale_tracker and the document rules. For
-- those, the conflict target never matched, so every collector run INSERTED a
-- fresh row instead of replacing the previous verdict. The engine runs at the
-- end of every collection, which is every thirty minutes: forty-eight new
-- copies of the same finding per day, per vehicle.
--
-- Live, that produced 2,979 open actions of which 200 were the same rule, and
-- an "estimated cost" tile of AED 1,424,592 that was a run counter multiplied
-- by a constant.
--
-- Two changes: a partial unique index for the NULL-window rules so they upsert
-- like everything else, and a purge of the copies already accumulated.

CREATE UNIQUE INDEX IF NOT EXISTS insight_nullwindow_uniq
  ON insight (code, entity_type, entity_id)
  WHERE window_start IS NULL AND window_end IS NULL;

-- Fleet-level verdicts key on the rule and the entity alone. volume_trend wrote
-- window_start = first observed month and window_end = last, both of which move
-- whenever the observed month set changes — so a new verdict never replaced the
-- old one and two contradictory fleet-wide readings were live at the same time:
-- "down 32%" tagged critical beside "up 18%" tagged good.
CREATE UNIQUE INDEX IF NOT EXISTS insight_fleet_verdict_uniq
  ON insight (code, entity_type, entity_id)
  WHERE entity_type = 'fleet';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_once WHERE name = 'v15_dedupe_insights') THEN
    -- Keep the most recent copy of each finding; delete the rest.
    DELETE FROM insight a USING insight b
    WHERE a.code = b.code
      AND a.entity_type IS NOT DISTINCT FROM b.entity_type
      AND a.entity_id   IS NOT DISTINCT FROM b.entity_id
      AND (
        (a.window_start IS NULL AND a.window_end IS NULL
         AND b.window_start IS NULL AND b.window_end IS NULL)
        OR a.entity_type = 'fleet'
      )
      AND (a.computed_at < b.computed_at
           OR (a.computed_at = b.computed_at AND a.id < b.id));
    INSERT INTO schema_once (name) VALUES ('v15_dedupe_insights');
  END IF;
END $$;
