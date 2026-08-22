-- ── the folded name, stored once instead of computed 175,000 times a request ──
--
-- One human is several records: Uber issues a UUID, Yango another, Bolt a third,
-- and the only thing they share is a name entered inconsistently ("Najeeb Ullah
-- Khan" vs "Najeeb Ullah Khan Khan"). So every query that answers a question
-- about a PERSON folds the name first — lowercase, collapse whitespace, collapse
-- any adjacent repeated word — and groups on the result.
--
-- That fold is two nested regexp_replace calls, and it was being evaluated per
-- row, per request. /api/roster asks "has this person ever driven, on any
-- platform, at any time", which by definition has no window and therefore no
-- index to narrow it: 175,000 rows folded on every page load. Measured at
-- production's row count, that one CTE is 2,434ms against 129ms for the same
-- aggregate without the fold — nineteen twentieths of the cost is the regex.
-- The endpoint took 21 seconds.
--
-- Every function in the fold (lower, btrim, regexp_replace) is IMMUTABLE, so
-- Postgres will store the result and maintain it itself. No collector change, no
-- backfill job, and no staleness — a generated column cannot drift from the
-- expression that defines it, which is the failure mode a cached copy would
-- have. The same aggregate is then 142ms: seventeen times faster, and verified
-- against the computed fold row for row.
--
-- If the fold in api/server.js (CANON) or api/custody_sql.js (personFold) ever
-- changes, THIS EXPRESSION MUST CHANGE WITH IT. test/person_key.test.mjs asserts
-- the three agree, so they cannot drift silently.

ALTER TABLE trip ADD COLUMN IF NOT EXISTS person_key text
  GENERATED ALWAYS AS (regexp_replace(
    btrim(regexp_replace(lower(driver_name), '\s+', ' ', 'g')),
    '(\m\w+)( \1)+', '\1', 'g')) STORED;

CREATE INDEX IF NOT EXISTS trip_person_key_idx ON trip (person_key)
  WHERE person_key IS NOT NULL AND person_key <> '';

-- The other side of the same join. driver_platform_state is small enough that
-- the fold is cheap there, but a roster row and a trip row have to agree on what
-- a person is, and two expressions maintained in two places eventually will not.
ALTER TABLE driver_platform_state ADD COLUMN IF NOT EXISTS person_key text
  GENERATED ALWAYS AS (regexp_replace(
    btrim(regexp_replace(lower(full_name), '\s+', ' ', 'g')),
    '(\m\w+)( \1)+', '\1', 'g')) STORED;

CREATE INDEX IF NOT EXISTS dps_person_key_idx ON driver_platform_state (person_key)
  WHERE person_key IS NOT NULL AND person_key <> '';

-- vehicle_driver_day is folded the same way wherever custody is resolved to a
-- person rather than to a platform account.
ALTER TABLE vehicle_driver_day ADD COLUMN IF NOT EXISTS person_key text
  GENERATED ALWAYS AS (regexp_replace(
    btrim(regexp_replace(lower(driver_name), '\s+', ' ', 'g')),
    '(\m\w+)( \1)+', '\1', 'g')) STORED;

CREATE INDEX IF NOT EXISTS vdd_person_key_idx ON vehicle_driver_day (person_key)
  WHERE person_key IS NOT NULL AND person_key <> '';

-- ── deliberately NOT exposed through trip_norm / trip_ext ────────────────────
-- Both views are `SELECT t.* ... FROM trip t`, and Postgres expands that star
-- once, at creation. A column added afterwards is invisible to them, and
-- CREATE OR REPLACE VIEW cannot add one — see the note at the top of
-- schema_v18.sql, which drops and rebuilds both for exactly this reason.
--
-- Rebuilding them here would mean a second authoritative copy of two long view
-- bodies, and the file that owns them is v18. So person_key is a base-table
-- column, and the queries that want it read `trip` directly. That is where it
-- matters: the query this was built for — "has this person ever driven, on any
-- platform, at any time" — has no window and therefore reads the whole table,
-- which is precisely why it cannot afford to fold 175,000 names on the way.
-- Windowed queries against the views still fold at runtime and are cheap
-- because the window already narrowed the scan.
