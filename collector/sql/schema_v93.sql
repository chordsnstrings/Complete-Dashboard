-- v93 — one man on two person rows, joined on the operator's ruling
-- (2026-09-29, looking at the Drivers page): "both of them are the same people".
--
-- ── WHAT THE PAGE SHOWED, AND WHY THE REGISTER ALONE DOES NOT FIX IT ────────
-- /api/drivers/directory for 2026-08-31..2026-09-29, read on production the
-- same day, listed him twice:
--
--   "Ali Abbas Ahmed"       uber  9e9060e7-0b8c-4f3b-8cd7-165d5eac55cd
--                           42 trips in the window, 3,516 ever      (person 101)
--   "Ali Abbas Faiz Ahmed"  bolt  6623821 + b17bcd50-e20b-4055-80d8-468131188397
--                           5 trips in the window, 535 ever         (person 115)
--
-- both Egari, both with L25054 as their usual vehicle. Two mechanisms kept them
-- apart, and this file is the second:
--
--   1. api/identity_map.js held the pair in PENDING over a single-trip
--      contradiction on 2025-08-31, so the stored person_key filed the Bolt
--      trips under "ali abbas faiz ahmed". The ruling moves the pair to
--      HAND_MERGES and sql/schema_v53.sql is regenerated from it — every
--      rollup keyed on person_key folds from that.
--
--   2. The directory, the driver page, the ledger and the texts do not group by
--      person_key. They group by the PERSON SPINE — driver + driver_platform_id,
--      built by src/persons.js — and the two records are two person rows there.
--      src/persons.js will see one component once the register joins them, but
--      it folds two person rows ONLY while neither carries money: re-pointing a
--      balance is "an operation somebody authorises and records", which is
--      api/person_merge_routes.js. The operator has authorised it. This file is
--      that recorded merge, made once, by the same statements that route runs.
--
-- ── WHAT MOVES, EXACTLY ──────────────────────────────────────────────────
-- The survivor is the person holding the Uber account — the register's `keep`
-- — and every OTHER person holding either Bolt account folds into it:
--
--   driver_ledger.person_id        every entry: advances, repayments, cash
--                                  deposits, deductions, openings. UPDATE, not
--                                  copy, so nothing is duplicated and nothing
--                                  is left behind; count and sum are preserved.
--   driver_platform_id.driver_id   every account row, detached ones included
--                                  (they carry a foreign key to the person and
--                                  would otherwise block the delete).
--   driver_ledger_audit.person_id  receipts and audit rows follow the person.
--   sms_outbox.person_id           the texts already sent, so the survivor's
--                                  history is whole and nothing dangles on a
--                                  deleted id (no foreign key would catch it).
--   driver.cash_rule               carried only where the survivor has none.
--
-- What does NOT move, as in the route: acct_platform/acct_ext_id and
-- person_name on each entry. They are evidence of what happened when it was
-- recorded and stay true whatever is decided afterwards about identity.
--
-- One audit row per folded person records all of it — every entry id with its
-- amount, book, type and date, every account, every audit and sms row id —
-- so the merge is undone by reading that row, not by guessing.
--
-- ── WHEN IT REFUSES, AND WHY THAT IS NOT A FAILURE ──────────────────────
-- If the survivor AND the folded person each carry an opening of the same kind
-- (cash_opening, or opening_balance), the merge would lose or double one of
-- them, depending on the page: /api/ledger/exposure takes the LATEST
-- cash_opening per person, and the driver register SUMS them. Which opening is
-- right is not something a migration can know. So it merges nothing, writes a
-- REFUSED audit row naming both openings, and raises a warning; the two rows
-- stay apart until somebody resolves the openings and folds them through
-- POST /api/person/merge. A merge that silently changed a balance would be the
-- mistake this ledger exists to make impossible.
--
-- ── IDEMPOTENT ───────────────────────────────────────────────────────────
-- On a database where the Uber account is not placed yet — every fresh one,
-- every test — there is nothing to merge and src/persons.js places all three
-- accounts on ONE person from the register on its first pass. Once merged,
-- every account is on the survivor and the loop finds nobody: a replay moves
-- nothing and writes no second audit row. test/identity_ruling_ali_abbas.test.mjs
-- runs it twice over seeded money and asserts both.
DO $mig$
DECLARE
  keep_acct   CONSTANT text   := '9e9060e7-0b8c-4f3b-8cd7-165d5eac55cd';
  alias_accts CONSTANT text[] := ARRAY['6623821', 'b17bcd50-e20b-4055-80d8-468131188397'];
  ruling      CONSTANT jsonb  := jsonb_build_object(
    'by', 'operator', 'on', '2026-09-29', 'words', 'both of them are the same people',
    'over', jsonb_build_array('2025-08-31'),
    'register', 'api/identity_map.js, HAND_MERGES — key ''ali abbas ahmed''');
  keep_id    bigint;
  keep_name  text;
  keep_rule  text;
  d          record;
  clash      jsonb;
  accts      jsonb;
  entries    jsonb;
  n_entries  int;
  amt        numeric;
  audit_ids  jsonb;
  sms_ids    jsonb;
  why        text;
