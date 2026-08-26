/* The vehicle directory, rewritten to read the trip table once.
   ─────────────────────────────────────────────────────────────────────────
   The page timed out at a year and the query it ran said why: it read the
   whole of trip three times. Once for the register of plates, which has no
   window in it and never can; once for the window itself; and once more for
   the self-join that reached the stored account fold, because trip_norm is
   SELECT t.* and a view's column list is frozen at creation, so the only way
   to a column added later is the base table.

   None of that is visible in the answer, which is the point of this file: the
   register is now descended through the index on plate rather than scanned,
   the window is reduced to one row per vehicle, day, platform and account
   before anything DISTINCT is asked of it, and the fold runs on what survives
   instead of on every trip. The rows must not have moved a byte.

   So the query as it stood is written out below, verbatim, and the query that
   ships is read out of api/vehicle_routes.js — never copied here, because a
   copy is a second definition and this test exists to prove there is one. Both
   run against the same fixture and every row must match, on the wide fleet as
   well as the small one: 240 plates is where a fold that merges two vehicles,
   or a grain that loses a day, stops being invisible. */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { applySchema } from './schema.mjs';
import { seedFleet, PLATES, WIDE_PLATES } from './fixture.mjs';
import { rebuildCustody } from '../src/custody.js';
import { peopleCountStored, personKey, JOIN_TRIP } from '../api/custody_sql.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

/* ── the query that shipped before this, frozen ─────────────────────────── */
const OLD = `WITH plates AS (
         SELECT DISTINCT plate FROM (
           SELECT plate FROM trip WHERE plate IS NOT NULL AND plate <> ''
           UNION SELECT plate FROM telemetry_snapshot
           UNION SELECT plate FROM vehicle_document WHERE plate IS NOT NULL
         ) s
       ),
       t AS (
         SELECT n.plate,
                count(*) FILTER (WHERE n.is_booking)::int trips,
                count(*) FILTER (WHERE NOT n.is_booking)::int telematics_journeys,
                count(DISTINCT n.local_day) FILTER (WHERE n.is_booking)::int days,
                count(DISTINCT n.local_day)::int days_moved,
                round(sum(n.distance_km) FILTER (WHERE n.is_booking AND n.has_distance)::numeric,0) km,
                round(sum(n.distance_km) FILTER (WHERE NOT n.is_booking AND n.has_distance)::numeric,0) telematics_km,
                round(sum(n.price) FILTER (WHERE n.has_fare)::numeric,0) revenue,
                count(*) FILTER (WHERE n.has_fare)::int priced_trips,
                ${peopleCountStored()}::int drivers,
                count(DISTINCT n.platform)::int platforms,
                max(n.requested_at) FILTER (WHERE n.is_booking) last_trip,
                max(n.requested_at) last_movement,
                min(n.fleet_id) fleet_id
         FROM trip_norm n ${JOIN_TRIP}
         WHERE n.local_day BETWEEN $1::date AND $2::date AND n.plate IS NOT NULL AND n.plate <> ''
         GROUP BY n.plate
       ),
       tel AS (
         SELECT DISTINCT ON (plate) plate, captured_at last_fix, polled_at, status, speed
         FROM telemetry_snapshot ORDER BY plate, captured_at DESC
       ),
       doc AS (
         SELECT plate, min(expires_at) soonest_expiry, count(*)::int docs
         FROM vehicle_document WHERE expires_at IS NOT NULL GROUP BY plate
       ),
       al AS (
         SELECT plate, count(*)::int alerts FROM alert
         WHERE (occurred_at AT TIME ZONE 'Asia/Dubai')::date BETWEEN $1::date AND $2::date
         GROUP BY plate
       )
       SELECT p.plate,
              coalesce(t.trips,0) trips,
              coalesce(t.telematics_journeys,0) telematics_journeys,
              coalesce(t.days,0) days, coalesce(t.days_moved,0) days_moved,
              t.km, t.telematics_km, t.revenue, coalesce(t.priced_trips,0) priced_trips,
              coalesce(t.drivers,0) drivers, coalesce(t.platforms,0) platforms,
              t.last_trip, t.last_movement,
              coalesce(t.fleet_id, v.fleet_id, vp.fleet_id) fleet_id,
              coalesce(v.make, vp.make) make, coalesce(v.model, vp.model) model,
              coalesce(v.year, vp.year) AS year,
              tel.last_fix, tel.status, tel.speed,
              (now() - tel.last_fix > interval '11 minutes') stale,
              round(extract(epoch FROM now() - tel.last_fix) / 60)::int fix_age_min,
              doc.soonest_expiry, (doc.soonest_expiry::date - now()::date) doc_days_left,
              coalesce(al.alerts,0) alerts,
              cd.driver_name current_driver, cd.driver_ext_id current_driver_id, cd.as_of driver_as_of
       FROM plates p
       LEFT JOIN t   ON t.plate = p.plate
       LEFT JOIN tel ON tel.plate = p.plate
       LEFT JOIN doc ON doc.plate = p.plate
       LEFT JOIN al  ON al.plate = p.plate
       LEFT JOIN vehicle v ON v.plate = p.plate
       LEFT JOIN vehicle_profile vp ON vp.plate = p.plate
       LEFT JOIN vehicle_current_driver cd ON cd.plate = p.plate
       ORDER BY coalesce(t.trips,0) DESC, p.plate
       LIMIT 500`;

