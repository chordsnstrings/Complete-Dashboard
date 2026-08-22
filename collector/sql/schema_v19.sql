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
WITH agg AS (
  SELECT upper(replace(plate, ' ', '')) AS plate,
         (requested_at AT TIME ZONE 'Asia/Dubai')::date AS day,
         -- A driver known only by name is still a driver. The synthesised key
         -- is deterministic and prefixed so it cannot collide with a provider
         -- id; the same expression appears in api/driver_routes.js (PKEY), so a
         -- person keys identically on their own page and on their vehicle's.
         coalesce(nullif(btrim(driver_ext_id), ''),
                  'name:' || lower(regexp_replace(btrim(driver_name), '\s+', ' ', 'g'))) AS driver_ext_id,
         platform,
         max(driver_name) AS driver_name,
         max(fleet_id)    AS fleet_id,
         count(*)::int    AS trips,
         round(sum(distance_km)::numeric, 1)::double precision AS km,
         round(sum(price)::numeric, 2) AS revenue,
         min(requested_at) AS first_trip_at,
         max(requested_at) AS last_trip_at
  FROM trip
  WHERE plate IS NOT NULL AND plate <> ''
    -- One of the two must identify somebody; a row with neither is a
    -- telematics journey and belongs to no driver.
    AND (coalesce(btrim(driver_ext_id), '') <> '' OR coalesce(btrim(driver_name), '') <> '')
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
