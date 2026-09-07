-- ---------------------------------------------------------------------------
-- One car, one row — before a second channel starts describing the same cars.
-- ---------------------------------------------------------------------------
-- vehicle_profile's primary key is (platform, vehicle_ext_id) with only a
-- non-unique index on plate (sql/schema_v5.sql:23-42), so the table has always
-- been able to hold one physical car twice. Until now it never did: exactly one
-- collector writes it (src/sources/uber_fleet.js:97), so every plate carried at
-- most one row and four LEFT JOINs in the read API were written as though that
-- were a property of the table rather than of who happened to be filling it.
--
--   api/vehicle_routes.js:294   the car directory  — LEFT JOIN vp ON vp.plate = p.plate
--   api/vehicle_routes.js:666   one car's spec     — same, then `const [spec] =`
--   api/cohort_routes.js:192    the cohort decor   — same
--   api/analytics_routes.js:994 the trip decor     — same, on a normalised plate
--
-- Yango's key API answers /v1/parks/cars/list with 104 cars carrying VINs, and
-- writing them would have made every one of those four wrong on the same day:
-- the directory would print a car known to both channels TWICE, and the three
-- `const [row] =` readers would take an arbitrary one of the two, so a car's
-- make, model, year and VIN could change between two requests with nothing
-- changed underneath. api/economics_routes.js:447 already carries the fix for
-- its own copy of this, in JS, with the comment explaining why — which is the
-- signal that the rule wanted to live in one place instead of five.
--
-- So: one row per plate, here, once.
--
-- ── how a conflict is settled, and why it is a COALESCE and not a pick ──────
-- Choosing a winning row would throw away what only the loser knows, and the
-- two channels are complementary rather than redundant: Uber carries the image
-- and the compliance status and Yango carries a VIN for cars Uber has none for.
-- So every scalar is coalesced across the channels in a stated order, and the
-- order is a preference for the FULLER record rather than a claim that one
-- provider is more truthful: uber first because it is what this product has
-- always displayed and a redeploy must not silently change what a car looks
-- like, then yango, then anything a later collector adds, alphabetically, so
-- the answer never depends on insertion order.
--
-- platform and vehicle_ext_id are NOT coalesced away, and they are NOT a
-- provenance claim about the values beside them. They name the FIRST record in
-- the order above, which is a stable way to open one of a car's rows; every
-- scalar is coalesced independently, so a plate whose uber row has no make and
-- whose yango row does reports platform 'uber' and make 'Tesla' from the yango
-- row. `platforms` lists every channel holding a record, and `vin_platforms`
-- the smaller set that actually filed a VIN — the two are different questions
-- and a page that answers one with the other overclaims.
--
-- ── why a view and not a table ─────────────────────────────────────────────
-- Nothing here is a new fact. It is the same rows, resolved, and a table would
-- be a second copy to keep in step with a collector that rewrites its half
-- every run. The view is cheap: vehicle_profile is in the low hundreds of rows
-- and vehprofile_plate_idx already indexes the column it groups on.
--
-- CREATE OR REPLACE VIEW can add a column but never remove or reorder one, so
-- a later change to this shape needs a new name or a DROP first — the trap
-- recorded in docs/COVERAGE.md, and the reason the column list below is
-- written out in full rather than as SELECT *.

