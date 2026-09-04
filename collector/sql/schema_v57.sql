-- ── driver contact details: email, picture, and one phone format ───────────
-- ---------------------------------------------------------------------------
-- driver_compliance has held `phone` since v2, written only by the hotel
-- channel — 132 rows, every one of them carrying a number. The Uber supplier
-- portal returns contact details too, and src/sources/uber_profile.js has been
-- deliberately dropping them since it was written ("none of them is a fact
-- about the work and this is not the place to start holding them"). The
-- operator has now asked for them, so they need somewhere to go.
--
-- WHAT UBER ACTUALLY HAS, measured field by field against the live schema on
-- 2026-09-04 (introspection is disabled server-side, so this was thirty-one
-- candidates, sixteen sub-selections and twenty-one paired probes):
--
--     user.email                                   scalar   answers
--     user.pictureUrl                              scalar   answers
--     user.phone { countryCode nationalPhoneNumber }         answers
--     user.name { firstName lastName }                       answers
--     user.address / homeAddress / city / country  DOES NOT EXIST, on any of
--         SupplierUserEntity, Driver or DriverInfo
--
-- So there is no postal address on that surface and there is no point looking
-- for one again; this file records that so the next person does not repeat the
-- fifty-eight requests it took to establish.
--
-- ONE FORMAT IN ONE COLUMN. The hotel rows are stored as 971543590546 — E.164
-- without the plus — and Uber hands back a country code and a national number
-- separately. A column holding two spellings of a phone number is a column
-- nobody can match on, so both become E.164 WITH the plus, which is the only
-- form that is unambiguous about where the country code ends.

ALTER TABLE driver_compliance ADD COLUMN IF NOT EXISTS email       TEXT;
ALTER TABLE driver_compliance ADD COLUMN IF NOT EXISTS picture_url TEXT;

-- The hotel numbers, normalised to match. Digits only, then a plus: a number
-- that already carries one is left exactly as it is, and anything that is not
-- a plausible international number is left alone rather than guessed at.
UPDATE driver_compliance
   SET phone = '+' || regexp_replace(phone, '[^0-9]', '', 'g')
 WHERE phone IS NOT NULL
   AND phone !~ '^\+'
   AND length(regexp_replace(phone, '[^0-9]', '', 'g')) BETWEEN 10 AND 15;

-- Contact details are looked up by person, so the index is on the name fold
-- rather than on the platform key a caller does not have.
CREATE INDEX IF NOT EXISTS driver_compliance_name_idx
  ON driver_compliance (lower(btrim(full_name)))
  WHERE full_name IS NOT NULL AND btrim(full_name) <> '';
