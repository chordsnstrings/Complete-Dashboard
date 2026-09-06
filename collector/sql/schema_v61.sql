-- Retract the occupancy segments a later reconcile pass superseded.
--
-- occupancy_segment was written by an upsert keyed on (plate, started_at) and
-- nothing else, so it did not hold the current reading of the fleet — it held
-- the union of every reconcile pass that has ever run. Two passes that disagree
-- about where a journey starts do not collide on that key, so both rows stayed.
-- src/reconcile.js now makes each pass authoritative for the window it judged;
-- this file removes what the old behaviour has already left behind.
--
-- WHY THE RECONCILER CANNOT DO IT ITSELF, stated properly: it is not that the
-- old rows lie outside any window it runs — the incremental window walks back
-- over most of them in the ordinary course of a week. It is that the new sweep
-- in src/reconcile.js only removes a fragment on a plate the CURRENT pass
-- re-derived, and a plate whose tracker has since gone quiet produces no fixes,
-- so the pass never lists it and never touches its rows. Those fragments would
-- outlive every future pass. This file is for them.
--
-- Measured on production on 2026-09-05 over 2026-08-20..2026-09-05: 3,511 rows,
-- of which 2,102 — 59.9 percent, and 51,401 of the 82,639 km — are intervals
-- lying strictly inside a longer segment on the same plate. Every one of them
-- has the same end as the row containing it and a later start, which is a pass
-- whose window opened in the middle of a journey recording the tail of it as a
-- journey of its own. 1,380 of them carry no boundary_gap_min at all — that
-- column was declared by schema_v8 and nothing wrote it until recently, so
-- those rows are older than the current reconciler in a second, independent
-- way. De-duplicated the same period is 1,409 segments and
-- 31,238 km, and the page that reports it stops claiming 3,511 journeys where
-- 1,409 happened.
--
-- WHAT THIS DELETES, precisely: a row is removed only when another row on the
-- SAME PLATE starts strictly earlier and ends no sooner — it is covered end to
-- end by a segment built from a superset of the same fixes, so it is a fragment
-- of that segment rather than a second journey. Rows that merely overlap
-- without one containing the other are left where they are; that shape is not
-- something these windows produce, and deleting on a guess would be discarding
-- evidence rather than a duplicate. Two rows describing the identical interval
-- cannot exist, because (plate, started_at) is the primary key.
--
-- A chain — C inside B inside A — resolves in one statement rather than in
-- passes: the EXISTS sees the snapshot the statement began with, so B and C are
-- both judged against A and both go, and A stays whatever the order. Once it
-- has run no such pair remains, so the statement is idempotent on its own; the
-- schema_once guard from sql/schema_v8.sql:52-67 is what stops it running again
-- on a table the reconciler has since refilled, since every schema file replays
-- on every boot in both containers.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_once WHERE name = 'v61_drop_superseded_segments') THEN
    DELETE FROM occupancy_segment d
     WHERE EXISTS (
       SELECT 1 FROM occupancy_segment o
        WHERE o.plate = d.plate
          AND o.started_at < d.started_at
          AND coalesce(o.ended_at, o.started_at) >= coalesce(d.ended_at, d.started_at));
    INSERT INTO schema_once (name) VALUES ('v61_drop_superseded_segments');
  END IF;
END $$;
