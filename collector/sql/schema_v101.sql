-- v101 — one account taken back off the person it had been folded into, on the
-- operator's instruction (2026-10-08): "unlink these two and put it back in
-- queue".
--
-- ── THE PAIR ─────────────────────────────────────────────────────────────
--   yango  8089d680edf14bccb846737205b30520  "MUHAMMAD KHALID"
--   uber   76ede4ae-768b-4126-804b-0b5c88043682  "Muhammad Khalid"
--
-- A `same_name` proposal joined them; it was confirmed on the Same person page
-- on 2026-09-21 with no reviewer recorded, and the person spine folded the
-- Yango account onto the Uber man's person row — the one that is "Muhammad
-- Khalifa Afzal Khalid" on the Drivers page. HR files them under two different
-- employees: Ecosine D034 (Muhammad Khalid Younas Gul), whose row carries this
-- Yango id beside Uber 4d4eb2c1…, and Ecosine D076 (Muhammad Khalifa Afzal
-- Khalid). The register has refused 4d4eb2c1… against 76ede4ae… since 2026-09-05
-- (77 simultaneous trips on two plates), so HR's D034 row and the link could
-- not both be right. The operator ruled HR right the same morning
-- (api/identity_map.js, REFUSED), and then asked for this pair to be unlinked
-- and put back in the queue.
--
-- ── WHAT ALREADY HAPPENED, AND WHAT THIS DOES ───────────────────────────
-- The link was put back in the queue through the page's own door —
-- POST /api/same-person/decide {verdict:'undecided'} — which clears
-- confirmed_at; the card is pending again. That stops the read-time fold. It
-- does NOT move the account off the person row: src/persons.js attaches and
-- folds but never detaches, by design ("re-pointing money is an operation
-- somebody has to authorise, not a side effect of a sweep"). So the Drivers
-- page still showed the Yango account inside Muhammad Khalifa Afzal Khalid.
--
-- This moves that ONE account row to a person of its own, named as Yango files
-- it, basis 'account' ("it is its own person"). Nothing else on the person
-- moves: the Uber, Bolt and hotel accounts, every ledger entry, every audit and
-- SMS row stay where they are. One audit row records it, on the person the
-- account left, so it is undone by reading that row.
--
-- ── WHEN IT REFUSES ──────────────────────────────────────────────────────
-- If any ledger entry on that person was recorded THROUGH this Yango account
-- (driver_ledger.acct_ext_id), the money would have to be split between two
-- people, and which of them owes it is not something a migration can know. It
-- then moves nothing, writes a REFUSED audit row naming the entries, and
-- raises a warning.
--
-- ── IDEMPOTENT ───────────────────────────────────────────────────────────
-- On a database where the two accounts are not on one person — every fresh
-- one, every test, and production after this has run — it does nothing.
-- test/identity_review_merge.test.mjs runs it twice and asserts both.
DO $mig$
DECLARE
  acct      CONSTANT text := '8089d680edf14bccb846737205b30520';
  other     CONSTANT text := '76ede4ae-768b-4126-804b-0b5c88043682';
  ruling    CONSTANT jsonb := jsonb_build_object(
    'by', 'operator', 'on', '2026-10-08',
    'words', 'unlink these two and put it back in queue',
    'and', 'HR is right — Younas Gul',
    'register', 'api/identity_map.js, REFUSED — 8089d680… against 76ede4ae…');
  holder    bigint;
  hold_name text;
  acct_plat text;
  acct_name text;
  new_id    bigint;
  through   jsonb;
  why       text;
BEGIN
  SELECT a.driver_id, dr.full_name, a.platform, a.display_name
    INTO holder, hold_name, acct_plat, acct_name
    FROM driver_platform_id a JOIN driver dr ON dr.id = a.driver_id
   WHERE a.external_id = acct AND a.detached_at IS NULL
   ORDER BY a.driver_id LIMIT 1;
  IF holder IS NULL THEN
    RETURN;   -- not placed: the spine will give it a person of its own
  END IF;
  IF NOT EXISTS (SELECT 1 FROM driver_platform_id
                  WHERE external_id = other AND detached_at IS NULL AND driver_id = holder) THEN
    RETURN;   -- already apart
  END IF;

  SELECT jsonb_agg(jsonb_build_object('entry_id', id, 'amount', amount, 'type', type_code,
                                      'on', to_char(effective_on, 'YYYY-MM-DD')) ORDER BY id)
    INTO through
    FROM driver_ledger WHERE person_id = holder AND acct_ext_id = acct;
  IF through IS NOT NULL THEN
    why := format('The Yango account %s was NOT moved off %s: %s ledger entr%s were recorded '
      || 'through it, and splitting them between two people is a decision, not a sweep. '
      || 'Move the entries deliberately, then detach the account.',
      acct, coalesce(hold_name, 'person ' || holder), jsonb_array_length(through),
      CASE WHEN jsonb_array_length(through) = 1 THEN 'y' ELSE 'ies' END);
    IF NOT EXISTS (
      SELECT 1 FROM driver_ledger_audit
       WHERE action = 'person_split' AND outcome = 'refused'
         AND payload->>'via' = 'sql/schema_v101.sql' AND person_id = holder) THEN
      INSERT INTO driver_ledger_audit (actor, action, outcome, why, person_id, payload)
      VALUES ('operator', 'person_split', 'refused', why, holder,
              jsonb_build_object('from', holder, 'account', acct, 'by', 'operator',
                                 'via', 'sql/schema_v101.sql', 'ruling', ruling,
                                 'entries_through_it', through));
    END IF;
    RAISE WARNING 'schema_v101: %', why;
    RETURN;
  END IF;

  INSERT INTO driver (full_name, created_by, created_note)
  VALUES (coalesce(nullif(btrim(acct_name), ''), 'MUHAMMAD KHALID'), 'operator',
          'split off person ' || holder || ' by sql/schema_v101.sql on the operator''s '
          || 'instruction of 2026-10-08: "unlink these two and put it back in queue"')
  RETURNING id INTO new_id;

  UPDATE driver_platform_id
     SET driver_id = new_id, basis = 'account', linked_by = 'operator', linked_at = now()
   WHERE external_id = acct AND detached_at IS NULL AND driver_id = holder;

  why := format('The Yango account %s ("%s") moved off %s onto a person of its own (%s): '
    || 'the operator asked for the pair to be unlinked and put back in the queue on 2026-10-08, '
    || 'having ruled HR''s roster right that morning — HR files this account under Ecosine '
    || 'D034, Muhammad Khalid Younas Gul, not D076. No ledger entry was recorded through it, '
    || 'so no money moved.',
    acct, coalesce(acct_name, 'MUHAMMAD KHALID'), coalesce(hold_name, 'person ' || holder), new_id);
  INSERT INTO driver_ledger_audit (actor, action, outcome, why, person_id, payload)
  VALUES ('operator', 'person_split', 'accepted', why, holder,
          jsonb_build_object('from', holder, 'to', new_id, 'account', acct,
                             'platform', acct_plat, 'by', 'operator',
                             'via', 'sql/schema_v101.sql', 'ruling', ruling,
                             'reversible_by', 'point this account''s driver_platform_id row back '
                               || 'at the "from" person and delete the "to" person, which '
                               || 'holds nothing else'));
END
$mig$;
