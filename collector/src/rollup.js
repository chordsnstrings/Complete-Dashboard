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
const grainSql = (bucketExpr, bucketName, sinceParam = '') => `
  SELECT ${bucketExpr} AS ${bucketName},
         CASE WHEN GROUPING(n.platform) = 1 THEN '*' ELSE coalesce(n.platform, 'unknown') END AS platform,
         CASE WHEN GROUPING(n.fleet_id) = 1 THEN '*' ELSE coalesce(n.fleet_id, 'unknown') END AS fleet_id,
         ${MEASURES}
  ${FROM_TRIPS}
  WHERE n.requested_at IS NOT NULL ${sinceParam}
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

/* A partial pass must never rebuild a bucket from part of it.
   The narrow refresh filters on local_day, but the month grain GROUPS by
   month — so a window starting mid-month rebuilt the whole August row from the
   fortnight inside the window and halved it. Measured: a five-day window
   reported August as 2 trips against 18. The chart would simply have been
   wrong, with nothing failing and nothing to notice.

   So the cutoff is snapped back to the start of the bucket that contains it.
   The pass then reads a few more days than asked and every bucket it writes is
   whole. */
const snapToBucket = (since, bucket) =>
  (bucket === 'month' ? `${since.slice(0, 7)}-01` : since);

async function refreshGrain(db, { table, bucket, expr, since }) {
  const set = COLS.map((c) => `${c} = EXCLUDED.${c}`).join(', ');
  const from = since ? snapToBucket(since, bucket) : null;
  const where = from ? 'AND n.local_day >= $1::date' : '';
  const { rowCount } = await db.query(
    `INSERT INTO ${table} (${bucket}, platform, fleet_id, ${COLS.join(', ')}, computed_at)
     SELECT ${bucket}, platform, fleet_id, ${COLS.join(', ')}, now()
     FROM (${grainSql(expr, bucket, where)}) g
     ON CONFLICT (${bucket}, platform, fleet_id) DO UPDATE
       SET ${set}, computed_at = now()`, from ? [from] : []);
  return rowCount || 0;
}

/* Month bounds and the platform list, which the month grain also carries. Kept
   out of MEASURES because array_agg of a column the set is grouping by is
   meaningless in the sets that do not group by it. */
async function refreshMonthExtras(db, since) {
  const from = since ? snapToBucket(since, 'month') : null;
  await db.query(
    `UPDATE rollup_month m SET first_day = x.a, last_day = x.b,
            platforms = x.p, booking_platforms = x.bp
     FROM (
       SELECT date_trunc('month', n.local_day)::date AS month,
              min(n.local_day) a, max(n.local_day) b,
              array_agg(DISTINCT n.platform) p,
              array_agg(DISTINCT n.platform) FILTER (WHERE n.is_booking) bp
       FROM trip_norm n ${from ? 'WHERE n.local_day >= $1::date' : ''} GROUP BY 1
     ) x
     WHERE m.month = x.month AND m.platform = '*' AND m.fleet_id = '*'`, from ? [from] : []);
}

async function refreshPersonMonth(db, since) {
  // Month-grained as well, so the same snap applies: a person's August row
  // rebuilt from five days of August is a person who worked five days.
  const from = since ? snapToBucket(since, 'month') : null;
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
     /* Not a person_key IS NOT NULL predicate here: that matches the partial
        index's own predicate exactly and tips the planner into an index
        scan with a heap fetch per row. It cost /api/drivers/directory a
        tenfold regression when written that way. Same set of rows, read the
        way this query is reading them anyway. */
     WHERE n.is_booking AND t.driver_name IS NOT NULL AND btrim(t.driver_name) <> ''
       ${from ? 'AND n.local_day >= $1::date' : ''}
     GROUP BY 1, 2
     ON CONFLICT (person_key, month) DO UPDATE
       SET name = EXCLUDED.name, driver_ext_id = EXCLUDED.driver_ext_id,
           bookings = EXCLUDED.bookings, revenue = EXCLUDED.revenue, km = EXCLUDED.km,
           platforms = EXCLUDED.platforms, computed_at = now()`, from ? [from] : []);
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