/* ── and the one that ships, read out of the route ──────────────────────── */
const SRC = readFileSync('api/vehicle_routes.js', 'utf8');
const AT = SRC.indexOf("app.get('/api/vehicles/directory'");
if (AT < 0) throw new Error('/api/vehicles/directory is no longer declared in api/vehicle_routes.js');
const OPEN = SRC.indexOf('`WITH RECURSIVE driven AS (', AT);
if (OPEN < 0) throw new Error('the directory query does not start where this test looks for it');
const ROUTE = SRC.slice(AT, SRC.indexOf('`, [from, to])', AT));
let NEW = SRC.slice(OPEN + 1, SRC.indexOf('`, [from, to])', AT));
NEW = NEW.replace("${personKey('a.driver_ext_id', 'a.driver_name')}",
  personKey('a.driver_ext_id', 'a.driver_name'));
if (/\$\{/.test(NEW)) throw new Error(`the route interpolates something this test does not substitute: ${NEW.match(/\$\{[^}]*\}/g)}`);

const WIN = ['2026-08-01', '2026-08-31'];

async function compare(label, db) {
  const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
  const before = await q(OLD, WIN);
  const after = await q(NEW, WIN);
  check(`${label}: the rewrite returns the same number of rows`,
    before.length === after.length && before.length > 0, `${before.length} vs ${after.length}`);
  /* fix_age_min is minutes since now(), and the two queries are two calls, so
     it cannot be identical by construction — it differs by one whenever the
     pair straddles a minute boundary. Comparing it made this test fail roughly
     once in every few runs and say nothing true when it did. It is compared as
     a bound instead, which is the only claim there is to make about it. */
  const CLOCK = 'fix_age_min';
  const fixed = (r) => JSON.stringify(Object.fromEntries(
    Object.entries(r).filter(([k]) => k !== CLOCK)));
  const diffs = [];
  for (let i = 0; i < Math.min(before.length, after.length); i++) {
    if (fixed(before[i]) !== fixed(after[i])) {
      diffs.push(`row ${i}: ${JSON.stringify(before[i])} vs ${JSON.stringify(after[i])}`);
    }
  }
  const drift = before.map((b, i) => Math.abs((b[CLOCK] ?? 0) - (after[i]?.[CLOCK] ?? 0)));
  check(`${label}: and the clock-derived age agrees to the minute`,
    drift.every((d) => d <= 1), `max drift ${Math.max(0, ...drift)}`);
  check(`${label}: and every row identical, in the same order`, diffs.length === 0,
    diffs.slice(0, 2).join(' | '));
  return after;
}

console.log('\nthe small fleet: every column, unmoved');

const db = new PGlite();
await applySchema(db);
await seedFleet(db);
await rebuildCustody({ from: WIN[0], to: WIN[1], db });
const small = await compare('small fleet', db);
check('and it is a fleet, not an empty answer',
  small.length >= PLATES.length, `${small.length} plates`);

/* The register has no window in it. A vehicle whose only trip is outside the
   window is still an asset the operator is paying for, and the whole reason
   the plate list is built from the whole record rather than from the window
   is that it must appear — with a dash for its work, never a zero it did not
   do. Descending the index instead of scanning the table must not change
   that, so the case is asserted here rather than assumed. */
await db.query(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
     requested_at, status, distance_km)
   VALUES ('uber','older-1','ecosine','A00001','u-old','Older Driver',
           '2025-02-11T09:00:00+04:00','completed',9)`);
/* Alphabetically past every seeded plate, so the walk has to reach its last
   value rather than stopping at the one before. */
await db.query(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
     requested_at, status, distance_km)
   VALUES ('uber','older-2','ecosine','ZZ9999','u-old','Older Driver',
           '2025-02-12T09:00:00+04:00','completed',9)`);
