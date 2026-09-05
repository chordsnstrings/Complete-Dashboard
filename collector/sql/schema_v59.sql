-- Scrub the credentials that are already in the database.
-- ---------------------------------------------------------------------------
-- MEASURED ON PRODUCTION 2026-09-05, with curl and NO credentials — this
-- product has no user authentication, so every /api route answers a request
-- with no cookie, no header and no token:
--
--   /api/trip?platform=hotel&id=…   trip.raw.driver carried `password`
--                                   ($2b$10$…, bcrypt cost 10), `emiratesId`
--                                   784-1999-8885500-5 and `notificationToken`
--                                   ExponentPushToken[…] — on 12 of 12 hotel
--                                   trips sampled, 0 of 36 uber/bolt/yango.
--   /api/probe/results              serves provider_probe.fields verbatim, and
--                                   the same sampler behind
--                                   /api/schema/raw-values has returned bcrypt
--                                   hashes and push tokens outright.
--
-- api/trip_routes.js now redacts on the way out, src/sources/hotel.js no longer
-- writes the driver's credentials at all, and src/probe.js no longer samples a
-- secret-shaped key. Every one of those fixes only changes what happens NEXT.
-- 1,714 stored hotel trip rows hold a bcrypt hash and a push token this
-- morning, and stored provider_probe rows hold sampled secrets; a boundary that
-- redacts is one edit away from not redacting, and a value that is still on
-- disk is still one query from being read. This file removes them.
--
-- ── what comes out, and what deliberately does not ─────────────────────────
-- ONLY the credentials and the government identity number. `raw` is the audit
-- trail this whole product rests on — every "what did the provider actually
-- send" answer is read from it — so this is a scalpel and not a cleaning: three
-- named paths leave each hotel booking and every other field of every other
-- document is untouched, byte for byte. Phone and email STAY, here as
-- everywhere else: the operator asked for them in as many words and #drivers,
-- #roster and every driver page render them. api/redact.js holds that line and
-- the argument for it.
--
-- The keys are named as paths rather than matched by shape because a jsonb
-- operator is not a regex walker and this has to be exactly predictable against
-- 364,015 live rows. The shape-matcher runs in JavaScript, at ingest and at the
-- boundary, where it can be tested; api/redact.js is the authority and this
-- file is a one-off catch-up for what that authority did not exist to stop.
--
-- ── and the row says what was taken ────────────────────────────────────────
-- A field silently missing from `raw` is indistinguishable from a field the
-- provider never sent, and telling those two apart is this product's central
-- claim. So a scrubbed row gets `_redacted`, the array of paths whose values
-- this database no longer holds — the same key src/sources/hotel.js writes on
-- every new booking, so a row cleaned here and a row collected after the fix
-- read identically. What separates them is the audit fact that this migration
-- ran, which is recorded once, with its time, in schema_once.
--
-- ── it runs on every boot, so it must survive running on every boot ────────
-- Both containers replay every file in sql/ from the start at startup, and the
-- migration ledger skips only a file whose sha has not changed — so an edit to
-- ANY line of this file re-runs the whole of it. Three things make that safe:
--
--   1. the schema_once guard below (the pattern from sql/schema_v8.sql:52-67):
--      one row per one-time data change, so the second boot is a no-op;
--   2. every statement is idempotent on its own account anyway — the WHERE
--      clauses select only rows that still carry a secret, so a re-run after
--      the guard row is deleted by hand changes nothing and appends no
--      duplicate path to `_redacted`;
--   3. nothing here fails on an absent key. `#-` on a path that is not there
--      returns the document unchanged, and every row is filtered by `?` before
--      it is touched, so a booking whose driver was never embedded, a NULL
--      `raw`, and a provider that has never been probed are all no-ops rather
--      than errors.
--
-- NOTE FOR WHOEVER LANDS THIS: src/schema_files.js is the list migrate()
-- replays, and a file that is not in it does nothing at all. This migration has
-- to be added there — test/economics_cost.test.mjs asserts that every schema
-- file on disk is in that list, for exactly this reason.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_once WHERE name = 'v59_scrub_stored_credentials') THEN

    /* THE BOOKINGS. The three paths are the hotel channel's, because it is the
       only channel that embeds a whole driver record in its booking — 12 of 12
       against 0 of 36 elsewhere. The filter is on the KEYS and not on
       platform = 'hotel', so a row any other collector wrote in the same shape
       is cleaned by the same statement rather than by a second one nobody
       writes. */
    UPDATE trip
       SET raw = (raw #- '{driver,password}'
                      #- '{driver,notificationToken}'
                      #- '{driver,emiratesId}')
                 || jsonb_build_object('_redacted',
                      /* Appended to whatever the row already declared withheld,
                         never replacing it: a row collected after the collector
                         fix arrives here already carrying `_redacted`, and its
                         history is not this migration's to overwrite. */
                      CASE WHEN jsonb_typeof(raw -> '_redacted') = 'array'
                           THEN raw -> '_redacted' ELSE '[]'::jsonb END
                      || (SELECT coalesce(jsonb_agg(p.path), '[]'::jsonb)
                            FROM (VALUES ('driver.password',          'password'),
                                         ('driver.notificationToken', 'notificationToken'),
                                         ('driver.emiratesId',        'emiratesId'))
                                 AS p(path, key)
                           WHERE raw -> 'driver' ? p.key))
     WHERE jsonb_typeof(raw -> 'driver') = 'object'
       AND (raw -> 'driver' ? 'password'
         OR raw -> 'driver' ? 'notificationToken'
         OR raw -> 'driver' ? 'emiratesId');

    /* THE PROBE. provider_probe.fields is a JSON array of
       {key, type, fill_pct, distinct_seen, distinct_capped, values} and it is
       `values` that carries the samples — a narrow secret (one default
       password across a fleet, say) was sampled outright and /api/probe/results
       serves it to anyone.

       The COUNT survives untouched, because the count is not contents and it is
       the whole reason this table exists: sixty buckets of one is an
       identifier, three buckets of four hundred is a dimension, and neither
       answer needs a value printed. The suppressed row says why it is empty
       rather than looking like a wide field, which is what the page would
       otherwise call it.

       Matched on the LEAF of the dotted path, and with the same words
       api/redact.js's SECRET_KEY uses — transcribed rather than shared,
       because SQL cannot import JavaScript. If that regex grows a term, this
       file does not follow it: it is a catch-up for what is on disk today, and
       what arrives tomorrow is stopped in src/probe.js, which does import it.
       The KEEP list is transcribed with it, or `driver_ext_id` — the join key
       every page is built on — would be suppressed as a credential. */
    WITH elem AS (
      SELECT p.provider, p.surface, e.ord, e.value,
             regexp_replace(coalesce(e.value ->> 'key', ''), '^.*\.', '') AS leaf
        FROM provider_probe p
        CROSS JOIN LATERAL jsonb_array_elements(p.fields) WITH ORDINALITY AS e(value, ord)
       WHERE jsonb_typeof(p.fields) = 'array'
    ),
    judged AS (
      SELECT provider, surface, ord, value,
             (    leaf ~* ('password|passwd|secret|token|otp|pin'
                        || '|emirates|national.?id|nationality.?id'
                        || '|licen[cs]e.?(no|num|number)|passport|visa.?(no|num|number)'
                        || '|iban|account.?(no|num|number)|card.?(no|num|number)'
                        || '|api.?key|auth|credential|cookie|session')
              AND leaf !~* ('^(driver_ext_id|external_id|trip_id|partner_id|org_id'
                        || '|vehicle_id|authorization|authorizations|has_authorization)$')
              /* Only a row that actually printed something. A secret field the
                 probe already suppressed for width carries values: null and is
                 left exactly as it is. */
              AND jsonb_typeof(value -> 'values') = 'array') AS scrub
        FROM elem
    ),
    rebuilt AS (
      SELECT provider, surface, bool_or(scrub) AS changed,
             jsonb_agg(
               CASE WHEN scrub THEN
                 jsonb_set(value, '{values}',
                   '["(withheld — a credential or an identity document by name)"]'::jsonb)
                 || jsonb_build_object(
                      'values_withheld', true,
                      'values_withheld_reason',
                      'This field''s NAME marks it as a credential or an identity document '
                      || '(api/redact.js), so the probe records how many distinct values it saw '
                      || 'and never what they were. The count is real and unredacted: it is what '
                      || 'answers "is this a dimension worth a column, or an identifier?", and it '
                      || 'answers it without printing anything.')
               ELSE value END
               ORDER BY ord) AS fields
        FROM judged GROUP BY provider, surface
    )
    UPDATE provider_probe p
       SET fields = r.fields
      FROM rebuilt r
     WHERE r.provider = p.provider AND r.surface = p.surface AND r.changed;

    INSERT INTO schema_once (name) VALUES ('v59_scrub_stored_credentials');
  END IF;
END $$;

COMMENT ON COLUMN trip.raw IS
  'The provider''s own record, as it arrived. Two things are not in it: a credential or identity document the collector refuses to store (src/sources/hotel.js), and one of those that sql/schema_v59.sql removed from a row already written. Either way the paths taken are listed in raw -> ''_redacted'', so a missing field can never be mistaken for a field the provider did not send. Everything that leaves through an API is redacted again at the boundary — see api/redact.js.';