/* A full rebuild reads every trip ever collected, and on this fleet that is
   about eighty seconds of database work across the three rollups. Running it
   every fifteen minutes on the same managed Postgres the API reads from was
   measurable at the other end: /api/playbook went from 9.3s to 11.1s and
   /api/capacity from 2.4s to 5.9s while a refresh was in flight. Making the
   pages faster by starving them is not making them faster.

   So the frequent refresh only recomputes recent buckets. Yesterday's numbers
   do not change when today's trips land; only a backfill rewrites history, and
   the daily full rebuild is what catches that.

   `days` is how far back to recompute. Deliberately wider than the collector's
   incremental window: a late-arriving trip, a corrected fare, or a run that
   fell behind all land days after the fact, and a rollup that only looked at
   today would miss every one of them. */
/* Only one refresh at a time.
   Three things start one — the boot pass, the quarter-hourly cron, and the end
   of every collection run — and on the first deploy two of them overlapped.
   Both do INSERT ... ON CONFLICT DO UPDATE over the same rows, and two such
   passes touching those rows in different orders deadlock: production reported
   rollup_month status=error, "deadlock detected", which is Postgres correctly
   refusing to corrupt anything and this code being wrong to ask.

   Overlap is not an error worth propagating — the second pass would compute
   exactly what the first is already computing. It is skipped and said so. */
let inFlight = null;

/* And across processes, where the in-process guard cannot see. Only the
   collector refreshes today, so this is belt and braces — but a scaled worker
   is one platform setting away, and the failure it would cause is the one that
   just happened. pg_try_advisory_lock returns false rather than waiting, which
   is what "skip, do not queue" needs. Skipped on PGlite, which has no pool. */
const LOCK_KEY = 4711;
async function withDbLock(db, fn) {
  if (typeof db.connect !== 'function') return fn();
  const client = await db.connect();
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS got', [LOCK_KEY]);
    if (!rows[0]?.got) {
      log.info(SRC, 'another process holds the rollup lock — skipped');
      return null;
    }
    try { return await fn(); }
    finally { await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]); }
  } finally { client.release(); }
}

export async function refreshRollups(opts = {}) {
  if (inFlight) {
    log.info(SRC, 'refresh already running — skipped');
    return inFlight;
  }
  inFlight = withDbLock(opts.db || pool, () => refreshRollupsInner(opts))
    .finally(() => { inFlight = null; });
  return inFlight;
}

async function refreshRollupsInner({ db = pool, days = null } = {}) {
  const t0 = Date.now();
  const since = days
    ? new Date(Date.now() - days * 864e5).toISOString().slice(0, 10)
    : null;
  const out = [];
  out.push(await runOne(db, 'rollup_day', () =>
    refreshGrain(db, { table: 'rollup_day', bucket: 'day', expr: 'n.local_day', since })));
  out.push(await runOne(db, 'rollup_month', async () => {
    const n = await refreshGrain(db, {
      table: 'rollup_month', bucket: 'month', expr: "date_trunc('month', n.local_day)::date", since });
    await refreshMonthExtras(db, since);
    return n;
  }));
  out.push(await runOne(db, 'rollup_person_month', () => refreshPersonMonth(db, since)));
  out.push(await runOne(db, 'driver_payout_day', () => refreshPayouts(db)));
  out.push(await runOne(db, 'driver_statement_day', () => refreshStatements(db)));
  /* Refresh the planner's statistics on the tables this just rewrote, and on
     trip itself. A generated column arrives with NO statistics — Postgres has
     never seen its distribution — so every plan touching person_key was being
     chosen blind, and one of them chose an index scan over most of the table.
     Autovacuum gets there eventually; "eventually" is a page that is slow for
     an hour after a deploy.

     ANALYZE takes a light lock and reads a sample, not the table, so it is
     cheap next to the rollup that just ran. Failure is not fatal: stale
     statistics are a slow query, not a wrong one. */
  try {
    await db.query('ANALYZE trip, rollup_day, rollup_month, rollup_person_month, driver_payout_day');
  } catch (e) { log.warn(SRC, 'analyze failed — plans may be stale', { err: String(e).slice(0, 120) }); }

  const failed = out.filter((o) => o.error);
  log[failed.length ? 'warn' : 'info'](SRC, since ? `refreshed since ${since}` : 'refreshed in full', {
    ms: Date.now() - t0,
    rows: out.reduce((a, o) => a + (o.rows || 0), 0),
    failed: failed.length || undefined,
  });
  return out;
}