CREATE OR REPLACE VIEW vehicle_plate AS
WITH ranked AS (
  SELECT vp.*,
         /* uber, then yango, then everything else alphabetically — and
            vehicle_ext_id last so two rows of the same platform still order
            deterministically rather than by whatever the heap returns. */
         row_number() OVER (PARTITION BY vp.plate
           ORDER BY CASE vp.platform WHEN 'uber' THEN 0 WHEN 'yango' THEN 1 ELSE 2 END,
                    vp.platform, vp.vehicle_ext_id) AS rn
    FROM vehicle_profile vp
   WHERE vp.plate IS NOT NULL AND btrim(vp.plate) <> ''
)
SELECT plate,
       /* The record a reader is looking at, so the page can name its source. */
       min(platform)       FILTER (WHERE rn = 1) AS platform,
       min(vehicle_ext_id) FILTER (WHERE rn = 1) AS vehicle_ext_id,
       array_agg(DISTINCT platform)                AS platforms,
       /* The channels that filed a VIN, which is NOT the same set as the
          channels that hold a record.
          ─────────────────────────────────────────────────────────────────
          `platforms` says who has a row. A page that reads it as "who agrees
          about this car's identity" is wrong in both directions: two rows
          where only one carries a VIN is not two providers agreeing, and two
          rows carrying DIFFERENT VINs is a disagreement that array_agg over
          platforms hides completely. Both facts get their own column, so a
          page cannot claim the first without asking for it. */
       array_remove(array_agg(DISTINCT platform)
         FILTER (WHERE vin IS NOT NULL AND btrim(vin) <> ''), NULL) AS vin_platforms,
       count(DISTINCT upper(btrim(vin)))
         FILTER (WHERE vin IS NOT NULL AND btrim(vin) <> '')::int   AS distinct_vins,
       count(*)::int                               AS profile_rows,
       /* Every scalar: the first channel in the order above that has one.
          min(x) FILTER (WHERE x IS NOT NULL) over rn ordering is not what is
          wanted — it would take the alphabetically smallest VALUE — so each
          column takes the value from the lowest rn that HAS one.

          NULLIF ON EVERY TEXT COLUMN, because array_remove takes out NULLs and
          nothing else. A provider that files a field as the empty string —
          which they do — would otherwise WIN at rn = 1 and hide a real value
          the other channel has, and the page would print nothing while the
          data was there. An empty string is an absent value wearing a
          different type. */
       (array_remove(array_agg(nullif(btrim(make),  '') ORDER BY rn), NULL))[1] AS make,
       (array_remove(array_agg(nullif(btrim(model), '') ORDER BY rn), NULL))[1] AS model,
       (array_remove(array_agg(year          ORDER BY rn), NULL))[1] AS year,
       (array_remove(array_agg(nullif(btrim(colour),     '') ORDER BY rn), NULL))[1] AS colour,
       (array_remove(array_agg(nullif(btrim(colour_hex), '') ORDER BY rn), NULL))[1] AS colour_hex,
       /* Upper-cased as well as trimmed: a VIN is an identifier, and two
          channels spelling it in two cases is one car counted twice by any
          reader that puts these in a Set. */
       (array_remove(array_agg(nullif(upper(btrim(vin)), '') ORDER BY rn), NULL))[1] AS vin,
       (array_remove(array_agg(nullif(btrim(image_url),  '') ORDER BY rn), NULL))[1] AS image_url,
       (array_remove(array_agg(nullif(btrim(owner_ext_id), '') ORDER BY rn), NULL))[1] AS owner_ext_id,
       (array_remove(array_agg(nullif(btrim(assigned_driver_ext_id), '') ORDER BY rn), NULL))[1]
                                                                     AS assigned_driver_ext_id,
       (array_remove(array_agg(nullif(btrim(compliance_status), '') ORDER BY rn), NULL))[1]
                                                                     AS compliance_status,
       (array_remove(array_agg(nullif(btrim(fleet_id), '') ORDER BY rn), NULL))[1] AS fleet_id,
       max(updated_at)                                               AS updated_at
  FROM ranked
 GROUP BY plate;

COMMENT ON VIEW vehicle_plate IS
  'One row per plate over vehicle_profile, which is keyed (platform, '
  'vehicle_ext_id) and can therefore hold one physical car once per channel. '
  'Every scalar is the first non-null in the order uber, yango, then '
  'alphabetically, so nothing a channel knows is lost and the displayed value '
  'does not change when a second channel starts describing the same car. '
  'platforms lists every channel that holds a record; profile_rows counts '
  'them. Read this instead of joining vehicle_profile on plate — a plain join '
  'multiplies the calling query''s rows once a car is known twice.';

-- ── the VINs, where somebody can see them ──────────────────────────────────
-- A plate is the fleet's working name for a car and a VIN is the car. Plates in
-- this emirate are reassigned; the VIN is not. The product has held VINs since
-- sql/schema_v5.sql and shows them on exactly one surface — /api/vehicle/
-- profile, one car at a time — so "how many cars do we actually have" could
-- only ever be answered by fetching 273 pages one by one, which is how it was
-- answered, and the answer was a number in a chat rather than a column anybody
-- can look at.
--
-- This index is what makes that a query rather than a sweep. Partial, because a
-- row with no VIN is not a car this can identify and an empty string must not
-- become the bucket every unidentified car falls into — the same shape as the
-- person_key indexes in sql/schema_v53.sql, for the same reason.
CREATE INDEX IF NOT EXISTS vehprofile_vin_idx ON vehicle_profile (vin)
  WHERE vin IS NOT NULL AND vin <> '';
