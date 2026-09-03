-- ── the Yango names already written under two compositions ─────────────────
-- ---------------------------------------------------------------------------
-- src/sources/yango.js now files every Yango driver under one name — the
-- summary endpoint's decomposition — across trips, the roster and the ledger.
-- That fixes what arrives from here on. It does not touch the rows already in
-- the table, and those are where the split people live: a trip written last
-- month still carries orders/list's `driver_full_name`, so the same driver_id
-- still folds to one person_key on trip and a different one on
-- driver_platform_state.
--
-- This aligns the history to the id, and ONLY to the id. It is not a name
-- rule and it makes no judgement about whether two names mean two people:
-- driver_ext_id is the same value on both rows or nothing happens. The
-- register in api/identity_map.js stays the only place where records with
-- DIFFERENT ids are joined, and stays a list of individually verified pairs.
--
-- The state row is the authority because its name is the one Yango hands back
-- decomposed, in parts, in natural order — the only composition whose word
-- order we can account for. A driver with no state row is left exactly as
-- they are; a name we cannot improve on is better than a name we invented.

-- Trips. person_key is GENERATED on this column, so the update rebuilds it.
UPDATE trip t
   SET driver_name = s.full_name
  FROM driver_platform_state s
 WHERE t.platform = 'yango'
   AND s.platform = 'yango'
   AND s.driver_ext_id = t.driver_ext_id
   AND s.full_name IS NOT NULL AND s.full_name <> ''
   AND t.driver_name IS DISTINCT FROM s.full_name;

-- The ledger carries a third composition of its own from transactions/list.
UPDATE ledger_entry l
   SET driver_name = s.full_name
  FROM driver_platform_state s
 WHERE l.platform = 'yango'
   AND s.platform = 'yango'
   AND s.driver_ext_id = l.driver_ext_id
   AND s.full_name IS NOT NULL AND s.full_name <> ''
   AND l.driver_name IS DISTINCT FROM s.full_name;

-- The weekly performance rows are already written from the decomposition, so
-- this is a no-op today. It is here so that a row written by an older build,
-- or a backfill replayed from a cached response, cannot leave one behind.
UPDATE driver_performance p
   SET driver_name = s.full_name
  FROM driver_platform_state s
 WHERE p.platform = 'yango'
   AND s.platform = 'yango'
   AND s.driver_ext_id = p.driver_ext_id
   AND s.full_name IS NOT NULL AND s.full_name <> ''
   AND p.driver_name IS DISTINCT FROM s.full_name;
