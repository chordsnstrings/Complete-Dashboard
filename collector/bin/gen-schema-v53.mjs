/* sql/schema_v53.sql is GENERATED from api/identity_map.js.
   ─────────────────────────────────────────────────────────────────────────
   The merge register and the expression the database stores must be the same
   list, and a hand-copied CASE in a .sql file is exactly the kind of second
   copy this codebase has been bitten by four times (see the header of
   sql/schema_v20.sql). So the .sql file is emitted from the register, and
   test/identity_merge.test.mjs re-runs this generator and fails if the file on
   disk differs by a byte.

     node bin/gen-schema-v53.mjs        # rewrite sql/schema_v53.sql
     node bin/gen-schema-v53.mjs --check  # exit 1 if it is stale        */
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MERGES, registerComment, identityCase } from '../api/identity_map.js';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'sql', 'schema_v53.sql');

/* personFold, spelled for a %I placeholder so one template serves six tables
   with two different name columns. Byte for byte the expression in
   sql/schema_v20.sql — test/person_key.test.mjs compares the values. */
const FOLD = "regexp_replace(\n"
  + "             btrim(regexp_replace(lower(%I), '\\s+', ' ', 'g')),\n"
  + "             '(\\m\\w+)( \\1)+', '\\1', 'g')";

export function render() {
  const tpl = identityCase('driver_ext_id', FOLD);
  /* The "already applied" probe, and why it cannot be the FIRST merge id.
     ─────────────────────────────────────────────────────────────────────────
     It was `MERGES[0].merge.id`, which is a fine test for "has this file ever
     run" and a silently wrong one for "is this file's register the one the
     column carries". The first entry is the oldest merge and it survives every
     later edit, so the day the register grew from three pairs to ninety-three
     the guard still matched, every table was skipped, and person_key would
     have gone on folding ninety people apart while api/identity_map.js said
     otherwise — the exact drift test/identity_merge.test.mjs exists to catch,
     arriving through the one path that test cannot see.

     The probe is the LAST alias id instead: appended as the register grows, so
     a column built from an older register never contains it and always
     rebuilds. Belt and braces with the count of WHEN clauses, because two
     registers of the same length that end on the same pair are the same
     register. */
  const aliasIds = MERGES.flatMap((m) => (m.merge?.ids || [m.merge?.id]).filter(Boolean));
  const probe = aliasIds[aliasIds.length - 1];
  const whens = aliasIds.length;
  return `-- ── ${MERGES.length} people who were on the roster more than once, folded onto one key each ──
-- ---------------------------------------------------------------------------
-- person_key is what every surface in this product groups people by, and it
-- was the folded NAME and nothing else: lowercase, collapse runs of
-- whitespace, collapse an adjacent repeated word (sql/schema_v20.sql for trip,
-- driver_platform_state and vehicle_driver_day; v42 for the earnings
-- components; v51 for the statements and payouts).
--
-- That fold cannot see the duplicates this fleet actually has, and MUST NOT be
-- taught to. Some are the same names in the opposite order ("Aliyan khalil" on
-- Uber against "Khalil Aliyan" on Yango) and one is a transliterated vowel
-- ("Shehzad Ahmad" against "Shehzad Ahmed"). Most are the shape the roster
-- produces every day: Bolt and the hotel channel file the full legal name and
-- Uber drops the middle one — "Zubair Khan Shaukat Ali" against "Zubair Khan
-- Ali", "Zia Ali Said Muhammad" against "Zia Ali Muhammad". Every rule loose
-- enough to catch those is loose enough to merge two men: this product's own
-- test/roster_twin.test.mjs pins "Muhammad Khalid Gul" and "Muhammad Khalid"
-- apart as two humans on two cars, and a subsequence rule would join them.
--
-- So the merge is a LIST, and each entry says what decided it. Two kinds sit
-- in it now. Some were checked one pair at a time against production — shared
-- plates, interleaved custody days, the gap between one record handing a car
-- to the other. The rest were found by src/identity_link.js on a phone number
-- both channels filed against the same person, which over the 289 roster rows
-- appears on no more than two records and never twice within one channel.
-- Twenty-six people were found by both, independently.
--
-- What is NOT here is any pair with a contradiction: a day on which both
-- records took a trip at the same time. Five carry one, they stay in PENDING,
-- and a simultaneous trip outranks a shared phone every time.
--
-- So the merge is a LIST of verified ids, not a rule. api/identity_map.js holds
-- it together with the measurement that decided each one. THIS FILE IS
-- GENERATED from that register by bin/gen-schema-v53.mjs, and
-- test/identity_merge.test.mjs re-runs the generator and fails if the two have
-- drifted apart.
--
-- The register, as it stands:
--
${registerComment()}
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

-- ── the views that depend on the column, and why they are the whole problem ──
-- Measured on production 2026-09-07, in the collector's own log:
--
--   ERROR [db] migration schema_v53.sql failed
--     {"err":"cannot drop column person_key of table trip because other objects
--             depend on it"}
--
-- sql/schema_v62.sql defines trip_ext as SELECT t.* over trip, so the view
-- depends on every column of it INCLUDING person_key, and a DROP COLUMN cannot
-- get past it. On a fresh database this file runs at position 53 and that view
-- is created at 62, so there is nothing to block it and the whole suite passes.
-- On a database that already exists — which is the only kind production has —
-- every view is already there and this file has been failing silently since the
-- day v62 shipped. The ledger does not record a failed file, so it retried
-- every boot, failed every boot, and the stored person_key went on carrying
-- whatever register was current when v62 landed while api/identity_map.js grew
-- to a hundred and thirty entries in front of it.
--
-- Dropping the views here and leaving them to a later file to recreate does NOT
-- work: the ledger skips a file whose sha it has already seen, so v62 would
-- never run again and trip_ext would simply be gone. And writing their
-- definitions out here would be a second copy of a view this codebase has
-- already been bitten by keeping two copies of.
--
-- So the definitions are read out of the catalogue, the views are dropped, the
-- columns are rebuilt, and the views are recreated from what was read. Nothing
-- is duplicated and nothing needs to know which views exist — a view added
-- tomorrow over any of these six columns is handled by the same code.

DO $mig$
DECLARE
  t   record;
  v   record;
  tpl text := $tpl$${tpl}$tpl$;
  need boolean := false;
  saved text[] := '{}';
  stmt text;
BEGIN
  /* Nothing is dropped unless something actually needs rebuilding. A boot on a
     database already carrying this register must not drop and recreate eight
     views for nothing. */
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
         AND c.generation_expression LIKE '%${probe}%'
         -- …and carries as many merges as this register has, so a column built
         -- from a SUPERSET that happens to end on the same pair still rebuilds.
         AND (length(c.generation_expression)
              - length(replace(c.generation_expression, 'WHEN ', ''))) / 5 = ${whens});
    need := true;
  END LOOP;
  IF NOT need THEN RETURN; END IF;

  /* ── read the dependent views out of the catalogue ──────────────────────
     Every view built on any of these six person_key columns, and every view
     built on THOSE, since a view over a view blocks the drop just as firmly.
     The depth column orders them so a view is recreated after whatever it
     selects from.
     Capped at ten levels: a cycle is impossible in Postgres's view graph, and
     a runaway loop inside a migration is worse than a missing view. */
  FOR v IN
    WITH RECURSIVE dep AS (
      SELECT DISTINCT r.ev_class AS oid, 1 AS depth
        FROM pg_depend d
        JOIN pg_rewrite r  ON r.oid = d.objid
        JOIN pg_class  src ON src.oid = d.refobjid
        JOIN pg_attribute a ON a.attrelid = src.oid AND a.attnum = d.refobjsubid
       WHERE a.attname = 'person_key'
         AND src.relname IN ('trip', 'driver_platform_state', 'vehicle_driver_day',
                             'money_event', 'driver_statement_day', 'driver_payout_day')
      UNION ALL
      SELECT r.ev_class, dep.depth + 1
        FROM dep
        JOIN pg_depend d  ON d.refobjid = dep.oid
        JOIN pg_rewrite r ON r.oid = d.objid AND r.ev_class <> dep.oid
       WHERE dep.depth < 10
    )
    SELECT c.relname AS name, max(dep.depth) AS depth,
           pg_get_viewdef(c.oid) AS def
      FROM dep JOIN pg_class c ON c.oid = dep.oid
     WHERE c.relkind = 'v'
     GROUP BY c.relname, c.oid
     ORDER BY 2, 1
  LOOP
    saved := saved || format('CREATE VIEW %I AS %s', v.name, v.def);
    RAISE NOTICE 'person_key rebuild: saving view %', v.name;
  END LOOP;

  /* Dropped deepest-first, though CASCADE would handle the order — every one
     of them is in the saved array, so nothing CASCADE takes goes unrecreated. */
  FOR v IN SELECT unnest AS name FROM unnest(ARRAY(
      SELECT c.relname FROM pg_class c
       WHERE c.relkind = 'v' AND c.relnamespace = current_schema()::regnamespace
         AND format('CREATE VIEW %I AS %s', c.relname, pg_get_viewdef(c.oid)) = ANY(saved)))
  LOOP
    EXECUTE format('DROP VIEW IF EXISTS %I CASCADE', v.name);
  END LOOP;

  /* ── the rebuild itself ─────────────────────────────────────────────── */
  FOR t IN SELECT * FROM (VALUES
        ('trip',                 'driver_name'),
        ('driver_platform_state','full_name'),
        ('vehicle_driver_day',   'driver_name'),
        ('money_event',          'driver_name'),
        ('driver_statement_day', 'driver_name'),
        ('driver_payout_day',    'driver_name')
      ) v(tbl, namecol)
  LOOP
    CONTINUE WHEN to_regclass(t.tbl) IS NULL;
    EXECUTE format('ALTER TABLE %I DROP COLUMN IF EXISTS person_key', t.tbl);
    EXECUTE format('ALTER TABLE %I ADD COLUMN person_key text GENERATED ALWAYS AS (%s) STORED',
                   t.tbl, format(tpl, t.namecol));
  END LOOP;

  /* ── and put the views back, shallowest first ───────────────────────── */
  FOREACH stmt IN ARRAY saved LOOP
    EXECUTE stmt;
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

-- ── and then tell the planner what it is looking at ───────────────────────
-- Re-adding a generated column rewrites the whole table, and a rewritten table
-- arrives with no statistics at all: no row estimate, no n_distinct for
-- person_key, no correlation. Postgres does not sample it on the spot, it
-- waits for autovacuum, and on a basic-xxs instance that wait is long.
--
-- Measured on production 2026-09-07, the boot this file first applied:
-- /api/kpis over the full window went from roughly a second to 48, on
-- unchanged query text and unchanged data. Every plan over person_key was
-- being costed against a table the planner believed was empty.
--
-- ANALYZE is cheap next to the rewrite that precedes it (single-digit seconds
-- against two minutes), it is legal inside the implicit transaction this file
-- runs in — unlike VACUUM, which is not, and which autovacuum will do in its
-- own time — and it runs even on the cheap path where the guard above skipped
-- the rebuild, which costs one sample and keeps a re-run honest.
ANALYZE trip;
ANALYZE driver_platform_state;
ANALYZE vehicle_driver_day;
ANALYZE money_event;
ANALYZE driver_statement_day;
ANALYZE driver_payout_day;
`;
}

if (process.argv[1] && process.argv[1].endsWith('gen-schema-v53.mjs')) {
  const want = render();
  if (process.argv.includes('--check')) {
    const got = readFileSync(OUT, 'utf8');
    if (got !== want) { console.error('sql/schema_v53.sql is stale — run node bin/gen-schema-v53.mjs'); process.exit(1); }
    console.log('sql/schema_v53.sql matches api/identity_map.js');
  } else {
    writeFileSync(OUT, want);
    console.log(`wrote ${OUT} (${want.length} bytes)`);
  }
}
