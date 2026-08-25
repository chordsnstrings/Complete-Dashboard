-- The empty string is not a licence plate.
-- ─────────────────────────────────────────────────────────────────────────
-- src/config.js normPlate was `(p || '').toUpperCase().replace(/[\s-]+/g, '')`.
-- Given nothing — a missing "Number plate" column in an Uber export, a booking
-- with no vehicle attached — it returned the empty STRING rather than null, and
-- that is what went into the table. So `plate` records a missing vehicle two
-- different ways, and every guard in the product was written for one of them.
--
-- Measured on /api/drivers/cross-platform over a year: 47 of 150 people carried
-- '' in their plate list. `array_agg(DISTINCT …)` sorts ascending so '' sorts
-- FIRST and always took one of the three slots — "the three cars they drove"
-- was two cars and a blank — while count(DISTINCT plate) counted it as a
-- vehicle and `mode() WITHIN GROUP` could return it as the car somebody mostly
-- drives. /api/kpis happened to guard with `AND n.plate <> ''` and the rest did
-- not, so two endpoints answering the same question about the same day could
-- disagree by one. Both look right on their own page.
--
-- normPlate now returns null, so no new row can carry a blank. This is the
-- history. Every column below is nullable and every one of them means "no
-- vehicle" when it is null, which is what the empty string was trying to say.
UPDATE trip               SET plate = NULL WHERE plate IS NOT NULL AND btrim(plate) = '';
UPDATE alert              SET plate = NULL WHERE plate IS NOT NULL AND btrim(plate) = '';
UPDATE driver_performance SET plate = NULL WHERE plate IS NOT NULL AND btrim(plate) = '';

-- Belt and braces: the write path is fixed and the history is cleaned, so the
-- only way a blank returns is a new source that does not use normPlate. A
-- constraint says so at the moment it happens rather than three pages later.
-- NOT VALID so the migration cannot fail on a row this file has not reached;
-- the check applies to every INSERT and UPDATE from here on.
DO $$
BEGIN
  ALTER TABLE trip  ADD CONSTRAINT trip_plate_not_blank  CHECK (plate <> '') NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  ALTER TABLE alert ADD CONSTRAINT alert_plate_not_blank CHECK (plate <> '') NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
