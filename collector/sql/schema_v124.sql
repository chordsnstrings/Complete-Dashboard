-- v124 — database roles and row-level security, as the backstop to the API's
-- fleet filter (collector/docs/ULM-DESIGN.md §4; src/fleet_scope.js).
--
-- THE GAP. A one-fleet reader's scope has been held in one place only: the
-- access gate rewrites a 'param' route's fleet filter to the reader's fleet
-- and the handler is trusted to put it on every statement. ULM-DESIGN §16
-- listed "row-level security and the two database roles" as not built. This
-- file builds the database half: a restricted role, and on every
-- fleet-bearing table a policy that shows that role the rows of the fleets in
-- the transaction's `app.fleets` setting and no others.
--
-- THE TWO ROLES OF §4, AS THEY STAND AFTER THIS FILE.
--   owner role    the application's existing database user. It ran every
--                 migration, so it owns every table, and Postgres exempts a
--                 table's owner from that table's policies — which is exactly
--                 what keeps every caller the API does not narrow (the Owner,
--                 every all-fleet role, the warmer, an anonymous visitor in
--                 open mode, the collector) on today's path, byte for byte.
--                 Moving ownership to a separate NOLOGIN role is not done
--                 here: it is a rewrite of every table's owner on production
--                 for no change in what anyone can read, and it is listed as
--                 a later phase in ULM-DESIGN's As-built note.
--   fleet_request the restricted role. NOLOGIN (nobody connects as it),
--                 NOINHERIT (it never picks up another role's rights, the
--                 owner's included, even if somebody grants it one),
--                 NOBYPASSRLS. It owns nothing and is granted SELECT and
--                 nothing else. The API assumes it with SET LOCAL ROLE inside
--                 a read-only transaction for a scoped reader's statements.
--
-- NO FORCE ROW LEVEL SECURITY, deliberately, against the letter of §4. FORCE
-- would subject the owner to the policies too, and the owner is every
-- unrestricted caller of the product: with the scope unset, every one of them
-- would read nothing. §4 assumed all traffic moves to the request role first;
-- this phase moves only the scoped readers, so the owner must stay exempt.
--
-- THE POLICY, on every table with a text `fleet_id` (or `fleet`) column:
--   FOR ALL TO PUBLIC
--   USING      (current_user <> 'fleet_request'
--               OR fleet_id = ANY (string_to_array(nullif(current_setting('app.fleets', true), ''), ',')))
--   WITH CHECK (current_user <> 'fleet_request')
-- One permissive policy for everybody, so that any role this file cannot
-- see — a reporting login an administrator made, say — that is neither the
-- owner nor BYPASSRLS keeps reading exactly what it read before (without it,
-- enabling RLS would show such a role nothing). Only a session that has
-- assumed fleet_request is narrowed. An unset or empty `app.fleets` matches
-- no fleet: the closed direction. NULL-fleet rows and the rollups' '*' rows
-- are not any fleet's and are not shown to it either (ULM-DESIGN §4: "the
-- rollups' '*' rows answer only a user whose scope is every fleet").
--
-- ONE TABLE WITH A fleet_id IS EXEMPT: `driver`, the person spine. §4 keeps
-- rows about a person whole — a scoped reader reaches a person through the
-- person's accounts in the reader's fleets — and driver.fleet_id is a column
-- nothing has written since the spine replaced it (src/persons.js and
-- api/ledger_person.js insert people with no fleet). Under the policy every
-- person row (fleet NULL) would vanish for the reader and every name with it.
--
-- AND THE VIEWS RUN AS THE READER. A view runs with its OWNER's rights by
-- default, and the owner is exempt from row-level security — so trip_norm,
-- read by nearly every page, would have handed the restricted role every
-- fleet's trips. Measured on PGlite before this file: the same SELECT through
-- a definer view returned all four rows of both fleets, through the table one.
-- Each view gets security_invoker = true (Postgres 15+), which changes nothing
-- for the owner (it owns the tables beneath too) and makes the policy hold
-- through the view for the reader.
--
-- WHY THIS FILE WRITES NO POLICY ITSELF. A migration file is sent as one
-- multi-statement query, which Postgres runs as ONE transaction; ENABLE ROW
-- LEVEL SECURITY, CREATE POLICY and ALTER VIEW each take an ACCESS EXCLUSIVE
-- lock and keep it to the end of the transaction. Forty-nine fleet tables and
-- eleven views (as of this file) in one transaction would hold every one of
-- those locks while waiting for the next — behind a rollup that runs forty
-- seconds — and stall every page. So this file defines fm_rls_secure(),
-- which secures ONE object, and src/db.js calls it right after the
-- migrations once per object, each its own short transaction with a
-- lock_timeout; a busy object is skipped and the next boot finishes it. That boot pass also re-secures whatever a later migration
-- creates or rebuilds — sql/schema_v53.sql drops and recreates nine views
-- whenever the identity register changes, which resets security_invoker.
--
-- NEVER FAILS, AND INERT WITHOUT ITS ROLE. DigitalOcean's managed Postgres 16
-- may give the application a user without CREATEROLE, and table ownership may
-- not be what is expected; a migration that raised would be retried at every
-- boot. Every statement here is guarded. If the role cannot be created, or the
-- application cannot assume it, fm_rls_plan() returns nothing and
-- fm_rls_secure() changes nothing: no table gains RLS, no view changes, and
-- the API reports the true reason (src/fleet_scope.js probeFleetScope). An
-- administrator can create the role later —
--   CREATE ROLE fleet_request NOLOGIN NOINHERIT;
--   GRANT fleet_request TO <the application's database user>;
-- — and the next boot does the rest.

-- 1. The restricted role.
DO $rls$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fleet_request') THEN
    BEGIN
      CREATE ROLE fleet_request NOLOGIN NOINHERIT NOBYPASSRLS;
    EXCEPTION
      WHEN duplicate_object THEN NULL;   -- the other service made it a moment ago
      WHEN OTHERS THEN
        RAISE NOTICE 'v124: the fleet_request role could not be created (%): row-level security stays unused until an administrator creates it', SQLERRM;
    END;
  END IF;
END
$rls$;

-- 2. The application may assume it. On Postgres 16 a CREATEROLE user that
-- creates a role holds ADMIN on it but not SET, so the grant is needed; a
-- superuser needs none. Refused (another user made the role) is not an error.
DO $rls$
DECLARE can_set boolean;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fleet_request') THEN
    BEGIN
      can_set := pg_has_role(current_user, 'fleet_request', 'SET');
    EXCEPTION WHEN OTHERS THEN
      can_set := pg_has_role(current_user, 'fleet_request', 'MEMBER');   -- before Postgres 16
    END;
    IF NOT can_set THEN
      BEGIN
        EXECUTE format('GRANT fleet_request TO %I', current_user);
      EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'v124: % cannot be granted fleet_request (%): an administrator can grant it', current_user, SQLERRM;
      END;
    END IF;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'v124: role membership not checked (%)', SQLERRM;
END
$rls$;

-- 3. fm_rls_usable(): may this session assume a restricted role that would
-- actually restrict? False when the role is missing, when it is a superuser or
-- may bypass RLS (it would narrow nothing), or when this user cannot SET ROLE
-- to it.
DO $rls$
BEGIN
  EXECUTE $def$
CREATE OR REPLACE FUNCTION fm_rls_usable() RETURNS boolean
LANGUAGE plpgsql AS $f$
DECLARE r record;
BEGIN
  SELECT rolsuper, rolbypassrls INTO r FROM pg_roles WHERE rolname = 'fleet_request';
  IF NOT FOUND OR r.rolsuper OR r.rolbypassrls THEN RETURN false; END IF;
  BEGIN
    RETURN pg_has_role(current_user, 'fleet_request', 'SET');
  EXCEPTION WHEN OTHERS THEN
    RETURN pg_has_role(current_user, 'fleet_request', 'MEMBER');
  END;
END
$f$
$def$;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'v124: fm_rls_usable() not created (%)', SQLERRM;
END
$rls$;

-- 4. fm_rls_plan(): every object in the public schema that is not yet as the
-- policy wants it, and why — the role cannot read it; a view runs as its
-- owner; a fleet table lacks the policy or has row-level security off.
-- Nothing at all while the role is unusable, so the boot pass is inert then.
DO $rls$
BEGIN
  EXECUTE $def$
CREATE OR REPLACE FUNCTION fm_rls_plan() RETURNS TABLE (rel regclass, why text)
LANGUAGE plpgsql AS $f$
BEGIN
  IF NOT fm_rls_usable() THEN RETURN; END IF;
  RETURN QUERY
  WITH t AS (
    SELECT c.oid AS o, c.relkind AS k, c.relrowsecurity AS on_,
           c.relname <> 'driver'          -- the person spine: see the header
           AND EXISTS (SELECT 1 FROM pg_attribute a
                        WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                          AND a.attname IN ('fleet_id', 'fleet')
                          AND a.atttypid IN ('text'::regtype, 'varchar'::regtype)) AS fleet,
           EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'fm_fleet_scope') AS pol,
           coalesce(c.reloptions && ARRAY['security_invoker=true', 'security_invoker=on',
                                          'security_invoker=1', 'security_invoker=yes'], false) AS inv,
           has_table_privilege('fleet_request', c.oid, 'SELECT') AS can_read
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v'))
  SELECT t.o::regclass,
         concat_ws('; ',
           CASE WHEN NOT t.can_read THEN 'not readable by fleet_request' END,
           CASE WHEN t.k = 'v' AND NOT t.inv THEN 'view runs as its owner' END,
           CASE WHEN t.fleet AND t.k IN ('r', 'p') AND NOT t.pol THEN 'no fleet policy' END,
           CASE WHEN t.fleet AND t.k IN ('r', 'p') AND NOT t.on_ THEN 'row-level security off' END)
    FROM t
   WHERE NOT t.can_read
      OR (t.k = 'v' AND NOT t.inv)
      OR (t.fleet AND t.k IN ('r', 'p') AND NOT (t.pol AND t.on_))
   ORDER BY 1;
END
$f$
$def$;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'v124: fm_rls_plan() not created (%)', SQLERRM;
END
$rls$;

-- 5. fm_rls_secure(target, lock_ms): bring ONE object up to the policy, in
-- the caller's transaction (one statement from src/db.js = one transaction),
-- waiting at most lock_ms for its lock. Two steps:
--   1. the read grant. It takes no lock a reader holds (measured on Postgres
--      16.15: GRANT 1 ms while a reader held the table; CREATE POLICY and
--      ENABLE ROW LEVEL SECURITY each waited out a 400 ms lock_timeout), so
--      it lands even when step 2 has to wait for the next boot. Without it a
--      table the role cannot read takes the restricted path out of use for
--      EVERY table (src/fleet_scope.js probeFleetScope) — rolled back with a
--      busy step 2, one busy new table would switch the whole backstop off.
--   2. the policy and RLS on (a fleet table) or security_invoker (a view),
--      which need the object's ACCESS EXCLUSIVE lock. Nested, so a busy or
--      refused step 2 keeps step 1. The policy is created BEFORE row-level
--      security is switched on, so there is never a moment with RLS on and
--      no policy (which would show every non-owner role nothing).
-- Nothing is raised: what was done comes back, then 'busy: …' (lock not had
-- in time; the next boot retries), 'refused: …' (a privilege the
-- application's user lacks) or 'failed: …' with Postgres's own words.
DO $rls$
BEGIN
  EXECUTE $def$
CREATE OR REPLACE FUNCTION fm_rls_secure(target regclass, lock_ms int DEFAULT 3000) RETURNS text
LANGUAGE plpgsql AS $f$
DECLARE
  k    "char";
  rls  boolean;
  opts text[];
  col  text;
  done text[] := ARRAY[]::text[];
BEGIN
  IF NOT fm_rls_usable() THEN
    RETURN 'skipped: the fleet_request role is missing or cannot be assumed';
  END IF;
  PERFORM set_config('lock_timeout', greatest(coalesce(lock_ms, 3000), 1)::text, true);
  SELECT c.relkind, c.relrowsecurity, c.reloptions INTO k, rls, opts
    FROM pg_class c WHERE c.oid = target;
  IF NOT FOUND THEN RETURN 'skipped: no such table or view'; END IF;

  -- 1. The read grant, on its own (see above). Checked after, not assumed: a
  -- user that holds SELECT on an object it does not own, without the grant
  -- option, gets a WARNING from GRANT ("no privileges were granted") and no
  -- error — measured on PGlite in the review of 2026-11-12, where the result
  -- read 'granted SELECT, refused: must be owner' for a table the role still
  -- could not read. The reason in the boot log must be the true one.
  IF NOT has_table_privilege('fleet_request', target, 'SELECT') THEN
    EXECUTE format('GRANT SELECT ON %s TO fleet_request', target);
    IF NOT has_table_privilege('fleet_request', target, 'SELECT') THEN
      RETURN format('refused: SELECT could not be granted to fleet_request — %s does not own %s (its owner is %s) and holds no grant option on it',
                    current_user, target, (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = target));
    END IF;
    done := done || 'granted SELECT'::text;
  END IF;

  -- 2. The narrowing itself; a failure here keeps step 1.
  BEGIN
    IF k = 'v' THEN
      IF NOT coalesce(opts && ARRAY['security_invoker=true', 'security_invoker=on',
                                    'security_invoker=1', 'security_invoker=yes'], false) THEN
        EXECUTE format('ALTER VIEW %s SET (security_invoker = true)', target);
        done := done || 'runs as the reader'::text;
      END IF;
    ELSIF k IN ('r', 'p') THEN
      SELECT a.attname INTO col
        FROM pg_attribute a
       WHERE a.attrelid = target AND a.attnum > 0 AND NOT a.attisdropped
         AND (SELECT c.relname FROM pg_class c WHERE c.oid = target) <> 'driver'   -- the person spine
         AND a.attname IN ('fleet_id', 'fleet')
         AND a.atttypid IN ('text'::regtype, 'varchar'::regtype)
       ORDER BY (a.attname = 'fleet_id') DESC
       LIMIT 1;
      IF col IS NOT NULL THEN
        IF NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = target AND p.polname = 'fm_fleet_scope') THEN
          EXECUTE format(
            $p$CREATE POLICY fm_fleet_scope ON %s AS PERMISSIVE FOR ALL TO PUBLIC
                 USING (current_user <> 'fleet_request'
                        OR %I = ANY (string_to_array(nullif(current_setting('app.fleets', true), ''), ',')))
                 WITH CHECK (current_user <> 'fleet_request')$p$, target, col);
          done := done || 'fleet policy'::text;
        END IF;
        IF NOT rls THEN
          EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', target);
          done := done || 'row-level security on'::text;
        END IF;
      END IF;
    END IF;
  EXCEPTION
    WHEN lock_not_available THEN
      RETURN array_to_string(array_remove(done, 'fleet policy') || ('busy: ' || SQLERRM), ', ');
    WHEN insufficient_privilege THEN
      RETURN array_to_string(array_remove(done, 'fleet policy') || ('refused: ' || SQLERRM), ', ');
  END;
  RETURN CASE WHEN cardinality(done) = 0 THEN 'nothing to do' ELSE array_to_string(done, ', ') END;
EXCEPTION
  WHEN lock_not_available THEN RETURN 'busy: ' || SQLERRM;
  WHEN insufficient_privilege THEN RETURN 'refused: ' || SQLERRM;
  WHEN OTHERS THEN RETURN 'failed: ' || SQLERRM;
END
$f$
$def$;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'v124: fm_rls_secure() not created (%)', SQLERRM;
END
$rls$;

-- 6. Say what they are, where a reader of the catalog will look. Guarded:
-- commenting needs ownership.
DO $rls$
BEGIN
  EXECUTE $c$COMMENT ON FUNCTION fm_rls_secure(regclass, int) IS
    'Row-level security backstop (sql/schema_v124.sql): secures ONE table or view for the fleet_request role — SELECT grant, the fm_fleet_scope policy, RLS on (never FORCE), security_invoker on views. Called once per object by src/db.js after the migrations. Returns what it did, or busy/refused/failed with the reason; never raises.'$c$;
  EXECUTE $c$COMMENT ON FUNCTION fm_rls_plan() IS
    'Row-level security backstop (sql/schema_v124.sql): the objects not yet as fm_rls_secure() leaves them, and why. Empty while the fleet_request role is missing or cannot be assumed.'$c$;
  EXECUTE $c$COMMENT ON FUNCTION fm_rls_usable() IS
    'Row-level security backstop (sql/schema_v124.sql): true when the fleet_request role exists, cannot bypass RLS, and this user may SET ROLE to it.'$c$;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'v124: comments not written (%)', SQLERRM;
END
$rls$;
DO $rls$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fleet_request') THEN
    EXECUTE $c$COMMENT ON ROLE fleet_request IS
      'The restricted request role (sql/schema_v124.sql, ULM-DESIGN §4): owns nothing, SELECT only, no BYPASSRLS. The API assumes it with SET LOCAL ROLE, in a read-only transaction with app.fleets set, for a reader whose grants cover some fleets but not all; every fleet table''s fm_fleet_scope policy then shows it only those fleets'' rows.'$c$;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'v124: role comment not written (%)', SQLERRM;
END
$rls$;
