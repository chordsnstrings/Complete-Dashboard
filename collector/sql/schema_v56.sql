-- ── the Bolt rows that arrived without their letter code ───────────────────
-- ---------------------------------------------------------------------------
-- A Dubai plate is a letter code and a number — L36397 — and Bolt sometimes
-- files only the digits. normPlate in src/config.js uppercases and strips
-- separators; it cannot put a missing letter back. So the same car became two
-- vehicles. Measured on production over the whole record:
--
--     36397   85 trips   beside L36397
--     64009   38 trips   beside L64009
--     46184   27 trips   beside L46184
--
-- three phantom rows in a 231-vehicle directory, splitting one car's
-- utilisation, safety rate, earnings and custody across two records that never
-- meet. src/sources/bolt.js reconciles this at write time from here on; this
-- repairs what is already stored.
--
-- ONLY WHERE THE ANSWER IS UNAMBIGUOUS. A digits-only plate is moved when
-- exactly ONE lettered plate known to this fleet ends with those digits. Two
-- candidates is a guess, and a guess here silently moves one car's trips onto
-- another car — so it is left alone and stays visible as its own row.
--
-- The candidate list deliberately excludes Bolt's own rows: Bolt is the feed
-- that drops the letter, so letting its rows vote would let a phantom plate
-- confirm itself.

DO $plate$
DECLARE
  r record;
BEGIN
  FOR r IN
    WITH known AS (
      SELECT DISTINCT plate FROM (
        SELECT plate FROM vehicle
        UNION SELECT plate FROM trip WHERE plate IS NOT NULL AND platform <> 'bolt'
      ) v WHERE plate ~ '^[A-Z]+[0-9]+$'
    ),
    bare AS (
      SELECT DISTINCT plate FROM trip
       WHERE platform = 'bolt' AND plate ~ '^[0-9]+$'
    )
    SELECT b.plate AS from_plate, min(k.plate) AS to_plate
      FROM bare b
      JOIN known k ON k.plate LIKE '%' || b.plate
                  AND length(k.plate) > length(b.plate)
     GROUP BY b.plate
    HAVING count(*) = 1          -- unambiguous, or nothing happens
  LOOP
    RAISE NOTICE 'bolt plate %  ->  %', r.from_plate, r.to_plate;
    UPDATE trip SET plate = r.to_plate
     WHERE platform = 'bolt' AND plate = r.from_plate;
    -- The custody and daily rollups key on the plate too, and they are
    -- accumulated rather than rebuilt from scratch on every run.
    UPDATE vehicle_driver_day SET plate = r.to_plate
     WHERE platform = 'bolt' AND plate = r.from_plate
       AND NOT EXISTS (SELECT 1 FROM vehicle_driver_day x
                        WHERE x.platform = 'bolt' AND x.plate = r.to_plate
                          AND x.day = vehicle_driver_day.day
                          AND x.driver_ext_id IS NOT DISTINCT FROM vehicle_driver_day.driver_ext_id);
    -- A row that WOULD collide with the real plate's row for the same
    -- driver-day is deleted rather than merged: the surviving row is the one
    -- built from the lettered plate, and the next rollup recomputes the totals
    -- from trip anyway.
    DELETE FROM vehicle_driver_day
     WHERE platform = 'bolt' AND plate = r.from_plate;
  END LOOP;
END
$plate$;
