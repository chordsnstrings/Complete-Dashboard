/* Background rollups: the aggregates that cost seconds, computed once.
   ─────────────────────────────────────────────────────────────────────────
   Four endpoints took between six and twenty-one seconds and they share a
   shape: they aggregate the ENTIRE trip history, with no window. /api/trend/
   monthly groups every trip ever collected by month, /api/forecast does that
   and then again by day, /api/retention groups every booking by person and
   month. No index helps, because the answer really does depend on every row.

   It is also the same answer for every viewer, and it only changes when the
   collector writes. So it is computed here, after each run, and the pages read
   the result.

   Three things this must not get wrong:

   1. A COUNT DISTINCT cannot be summed. Rolling days up into a month would
      report a driver who worked twenty days as twenty drivers, and summing
      per-platform rows would count one human on Uber and Yango as two — the
      exact bug the person fold exists to prevent. So every grain a page asks
      for is computed at that grain, including the '*' rows that mean "all
      platforms", which are computed and not derived.

   2. It must be verifiable. A precomputed number that quietly disagrees with
      the live query is worse than a slow page, because nothing about it looks
      wrong. test/rollup.test.mjs runs both and asserts they match.

   3. It must say how old it is. rollup_state records every run, and the API
      exposes it, so a page reading a cached answer can date it.  */
import { pool } from './db.js';
import { log } from './log.js';

const SRC = 'rollup';

/* The measures, written once and reused at both grains. `trip_norm` already
   resolves the traps these depend on — is_booking separates a platform booking
   from its telematics twin, has_distance rejects the odometer rows that read
   193,027 km, has_fare excludes complimentary rides — so the rollup inherits
   them rather than restating them and drifting. */
const MEASURES = `
  count(*)::int                                                            AS trips,
  count(*) FILTER (WHERE n.is_booking)::int                                AS bookings,
  count(*) FILTER (WHERE NOT n.is_booking)::int                            AS telematics,
  count(DISTINCT t.person_key) FILTER (WHERE n.is_booking
    AND t.person_key IS NOT NULL AND t.person_key <> '')::int              AS drivers,
  count(DISTINCT n.plate)::int                                             AS vehicles,
  count(DISTINCT n.plate) FILTER (WHERE n.is_booking)::int                 AS earning_vehicles,
  count(*) FILTER (WHERE n.driver_ext_id IS NOT NULL AND n.is_booking)::int AS attributed_trips,
  round(sum(n.price) FILTER (WHERE n.has_fare)::numeric, 2)                AS revenue,
  count(*) FILTER (WHERE n.has_fare)::int                                  AS priced_trips,
  round(sum(n.distance_km) FILTER (WHERE n.has_distance AND n.is_booking)::numeric, 1) AS km,
  count(*) FILTER (WHERE n.has_distance AND n.is_booking)::int             AS measured_trips,
  count(*) FILTER (WHERE n.outcome = 'completed')::int                     AS completed,
  count(*) FILTER (WHERE n.outcome = 'not_completed')::int                 AS not_completed,
  count(*) FILTER (WHERE n.outcome IS NOT NULL)::int                       AS outcome_n`;

/* Every column qualified. trip_norm is SELECT t.* over trip, so the join puts
   two of every base column in scope and an unqualified `plate` is ambiguous —
   Postgres rejects the statement rather than picking one, which is the good
   outcome. The measures read from the view (n) because that is where the
   resolved columns live; only person_key comes from the base table. */

/* person_key lives on `trip`, not on trip_norm — the view is SELECT t.* and
   Postgres froze its column list at creation (see schema_v18/v20). Joining the
   base table back on is what makes the folded distinct count available without
   rebuilding two long view bodies in a third file. */
const FROM_TRIPS = `FROM trip_norm n JOIN trip t ON t.platform = n.platform AND t.external_id = n.external_id`;