/* A plate nobody typed. It used to be inserted two ways here — NULL and the
   empty string — because the collector wrote both: normPlate returned '' for
   anything that normalised away, so "no vehicle" was recorded two different
   ways and every guard downstream had been written for one of them.

   sql/schema_v32.sql fixes that at the source (normPlate returns null) and adds
   `CHECK (plate <> '')`, so the blank row this test used to insert is now
   rejected by the database. The check below proves the constraint holds rather
   than proving the directory survives the row: an insert that cannot happen is
   a better guarantee than a filter that catches it. */
await db.query(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, requested_at, status)
   VALUES ('fms','null-1','ecosine',NULL,'2026-08-04T09:00:00+04:00','completed')`);
let blankRejected = false;
try {
  await db.query(
    `INSERT INTO trip (platform, external_id, fleet_id, plate, requested_at, status)
     VALUES ('fms','blank-1','ecosine','','2026-08-04T09:00:00+04:00','completed')`);
} catch (e) { blankRejected = /plate_not_blank/.test(String(e.message || e)); }

const edges = await compare('with plates outside the window', db);
const plates = edges.map((r) => r.plate);
check('a vehicle whose only trip predates the window still has a row',
  plates.includes('A00001'), JSON.stringify(plates));
check('and so does one sorting past every other plate',
  plates.includes('ZZ9999'), JSON.stringify(plates));
check('a vehicle with no work in the window reports absence, not zero distance',
  edges.find((r) => r.plate === 'A00001')?.km == null,
  JSON.stringify(edges.find((r) => r.plate === 'A00001')));
check('a blank plate is not a vehicle', !plates.includes(''), JSON.stringify(plates));
check('and the database refuses to store one at all', blankRejected,
  'CHECK (plate <> \'\') is missing — a blank plate can be written again');

console.log('\nthe wide fleet: 240 plates, where folding and truncation show');

const wide = new PGlite();
await applySchema(wide);
await seedFleet(wide, { wide: true });
await rebuildCustody({ from: WIN[0], to: WIN[1], db: wide });
const many = await compare('wide fleet', wide);
check('the wide fleet really is wide', many.length >= WIDE_PLATES, `${many.length} plates`);
check('and its head-count survives the reduction',
  many.every((r) => r.drivers >= 0) && many.some((r) => r.drivers > 0),
  JSON.stringify(many.slice(0, 2).map((r) => [r.plate, r.drivers])));

console.log('\nwhat the query must not go back to');

/* The self-join is what read the table a second time, and it was there only to
   reach person_key. The fold is the same value either way, so the shape that
   must not return is the join, not the column. */
check('the directory no longer joins the base table for one column',
  !ROUTE.includes(JOIN_TRIP) && !/person_key/.test(ROUTE),
  'the self-join is back, and with it a second read of the whole trip table');

/* Matching the partial index's own predicate is what took the driver
   directory from 4.3 seconds to 41: the planner chose that index and then
   fetched a heap row for nearly every row in the table. Nothing here may
   filter on the folded column. */
check('and nothing here filters on the folded column',
  !/WHERE[^)]*person_key/.test(ROUTE),
  'a person_key predicate makes the planner choose the partial index');

/* The register walks trip_plate_idx one plate at a time. Without that index
   each step of the walk is a scan of the whole table, which is the failure
   this rewrite exists to end, arriving 250 times over. */
const sql = readdirSync('sql').filter((f) => f.endsWith('.sql'))
  .map((f) => readFileSync(`sql/${f}`, 'utf8')).join('\n');
check('the index the plate register walks is declared',
  /CREATE INDEX[^;]*ON trip \(plate\)/i.test(sql),
  'no plain index on trip(plate) — the register would scan the table per plate');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
