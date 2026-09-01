-- The money tables fold people per row, and /api/reconcile pays for it twice.
-- ---------------------------------------------------------------------------
-- personFold is two nested regexes, one of them with a backreference. Over the
-- trip table that cost 21 seconds a request until sql/schema_v20.sql stored it;
-- the same reasoning was never applied to the two tables the money lives in.
--
-- /api/reconcile is the page that made it visible. It is all-time by design, it
-- folds BOTH sides by person, and bin/render-audit.mjs reported it as
-- "blank-page — no kpi, table, chart or panel" because the answer arrived after
-- the page's settle window. Measured on production with the slow-query log:
-- the covered-pairs query 5.0-5.7s, the monthly statement fold 2.6-3.2s, on
-- tables holding tens of thousands of rows — small tables, and a regex per row.
--
-- Stored, the fold is computed once per write instead of once per row per
-- request, and it is the same expression as everywhere else: sql/schema_v20.sql
-- for trip and driver_platform_state, sql/schema_v42.sql for the earnings
-- components. test/person_key.test.mjs asserts all of them agree with the JS
-- definition in api/custody_sql.js, so a change to the fold cannot land in one
-- place and not the others.
--
-- IF personFold IN api/custody_sql.js CHANGES, THIS EXPRESSION MUST CHANGE.

ALTER TABLE driver_statement_day ADD COLUMN IF NOT EXISTS person_key text
  GENERATED ALWAYS AS (regexp_replace(
    btrim(regexp_replace(lower(driver_name), '\s+', ' ', 'g')),
    '(\m\w+)( \1)+', '\1', 'g')) STORED;

-- Partial, like every other person_key index: a row with no name has no person,
-- and an empty key must never become a bucket every anonymous row falls into.
CREATE INDEX IF NOT EXISTS dsd_person_key_idx ON driver_statement_day (person_key, day)
  WHERE person_key IS NOT NULL AND person_key <> '';

ALTER TABLE driver_payout_day ADD COLUMN IF NOT EXISTS person_key text
  GENERATED ALWAYS AS (regexp_replace(
    btrim(regexp_replace(lower(driver_name), '\s+', ' ', 'g')),
    '(\m\w+)( \1)+', '\1', 'g')) STORED;

CREATE INDEX IF NOT EXISTS dpd_person_key_idx ON driver_payout_day (person_key, day)
  WHERE person_key IS NOT NULL AND person_key <> '';