/* Materialise the payout-day resolution — see sql/schema_v23.sql.
   ─────────────────────────────────────────────────────────────────────────
   driver_payout_day_live expands every report window into its days and picks a
   winner per (platform, driver, day). Computing that on demand cost a one-vCPU
   database twenty seconds and more per query, and every page's money passes
   through it — so it runs here, once per collection cycle, and everything else
   reads the table it fills.

   Always in full, never incrementally. The winner for a day can change when a
   FINER report arrives for a week already covered by a coarse one, and which
   days that dethrones is exactly the question the view answers — an
   incremental refresh would have to answer it twice. The whole expansion is
   one INSERT..SELECT on the server; measured at production shape it is the
   cost of one of the queries it replaces.

   DELETE, not TRUNCATE: TRUNCATE takes ACCESS EXCLUSIVE and blocks every
   reader for the duration of the rebuild, while DELETE inside the transaction
   lets a concurrent reader see the previous complete answer until the commit
   swaps it. The dead rows are the price; autovacuum collects them, and the
   ANALYZE below keeps the planner current meanwhile. */
export async function refreshPayouts(db = pool) {
  await db.query('BEGIN');
  try {
    await db.query('DELETE FROM driver_payout_day');
    const r = await db.query(`
      INSERT INTO driver_payout_day
        (platform, fleet_id, driver_ext_id, driver_name, day,
         period_start, period_end, period_days, period_earnings,
         earnings, cash_earnings, trips, distance_km, hours_online, hours_on_trip,
         acceptance_rate, cancellation_rate, completion_rate, rating, currency, ingested_at)
      SELECT platform, fleet_id, driver_ext_id, driver_name, day,
             period_start, period_end, period_days, period_earnings,
             earnings, cash_earnings, trips, distance_km, hours_online, hours_on_trip,
             acceptance_rate, cancellation_rate, completion_rate, rating, currency, ingested_at
      FROM driver_payout_day_live`);
    await db.query('COMMIT');
    return r.rowCount ?? 0;
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    throw e;
  }
}

/* Derive the ON-TRIP statement days from the earner-payments components.
   ─────────────────────────────────────────────────────────────────────────
   The REST payments surface is the one API that carries Uber's statement view
   — net fares, tips, tolls, cash collected — and it lands in
   driver_earnings_component per driver-week. This turns those periods into
   driver_statement_day rows (source='uber_rest'), the table every on-trip
   figure reads, spreading each week evenly over its days the same way the
   payout resolution spreads its periods.

   Component semantics, read from the tree itself: net_fare is the fare income
   net of commission (the on-trip net, excluding tips), tip and toll (Salik)
   ride separately, cash_collected arrives NEGATIVE — it is money already in
   the driver's hand. Categories the mapping does not name (taxes, surcharges,
   promos) are deliberately left out rather than guessed at: an unmapped
   dirham is invisible here but still present in the payout, and inventing a
   column for it would be the exact sin the ledger reconciliation exists to
   catch.

   Delete-and-rebuild of the uber_rest slice only: the ledger slice (reference
   data) and any future source are other writers' rows. */