/* GROUPING SETS leaves NULL in the columns a set did not group by, and NULL is
   also a legitimate fleet_id on a row we could not attribute. coalesce alone
   cannot tell the two apart, so the sets are labelled with GROUPING() and the
   '*' is applied from the label. */
/* Every (platform, fleet) combination a page can ask for, including the '*'
   rows, computed in one pass by GROUPING SETS rather than four queries — and,
   the part that matters, each distinct count computed at its own grain instead
   of summed from the others.

   GROUPING SETS leaves NULL in the columns a set did not group by, and NULL is
   also a legitimate fleet_id on a row we could not attribute. coalesce alone
   cannot tell those apart — it would file every unattributed trip under "all
   fleets" and double the totals — so the sets are labelled with GROUPING() and
   '*' is applied from the label, leaving the real NULLs as 'unknown'. */
const grainSql = (bucketExpr, bucketName) => `
  SELECT ${bucketExpr} AS ${bucketName},
         CASE WHEN GROUPING(n.platform) = 1 THEN '*' ELSE coalesce(n.platform, 'unknown') END AS platform,
         CASE WHEN GROUPING(n.fleet_id) = 1 THEN '*' ELSE coalesce(n.fleet_id, 'unknown') END AS fleet_id,
         ${MEASURES}
  ${FROM_TRIPS}
  WHERE n.requested_at IS NOT NULL
  GROUP BY GROUPING SETS (
    (${bucketExpr}, n.platform, n.fleet_id),
    (${bucketExpr}, n.platform),
    (${bucketExpr}, n.fleet_id),
    (${bucketExpr}))`;

/* The same SQL, exported so a reader can compute a grain directly when the
   stored one is not there yet — a fresh database, a deploy before the first
   collection, or a rollup that failed. The alternative was a second copy of
   each aggregate living in the route as a "fallback", which is how the two
   quietly stop agreeing: the fast path and the slow path would then be
   different answers to the same question, and only one of them ever gets
   fixed. One definition, two ways to execute it.

   `bucket` is 'day' or 'month'. */
export const rollupGrainSql = (bucket) => grainSql(
  bucket === 'month' ? "date_trunc('month', n.local_day)::date" : 'n.local_day', bucket);

const COLS = ['trips', 'bookings', 'telematics', 'drivers', 'vehicles', 'earning_vehicles',
  'attributed_trips', 'revenue', 'priced_trips', 'km', 'measured_trips',
  'completed', 'not_completed', 'outcome_n'];

async function refreshGrain(db, { table, bucket, expr }) {
  const set = COLS.map((c) => `${c} = EXCLUDED.${c}`).join(', ');
  const { rowCount } = await db.query(
    `INSERT INTO ${table} (${bucket}, platform, fleet_id, ${COLS.join(', ')}, computed_at)
     SELECT ${bucket}, platform, fleet_id, ${COLS.join(', ')}, now()
     FROM (${grainSql(expr, bucket)}) g
     ON CONFLICT (${bucket}, platform, fleet_id) DO UPDATE
       SET ${set}, computed_at = now()`);
  return rowCount || 0;
}

/* Month bounds and the platform list, which the month grain also carries. Kept
   out of MEASURES because array_agg of a column the set is grouping by is
   meaningless in the sets that do not group by it. */
async function refreshMonthExtras(db) {
  await db.query(
    `UPDATE rollup_month m SET first_day = x.a, last_day = x.b,
            platforms = x.p, booking_platforms = x.bp
     FROM (
       SELECT date_trunc('month', n.local_day)::date AS month,
              min(n.local_day) a, max(n.local_day) b,
              array_agg(DISTINCT n.platform) p,
              array_agg(DISTINCT n.platform) FILTER (WHERE n.is_booking) bp
       FROM trip_norm n GROUP BY 1
     ) x
     WHERE m.month = x.month AND m.platform = '*' AND m.fleet_id = '*'`);
}

