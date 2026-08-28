// Derives vehicle→driver custody per day from the trip table.
//
// Every platform that records a plate and a driver on the same trip contributes, so
// this is not Uber-only — it just happens that Uber's report carries both on 99.9%
// of rows. Handovers are preserved: all drivers of a plate on a day are kept, and the
// one with the most trips is marked primary.
import { pool } from './db.js';
import { log } from './log.js';

/* `db` is injectable so a test can run the real rebuild against an in-process
   Postgres rather than reimplementing the fold beside it — a test that builds
   custody its own way proves nothing about the one that ships. Anything with
   pg's .query(text, params) fits, which PGlite does. */
export async function rebuildCustody({ from, to, db = pool } = {}) {
  const q = (t, p) => db.query(t, p).then((r) => r.rows);
  const start = from || new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10);
  const end = to || new Date().toISOString().slice(0, 10);

  // Set-wise in Postgres — pulling 160k rows into Node to group them would be
  // slower and pointless.
  await db.query(
    `INSERT INTO vehicle_driver_day
       (plate, day, driver_ext_id, platform, driver_name, fleet_id, trips, km, revenue, first_trip_at, last_trip_at, is_primary, last_end_at)
     /* The fold itself lives in sql/schema_v19.sql as custody_live. It used to
        be written out here, which meant the rule for who counts as a driver
        existed in two places and drifted: this copy required driver_ext_id IS
        NOT NULL, so anybody a provider names without an id never got a custody
        row — invisible on their vehicle's driver list, unattributable for a
        harsh-driving event, unnameable on an unauthorised segment. Not a rare
        shape either: the hotel channel names a driver on every booking and
        does not always carry an id. This job's only job now is to materialise
        a window of the one definition. */
     SELECT plate, day, driver_ext_id, platform, driver_name, fleet_id,
            trips, km, revenue, first_trip_at, last_trip_at, is_primary, last_end_at
     FROM custody_live
     WHERE day >= $1::date AND day <= $2::date
     ON CONFLICT (plate, day, driver_ext_id, platform) DO UPDATE SET
       driver_name = EXCLUDED.driver_name, fleet_id = EXCLUDED.fleet_id,
       trips = EXCLUDED.trips, km = EXCLUDED.km, revenue = EXCLUDED.revenue,
       first_trip_at = EXCLUDED.first_trip_at, last_trip_at = EXCLUDED.last_trip_at,
       last_end_at = EXCLUDED.last_end_at,
       is_primary = EXCLUDED.is_primary`,
    [start, end]);

  /* is_primary used to be a second pass over the table. It is part of the fold
     now, so a plate-day written by this job is internally consistent the moment
     it lands rather than for the gap between the two statements. */

  const [n] = await q(`SELECT count(*)::int n, count(DISTINCT plate)::int plates,
                              count(DISTINCT driver_ext_id)::int drivers
                       FROM vehicle_driver_day WHERE day >= $1 AND day <= $2`, [start, end]);
  log.info('custody', 'rebuilt', { rows: n.n, plates: n.plates, drivers: n.drivers, from: start, to: end });
  return n.n;
}
