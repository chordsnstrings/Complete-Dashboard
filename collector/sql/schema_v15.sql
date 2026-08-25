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

-- The purge runs BEFORE the indexes, and unconditionally — both the hard way.
--
-- This file originally created the indexes first and guarded the purge behind
-- schema_once. A migration file is one implicit transaction: the index failed
-- on the duplicates it was meant to prevent, the whole file rolled back —
-- purge included — and the guard meant nothing because the INSERT rolled back
-- with it. Result: "could not create unique index insight_nullwindow_uniq" on
-- every boot since this file shipped, no index, and the duplicate verdicts it
-- describes still accumulating forty-eight a day in production while the
-- migration that fixes them reported having tried.
--
-- Deleting older copies is idempotent, so it needs no run-once guard: on a
-- database already deduped it deletes nothing.
-- Written as an anti-join against the survivors, NOT as a self-join.
--
-- The original was `DELETE FROM insight a USING insight b`, which is a
-- quadratic comparison: thirty thousand rows is nine hundred million pairs,
-- and it hit the two-minute statement timeout without ever finishing. It
-- therefore failed on EVERY boot since this file shipped — burning two of the
-- five minutes a deploy spent answering 503, and never deduplicating anything,
-- which is why the unique indexes below could never be created either.
--
-- DISTINCT ON picks the survivor with one sort, exactly the row the read path
-- already selects, and the delete removes what is not in that set. Same
-- outcome, O(n log n) instead of O(n squared).
--
-- The tiebreak is computed_at DESC then id DESC, matching schema_v31's purge,
-- so the two cannot disagree about which copy survives.
WITH keep AS (
  SELECT DISTINCT ON (code, entity_type, entity_id) id
    FROM insight
   WHERE (window_start IS NULL AND window_end IS NULL) OR entity_type = 'fleet'
   ORDER BY code, entity_type, entity_id, computed_at DESC, id DESC
)
DELETE FROM insight i
 WHERE ((i.window_start IS NULL AND i.window_end IS NULL) OR i.entity_type = 'fleet')
   AND NOT EXISTS (SELECT 1 FROM keep k WHERE k.id = i.id);

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


