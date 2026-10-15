-- v108 — Mohammad Shahin Mohammad Shahazanan: the operator's ruling of
-- 2026-10-15 that the Bolt "Mohammad Shahin Mohammad Shahazan" (6628697) and the
-- Uber "Mohammad Shahin Mohammad Shahazanan" (47f7edb9, with his hotel record
-- 67483c64…129) are one man, made one person row.
--
-- The bottom-45 driver report (14 Sep – 13 Oct 2026) listed them at #1 and #42
-- and flagged them instead of merging them on a name. Measured on production
-- over both whole histories: the two records moved through the same five cars
-- in the same order on the same dates (L44286, L76101, L75122 for one day on
-- both, L44305 from 2025-10-03 to 2026-04-25 on both, L77059 from 2026-08-29);
-- 227 of the Bolt record's 302 days are days the Uber record worked the same
-- car, 179 of them interleaved; never two cars within ten minutes. The
-- operator: "Yes merge". api/identity_map.js carries it as the last
-- HAND_MERGES entry, key 'mohammad shahin mohammad shahazanan' — the key the
-- roster sweep had already given his Uber and hotel records — and
-- sql/schema_v53.sql is regenerated from it.
--
-- The Drivers page groups by the person spine instead, which folds two person
-- rows only while neither carries money, and on production they were two rows
-- (person 99 with the Uber and hotel accounts, person 223 with the Bolt one).
-- So, exactly as sql/schema_v105.sql did for Shajahan Machilakath, the ruling
-- is the authorisation and this file is the recorded merge: the same
-- statements, the same two refusals (an opening of one kind on both rows;
-- somebody else's account on the row that would fold), one audit row that
-- says how to undo it. The survivor is the row holding the Uber account
-- 47f7edb9; any other row holding his accounts folds into it.
--
-- Idempotent and a no-op on a fresh database, exactly as v105: nothing placed,
-- nothing to fold; once folded, the loop finds nobody.
--
-- The list is the register's entry, and test/identity_shahazan_merge.test.mjs
-- fails if the two drift.
DO $mig$
DECLARE
  people CONSTANT jsonb := $list$[
{"k":"mohammad shahin mohammad shahazanan","keep":"47f7edb9-b533-45b9-8f42-2f383b8384bb","alias":["6628697","67483c64055e070d79100129"],"words":["Yes merge"]}
]$list$::jsonb;
  p          jsonb;
  keep_acct  text;
  key_ids    text[];
  keep_id    bigint;
  keep_name  text;
  keep_rule  text;
  d          record;
  clash      jsonb;
  foreign_a  jsonb;
  accts      jsonb;
  entries    jsonb;
  n_entries  int;
  amt        numeric;
  audit_ids  jsonb;
  sms_ids    jsonb;
  ruling     jsonb;
  why        text;
BEGIN
  FOR p IN SELECT value FROM jsonb_array_elements(people) LOOP
    keep_acct := p->>'keep';
    key_ids := ARRAY[keep_acct] || ARRAY(SELECT jsonb_array_elements_text(p->'alias'));
    ruling := jsonb_build_object('by', 'operator', 'on', '2026-10-15', 'words', p->'words',
      'register', format('api/identity_map.js — key ''%s''', p->>'k'));
    keep_id := NULL;
    SELECT a.driver_id, dr.full_name, dr.cash_rule
      INTO keep_id, keep_name, keep_rule
      FROM driver_platform_id a JOIN driver dr ON dr.id = a.driver_id
     WHERE a.external_id = ANY (key_ids) AND a.detached_at IS NULL
     ORDER BY (a.external_id = keep_acct) DESC, a.driver_id
     LIMIT 1;
    CONTINUE WHEN keep_id IS NULL;   -- not placed: the spine places them on one row

    FOR d IN
      SELECT DISTINCT dr.id, dr.full_name, dr.cash_rule
        FROM driver_platform_id a JOIN driver dr ON dr.id = a.driver_id
       WHERE a.external_id = ANY (key_ids) AND a.detached_at IS NULL
         AND a.driver_id <> keep_id
       ORDER BY dr.id
    LOOP
      BEGIN
        /* Refusal 1: somebody else's account on the row that would fold. */
        SELECT jsonb_agg(jsonb_build_object('platform', platform, 'ext_id', external_id)
                         ORDER BY platform, external_id)
          INTO foreign_a
          FROM driver_platform_id
         WHERE driver_id = d.id AND detached_at IS NULL
           AND external_id <> ALL (key_ids) AND external_id NOT LIKE 'name:%';
        /* Refusal 2: an opening of the same kind on both rows. */
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
        IF foreign_a IS NOT NULL OR clash IS NOT NULL THEN
          why := format('%s was NOT folded into %s (key ''%s''): %s The operator ruled them one '
            || 'person on 2026-10-15; fold them through POST /api/person/merge once that is resolved.',
            coalesce(d.full_name, 'person ' || d.id), coalesce(keep_name, 'person ' || keep_id), p->>'k',
            CASE WHEN foreign_a IS NOT NULL
              THEN 'that row also holds an account that is not this person''s, and folding it '
                || 'would carry that account onto him.'
              ELSE 'both carry an opening of the same kind, and merging would lose or double one '
                || 'of them (exposure reads the latest cash opening, the register sums them).' END);
          IF NOT EXISTS (
            SELECT 1 FROM driver_ledger_audit
             WHERE action = 'person_merge' AND outcome = 'refused'
               AND payload->>'via' = 'sql/schema_v108.sql'
               AND (payload->>'drop')::bigint = d.id AND (payload->>'keep')::bigint = keep_id) THEN
            INSERT INTO driver_ledger_audit (actor, action, outcome, why, person_id, payload)
            VALUES ('operator', 'person_merge', 'refused', why, keep_id,
                    jsonb_build_object('keep', keep_id, 'drop', d.id, 'by', 'operator',
                                       'via', 'sql/schema_v108.sql', 'key', p->>'k', 'ruling', ruling,
                                       'foreign_accounts', foreign_a, 'openings_on_both', clash));
          END IF;
          RAISE WARNING 'schema_v108: %', why;
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

        why := format('%s folded into %s (key ''%s''): the operator ruled them one person on '
          || '2026-10-15 ("%s"). Moved %s account(s) and %s ledger entr%s worth %s.',
          coalesce(d.full_name, 'person ' || d.id), coalesce(keep_name, 'person ' || keep_id),
          p->>'k', (SELECT string_agg(w, '"; "') FROM jsonb_array_elements_text(p->'words') w),
          jsonb_array_length(accts), n_entries, CASE WHEN n_entries = 1 THEN 'y' ELSE 'ies' END,
          round(amt, 2));
        INSERT INTO driver_ledger_audit (actor, action, outcome, why, person_id, payload)
        VALUES ('operator', 'person_merge', 'accepted', why, keep_id,
                jsonb_build_object(
                  'keep', keep_id, 'drop', d.id, 'by', 'operator', 'why', why,
                  'via', 'sql/schema_v108.sql', 'key', p->>'k', 'ruling', ruling,
                  'accounts_moved', accts,
                  'entries_moved', entries,
                  'moved_amount', round(amt, 2),
                  'audit_rows_moved', audit_ids,
                  'sms_rows_moved', sms_ids,
                  'cash_rule', jsonb_build_object('survivor_after', keep_rule, 'dropped', d.cash_rule),
                  'reversible_by', 'move these entry, audit and sms ids back to the dropped person id '
                    || '(re-created with its old name) and re-attach the accounts listed above'));

        DELETE FROM driver WHERE id = d.id;
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'schema_v108: person % (key %) could not be folded into %: %',
          d.id, p->>'k', keep_id, SQLERRM;
      END;
    END LOOP;
  END LOOP;
END
$mig$;