async function refreshPersonMonth(db) {
  const { rowCount } = await db.query(
    `INSERT INTO rollup_person_month (person_key, month, name, driver_ext_id, bookings, revenue, km, platforms, computed_at)
     SELECT t.person_key,
            date_trunc('month', n.local_day)::date AS month,
            max(n.driver_name),
            (array_agg(DISTINCT n.driver_ext_id) FILTER (WHERE n.driver_ext_id IS NOT NULL))[1],
            count(*)::int,
            round(sum(n.price) FILTER (WHERE n.has_fare)::numeric, 2),
            round(sum(n.distance_km) FILTER (WHERE n.has_distance)::numeric, 1),
            array_agg(DISTINCT n.platform),
            now()
     ${FROM_TRIPS}
     WHERE n.is_booking AND t.person_key IS NOT NULL AND t.person_key <> ''
     GROUP BY 1, 2
     ON CONFLICT (person_key, month) DO UPDATE
       SET name = EXCLUDED.name, driver_ext_id = EXCLUDED.driver_ext_id,
           bookings = EXCLUDED.bookings, revenue = EXCLUDED.revenue, km = EXCLUDED.km,
           platforms = EXCLUDED.platforms, computed_at = now()`);
  return rowCount || 0;
}

/* One named rollup, with its own state row. Named separately so a failure in
   one does not read as a failure of all three — and so a page can tell which
   of its numbers is stale. */
async function runOne(db, name, fn) {
  const t0 = Date.now();
  await db.query(
    `INSERT INTO rollup_state (name, started_at, status) VALUES ($1, now(), 'running')
     ON CONFLICT (name) DO UPDATE SET started_at = now(), status = 'running', error = NULL`, [name]);
  try {
    const rows = await fn();
    const [{ a, b } = {}] = (await db.query(
      `SELECT min(local_day) a, max(local_day) b FROM trip_norm`)).rows;
    await db.query(
      `UPDATE rollup_state SET finished_at = now(), rows_written = $2, duration_ms = $3,
              covers_from = $4, covers_to = $5, status = 'ok', error = NULL
       WHERE name = $1`, [name, rows, Date.now() - t0, a || null, b || null]);
    return { name, rows, ms: Date.now() - t0 };
  } catch (e) {
    /* Recorded, not swallowed. A rollup that fails silently leaves the pages
       reading whatever it wrote last time, with no way to tell. */
    await db.query(
      `UPDATE rollup_state SET finished_at = now(), duration_ms = $2, status = 'error', error = $3
       WHERE name = $1`, [name, Date.now() - t0, String(e).slice(0, 400)]);
    log.error(SRC, `${name} failed`, { err: String(e).slice(0, 300) });
    return { name, error: String(e).slice(0, 200) };
  }
}

export async function refreshRollups({ db = pool } = {}) {
  const t0 = Date.now();
  const out = [];
  out.push(await runOne(db, 'rollup_day', () =>
    refreshGrain(db, { table: 'rollup_day', bucket: 'day', expr: 'n.local_day' })));
  out.push(await runOne(db, 'rollup_month', async () => {
    const n = await refreshGrain(db, {
      table: 'rollup_month', bucket: 'month', expr: "date_trunc('month', n.local_day)::date" });
    await refreshMonthExtras(db);
    return n;
  }));
  out.push(await runOne(db, 'rollup_person_month', () => refreshPersonMonth(db)));
  const failed = out.filter((o) => o.error);
  log[failed.length ? 'warn' : 'info'](SRC, 'refreshed', {
    ms: Date.now() - t0,
    rows: out.reduce((a, o) => a + (o.rows || 0), 0),
    failed: failed.length || undefined,
  });
  return out;
}

/* How fresh each rollup is, for the API to hand to a page. */
export async function rollupState(db = pool) {
  const { rows } = await db.query(
    `SELECT name, status, finished_at, rows_written, duration_ms, covers_from, covers_to, error,
            round(extract(epoch from (now() - finished_at))/60)::int AS age_min
     FROM rollup_state ORDER BY name`);
  return rows;
}