BEGIN
  SELECT a.driver_id, dr.full_name, dr.cash_rule
    INTO keep_id, keep_name, keep_rule
    FROM driver_platform_id a JOIN driver dr ON dr.id = a.driver_id
   WHERE a.external_id = keep_acct AND a.detached_at IS NULL
   ORDER BY a.driver_id LIMIT 1;
  IF keep_id IS NULL THEN
    RETURN;   -- not placed yet: the spine places all three on one person itself
  END IF;

  FOR d IN
    SELECT DISTINCT dr.id, dr.full_name, dr.cash_rule
      FROM driver_platform_id a JOIN driver dr ON dr.id = a.driver_id
     WHERE a.external_id = ANY (alias_accts) AND a.detached_at IS NULL
       AND a.driver_id <> keep_id
     ORDER BY dr.id
  LOOP
    /* The refusal: an opening of the same kind on both sides. */
    SELECT jsonb_agg(jsonb_build_object('type', type_code, 'person_id', person_id,
                                        'entry_id', id, 'amount', amount,
                                        'on', to_char(effective_on, 'YYYY-MM-DD'))
                     ORDER BY type_code, person_id, id)
      INTO clash
      FROM driver_ledger e
     WHERE e.person_id IN (keep_id, d.id)
       AND e.type_code IN ('cash_opening', 'opening_balance')
       AND e.entry_source <> 'verification'
       AND e.type_code IN (
         SELECT type_code FROM driver_ledger
          WHERE person_id = keep_id AND type_code IN ('cash_opening', 'opening_balance')
            AND entry_source <> 'verification'
         INTERSECT
         SELECT type_code FROM driver_ledger
          WHERE person_id = d.id AND type_code IN ('cash_opening', 'opening_balance')
            AND entry_source <> 'verification');
    IF clash IS NOT NULL THEN
      why := format('%s was NOT folded into %s: both carry an opening of the same kind, and '
        || 'merging would lose or double one of them (exposure reads the latest cash opening, '
        || 'the register sums them). Resolve the openings, then fold through '
        || 'POST /api/person/merge. The operator ruled them one person on 2026-09-29.',
        coalesce(d.full_name, 'person ' || d.id), coalesce(keep_name, 'person ' || keep_id));
      /* Once. The migration ledger records this file after a clean run, so
         production reaches here one time; a replay anywhere else must not
         stack a second refusal on top of the first. */
      IF NOT EXISTS (
        SELECT 1 FROM driver_ledger_audit
         WHERE action = 'person_merge' AND outcome = 'refused'
           AND payload->>'via' = 'sql/schema_v93.sql'
           AND (payload->>'drop')::bigint = d.id AND (payload->>'keep')::bigint = keep_id) THEN
        INSERT INTO driver_ledger_audit (actor, action, outcome, why, person_id, payload)
        VALUES ('operator', 'person_merge', 'refused', why, keep_id,
                jsonb_build_object('keep', keep_id, 'drop', d.id, 'by', 'operator',
                                   'via', 'sql/schema_v93.sql', 'ruling', ruling,
                                   'openings_on_both', clash));
      END IF;
      RAISE WARNING 'schema_v93: %', why;
      CONTINUE;
    END IF;

    SELECT coalesce(jsonb_agg(jsonb_build_object('platform', platform, 'ext_id', external_id,
                                                 'detached', detached_at IS NOT NULL)
                              ORDER BY platform, external_id), '[]'::jsonb)
      INTO accts FROM driver_platform_id WHERE driver_id = d.id;
    SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'amount', amount, 'book', book,
                                                 'type', type_code,
                                                 'on', to_char(effective_on, 'YYYY-MM-DD'))
                              ORDER BY id), '[]'::jsonb),
           count(*), coalesce(sum(amount), 0)
      INTO entries, n_entries, amt
      FROM driver_ledger WHERE person_id = d.id;
    SELECT coalesce(jsonb_agg(id ORDER BY id), '[]'::jsonb) INTO audit_ids
      FROM driver_ledger_audit WHERE person_id = d.id;
    SELECT coalesce(jsonb_agg(id ORDER BY id), '[]'::jsonb) INTO sms_ids
      FROM sms_outbox WHERE person_id = d.id;

    UPDATE driver_ledger       SET person_id = keep_id WHERE person_id = d.id;
    UPDATE driver_platform_id  SET driver_id = keep_id WHERE driver_id = d.id;
    UPDATE driver_ledger_audit SET person_id = keep_id WHERE person_id = d.id;
    UPDATE sms_outbox          SET person_id = keep_id WHERE person_id = d.id;
    IF keep_rule IS NULL AND d.cash_rule IS NOT NULL THEN
      UPDATE driver SET cash_rule = d.cash_rule WHERE id = keep_id;
      keep_rule := d.cash_rule;
    END IF;

    why := format('%s folded into %s: the operator ruled on 2026-09-29, "both of them are the '
      || 'same people", over the one-trip contradiction of 2025-08-31 that had held the pair in '
      || 'PENDING. Moved %s account(s) and %s ledger entr%s worth %s.',
      coalesce(d.full_name, 'person ' || d.id), coalesce(keep_name, 'person ' || keep_id),
      jsonb_array_length(accts), n_entries, CASE WHEN n_entries = 1 THEN 'y' ELSE 'ies' END,
      round(amt, 2));
    INSERT INTO driver_ledger_audit (actor, action, outcome, why, person_id, payload)
    VALUES ('operator', 'person_merge', 'accepted', why, keep_id,
            jsonb_build_object(
              'keep', keep_id, 'drop', d.id, 'by', 'operator', 'why', why,
              'via', 'sql/schema_v93.sql', 'ruling', ruling,
              'accounts_moved', accts,
              'entries_moved', entries,
              'moved_amount', round(amt, 2),
              'audit_rows_moved', audit_ids,
              'sms_rows_moved', sms_ids,
              'cash_rule', jsonb_build_object('survivor_after', keep_rule, 'dropped', d.cash_rule),
              'reversible_by', 'move these entry, audit and sms ids back to the dropped person id '
                || '(re-created with its old name) and re-attach the accounts listed above'));

    DELETE FROM driver WHERE id = d.id;
  END LOOP;
END
$mig$;