export async function refreshStatements(db = pool) {
  await db.query('BEGIN');
  try {
    await db.query(`DELETE FROM driver_statement_day WHERE source = 'uber_rest'`);
    /* Same resolution as the payout view: periods first, then one winner per
       day — the FINEST period covering it. The table holds report windows on
       several grids (weekly now; three-day and longer run-stamps from before
       the weekly fix), and two grids covering one day must not both spread
       into it, nor an arbitrary one win. */
    const r = await db.query(`
      WITH per AS (
        SELECT platform, coalesce(fleet_id, 'ecosine') AS fleet_id, driver_ext_id,
               max(driver_name) AS driver_name, period_start, period_end,
               (period_end - period_start + 1)::numeric AS days,
               sum(amount) FILTER (WHERE category = 'net_fare')        AS net,
               sum(amount) FILTER (WHERE category = 'tip')             AS tips,
               sum(amount) FILTER (WHERE category = 'toll')            AS salik,
               -sum(amount) FILTER (WHERE category = 'cash_collected') AS cash
        FROM driver_earnings_component
        WHERE category IN ('net_fare', 'tip', 'toll', 'cash_collected')
        GROUP BY platform, fleet_id, driver_ext_id, period_start, period_end
        HAVING sum(amount) FILTER (WHERE category = 'net_fare') IS NOT NULL
      ),
      resolved AS (
        SELECT DISTINCT ON (p.platform, p.fleet_id, p.driver_ext_id, d.day)
               p.platform, p.fleet_id,
               coalesce(p.driver_name, p.driver_ext_id) AS driver_name,
               p.driver_ext_id, d.day::date AS day,
               p.net / p.days AS net, p.tips / p.days AS tips,
               p.salik / p.days AS salik, p.cash / p.days AS cash
        FROM per p
        CROSS JOIN LATERAL generate_series(p.period_start, p.period_end, interval '1 day') AS d(day)
        ORDER BY p.platform, p.fleet_id, p.driver_ext_id, d.day,
                 (p.period_end - p.period_start) ASC, p.period_start ASC
      ),
      /* One person can hold two platform accounts (a real case in this fleet:
         the same driver as "…Ghulam Qadir" and "…khan"). Their names may fold
         to one key, and the table is keyed per person-day — so account rows
         folding together are SUMMED, never last-write-wins. */
      folded AS (
        SELECT platform, fleet_id, max(driver_name) AS driver_name,
               max(driver_ext_id) AS driver_ext_id, day,
               sum(net) AS net, sum(tips) AS tips, sum(salik) AS salik, sum(cash) AS cash
        FROM resolved
        GROUP BY platform, fleet_id, lower(regexp_replace(driver_name, '\\s+', ' ', 'g')), day
      )
      INSERT INTO driver_statement_day
        (platform, fleet_id, driver_name, driver_ext_id, day,
         net, tips, salik, cash, source, pseudo)
      SELECT platform, fleet_id, driver_name, driver_ext_id, day,
             net, tips, salik, cash, 'uber_rest', false
      FROM folded
      ON CONFLICT (platform, fleet_id, name_key, day, source) DO UPDATE SET
        net = EXCLUDED.net, tips = EXCLUDED.tips, salik = EXCLUDED.salik,
        cash = EXCLUDED.cash, driver_ext_id = EXCLUDED.driver_ext_id,
        ingested_at = now()`);
    await db.query('COMMIT');
    return r.rowCount ?? 0;
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    throw e;
  }
}

/* How fresh each rollup is, for the API to hand to a page. */
export async function rollupState(db = pool) {
  const { rows } = await db.query(
    `SELECT name, status, finished_at, rows_written, duration_ms, covers_from, covers_to, error,
            round(extract(epoch from (now() - finished_at))/60)::int AS age_min
     FROM rollup_state ORDER BY name`);
  return rows;
}
