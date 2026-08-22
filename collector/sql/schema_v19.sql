-- v19 — one definition of custody, used by both the batch table and the page.
--
-- vehicle_driver_day is rebuilt by a job. Everything that asks "who had this
-- car" read the table, so the answer was only as fresh as the last rebuild and
-- only as wide as its 400-day horizon. On the vehicle page that showed up as a
-- driver panel that was blank while the trip panel beside it listed trips for
-- the same plate and window — the page contradicting itself.
--
-- The fix is not to duplicate the aggregation in the endpoint (two copies of a
-- fold is two answers eventually). It is to name the fold once, here, and have
-- the job insert from it and the page read from it.
CREATE OR REPLACE VIEW custody_live AS
WITH known AS (
  /* One provider id per canonical name, for people who carry an id SOMEWHERE.
     Without this, a driver who works Uber under an id and the hotel channel
     without one becomes two custodians of the same car on the same day: the
     vehicle page lists them twice, the driver count for that plate is one too
     high, and clicking one of the two shows a fraction of their work. Folding
     by exact normalised name is the identity rule this product already uses
     everywhere else — see api/driver_routes.js — so this is not a new claim
     about who is who, only the existing one applied here too. */
  SELECT lower(regexp_replace(btrim(driver_name), '\s+', ' ', 'g')) AS canon,
         min(driver_ext_id) AS driver_ext_id
    FROM trip
   WHERE coalesce(btrim(driver_ext_id), '') <> '' AND coalesce(btrim(driver_name), '') <> ''
   GROUP BY 1
),
agg AS (
  SELECT upper(replace(t.plate, ' ', '')) AS plate,
         (t.requested_at AT TIME ZONE 'Asia/Dubai')::date AS day,
         /* The person key, in preference order: the id this row carries; failing
            that, an id the same person carries elsewhere; failing that, a
            synthesised key from the canonical name — deterministic, and
            prefixed so it can never be mistaken for a provider id. */
         coalesce(nullif(btrim(t.driver_ext_id), ''), k.driver_ext_id,
                  'name:' || lower(regexp_replace(btrim(t.driver_name), '\s+', ' ', 'g'))) AS driver_ext_id,
         t.platform,
         max(t.driver_name) AS driver_name,
         max(t.fleet_id)    AS fleet_id,
         count(*)::int      AS trips,
         round(sum(t.distance_km)::numeric, 1)::double precision AS km,
         round(sum(t.price)::numeric, 2) AS revenue,
         min(t.requested_at) AS first_trip_at,
         max(t.requested_at) AS last_trip_at
  FROM trip t
  LEFT JOIN known k ON k.canon = lower(regexp_replace(btrim(t.driver_name), '\s+', ' ', 'g'))
  WHERE t.plate IS NOT NULL AND t.plate <> ''
    -- One of the two must identify somebody; a row with neither is a
    -- telematics journey and belongs to no driver.
    AND (coalesce(btrim(t.driver_ext_id), '') <> '' OR coalesce(btrim(t.driver_name), '') <> '')
  GROUP BY 1, 2, 3, 4
)
SELECT agg.*,
       (row_number() OVER (PARTITION BY plate, day
                           ORDER BY trips DESC, first_trip_at ASC) = 1) AS is_primary
FROM agg;

-- The view groups on the normalised plate and the Dubai day, so a page asking
-- for one plate over one window needs those as index keys or it seq-scans trip.
CREATE INDEX IF NOT EXISTS trip_custody_idx
  ON trip (upper(replace(plate, ' ', '')), ((requested_at AT TIME ZONE 'Asia/Dubai')::date))
  WHERE plate IS NOT NULL AND plate <> '';
