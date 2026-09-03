-- ── three people who were on the roster twice, folded onto one key each ─────
-- ---------------------------------------------------------------------------
-- person_key is what every surface in this product groups people by, and until
-- now it was the folded NAME and nothing else: lowercase, collapse runs of
-- whitespace, collapse an adjacent repeated word (sql/schema_v20.sql for trip,
-- driver_platform_state and vehicle_driver_day; v42 for the earnings
-- components; v51 for the statements and payouts).
--
-- That fold cannot see three duplicates an operator asked about, and MUST NOT
-- be taught to. Two are the same names in the opposite order ("Aliyan khalil"
-- on Uber against "Khalil Aliyan" on Yango; "Moses Arthur" on Uber against
-- "Arthur Moses" on Bolt) and the third is one transliterated vowel ("Shehzad
-- Ahmad Ghulam Muhammad" on Uber against "Shehzad Ahmed Ghulam Muhammad" on the
-- hotel channel). Every rule loose enough to catch them is loose enough to
-- merge two men: this product's own test/roster_twin.test.mjs pins "Muhammad
-- Khalid Gul" and "Muhammad Khalid" apart as two humans on two cars, and a
-- word-order rule would join "Gul Muhammad Khalid" to either of them the day
-- such a row arrives.
--
-- So the merge is a LIST of verified ids, not a rule. api/identity_map.js holds
-- it together with the measurement that decided each one. THIS FILE IS
-- GENERATED from that register by bin/gen-schema-v53.mjs, and
-- test/identity_merge.test.mjs re-runs the generator and fails if the two have
-- drifted apart.
--
-- The register, as it stands:
--
-- 7fc8da91fc4a44c185e8d6d918db3e6b (yango "Khalil Aliyan")
--   -> 5f16534e-68be-451b-b057-3e3d948e868b (uber "Aliyan khalil") = 'aliyan khalil'
--   verified 2026-09-03 on plate L36397
-- ab2aec60-56ff-48e2-85c0-3591f6f29aa3 (bolt "Arthur Moses")
--   -> 9d396a20-454b-4a7e-91ae-9de8f9aa8942 (uber "Moses Arthur") = 'moses arthur'
--   verified 2026-09-03 on plate L10595
-- 67483c64055e070d7910010a (hotel "Shehzad Ahmed Ghulam Muhammad")
--   -> f6253b6e-fca4-41cf-99c1-6c2f3e2e67b2 (uber "Shehzad Ahmad Ghulam Muhammad") = 'shehzad ahmad ghulam muhammad'
--   verified 2026-09-03 on plate L46208
--
-- The canonical key of each pair is the folded name of the SURVIVING record,
-- unchanged. No key in this database moves except the alias record's, which
-- moves onto the survivor — so the migration merges work together and renames
-- nobody.
--
-- ── why the column is dropped and re-added ─────────────────────────────────
-- Postgres 16 has no ALTER COLUMN ... SET EXPRESSION (that arrived in 17), so a
-- generated column's expression can only be replaced by replacing the column.
-- Dropping it takes its indexes with it — including trip_econ_day_idx from
-- sql/schema_v30.sql, which carries person_key in its INCLUDE list — and every
-- one of them is recreated at the bottom of this file, verbatim from the file
-- that owns it. The guard below skips the rebuild once the expression is
-- already in place, so a re-run costs one catalogue lookup per table instead of
-- a rewrite of the trip table.

DO $mig$
DECLARE
  t   record;
  tpl text := $tpl$CASE driver_ext_id
         WHEN '7fc8da91fc4a44c185e8d6d918db3e6b' THEN 'aliyan khalil'
         WHEN 'ab2aec60-56ff-48e2-85c0-3591f6f29aa3' THEN 'moses arthur'
         WHEN '67483c64055e070d7910010a' THEN 'shehzad ahmad ghulam muhammad'
         ELSE regexp_replace(
             btrim(regexp_replace(lower(%I), '\s+', ' ', 'g')),
             '(\m\w+)( \1)+', '\1', 'g') END$tpl$;
BEGIN
  FOR t IN SELECT * FROM (VALUES
        ('trip',                 'driver_name'),
        ('driver_platform_state','full_name'),
        ('vehicle_driver_day',   'driver_name'),
        ('money_event',          'driver_name'),
        ('driver_statement_day', 'driver_name'),
        ('driver_payout_day',    'driver_name')
      ) v(tbl, namecol)
  LOOP
    -- A table this database has not built yet is not this file's business.
    CONTINUE WHEN to_regclass(t.tbl) IS NULL;
    -- Already carrying the register: nothing to do, and nothing to rewrite.
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM information_schema.columns c
       WHERE c.table_schema = current_schema()
         AND c.table_name   = t.tbl
         AND c.column_name  = 'person_key'
         AND c.generation_expression LIKE '%7fc8da91fc4a44c185e8d6d918db3e6b%');
    EXECUTE format('ALTER TABLE %I DROP COLUMN IF EXISTS person_key', t.tbl);
    EXECUTE format('ALTER TABLE %I ADD COLUMN person_key text GENERATED ALWAYS AS (%s) STORED',
                   t.tbl, format(tpl, t.namecol));
  END LOOP;
END
$mig$;

-- ── the indexes the drop took with it ──────────────────────────────────────
-- Partial on the same predicate as before: a row with no name has no person,
-- and an empty key must never become the bucket every anonymous row falls into.
CREATE INDEX IF NOT EXISTS trip_person_key_idx ON trip (person_key)
  WHERE person_key IS NOT NULL AND person_key <> '';

CREATE INDEX IF NOT EXISTS dps_person_key_idx ON driver_platform_state (person_key)
  WHERE person_key IS NOT NULL AND person_key <> '';

CREATE INDEX IF NOT EXISTS vdd_person_key_idx ON vehicle_driver_day (person_key)
  WHERE person_key IS NOT NULL AND person_key <> '';

CREATE INDEX IF NOT EXISTS money_event_person_idx ON money_event (person_key)
  WHERE person_key IS NOT NULL AND person_key <> '';

CREATE INDEX IF NOT EXISTS dsd_person_key_idx ON driver_statement_day (person_key, day)
  WHERE person_key IS NOT NULL AND person_key <> '';

CREATE INDEX IF NOT EXISTS dpd_person_key_idx ON driver_payout_day (person_key, day)
  WHERE person_key IS NOT NULL AND person_key <> '';

-- The covering index for the unit-economics window scan (sql/schema_v30.sql).
-- It INCLUDEs person_key, so dropping the column dropped it, and /api/economics
-- goes back to a heap fetch per row without it.
CREATE INDEX IF NOT EXISTS trip_econ_day_idx
  ON trip (((requested_at AT TIME ZONE 'Asia/Dubai')::date))
  INCLUDE (plate, platform, fleet_id, person_key, driver_ext_id, driver_name,
           status, payment_type, price, distance_km, requested_at);
