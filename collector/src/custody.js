// Derives vehicle→driver custody per day from the trip table.
//
// Every platform that records a plate and a driver on the same trip contributes, so
// this is not Uber-only — it just happens that Uber's report carries both on 99.9%
// of rows. Handovers are preserved: all drivers of a plate on a day are kept, and the
// one with the most trips is marked primary.
import { pool } from './db.js';
import { log } from './log.js';

const q = (t, p) => pool.query(t, p).then((r) => r.rows);

export async function rebuildCustody({ from, to } = {}) {
  const start = from || new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10);
  const end = to || new Date().toISOString().slice(0, 10);

  // Aggregate straight from trips. Done set-wise in Postgres — pulling 160k rows into
  // Node to group them would be slower and pointless.
  await pool.query(
    `INSERT INTO vehicle_driver_day
       (plate, day, driver_ext_id, platform, driver_name, fleet_id, trips, km, revenue, first_trip_at, last_trip_at)
     SELECT upper(replace(plate,' ','')) AS plate,
            (requested_at AT TIME ZONE 'Asia/Dubai')::date AS day,
            driver_ext_id, platform,
            max(driver_name) AS driver_name,
            max(fleet_id)    AS fleet_id,
            count(*)::int    AS trips,
            round(sum(distance_km)::numeric, 1)::double precision AS km,
            round(sum(price)::numeric, 2)    AS revenue,
            min(requested_at) AS first_trip_at,
            max(requested_at) AS last_trip_at
     FROM trip
     WHERE plate IS NOT NULL AND plate <> ''
       AND driver_ext_id IS NOT NULL AND driver_ext_id <> ''
       AND requested_at >= $1 AND requested_at < ($2::date + 1)
     GROUP BY 1,2,3,4
     ON CONFLICT (plate, day, driver_ext_id, platform) DO UPDATE SET
       driver_name = EXCLUDED.driver_name,
       trips = EXCLUDED.trips, km = EXCLUDED.km, revenue = EXCLUDED.revenue,
       first_trip_at = EXCLUDED.first_trip_at, last_trip_at = EXCLUDED.last_trip_at`,
    [start, end]);

  // Mark the primary driver per plate-day (most trips wins; earliest start breaks ties).
  await pool.query(
    `WITH ranked AS (
       SELECT plate, day, driver_ext_id, platform,
              row_number() OVER (PARTITION BY plate, day ORDER BY trips DESC, first_trip_at ASC) rn
       FROM vehicle_driver_day
       WHERE day >= $1 AND day <= $2)
     UPDATE vehicle_driver_day v
        SET is_primary = (r.rn = 1)
     FROM ranked r
     WHERE v.plate = r.plate AND v.day = r.day
       AND v.driver_ext_id = r.driver_ext_id AND v.platform = r.platform`,
    [start, end]);

  const [n] = await q(`SELECT count(*)::int n, count(DISTINCT plate)::int plates,
                              count(DISTINCT driver_ext_id)::int drivers
                       FROM vehicle_driver_day WHERE day >= $1 AND day <= $2`, [start, end]);
  log.info('custody', 'rebuilt', { rows: n.n, plates: n.plates, drivers: n.drivers, from: start, to: end });
  return n.n;
}
